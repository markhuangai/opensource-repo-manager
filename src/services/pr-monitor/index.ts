import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { currentContinuation } from "../clarification.ts";
import type { GitHubReader } from "../../adapters/github/reader.ts";
import type { RunSnapshot } from "../../config/load.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import { digest, RuntimeError } from "../../domain/agents.ts";
import { budgetUsage, IntakeError, type Job } from "../../domain/jobs.ts";
import type { SafeLogger } from "../../logging/redact.ts";
import type { Store } from "../../repositories/store.ts";
import { PrMonitorRepository } from "../../repositories/pr-monitor.ts";
import { InvestigationRepository } from "../../repositories/investigation.ts";
import type { Supervisor } from "../../runtime/supervisor.ts";
import type { ImplementationService } from "../implementation/index.ts";
import type { IntakeService } from "../intake.ts";
import { publicationText } from "../publication/scanner.ts";
import type { PublicationProposal } from "../publication/contracts.ts";
import type {
  FindingDisposition,
  PrMonitor,
  PrSnapshot,
  ReviewSurface,
} from "./contracts.ts";
import { readinessReadFailures } from "./contracts.ts";
import {
  evaluateReadiness,
  findingIdentity,
  observationDigest,
  requiredChecks,
  reviewSurfaces,
} from "./policy.ts";

const transient = new Set([
  "github_read_failed",
  "github_graphql_failed",
  "github_rate_limited",
  "pull_changed_during_read",
  "publication_busy",
  "publication_pending",
  "publication_backoff",
  "github_publication_failed",
]);
const policyFailures = new Set([
  "pr_requirements_unknown",
  "pr_checks_unconfigured",
  "pr_monitor_disabled",
]);

export class PrMonitorService {
  readonly repository: PrMonitorRepository;
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private requested = false;
  private failure: string | null = null;
  private active = false;
  private readonly busy = new Set<number>();
  private coordinatorWake: () => void = () => {};
  private readonly store: Store;
  private readonly intake: IntakeService;
  private readonly reader: GitHubReader;
  private readonly implementation: ImplementationService;
  private readonly supervisor: Supervisor;
  private readonly snapshot: RunSnapshot;
  private readonly secrets: SecretAccessor;
  private readonly logger: SafeLogger;

  constructor(
    store: Store,
    intake: IntakeService,
    reader: GitHubReader,
    implementation: ImplementationService,
    supervisor: Supervisor,
    snapshot: RunSnapshot,
    secrets: SecretAccessor,
    logger: SafeLogger,
  ) {
    this.store = store;
    this.intake = intake;
    this.reader = reader;
    this.implementation = implementation;
    this.supervisor = supervisor;
    this.snapshot = snapshot;
    this.secrets = secrets;
    this.logger = logger;
    this.repository = new PrMonitorRepository(store);
    implementation.monitor = this;
    supervisor.publication.setReadinessValidator((id, signal) =>
      this.validateReadiness(id, signal),
    );
    supervisor.notifications.setReadinessValidator((id, signal) =>
      this.validateReadiness(id, signal),
    );
  }

  setCoordinatorWake(wake: () => void) {
    this.coordinatorWake = wake;
  }

  enabled() {
    return this.snapshot.settings.pr_monitor.enabled;
  }

  status() {
    const records = this.repository.all();
    return {
      state: !this.enabled()
        ? "disabled"
        : this.failure
          ? "degraded"
          : this.started
            ? "running"
            : "stopped",
      reason: this.failure,
      waiting: records.filter((item) =>
        ["waiting", "queued"].includes(item.stage),
      ).length,
      active: this.active ? 1 : 0,
      repairing: records.filter((item) => item.stage === "repairing").length,
      automation_clean: records.filter((item) => item.stage === "ready").length,
      blocked: records.filter((item) => item.stage === "blocked").length,
      closed: records.filter((item) => item.stage === "closed").length,
    };
  }

  start() {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    this.wake();
  }

  wake() {
    if (!this.started || this.controller.signal.aborted) return;
    this.requested = true;
    if (this.running) return;
    clearTimeout(this.timer);
    this.requested = false;
    this.running = this.cycle(this.controller.signal)
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted) {
          this.failure = this.code(error);
          this.logger.error(`PR monitoring unavailable (${this.failure}).`);
        }
      })
      .finally(() => {
        this.running = undefined;
        if (!this.started || this.controller.signal.aborted) return;
        const retries = this.repository
          .all()
          .map((item) => item.retry_at)
          .filter((time) => time > Date.now());
        const delay = this.requested
          ? 1
          : Math.min(
              this.snapshot.settings.limits.reconciliation_minutes * 60_000,
              retries.length
                ? Math.max(1, Math.min(...retries) - Date.now())
                : Infinity,
            );
        this.timer = setTimeout(
          () => this.wake(),
          Math.min(2_147_483_647, delay),
        );
      });
  }

  async stop() {
    this.started = false;
    this.controller.abort(new RuntimeError("pr_monitor_stopped"));
    clearTimeout(this.timer);
    await this.running;
  }

  async reconcile(signal = this.controller.signal) {
    if (this.running) return this.running;
    this.running = this.cycle(signal);
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async cycle(signal: AbortSignal) {
    if (!this.intake.enrolled() || signal.aborted || !this.enabled()) return;
    const policyDigest = digest(this.snapshot.settings.pr_monitor);
    let handoffFailure: string | null = null;
    for (const implementation of this.implementation.repository.all()) {
      if (implementation.stage !== "remote_review") continue;
      try {
        this.repository.ensure(implementation, policyDigest);
      } catch (error) {
        handoffFailure = this.code(error);
        const job = this.store.jobById(implementation.job_id);
        if (
          job?.status === "pending" &&
          job.revision === implementation.revision
        ) {
          const pull = this.store
            .ownedPulls()
            .find((item) => item.job_id === job.id);
          const id = `pr-handoff-${implementation.id}`;
          if (!this.supervisor.notifications.repository.event(id)) {
            try {
              const event = this.supervisor.notifications.prepare({
                id,
                job_id: job.id,
                revision: job.revision,
                repository_id: this.store.repository()!.id,
                issue_number: job.issue_number,
                ...(pull?.number ? { pull_number: pull.number } : {}),
                occurred_at: implementation.started_at,
                outcome: "needs_attention",
                reason: "workflow_blocked",
              });
              await this.supervisor.notifications.enqueue(event, {}, signal);
            } catch (notificationError) {
              this.logger.error(
                `PR handoff notification unavailable (${this.code(notificationError)}).`,
              );
            }
          }
        }
      }
    }
    for (const item of this.repository.all()) {
      if (signal.aborted) return;
      if (this.busy.has(item.job_id)) continue;
      this.busy.add(item.job_id);
      const record = this.repository.get(item.job_id)!;
      try {
        if (this.repository.implementation(record).recovering) continue;
        const question = currentContinuation(
          this.store,
          record.job_id,
        )?.question;
        if (question && !this.store.durability?.replies(question.id).length)
          continue;
        if (record.stage === "closed" || Date.now() < record.retry_at) continue;
        if (record.stage === "assessing" && !this.active) {
          record.stage = "queued";
          this.repository.save(record);
        }
        await this.observe(record, policyDigest, signal);
      } catch (error) {
        if (signal.aborted) return;
        await this.failed(record, error, signal);
      } finally {
        this.busy.delete(item.job_id);
        if (record.stage === "queued") this.coordinatorWake();
      }
    }
    if (handoffFailure) this.failure = handoffFailure;
  }

  private assertWaitBudget(record: PrMonitor) {
    this.repository.accountWait(record);
    const job = this.store.jobById(record.job_id)!;
    if (
      budgetUsage.parse(JSON.parse(job.budget_json)).wait_ms >=
      this.store.snapshot(job.snapshot_digest).settings.limits.wait_hours *
        3_600_000
    )
      throw new RuntimeError("pr_wait_budget_exhausted");
  }

  private invalidate(record: PrMonitor) {
    if (record.readiness_id) record.policy_generation++;
    record.readiness_id = null;
    record.notification_id = null;
    if (record.stage === "ready") record.stage = "waiting";
    if (
      record.wait_accounted_at === null &&
      !["repairing", "assessing", "blocked", "closed"].includes(record.stage)
    )
      record.wait_accounted_at = Date.now();
  }

  private async observe(
    record: PrMonitor,
    policyDigest: string,
    signal: AbortSignal,
  ) {
    const job = this.store.jobById(record.job_id);
    if (!job || job.status === "closed") {
      this.repository.accountWait(record);
      record.stage = "closed";
      record.wait_accounted_at = null;
      record.readiness_id = null;
      this.repository.save(record);
      return;
    }
    if (record.policy_digest !== policyDigest) {
      this.invalidate(record);
      record.policy_digest = policyDigest;
      record.policy_generation++;
      if (record.failure && policyFailures.has(record.failure)) {
        record.stage = "waiting";
        record.failure = null;
        record.wait_accounted_at = Date.now();
      }
    }
    if (record.failure && policyFailures.has(record.failure)) {
      record.stage = "waiting";
      record.failure = null;
      record.wait_accounted_at = Date.now();
    }
    const pendingPublication = this.supervisor.publication.repository.pending(
      record.job_id,
    );
    if (
      pendingPublication?.steps.some((step) =>
        ["dispatching", "uncertain"].includes(step.state),
      )
    ) {
      const receipt = await this.supervisor.publication.reconcile(
        pendingPublication.id,
        signal,
      );
      if (receipt.status !== "confirmed" && receipt.status !== "reviewed")
        throw new RuntimeError(receipt.failure ?? "publication_pending");
      if (
        record.stage === "blocked" &&
        ["publication_effect_uncertain", "publication_pending"].includes(
          record.failure ?? "",
        )
      ) {
        record.stage = "queued";
        record.failure = null;
      }
    }
    if (this.store.hasUncertainMcpWrite(job.id)) {
      await this.recoverWrites(record, signal);
      if (this.store.hasUncertainMcpWrite(job.id))
        throw new RuntimeError("mcp_write_uncertain");
    }
    this.repository.current(record);
    const implementation = this.repository.implementation(record);
    if (
      implementation.publication_id &&
      implementation.publication_id !== record.publication_id
    ) {
      const operation = this.supervisor.publication.repository.operation(
        implementation.publication_id,
      );
      if (operation?.status === "confirmed") {
        if (
          operation.proposal.kind !== "change" ||
          operation.proposal.expected_head !== record.expected_head ||
          !operation.commit
        )
          throw new RuntimeError("pr_publication_changed");
        this.invalidate(record);
        record.expected_head = operation.commit;
        record.publication_id = operation.id;
        record.head_published_at =
          this.supervisor.publication.repository.publishedAt(operation);
        const evidence = this.localEvidence(record);
        for (const finding of record.findings) {
          if (finding.disposition === "fix" && finding.fixed_head === null) {
            finding.fixed_head = operation.commit;
            finding.evidence.push(...evidence);
          }
        }
        record.stage = "waiting";
        record.failure = null;
        record.wait_accounted_at = Date.now();
      }
    }
    if (
      record.stage === "repairing" &&
      implementation.stage === "blocked" &&
      !implementation.retry_stage
    )
      throw new RuntimeError(implementation.failure ?? "pr_repair_failed");
    if (record.stage === "blocked") {
      await this.report(record, "blocked", signal);
      await this.notify(record, false, signal);
      return;
    }
    this.assertWaitBudget(record);
    const current = await this.read(record, signal);
    if (current.state === "closed" || current.merged) {
      record.stage = "closed";
      record.readiness_id = null;
      record.wait_accounted_at = null;
      this.repository.save(record);
      return;
    }
    this.assertWaitBudget(record);
    this.assertOwned(record, current);
    const fingerprint = observationDigest(current);
    const previous =
      record.snapshot_digest &&
      this.repository.read<{ snapshot: PrSnapshot }>(record.snapshot_digest)
        .snapshot;
    if (previous && observationDigest(previous) !== fingerprint)
      this.invalidate(record);
    record.observed_head = current.head_sha;
    record.snapshot_digest = this.repository.evidence({
      job_id: job.id,
      snapshot: current,
    });
    record.generation++;
    record.retry_at = 0;
    this.failure = null;
    if (record.stage === "repairing" || record.stage === "assessing") {
      this.repository.save(record);
      return;
    }
    const decision = evaluateReadiness(
      current,
      this.snapshot.settings.pr_monitor,
      record.head_published_at,
    );
    if (decision.reason && policyFailures.has(decision.reason))
      throw new RuntimeError(decision.reason);
    const surfaces = this.surfaces(current);
    if (
      this.unassessed(record, surfaces).length ||
      record.pending_agent ||
      this.hasActions(record) ||
      record.findings.some(
        (item) => item.disposition === "fix" && !item.fixed_head,
      )
    ) {
      record.stage = "queued";
      this.repository.save(record);
      this.coordinatorWake();
      return;
    }
    if (
      record.findings.some(
        (item) =>
          this.findingCurrent(record, item) && item.disposition === "blocked",
      )
    )
      throw new RuntimeError("pr_feedback_unresolved");
    if (!decision.clean) {
      if (
        decision.reason === "pr_checks_failed" ||
        decision.reason === "pr_reviewer_unavailable"
      )
        throw new RuntimeError(decision.reason);
      record.stage = "waiting";
      this.repository.save(record);
      await this.report(record, "waiting", signal);
      return;
    }
    this.localEvidence(record);
    const readiness = {
      job_id: job.id,
      revision: record.revision,
      monitor_id: record.id,
      head_sha: record.expected_head,
      policy_digest: record.policy_digest,
      observation_digest: fingerprint,
      snapshot: current,
      checks: decision.checks,
      reviewers: decision.reviewers,
      findings_digest: digest(record.findings),
    };
    record.readiness_id = this.repository.evidence(readiness);
    this.repository.accountWait(record);
    record.wait_accounted_at = null;
    record.failure = null;
    if (this.hasMcp(record) && record.mcp_done_for !== record.readiness_id) {
      record.stage = "queued";
      this.repository.save(record);
      this.coordinatorWake();
      return;
    }
    record.stage = "ready";
    this.repository.save(record);
    await this.validateReadiness(record.readiness_id, signal);
    await this.report(record, "ready", signal);
    await this.notify(record, true, signal);
  }

  private surfaces(snapshot: PrSnapshot) {
    const required = new Set(
      requiredChecks(snapshot, this.snapshot.settings.pr_monitor).map(
        (item) => item.name,
      ),
    );
    return reviewSurfaces(snapshot, (kind, id) =>
      this.store.owns(kind, id),
    ).filter(
      (surface) =>
        surface.kind !== "check" ||
        snapshot.checks.some(
          (item) =>
            `check:${item.id}` === surface.id && required.has(item.name),
        ),
    );
  }

  private findingCurrent(record: PrMonitor, finding: FindingDisposition) {
    return (
      finding.assessed_head === record.expected_head ||
      finding.fixed_head === record.expected_head
    );
  }

  private unassessed(record: PrMonitor, surfaces: ReviewSurface[]) {
    return surfaces.filter(
      (surface) =>
        !record.findings.some(
          (item) =>
            item.surface.id === surface.id &&
            item.surface.digest === surface.digest &&
            this.findingCurrent(record, item),
        ),
    );
  }

  private hasActions(record: PrMonitor) {
    return record.findings.some(
      (finding) =>
        this.findingCurrent(record, finding) &&
        !finding.publication_id &&
        finding.disposition !== "informational" &&
        finding.disposition !== "blocked" &&
        (finding.disposition !== "fix" ||
          finding.fixed_head === record.expected_head),
    );
  }

  async advance(job: Job, signal: AbortSignal) {
    const question = currentContinuation(this.store, job.id)?.question;
    if (question && !this.store.durability?.replies(question.id).length) return;
    if (this.busy.has(job.id)) return;
    const record = this.repository.get(job.id);
    if (
      !record ||
      record.stage !== "queued" ||
      !this.enabled() ||
      signal.aborted ||
      this.active
    )
      return;
    this.busy.add(job.id);
    this.active = true;
    try {
      this.assertWaitBudget(record);
      this.repository.current(record);
      await this.resumePending(record, signal);
      let snapshot = await this.read(record, signal);
      this.assertWaitBudget(record);
      record.wait_accounted_at = null;
      this.repository.save(record);
      this.assertOwned(record, snapshot);
      const surfaces = this.surfaces(snapshot);
      const missing = this.unassessed(record, surfaces);
      if (missing.length) {
        record.stage = "assessing";
        record.pending_agent = {
          task: "assessment",
          prior_runs: this.store.runs().map((run) => run.id),
        };
        this.repository.save(record);
        const assessment = await this.implementation.assessFeedback(
          this.repository.implementation(record),
          {
            expected_head: record.expected_head,
            surfaces: missing,
            previous_findings: structuredClone(record.findings),
            local_receipts: this.localEvidence(record),
          },
          signal,
        );
        if (!assessment) {
          record.pending_agent = null;
          record.stage = "queued";
          record.wait_accounted_at = null;
          this.repository.save(record);
          return;
        }
        const refreshed = await this.read(record, signal);
        this.assertOwned(record, refreshed);
        if (digest(this.surfaces(refreshed)) !== digest(surfaces)) {
          record.pending_agent = null;
          record.stage = "waiting";
          record.wait_accounted_at = Date.now();
          this.repository.save(record);
          this.wake();
          return;
        }
        if (
          assessment.result.dispositions.length !== missing.length ||
          new Set(assessment.result.dispositions.map((item) => item.surface_id))
            .size !== missing.length
        )
          throw new RuntimeError("pr_assessment_incomplete");
        for (const disposition of assessment.result.dispositions) {
          const surface = missing.find(
            (item) => item.id === disposition.surface_id,
          );
          if (!surface) throw new RuntimeError("pr_assessment_incomplete");
          if (
            ["fix", "fixed", "non_actionable"].includes(
              disposition.disposition,
            ) &&
            !disposition.citations.length
          )
            throw new RuntimeError("pr_assessment_evidence_missing");
          const evidence = await this.citations(record, disposition.citations);
          const previous = record.findings.findLast(
            (item) =>
              item.surface.id === surface.id &&
              item.surface.digest === surface.digest &&
              item.disposition === disposition.disposition &&
              item.explanation === disposition.explanation &&
              item.publication_id,
          );
          record.findings.push({
            ...disposition,
            surface,
            run_id: assessment.run_id,
            assessed_head: record.expected_head,
            fixed_head:
              disposition.disposition === "fixed" ? record.expected_head : null,
            publication_id: previous?.publication_id ?? null,
            evidence: [...evidence, ...this.localEvidence(record)],
          });
        }
        record.pending_agent = null;
        record.assessment_digest = digest(surfaces);
        snapshot = refreshed;
      }
      record.stage = "queued";
      record.snapshot_digest = this.repository.evidence({
        job_id: job.id,
        snapshot,
      });
      record.observed_head = snapshot.head_sha;
      this.repository.save(record);
      await this.publishDispositions(record, signal);
      if (
        record.findings.some(
          (item) =>
            this.findingCurrent(record, item) && item.disposition === "blocked",
        )
      )
        throw new RuntimeError("pr_feedback_unresolved");
      const fixes = record.findings.filter(
        (item) =>
          item.assessed_head === record.expected_head &&
          item.disposition === "fix" &&
          !item.fixed_head,
      );
      if (fixes.length) {
        const pending = this.supervisor.publication.repository.pending(job.id);
        if (pending) throw new RuntimeError("publication_pending");
        this.implementation.repository.repairPublished(
          this.repository.implementation(record),
          fixes.map((item) =>
            JSON.stringify({
              surface: item.surface,
              explanation: item.explanation,
              evidence: item.evidence,
            }),
          ),
        );
        this.invalidate(record);
        record.stage = "repairing";
        record.wait_accounted_at = null;
        this.repository.save(record);
        this.coordinatorWake();
        return;
      }
      if (
        record.readiness_id &&
        this.hasMcp(record) &&
        record.mcp_done_for !== record.readiness_id
      ) {
        const readiness = this.repository.readiness(record.readiness_id);
        if (observationDigest(snapshot) !== readiness.observation_digest) {
          this.invalidate(record);
        } else {
          record.pending_agent = {
            task: "readiness",
            prior_runs: this.store.runs().map((run) => run.id),
          };
          this.repository.save(record);
          await this.implementation.recordReadiness(
            this.repository.implementation(record),
            record.readiness_id,
            {
              receipt: readiness,
              evidence: [
                { kind: "pr_monitor_evidence", id: record.readiness_id },
              ],
            },
            signal,
          );
          record.mcp_done_for = record.readiness_id;
          record.pending_agent = null;
        }
      }
      record.stage = "waiting";
      record.wait_accounted_at = Date.now();
      this.repository.save(record);
      this.wake();
    } catch (error) {
      if (!signal.aborted) await this.failed(record, error, signal);
    } finally {
      this.active = false;
      this.busy.delete(job.id);
      this.wake();
    }
  }

  private async publishDispositions(record: PrMonitor, signal: AbortSignal) {
    for (const finding of record.findings) {
      if (
        !this.findingCurrent(record, finding) ||
        finding.publication_id ||
        ["blocked", "informational"].includes(finding.disposition) ||
        (finding.disposition === "fix" && !finding.fixed_head)
      )
        continue;
      const proposal: PublicationProposal = {
        kind: "feedback",
        job_id: record.job_id,
        revision: record.revision,
        expected_head: record.expected_head,
        finding_id: findingIdentity(finding),
      };
      const id = this.supervisor.publication.operationId(proposal);
      const pending = this.supervisor.publication.repository.pending(
        record.job_id,
      );
      if (pending && pending.id !== id) {
        const result = await this.supervisor.publication.publish(
          pending.proposal,
          signal,
        );
        if (result.status !== "confirmed")
          throw new RuntimeError(result.failure ?? "publication_pending");
      }
      const receipt = await this.supervisor.publication.publish(
        proposal,
        signal,
      );
      if (receipt.status !== "confirmed")
        throw new RuntimeError(receipt.failure ?? "publication_pending");
      finding.publication_id = id;
      this.repository.save(record);
    }
  }

  private localEvidence(record: PrMonitor) {
    const implementation = this.repository.implementation(record),
      publication = this.supervisor.publication.repository.operation(
        record.publication_id,
      ),
      origin = this.implementation.repository.published(implementation);
    const audit = implementation.audits.find(
        (item) => item.id === implementation.audit_id,
      ),
      test = implementation.tests.find(
        (item) => item.id === implementation.test_id,
      );
    if (
      !audit?.evidence_id ||
      !test?.evidence_id ||
      !implementation.artifact_digest ||
      test.state !== "passed" ||
      !audit.result.approved ||
      audit.result.findings.length ||
      test.artifact_digest !== implementation.artifact_digest ||
      test.scope_digest !== implementation.scope_digest ||
      test.audit_id !== audit.id ||
      this.store.run(test.run_id)?.status !== "completed" ||
      origin?.id !== record.publication_id ||
      origin.head !== record.expected_head ||
      implementation.recovering ||
      (publication &&
        (publication.status !== "confirmed" ||
          publication.proposal.kind !== "change" ||
          publication.proposal.artifact_digest !==
            implementation.artifact_digest))
    )
      throw new RuntimeError("pr_local_evidence_missing");
    return [audit.evidence_id, test.evidence_id].map((id) => ({
      id,
      receipt: this.supervisor.publication.repository.evidence(id),
    }));
  }

  private async citations(
    record: PrMonitor,
    citations: { path: string; start_line: number; end_line: number }[],
  ) {
    const implementation = this.repository.implementation(record);
    const manifest = this.store.artifact(
      implementation.artifact_digest!,
      record.job_id,
      record.revision,
    );
    const evidence: unknown[] = [];
    for (const citation of citations) {
      const file = manifest.files.find((item) => item.path === citation.path);
      if (
        !file ||
        file.kind !== "file" ||
        citation.end_line < citation.start_line ||
        citation.end_line - citation.start_line > 200
      )
        throw new RuntimeError("pr_assessment_evidence_invalid");
      const bytes = await readFile(
        join(this.supervisor.workspaces.privateRoot, "blobs", file.digest),
      );
      const lines = publicationText(bytes, file.path).split("\n");
      if (citation.end_line > lines.length)
        throw new RuntimeError("pr_assessment_evidence_invalid");
      evidence.push({
        ...citation,
        artifact_digest: implementation.artifact_digest,
        text: lines
          .slice(citation.start_line - 1, citation.end_line)
          .join("\n"),
      });
    }
    return evidence;
  }

  private async read(record: PrMonitor, signal: AbortSignal) {
    const snapshot = await this.reader.monitor(record.pull_number, signal);
    if (this.secrets.containsCredentials(snapshot))
      throw new RuntimeError("secret_in_input");
    await this.supervisor.publication.outputReview.scanner.scan(
      snapshot,
      signal,
    );
    return snapshot;
  }

  private assertOwned(record: PrMonitor, snapshot: PrSnapshot) {
    const origin = this.implementation.repository.published(
      this.repository.implementation(record),
    );
    const target = this.supervisor.publication.repository.target(record.job_id);
    if (
      !origin ||
      !target.pull ||
      target.pull.id !== snapshot.id ||
      record.pull_number !== snapshot.number ||
      origin.actor.id !== snapshot.author_id ||
      snapshot.repository_id !== this.store.repository()?.id ||
      snapshot.base_repository_id !== snapshot.repository_id ||
      snapshot.branch !== target.branch ||
      snapshot.base !==
        this.repository.implementation(record).source.default_branch
    )
      throw new RuntimeError("pr_ownership_changed");
    if (
      snapshot.head_sha !== record.expected_head ||
      target.head !== record.expected_head
    )
      throw new RuntimeError("pr_head_changed");
    if (snapshot.draft) throw new RuntimeError("pr_draft_changed");
  }

  async validateReadiness(id: string, signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.controller.signal]);
    const evidence =
      this.repository.read<import("./contracts.ts").PrReadiness>(id);
    try {
      this.repository.readiness(id);
      const job = this.store.jobById(evidence.job_id);
      if (!job) throw new RuntimeError("revision_stale");
      await this.intake.refresh(job.issue_number, signal, false);
      const readiness = this.repository.readiness(id),
        record = this.repository.get(readiness.job_id)!;
      if (
        readiness.policy_digest !== digest(this.snapshot.settings.pr_monitor) ||
        (this.hasMcp(record) && record.mcp_done_for !== id)
      )
        throw new RuntimeError("pr_readiness_stale");
      const snapshot = await this.read(record, signal);
      this.repository.readiness(id);
      const current = this.repository.get(readiness.job_id)!;
      this.assertOwned(current, snapshot);
      const decision = evaluateReadiness(
        snapshot,
        this.snapshot.settings.pr_monitor,
        current.head_published_at,
      );
      if (
        !decision.clean ||
        observationDigest(snapshot) !== readiness.observation_digest ||
        digest(current.findings) !== readiness.findings_digest
      )
        throw new RuntimeError("pr_readiness_stale");
    } catch (error) {
      if (signal.aborted) throw error;
      if (!this.busy.has(evidence.job_id)) {
        const current = this.repository.get(evidence.job_id);
        if (current?.readiness_id === id) {
          if (!this.suspendReadiness(current, error)) this.invalidate(current);
          this.repository.save(current);
        }
      }
      this.wake();
      throw error;
    }
  }

  private hasMcp(record: PrMonitor) {
    const job = this.store.jobById(record.job_id)!;
    return Object.values(
      this.store.snapshot(job.snapshot_digest).roles.implementation.mcp,
    ).some((grant) => Object.keys(grant.tools).length > 0);
  }

  private async resumePending(record: PrMonitor, signal: AbortSignal) {
    const pending = record.pending_agent;
    if (!pending) return;
    if (this.store.hasUncertainMcpWrite(record.job_id)) {
      await this.recoverWrites(record, signal);
      if (this.store.hasUncertainMcpWrite(record.job_id))
        throw new RuntimeError("mcp_write_uncertain");
    }
    const writes = this.supervisor.mcpWrites.repository
      .all()
      .filter(
        (item) =>
          item.job_id === record.job_id &&
          !pending.prior_runs.includes(item.binding.run_id) &&
          item.state !== "rejected",
      );
    if (writes.length && pending.task !== "readiness")
      throw new RuntimeError("pr_interrupted_after_write");
    if (writes.length && pending.task === "readiness")
      record.mcp_done_for = record.readiness_id;
    if (!writes.length && !this.store.reserveInfrastructureRetry(record.job_id))
      throw new RuntimeError("infrastructure_budget_exhausted");
    record.pending_agent = null;
    const implementation = this.repository.implementation(record);
    implementation.agent_pending = null;
    this.implementation.repository.save(implementation);
    this.repository.save(record);
  }

  private async recoverWrites(record: PrMonitor, signal: AbortSignal) {
    for (const operation of this.supervisor.mcpWrites.repository
      .all(["uncertain"])
      .filter((item) => item.job_id === record.job_id)) {
      if (record.recovery_attempts.includes(operation.id)) continue;
      record.recovery_attempts.push(operation.id);
      this.repository.save(record);
      try {
        await this.supervisor.mcpWrites.recover(operation.id, signal);
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    if (
      !this.store.hasUncertainMcpWrite(record.job_id) &&
      record.failure === "mcp_write_uncertain"
    ) {
      record.stage = "queued";
      record.failure = null;
      this.repository.save(record);
    }
  }

  private async report(
    record: PrMonitor,
    stage: "waiting" | "blocked" | "ready",
    signal: AbortSignal,
  ) {
    const implementation = this.repository.implementation(record),
      investigation = new InvestigationRepository(this.store).get(
        implementation.investigation_id,
      );
    const key = digest({
      stage,
      head: record.expected_head,
      readiness: stage === "ready" ? record.readiness_id : null,
      policy: record.policy_generation,
    });
    if (
      record.status_text === key &&
      record.status_operation &&
      this.supervisor.publication.repository.operation(record.status_operation)
        ?.status === "confirmed"
    )
      return;
    const pending = this.supervisor.publication.repository.pending(
      record.job_id,
    );
    if (pending) {
      const result =
        pending.revision === record.revision
          ? await this.supervisor.publication.publish(pending.proposal, signal)
          : await this.supervisor.publication.reconcile(pending.id, signal);
      if (result.status !== "confirmed")
        throw new RuntimeError(result.failure ?? "publication_pending");
    }
    const proposal: PublicationProposal = {
      kind: "pr_stage",
      job_id: record.job_id,
      revision: record.revision,
      stage,
      expected_head: record.expected_head,
      previous_operation: investigation.publication_id,
      readiness_id: stage === "ready" ? record.readiness_id : null,
      generation: record.policy_generation,
    };
    record.status_operation = this.supervisor.publication.operationId(proposal);
    this.repository.save(record);
    const receipt = await this.supervisor.publication.publish(proposal, signal);
    if (receipt.status !== "confirmed")
      throw new RuntimeError(receipt.failure ?? "publication_pending");
    record.status_text = key;
    this.repository.save(record);
  }

  private async notify(record: PrMonitor, ready: boolean, signal: AbortSignal) {
    const job = this.store.jobById(record.job_id);
    if (!job || job.status !== "pending" || job.revision !== record.revision)
      return;
    if (this.store.durability) {
      if (!ready) return;
      const readiness = this.repository.readiness(record.readiness_id!);
      const key = digest({
        head: record.expected_head,
        policy: record.policy_digest,
        observation: readiness.observation_digest,
      });
      if (record.notification_id === key) return;
      await this.validateReadiness(record.readiness_id!, signal);
      const investigation = new InvestigationRepository(this.store).get(
        this.repository.implementation(record).investigation_id,
      );
      const receipt = await this.supervisor.publication.publish(
        {
          kind: "pr_notification",
          job_id: job.id,
          revision: job.revision,
          stage: "ready",
          expected_head: record.expected_head,
          previous_operation: investigation.publication_id,
          readiness_id: record.readiness_id!,
          generation: record.policy_generation,
          event_id: key,
        },
        signal,
      );
      if (receipt.status !== "confirmed")
        throw new RuntimeError(receipt.failure ?? "publication_pending");
      record.notification_id = key;
      this.repository.save(record);
      return;
    }
    const id = this.notificationId(record, ready);
    if (this.supervisor.notifications.repository.event(id)) return;
    if (ready) await this.validateReadiness(record.readiness_id!, signal);
    const event = this.supervisor.notifications.prepare({
      id,
      job_id: job.id,
      revision: job.revision,
      repository_id: this.store.repository()!.id,
      issue_number: job.issue_number,
      pull_number: record.pull_number,
      ...(ready
        ? { head_sha: record.expected_head, readiness_id: record.readiness_id! }
        : {}),
      occurred_at: record.started_at,
      outcome: ready ? "ready_for_review" : "needs_attention",
      reason: ready
        ? "automation_clean"
        : record.failure === "pr_wait_budget_exhausted"
          ? "review_timeout"
          : record.failure?.includes("budget")
            ? "budget_exhausted"
            : record.failure === "pr_checks_failed"
              ? "checks_failed"
              : "workflow_blocked",
    });
    await this.supervisor.notifications.enqueue(event, {}, signal);
    if (ready) {
      record.notification_id = id;
      this.repository.save(record);
    }
  }

  private notificationId(record: PrMonitor, ready: boolean) {
    return `pr-${record.id}-${ready ? record.expected_head.slice(0, 12) : "blocked"}-${record.policy_generation}`;
  }

  private suspendReadiness(record: PrMonitor, error: unknown) {
    const code = this.code(error);
    if (
      !readinessReadFailures.has(code) &&
      !(
        code === "pr_readiness_unavailable" &&
        readinessReadFailures.has(record.failure ?? "")
      )
    )
      return false;
    const event = this.supervisor.notifications.repository.event(
      this.notificationId(record, true),
    )?.prepared.event;
    if (
      !record.readiness_id ||
      event?.readiness_id !== record.readiness_id ||
      event.head_sha !== record.expected_head
    )
      return false;
    record.stage = "waiting";
    if (code !== "pr_readiness_unavailable") record.failure = code;
    record.wait_accounted_at ??= Date.now();
    record.retry_at = Math.max(
      record.retry_at,
      Date.now() + 1000,
      error instanceof IntakeError ? error.retryAt : 0,
    );
    return true;
  }

  private code(error: unknown) {
    return error instanceof RuntimeError || error instanceof IntakeError
      ? error.code
      : error instanceof z.ZodError
        ? "pr_response_invalid"
        : "pr_monitor_failed";
  }

  private async failed(record: PrMonitor, error: unknown, signal: AbortSignal) {
    const code = this.code(error);
    if (
      code === "lease_busy" ||
      code === "publication_busy" ||
      code === "pr_readiness_stale"
    ) {
      if (code === "pr_readiness_stale") this.invalidate(record);
      record.stage = "queued";
      record.wait_accounted_at ??= Date.now();
      record.retry_at = Date.now() + 1000;
      this.repository.save(record);
      return;
    }
    const suspended = this.suspendReadiness(record, error);
    if (!suspended) this.invalidate(record);
    this.repository.accountWait(record);
    if (
      (transient.has(code) || suspended) &&
      this.store.reserveInfrastructureRetry(record.job_id)
    ) {
      record.stage = "waiting";
      record.wait_accounted_at ??= Date.now();
      record.retry_at = Math.max(
        Date.now() + 1000,
        error instanceof IntakeError ? error.retryAt : 0,
      );
      if (!suspended) record.failure = null;
      this.repository.save(record);
      return;
    }
    if (suspended) this.invalidate(record);
    record.stage = "blocked";
    record.failure = this.store.hasUncertainMcpWrite(record.job_id)
      ? "mcp_write_uncertain"
      : code;
    record.wait_accounted_at = null;
    this.repository.save(record);
    this.logger.error(`PR maintenance blocked (${record.failure}).`);
    try {
      await this.report(record, "blocked", signal);
    } catch (publicationError) {
      this.failure = this.code(publicationError);
    }
    try {
      await this.notify(record, false, signal);
    } catch (notificationError) {
      this.failure = this.code(notificationError);
    }
  }
}
