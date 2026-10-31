import { randomUUID } from "node:crypto";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createGitHubWriter,
  type GitHubWriter,
  type RemotePull,
  type RemoteThread,
} from "../../adapters/github/writer.ts";
import { PublicationGit } from "../../adapters/github/git.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import { digest, RuntimeError, workerLimits } from "../../domain/agents.ts";
import { IntakeError, type IssueContext } from "../../domain/jobs.ts";
import type { Store } from "../../repositories/store.ts";
import { PublicationRepository } from "../../repositories/publication.ts";
import { InvestigationRepository } from "../../repositories/investigation.ts";
import { ImplementationRepository } from "../../repositories/implementation.ts";
import { PrMonitorRepository } from "../../repositories/pr-monitor.ts";
import { findingIdentity } from "../pr-monitor/policy.ts";
import { renderFindings, stageText } from "../investigation/contracts.ts";
import type { BootstrapLease, Supervisor } from "../../runtime/supervisor.ts";
import { rootDirectory } from "../workspaces/files.ts";
import { ExternalOutputReview } from "./review.ts";
import { policyIdentity } from "./scanner.ts";
import { renderQuestion } from "../clarification-contracts.ts";
import {
  proposalSchema,
  type PublicationEvidence,
  type PublicationProposal,
  type PublicationReceipt,
  type MutationStep,
  type OwnedPull,
  type ReviewRequest,
} from "./contracts.ts";

type FrozenPayload = {
  destination: Record<string, unknown>;
  comment?: string;
  pull?: { title: string; body: string; branch: string; base: string };
  candidate?: Awaited<ReturnType<PublicationGit["build"]>>;
  evidence: unknown[];
  narrative?: string;
  feedback?: {
    thread: string | null;
    before: RemoteThread | null;
    body: string;
    resolve: boolean;
  };
};
type PublicationOptions = {
  writer?: (ready: () => void) => GitHubWriter;
  sourceUrl?: (repository: string) => string;
};
const notices = {
  model_unavailable:
    "Model service is unavailable. Work is blocked; no completion is claimed.",
  budget_exhausted:
    "The job budget is exhausted. Work is blocked; no completion is claimed.",
  publication_blocked:
    "Publication is blocked. Operator inspection is required.",
};

export class PublicationService {
  readonly repository: PublicationRepository;
  readonly outputReview: ExternalOutputReview;
  private readonly writer: GitHubWriter;
  private readonly root: string;
  private readonly active = new Set<number>();
  private readonly supervisor: Supervisor;
  private readonly store: Store;
  private readonly secrets: SecretAccessor;
  private readonly options: PublicationOptions;
  private readinessValidator?: (
    id: string,
    signal: AbortSignal,
  ) => Promise<void>;
  constructor(
    supervisor: Supervisor,
    store: Store,
    secrets: SecretAccessor,
    options: PublicationOptions = {},
  ) {
    this.supervisor = supervisor;
    this.store = store;
    this.secrets = secrets;
    this.options = options;
    this.repository = new PublicationRepository(store);
    this.root = join(supervisor.workspaces.privateRoot, "publication");
    this.outputReview = new ExternalOutputReview(
      supervisor,
      store,
      secrets,
      join(this.root, "scans"),
    );
    this.writer =
      options.writer?.(() => this.repository.providerReady()) ??
      createGitHubWriter(
        supervisor.repositoryName(),
        secrets.get("github.token"),
        () => this.repository.providerReady(),
      );
  }

  async recordEvidence(evidence: PublicationEvidence, signal: AbortSignal) {
    const frozen = structuredClone(evidence);
    await this.outputReview.scanner.scan(frozen, signal);
    return this.repository.recordEvidence(frozen);
  }

  setReadinessValidator(
    validate: (id: string, signal: AbortSignal) => Promise<void>,
  ) {
    this.readinessValidator = validate;
  }

  async publish(
    input: PublicationProposal,
    signal: AbortSignal,
  ): Promise<PublicationReceipt> {
    const proposal = proposalSchema.parse(structuredClone(input));
    return this.exclusive(proposal.job_id, () =>
      this.publishCurrent(proposal, signal),
    );
  }

  async reviewQuestion(
    input: Extract<PublicationProposal, { kind: "question" }>,
    signal: AbortSignal,
  ) {
    const proposal = proposalSchema.parse(structuredClone(input));
    if (proposal.kind !== "question")
      throw new RuntimeError("publication_proposal_invalid");
    return this.exclusive(proposal.job_id, () =>
      this.publishCurrent(proposal, signal, true),
    );
  }

  operationId(proposal: PublicationProposal) {
    return digest({
      instance: this.repository.instance(),
      proposal: proposalSchema.parse(proposal),
    });
  }

  private async exclusive<T>(jobId: number, operation: () => Promise<T>) {
    if (this.active.has(jobId)) throw new RuntimeError("publication_busy");
    this.active.add(jobId);
    try {
      return await operation();
    } finally {
      this.active.delete(jobId);
    }
  }

  private async publishCurrent(
    proposal: PublicationProposal,
    signal: AbortSignal,
    reviewOnly = false,
  ): Promise<PublicationReceipt> {
    if (this.secrets.containsCredentials(proposal))
      throw new RuntimeError("publication_secret");
    const id = this.operationId(proposal);
    const previous = this.repository.operation(id);
    if (previous?.status === "confirmed" || previous?.status === "blocked")
      return previous;
    this.repository.current(proposal.job_id, proposal.revision);
    const operation = async (
      publicationSignal: AbortSignal,
      lease?: BootstrapLease,
    ) => {
      const job = this.repository.current(proposal.job_id, proposal.revision);
      const source = (
        JSON.parse(job.input_json) as { source: PublicationReceipt["source"] }
      ).source;
      const receipt = this.repository.begin({
        id,
        job_id: job.id,
        revision: job.revision,
        status: "prepared",
        failure: null,
        retry_at: 0,
        retry_pending: false,
        proposal,
        source,
        target: this.repository.target(job.id),
        actor: null,
        timestamp: new Date().toISOString(),
        review_id: null,
        payload: null,
        commit: null,
        steps: [],
      });
      let git: PublicationGit | undefined, directory: string | undefined;
      this.repository.retry(receipt);
      try {
        await this.store.checkpoint(publicationSignal);
        if (
          receipt.steps.some(
            (step) =>
              step.state === "dispatching" || step.state === "uncertain",
          )
        ) {
          await this.reconcileCurrent(receipt.id, publicationSignal);
          const reconciled = this.repository.operation(receipt.id)!;
          Object.assign(receipt, reconciled);
          if (
            receipt.status === "uncertain" ||
            receipt.status === "confirmed" ||
            receipt.status === "blocked"
          )
            return receipt;
        }
        await this.authority(receipt, publicationSignal);
        await rootDirectory(this.root);
        directory = await mkdtemp(join(this.root, "git-"));
        await rmdir(directory);
        git = new PublicationGit(
          directory,
          this.secrets,
          this.supervisor.repositoryName(),
          this.options.sourceUrl,
        );
        const payload = await this.prepare(receipt, git, publicationSignal);
        const reviewRequest = this.reviewRequest(receipt);
        if (!receipt.review_id) {
          if (
            proposal.kind === "notice" ||
            proposal.kind === "investigation_stage" ||
            proposal.kind === "pr_stage"
          ) {
            await this.outputReview.scanner.scan(payload, publicationSignal);
            receipt.review_id = this.repository.review({
              id: randomUUID(),
              job_id: job.id,
              revision: job.revision,
              binding: this.outputReview.binding(reviewRequest),
              policy_identity: policyIdentity,
              approved: true,
              run_id: null,
              created_at: Date.now(),
            }).id;
          } else
            receipt.review_id = (
              await this.outputReview.review(
                reviewRequest,
                publicationSignal,
                lease,
              )
            ).id;
          receipt.status = "reviewed";
          this.repository.save(receipt);
          await this.store.checkpoint(publicationSignal);
        }
        if (reviewOnly) return receipt;
        for (let index = 0; index < receipt.steps.length; index++) {
          const step = receipt.steps[index];
          if (step.state === "confirmed") continue;
          await this.authority(receipt, publicationSignal);
          this.approval(receipt);
          await this.before(receipt, step, publicationSignal);
          if (receipt.steps[index].state === "confirmed") continue;
          publicationSignal.throwIfAborted();
          this.repository.current(job.id, job.revision);
          this.repository.providerReady();
          step.state = "dispatching";
          receipt.status = "dispatching";
          this.repository.save(receipt);
          await this.store.checkpoint(publicationSignal);
          try {
            if (step.kind === "question_comment")
              await this.writer.comment(
                job.issue_number,
                null,
                payload.comment!,
                publicationSignal,
              );
            else if (step.kind === "comment")
              await this.writer.comment(
                job.issue_number,
                receipt.target.comment?.id ?? null,
                payload.comment!,
                publicationSignal,
              );
            else if (step.kind === "branch")
              await git!.push(
                receipt.commit!,
                receipt.target.branch,
                publicationSignal,
              );
            else if (step.kind === "feedback_reply") {
              if (payload.feedback!.thread)
                await this.writer.replyThread(
                  payload.feedback!.thread,
                  payload.feedback!.body,
                  publicationSignal,
                );
              else
                await this.writer.comment(
                  receipt.target.pull!.number,
                  null,
                  payload.feedback!.body,
                  publicationSignal,
                );
            } else if (step.kind === "thread_resolution")
              await this.writer.resolveThread(
                payload.feedback!.thread!,
                publicationSignal,
              );
            else
              await this.writer.updatePull(
                receipt.target.pull?.number ?? null,
                payload.pull!,
                publicationSignal,
              );
          } catch (error) {
            this.failed(receipt, error);
            step.state = "uncertain";
            receipt.status = "uncertain";
            this.repository.save(receipt);
            if (publicationSignal.aborted || Date.now() < receipt.retry_at)
              return receipt;
          }
          const reconciled = await this.reconcileCurrent(
            receipt.id,
            publicationSignal,
          );
          Object.assign(receipt, reconciled);
          if (
            reconciled.status === "uncertain" ||
            reconciled.status === "blocked"
          )
            return receipt;
        }
        receipt.status = "confirmed";
        receipt.failure = null;
        this.repository.save(receipt);
        await this.store.checkpoint(publicationSignal);
        return receipt;
      } catch (error) {
        const cancelled =
          publicationSignal.aborted && error === publicationSignal.reason;
        this.failed(receipt, error);
        receipt.status = receipt.steps.some(
          (step) => step.state === "dispatching" || step.state === "uncertain",
        )
          ? "uncertain"
          : cancelled ||
              (error instanceof IntakeError &&
                ["github_rate_limited", "github_publication_failed"].includes(
                  error.code,
                )) ||
              (error instanceof RuntimeError &&
                ["publication_backoff", "publication_git_failed"].includes(
                  error.code,
                ))
            ? receipt.review_id
              ? "reviewed"
              : "prepared"
            : "blocked";
        if (cancelled) receipt.retry_pending = true;
        this.repository.save(receipt);
        return receipt;
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    };
    return proposal.kind === "notice" ||
      proposal.kind === "investigation_stage" ||
      proposal.kind === "pr_stage" ||
      (proposal.kind === "question" && previous?.review_id && !reviewOnly)
      ? this.supervisor.withPublicationNotice(signal, (noticeSignal) =>
          operation(noticeSignal),
        )
      : this.supervisor.withJobLease(
          this.supervisor.request(proposal.job_id, "output_review"),
          signal,
          (lease) => operation(lease.signal, lease),
        );
  }

  async reconcile(
    operationId: string,
    signal: AbortSignal,
  ): Promise<PublicationReceipt> {
    const receipt = this.repository.operation(operationId);
    if (!receipt) throw new RuntimeError("publication_missing");
    return this.exclusive(receipt.job_id, () =>
      this.reconcileCurrent(operationId, signal),
    );
  }

  private async reconcileCurrent(
    operationId: string,
    signal: AbortSignal,
  ): Promise<PublicationReceipt> {
    const receipt = this.repository.operation(operationId);
    if (!receipt) throw new RuntimeError("publication_missing");
    if (receipt.status === "confirmed" || receipt.status === "blocked")
      return receipt;
    if (this.finishReconciliation(receipt)) {
      this.repository.save(receipt);
      return receipt;
    }
    this.repository.retry(receipt);
    try {
      await this.store.checkpoint(signal);
      const job = this.store.jobById(receipt.job_id);
      if (!job || !receipt.actor || !receipt.payload)
        throw new RuntimeError("publication_incomplete");
      const repository = await this.writer.repository(signal);
      if (
        repository.id !== this.store.repository()?.id ||
        repository.full_name !== this.supervisor.repositoryName()
      )
        throw new RuntimeError("publication_repository_changed");
      const payload = receipt.payload as FrozenPayload;
      for (const step of receipt.steps) {
        if (step.state !== "dispatching" && step.state !== "uncertain")
          continue;
        let matched = false;
        if (step.kind === "question_comment") {
          const matches = (
            await this.writer.comments(job.issue_number, signal)
          ).filter(
            (comment) =>
              comment.body === payload.comment &&
              comment.author_id === receipt.actor!.id &&
              (step.object_id === undefined || step.object_id === comment.id),
          );
          if (matches.length === 1) {
            step.object_id = matches[0].id;
            matched = true;
          }
        } else if (step.kind === "comment") {
          const matches = (
            await this.writer.comments(job.issue_number, signal)
          ).filter(
            (comment) =>
              comment.body === payload.comment &&
              comment.author_id === receipt.actor!.id &&
              (!receipt.target.comment ||
                comment.id === receipt.target.comment.id),
          );
          if (matches.length === 1) {
            receipt.target.comment = matches[0];
            matched = true;
          }
        } else if (step.kind === "branch") {
          const branch = await this.writer.branch(
            receipt.target.branch,
            signal,
          );
          if (branch.head === receipt.commit) {
            receipt.target.head = branch.head;
            if (receipt.target.pull) receipt.target.pull.head = branch.head!;
            matched = true;
          }
        } else if (
          step.kind === "feedback_reply" ||
          step.kind === "thread_resolution"
        ) {
          const feedback = payload.feedback!;
          if (feedback.thread) {
            const thread = await this.writer.thread(feedback.thread, signal);
            if (
              thread.pull_id !== receipt.target.pull!.id ||
              thread.repository_id !== this.store.repository()!.id
            )
              throw new RuntimeError("publication_thread_changed");
            const matches = thread.comments.filter(
              (comment) =>
                comment.body === feedback.body &&
                comment.author_login?.toLowerCase().replace(/\[bot\]$/, "") ===
                  receipt.actor!.login.toLowerCase().replace(/\[bot\]$/, ""),
            );
            matched =
              matches.length === 1 &&
              (step.kind === "feedback_reply" || thread.resolved);
            if (matches.length === 1)
              this.repository.feedbackObject(
                receipt,
                "review_comment",
                matches[0].id,
              );
          } else {
            const matches = (
              await this.writer.comments(receipt.target.pull!.number, signal)
            ).filter(
              (comment) =>
                comment.body === feedback.body &&
                comment.author_id === receipt.actor!.id,
            );
            matched = matches.length === 1;
            if (matched)
              this.repository.feedbackObject(
                receipt,
                "issue_comment",
                matches[0].id,
              );
          }
        } else {
          const matches = (
            await this.writer.pulls(receipt.target.branch, signal)
          ).filter(
            (pull) =>
              this.matchesPull(receipt, pull) &&
              pull.title === payload.pull!.title &&
              pull.body === payload.pull!.body &&
              (!receipt.target.pull || pull.id === receipt.target.pull.id),
          );
          if (matches.length === 1) {
            receipt.target.pull = this.ownedPull(matches[0]);
            matched = true;
          }
        }
        step.state = matched ? "confirmed" : "uncertain";
        receipt.status = matched ? "reviewed" : "uncertain";
        if (matched) {
          this.repository.finishStep(receipt, step.kind);
          await this.store.checkpoint(signal);
        } else {
          receipt.failure = "publication_effect_uncertain";
          receipt.retry_pending = true;
          this.repository.save(receipt);
          return receipt;
        }
      }
      this.finishReconciliation(receipt);
      this.repository.save(receipt);
      return receipt;
    } catch (error) {
      this.failed(receipt, error);
      receipt.retry_pending = true;
      if (
        receipt.steps.some(
          (step) => step.state === "dispatching" || step.state === "uncertain",
        )
      )
        receipt.status = "uncertain";
      this.repository.save(receipt);
      return receipt;
    }
  }

  private finishReconciliation(receipt: PublicationReceipt) {
    if (
      !receipt.steps.every(
        (step) => step.state === "confirmed" || step.state === "prepared",
      )
    )
      return false;
    const complete =
      receipt.steps.length > 0 &&
      receipt.steps.every((step) => step.state === "confirmed");
    if (!complete) {
      try {
        this.repository.current(receipt.job_id, receipt.revision);
        return false;
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== "revision_stale")
          throw error;
      }
    }
    receipt.status = complete ? "confirmed" : "blocked";
    receipt.failure = complete ? null : "revision_stale";
    receipt.retry_pending = false;
    return true;
  }

  private async prepare(
    receipt: PublicationReceipt,
    git: PublicationGit,
    signal: AbortSignal,
  ): Promise<FrozenPayload> {
    const proposal = receipt.proposal,
      job = this.repository.current(receipt.job_id, receipt.revision);
    const marker = `<!-- orm:${this.repository.instance()}:${job.id}:${receipt.id} -->`;
    const payload: FrozenPayload = {
      destination: {
        repository_id: this.store.repository()!.id,
        repository: this.supervisor.repositoryName(),
        issue: job.issue_number,
        kind: proposal.kind,
        branch: receipt.target.branch,
        expected_head:
          proposal.kind === "change" ? proposal.expected_head : null,
        comment_id: receipt.target.comment?.id ?? null,
        pull_id: receipt.target.pull?.id ?? null,
      },
      evidence: [],
    };
    if (proposal.kind === "question") {
      payload.destination.comment_id = null;
      payload.comment = renderQuestion(proposal, marker);
      payload.evidence = [
        {
          question_id: proposal.question_id,
          phase: proposal.phase,
          audience: proposal.audience,
          source: receipt.source,
          context: JSON.parse(job.input_json),
          scope:
            new ImplementationRepository(this.store).current(job)?.scope ??
            null,
        },
      ];
    } else if (proposal.kind === "investigation") {
      const investigations = new InvestigationRepository(this.store);
      const record = investigations.get(proposal.investigation_id);
      investigations.assertCurrent(record);
      if (
        record.job_id !== job.id ||
        record.revision !== job.revision ||
        !record.result
      )
        throw new RuntimeError("investigation_evidence_mismatch");
      const evidence = record.result.evidence_ids.map((id) => ({
        id,
        ...investigations.evidence(id, job.id, job.revision, receipt.source),
      }));
      payload.narrative = renderFindings(
        record,
        evidence,
        this.supervisor.repositoryName(),
      );
      payload.evidence = evidence;
      if (record.result.outcome === "manual_feature")
        payload.evidence.push({
          context: JSON.parse(job.input_json),
          classification: record.triage,
        });
      if (record.result.outcome === "maintenance_candidate")
        payload.evidence.push({
          bug_evidence: record.result.bug,
          requirement:
            "Approve only a demonstrated violation of existing supported behavior. Labels and requested new behavior do not establish a bug. Source-only proof must establish the supported contract and trace its violation.",
        });
      payload.comment = `${payload.narrative}${this.pullReference(receipt)}\n\n${marker}`;
    } else if (proposal.kind === "investigation_stage") {
      payload.narrative = this.previousNarrative(
        proposal.previous_operation,
        job.id,
      );
      payload.comment = `${this.investigationStatus(proposal.stage, payload.narrative)}${this.pullReference(receipt)}\n\n${marker}`;
    } else if (proposal.kind === "pr_stage") {
      payload.narrative = this.previousNarrative(
        proposal.previous_operation,
        job.id,
      );
      payload.comment = `${this.prStatus(receipt, payload.narrative)}\n\n${marker}`;
      if (proposal.readiness_id)
        payload.evidence = [
          new PrMonitorRepository(this.store).readiness(proposal.readiness_id),
        ];
    } else if (proposal.kind === "feedback") {
      const monitors = new PrMonitorRepository(this.store),
        monitor = monitors.get(job.id);
      if (
        !monitor ||
        monitor.expected_head !== proposal.expected_head ||
        monitor.observed_head !== proposal.expected_head
      )
        throw new RuntimeError("publication_head_changed");
      monitors.current(monitor);
      const finding = monitor.findings.find(
        (item) => findingIdentity(item) === proposal.finding_id,
      );
      if (
        !finding ||
        finding.disposition === "blocked" ||
        (finding.disposition === "fix" &&
          finding.fixed_head !== proposal.expected_head)
      )
        throw new RuntimeError("publication_feedback_unverified");
      const snapshot =
        monitor.snapshot_digest &&
        monitors.read<{
          snapshot: import("../pr-monitor/contracts.ts").PrSnapshot;
        }>(monitor.snapshot_digest).snapshot;
      if (!snapshot || snapshot.head_sha !== proposal.expected_head)
        throw new RuntimeError("publication_head_changed");
      const thread = finding.surface.thread_id
        ? snapshot.threads.find((item) => item.id === finding.surface.thread_id)
        : null;
      if (finding.surface.thread_id && !thread)
        throw new RuntimeError("publication_thread_changed");
      const fixed =
        finding.disposition === "fixed" || finding.fixed_head !== null;
      const body = `${fixed ? `Fixed in ${proposal.expected_head}:` : finding.disposition === "informational" ? "Reviewed:" : "Not actionable for this PR:"} ${finding.explanation}\n\n${marker}`;
      payload.feedback = {
        thread: thread?.id ?? null,
        before: thread
          ? {
              id: thread.id,
              pull_id: snapshot.id,
              pull_number: snapshot.number,
              repository_id: snapshot.repository_id,
              resolved: thread.isResolved,
              comments: thread.comments.map((item) => ({
                id: item.databaseId,
                node_id: item.id,
                body: item.body,
                author_login: item.author?.login ?? null,
              })),
            }
          : null,
        body,
        resolve: !!thread && !thread.isResolved,
      };
      payload.evidence = [
        finding,
        {
          snapshot_digest: monitor.snapshot_digest,
          head_sha: snapshot.head_sha,
        },
      ];
      if (receipt.payload !== null) {
        const frozen = receipt.payload as FrozenPayload;
        payload.feedback = frozen.feedback;
        payload.evidence = frozen.evidence;
      }
    } else if (proposal.kind !== "change")
      payload.comment = `${proposal.kind === "notice" ? notices[proposal.reason] : proposal.body}\n\n${marker}`;
    else {
      if (
        proposal.expected_head !== receipt.target.head &&
        receipt.target.head !== receipt.commit
      )
        throw new RuntimeError("publication_head_changed");
      const manifest = this.store.artifact(
        proposal.artifact_digest,
        job.id,
        job.revision,
      );
      if (digest(manifest.source) !== digest(receipt.source))
        throw new RuntimeError("artifact_source_mismatch");
      const evidence = proposal.evidence_ids.map((id) =>
        this.repository.evidence(id),
      );
      payload.evidence = evidence;
      if (
        !["audit", "test"].every((kind) =>
          evidence.some((item) => item.kind === kind),
        ) ||
        evidence.some(
          (item) =>
            item.job_id !== job.id ||
            item.revision !== job.revision ||
            item.artifact_digest !== proposal.artifact_digest ||
            item.source_sha !== receipt.source.sha,
        )
      )
        throw new RuntimeError("publication_evidence_mismatch");
      const parent = proposal.expected_head ?? receipt.source.sha;
      this.repository.providerReady();
      await git.initialize(parent, signal);
      const message = `${proposal.commit_message}\n\nORM-Publication: ${this.repository.instance()}:${job.id}:${receipt.id}\n`;
      payload.candidate = await git.build(
        manifest,
        join(this.supervisor.workspaces.privateRoot, "blobs"),
        parent,
        message,
        receipt.actor!,
        receipt.timestamp,
        workerLimits(this.store.snapshot(job.snapshot_digest)).storage,
        signal,
      );
      payload.pull = {
        title: proposal.title,
        body: `${proposal.body}\n\nclose #${job.issue_number}\n\n${marker}`,
        branch: receipt.target.branch,
        base: receipt.source.default_branch,
      };
      if (
        !payload.candidate.changes.length &&
        (!receipt.target.pull || receipt.target.head !== parent)
      )
        throw new RuntimeError("publication_no_change");
      if (receipt.commit && receipt.commit !== payload.candidate.commit)
        throw new RuntimeError("publication_candidate_changed");
      receipt.commit = payload.candidate.commit;
    }
    if (payload.comment && Buffer.byteLength(payload.comment) > 65536)
      throw new RuntimeError("publication_size_limit");
    if (receipt.payload !== null && digest(receipt.payload) !== digest(payload))
      throw new RuntimeError("publication_payload_changed");
    receipt.payload = payload;
    if (!receipt.steps.length)
      receipt.steps =
        proposal.kind === "feedback"
          ? [
              {
                kind: "feedback_reply",
                before: payload.feedback!.before,
                after: payload.feedback!.body,
                state: "prepared",
              },
              ...(payload.feedback!.resolve
                ? [
                    {
                      kind: "thread_resolution" as const,
                      before: false,
                      after: true,
                      state: "prepared" as const,
                    },
                  ]
                : []),
            ]
          : proposal.kind === "change"
            ? [
                ...(payload.candidate!.changes.length
                  ? [
                      {
                        kind: "branch",
                        before: proposal.expected_head,
                        after: receipt.commit,
                        state: "prepared",
                      } as MutationStep,
                    ]
                  : []),
                {
                  kind: "pull",
                  before: receipt.target.pull,
                  after: payload.pull!,
                  state: "prepared",
                },
              ]
            : [
                {
                  kind:
                    proposal.kind === "question"
                      ? "question_comment"
                      : "comment",
                  before:
                    proposal.kind === "question"
                      ? null
                      : receipt.target.comment,
                  after: payload.comment,
                  state: "prepared",
                },
              ];
    this.repository.save(receipt);
    return payload;
  }

  private reviewRequest(receipt: PublicationReceipt): ReviewRequest {
    const payload = receipt.payload as FrozenPayload;
    return {
      job_id: receipt.job_id,
      revision: receipt.revision,
      destination: payload.destination,
      payload,
      evidence: payload.evidence,
      ...(receipt.proposal.kind === "change"
        ? { artifact_digest: receipt.proposal.artifact_digest }
        : receipt.proposal.kind === "feedback"
          ? {
              artifact_digest: new PrMonitorRepository(
                this.store,
              ).implementation(
                new PrMonitorRepository(this.store).get(receipt.job_id)!,
              ).artifact_digest!,
            }
          : {}),
    };
  }
  private approval(receipt: PublicationReceipt) {
    if (!receipt.review_id) throw new RuntimeError("output_review_missing");
    const request = this.reviewRequest(receipt);
    if (
      receipt.proposal.kind !== "notice" &&
      receipt.proposal.kind !== "investigation_stage" &&
      receipt.proposal.kind !== "pr_stage"
    ) {
      this.outputReview.verify(receipt.review_id, request);
      return;
    }
    const proposal = receipt.proposal;
    const narrative =
      proposal.kind === "investigation_stage" || proposal.kind === "pr_stage"
        ? this.previousNarrative(proposal.previous_operation, receipt.job_id)
        : "";
    const expected = `${proposal.kind === "notice" ? notices[proposal.reason] : proposal.kind === "pr_stage" ? this.prStatus(receipt, narrative) : `${this.investigationStatus(proposal.stage, narrative)}${this.pullReference(receipt)}`}\n\n<!-- orm:${this.repository.instance()}:${receipt.job_id}:${receipt.id} -->`;
    const review = this.repository.reviewed(receipt.review_id);
    if (
      (receipt.payload as FrozenPayload).comment !== expected ||
      !review.approved ||
      review.run_id !== null ||
      review.policy_identity !== policyIdentity ||
      review.binding !== this.outputReview.binding(request)
    )
      throw new RuntimeError("output_review_mismatch");
  }

  private pullReference(receipt: PublicationReceipt) {
    const pull = receipt.target.pull;
    return pull
      ? `\n\nPull request: https://github.com/${this.supervisor.repositoryName()}/pull/${pull.number}`
      : "";
  }

  private prStatus(receipt: PublicationReceipt, narrative: string) {
    const proposal = receipt.proposal;
    if (proposal.kind !== "pr_stage")
      throw new RuntimeError("publication_invalid");
    const text =
      proposal.stage === "ready"
        ? "Automation clean; awaiting human review. Human merge remains required."
        : proposal.stage === "blocked"
          ? "PR maintenance is blocked and needs operator attention. No readiness is claimed."
          : "The pull request is awaiting current-head CI and automated review. No readiness is claimed.";
    return `${text}\n\nRecorded instance head: ${proposal.expected_head}${narrative ? `\n\nPrevious reviewed findings:\n\n${narrative}` : ""}${this.pullReference(receipt)}`;
  }

  private investigationStatus(
    stage: keyof typeof stageText | "completed",
    narrative: string,
  ) {
    if (stage === "completed") {
      if (!narrative)
        throw new RuntimeError("investigation_summary_unreviewed");
      return narrative;
    }
    return `${stageText[stage]}${narrative ? `\n\nPrevious reviewed findings:\n\n${narrative}` : ""}`;
  }

  private previousNarrative(id: string | null, jobId: number) {
    if (id === null)
      return this.store.durability?.recoveryContext()?.findings ?? "";
    const operation = this.repository.operation(id);
    if (
      !operation ||
      operation.job_id !== jobId ||
      operation.status !== "confirmed" ||
      operation.proposal.kind !== "investigation" ||
      !operation.review_id
    )
      throw new RuntimeError("investigation_summary_unreviewed");
    const payload = operation.payload as FrozenPayload;
    const receipt = this.repository.reviewed(operation.review_id);
    const run = receipt.run_id ? this.store.run(receipt.run_id) : undefined;
    const expected = digest({
      job_id: jobId,
      revision: operation.revision,
      destination: payload.destination,
      payload,
      evidence: payload.evidence,
      artifact_digest: null,
      parent_run_id: null,
      snapshot_digest: this.store.jobById(jobId)!.snapshot_digest,
      policy_identity: policyIdentity,
    });
    if (
      !payload.narrative ||
      !receipt.approved ||
      receipt.binding !== expected ||
      receipt.policy_identity !== policyIdentity ||
      run?.role !== "output_review" ||
      run.job_id !== jobId ||
      run.revision !== operation.revision ||
      run.status !== "completed" ||
      run.finished_at === null
    )
      throw new RuntimeError("investigation_summary_unreviewed");
    return payload.narrative;
  }
  private async authority(receipt: PublicationReceipt, signal: AbortSignal) {
    signal.throwIfAborted();
    const job = this.repository.current(receipt.job_id, receipt.revision),
      repository = await this.writer.repository(signal),
      enrolled = this.store.repository();
    if (
      !enrolled ||
      repository.id !== enrolled.id ||
      repository.full_name !== this.supervisor.repositoryName() ||
      repository.default_branch !== receipt.source.default_branch
    )
      throw new RuntimeError("publication_repository_changed");
    const checkScope =
      receipt.proposal.kind === "question" ||
      (receipt.target.pull &&
        (receipt.proposal.kind === "change" ||
          receipt.proposal.kind === "feedback" ||
          (receipt.proposal.kind === "pr_stage" &&
            receipt.proposal.stage !== "blocked")));
    if (checkScope) this.store.assertPublishedScope(job.id);
    if (
      !(await this.writer.issueOpen(
        job.issue_number,
        signal,
        checkScope ? (JSON.parse(job.input_json) as IssueContext) : undefined,
      ))
    )
      throw new RuntimeError(
        checkScope ? "pr_scope_changed" : "publication_issue_closed",
      );
    const actor = await this.writer.actor(signal);
    if (receipt.actor && digest(receipt.actor) !== digest(actor))
      throw new RuntimeError("publication_actor_changed");
    receipt.actor = actor;
    if (
      receipt.proposal.kind === "question" &&
      !receipt.target.pull &&
      (await this.writer.branch(repository.default_branch, signal)).head !==
        receipt.source.sha
    )
      throw new RuntimeError("publication_source_changed");
    if (
      receipt.proposal.kind === "feedback" ||
      receipt.proposal.kind === "pr_stage"
    ) {
      const current = await this.writer.pull(
        receipt.target.pull!.number,
        signal,
      );
      const expected = receipt.proposal.expected_head;
      if (
        !this.matchesPull(
          receipt,
          current,
          receipt.proposal.kind === "pr_stage" &&
            receipt.proposal.stage === "blocked"
            ? current.head
            : expected,
        )
      )
        throw new RuntimeError("publication_pull_changed");
      if (
        receipt.proposal.kind === "pr_stage" &&
        receipt.proposal.stage === "ready"
      ) {
        if (!receipt.proposal.readiness_id || !this.readinessValidator)
          throw new RuntimeError("pr_readiness_missing");
        await this.readinessValidator(receipt.proposal.readiness_id, signal);
      }
    }
    if (receipt.proposal.kind === "change") {
      const branch = await this.writer.branch(receipt.target.branch, signal);
      if (
        receipt.target.branch === repository.default_branch ||
        branch.protected
      )
        throw new RuntimeError("publication_branch_protected");
      if (branch.head !== receipt.target.head)
        throw new RuntimeError("publication_head_changed");
      const base = await this.writer.branch(repository.default_branch, signal);
      if (base.head !== receipt.source.sha)
        throw new RuntimeError("publication_source_changed");
    }
  }
  private async before(
    receipt: PublicationReceipt,
    step: MutationStep,
    signal: AbortSignal,
  ) {
    const job = this.store.jobById(receipt.job_id)!;
    if (step.kind === "feedback_reply" || step.kind === "thread_resolution") {
      const feedback = (receipt.payload as FrozenPayload).feedback!;
      if (feedback.thread) {
        const thread = await this.writer.thread(feedback.thread, signal);
        if (
          thread.pull_id !== receipt.target.pull!.id ||
          thread.repository_id !== this.store.repository()!.id
        )
          throw new RuntimeError("publication_thread_changed");
        if (
          step.kind === "feedback_reply" &&
          digest(thread) !== digest(feedback.before)
        )
          throw new RuntimeError("publication_thread_changed");
        if (step.kind === "thread_resolution") {
          if (
            !thread.comments.some(
              (comment) =>
                comment.body === feedback.body &&
                comment.author_login === receipt.actor!.login,
            )
          )
            throw new RuntimeError("publication_feedback_unverified");
          const original = feedback.before!.comments;
          const foreign = thread.comments.filter(
            (comment) =>
              comment.body !== feedback.body ||
              comment.author_login !== receipt.actor!.login,
          );
          if (digest(foreign) !== digest(original))
            throw new RuntimeError("publication_thread_changed");
          if (thread.resolved) {
            step.state = "confirmed";
            this.repository.finishStep(receipt, step.kind);
          }
        }
      }
      return;
    }
    if (step.kind === "branch" && receipt.target.pull) {
      const current = await this.writer.pull(
        receipt.target.pull.number,
        signal,
      );
      if (
        !this.matchesPull(receipt, current, receipt.target.head) ||
        digest(this.ownedPull(current)) !== digest(receipt.target.pull)
      )
        throw new RuntimeError("publication_pull_changed");
    }
    if (step.kind === "question_comment") {
      const matches = (
        await this.writer.comments(job.issue_number, signal)
      ).filter((comment) =>
        comment.body.includes(
          `<!-- orm:${this.repository.instance()}:${job.id}:${receipt.id} -->`,
        ),
      );
      if (matches.length) {
        const match = matches[0];
        if (
          matches.length !== 1 ||
          match.author_id !== receipt.actor!.id ||
          match.body !== (receipt.payload as FrozenPayload).comment
        )
          throw new RuntimeError("publication_ownership_conflict");
        step.object_id = match.id;
        step.state = "confirmed";
        this.repository.finishStep(receipt, step.kind);
      }
    } else if (step.kind === "comment") {
      const comments = await this.writer.comments(job.issue_number, signal);
      if (receipt.target.comment) {
        const current = comments.find(
          (comment) => comment.id === receipt.target.comment!.id,
        );
        if (!current || digest(current) !== digest(receipt.target.comment))
          throw new RuntimeError("publication_comment_changed");
      } else if (
        comments.some((comment) =>
          comment.body.includes(
            `<!-- orm:${this.repository.instance()}:${job.id}:`,
          ),
        )
      )
        throw new RuntimeError("publication_ownership_conflict");
    } else if (step.kind === "pull") {
      const pulls = await this.writer.pulls(receipt.target.branch, signal);
      if (receipt.target.pull) {
        const current = await this.writer.pull(
          receipt.target.pull.number,
          signal,
        );
        if (
          !this.matchesPull(receipt, current) ||
          digest(this.ownedPull(current)) !== digest(receipt.target.pull) ||
          pulls.some((pull) => pull.id !== current.id && pull.state === "open")
        )
          throw new RuntimeError("publication_pull_changed");
      } else if (pulls.length)
        throw new RuntimeError("publication_ownership_conflict");
    }
  }
  private matchesPull(
    receipt: PublicationReceipt,
    pull: RemotePull,
    expectedHead = receipt.commit,
  ) {
    return (
      pull.state === "open" &&
      !pull.draft &&
      pull.author_id === receipt.actor!.id &&
      pull.head === expectedHead &&
      pull.branch === receipt.target.branch &&
      pull.base === receipt.source.default_branch &&
      pull.repository_id === this.store.repository()!.id &&
      pull.base_repository_id === this.store.repository()!.id
    );
  }
  private ownedPull(pull: OwnedPull): OwnedPull {
    return {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      head: pull.head,
      base: pull.base,
      author_id: pull.author_id,
    };
  }
  private failure(error: unknown) {
    return error instanceof RuntimeError || error instanceof IntakeError
      ? error.code
      : "publication_invalid";
  }

  private failed(receipt: PublicationReceipt, error: unknown) {
    receipt.failure = this.failure(error);
    if (error instanceof IntakeError) {
      this.repository.deferProvider(error.retryAt);
      receipt.retry_at = Math.max(receipt.retry_at, error.retryAt);
      receipt.retry_pending = true;
    } else if (
      error instanceof RuntimeError &&
      error.code === "publication_git_failed"
    )
      receipt.retry_pending = true;
  }
}
