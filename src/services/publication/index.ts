import { randomUUID } from "node:crypto";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createGitHubWriter,
  type GitHubWriter,
  type RemotePull,
} from "../../adapters/github/writer.ts";
import { PublicationGit } from "../../adapters/github/git.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import { digest, RuntimeError, workerLimits } from "../../domain/agents.ts";
import { IntakeError } from "../../domain/jobs.ts";
import type { Store } from "../../repositories/store.ts";
import { PublicationRepository } from "../../repositories/publication.ts";
import type { BootstrapLease, Supervisor } from "../../runtime/supervisor.ts";
import { rootDirectory } from "../workspaces/files.ts";
import { ExternalOutputReview } from "./review.ts";
import { policyIdentity } from "./scanner.ts";
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
  evidence: PublicationEvidence[];
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

  async publish(
    input: PublicationProposal,
    signal: AbortSignal,
  ): Promise<PublicationReceipt> {
    const proposal = proposalSchema.parse(structuredClone(input));
    return this.exclusive(proposal.job_id, () =>
      this.publishCurrent(proposal, signal),
    );
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
  ): Promise<PublicationReceipt> {
    if (this.secrets.containsCredentials(proposal))
      throw new RuntimeError("publication_secret");
    const id = digest({ instance: this.repository.instance(), proposal });
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
          if (proposal.kind === "notice") {
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
        }
        for (let index = 0; index < receipt.steps.length; index++) {
          const step = receipt.steps[index];
          if (step.state === "confirmed") continue;
          await this.authority(receipt, publicationSignal);
          this.approval(receipt);
          await this.before(receipt, step, publicationSignal);
          publicationSignal.throwIfAborted();
          this.repository.current(job.id, job.revision);
          this.repository.providerReady();
          step.state = "dispatching";
          receipt.status = "dispatching";
          this.repository.save(receipt);
          try {
            if (step.kind === "comment")
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
    return proposal.kind === "notice"
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
        if (step.kind === "comment") {
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
        if (matched) this.repository.finishStep(receipt, step.kind);
        else {
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
    if (proposal.kind !== "change")
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
      payload.evidence = proposal.evidence_ids.map((id) =>
        this.repository.evidence(id),
      );
      if (
        !["audit", "test"].every((kind) =>
          payload.evidence.some((item) => item.kind === kind),
        ) ||
        payload.evidence.some(
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
    if (receipt.payload !== null && digest(receipt.payload) !== digest(payload))
      throw new RuntimeError("publication_payload_changed");
    receipt.payload = payload;
    if (!receipt.steps.length)
      receipt.steps =
        proposal.kind === "change"
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
                kind: "comment",
                before: receipt.target.comment,
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
        : {}),
    };
  }
  private approval(receipt: PublicationReceipt) {
    if (!receipt.review_id) throw new RuntimeError("output_review_missing");
    const request = this.reviewRequest(receipt);
    if (receipt.proposal.kind !== "notice") {
      this.outputReview.verify(receipt.review_id, request);
      return;
    }
    const expected = `${notices[receipt.proposal.reason]}\n\n<!-- orm:${this.repository.instance()}:${receipt.job_id}:${receipt.id} -->`;
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
    if (!(await this.writer.issueOpen(job.issue_number, signal)))
      throw new RuntimeError("publication_issue_closed");
    const actor = await this.writer.actor(signal);
    if (receipt.actor && digest(receipt.actor) !== digest(actor))
      throw new RuntimeError("publication_actor_changed");
    receipt.actor = actor;
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
    if (step.kind === "comment") {
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
