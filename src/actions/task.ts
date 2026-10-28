import { ConfigurationError } from "../config/errors.ts";
import { RuntimeError, digest } from "../domain/agents.ts";
import { IntakeError, type IssueContext } from "../domain/jobs.ts";
import type { Store } from "../repositories/store.ts";
import { InvestigationRepository } from "../repositories/investigation.ts";
import { ImplementationRepository } from "../repositories/implementation.ts";
import { PrMonitorRepository } from "../repositories/pr-monitor.ts";
import { PublicationRepository } from "../repositories/publication.ts";
import type { Application } from "../runtime/application.ts";

export type TaskRequest = Readonly<{ issue_number: number }>;
export type TaskResult = Readonly<{
  version: 1;
  outcome:
    | "waiting"
    | "ready"
    | "out_of_scope"
    | "no_fix"
    | "closed"
    | "blocked"
    | "failed";
  reason:
    | "needs_information"
    | "remote_checks"
    | "monitor_disabled"
    | "retry_scheduled"
    | "human_review"
    | "manual_feature"
    | "no_fix"
    | "issue_closed"
    | "pull_closed"
    | "investigation_blocked"
    | "implementation_blocked"
    | "monitor_blocked"
    | "no_progress"
    | "task_state_invalid"
    | "arguments_invalid"
    | "configuration_invalid"
    | "intake_failed"
    | "runtime_failed"
    | "cancelled"
    | "cleanup_failed"
    | "state_missing"
    | "state_invalid"
    | "state_conflict"
    | "state_local_conflict"
    | "state_legacy_unbound"
    | "state_size_limit"
    | "state_incompatible"
    | "state_unavailable"
    | "state_unreviewed"
    | "state_secret"
    | "state_write_uncertain"
    | "recovery_evidence_missing";
  repository?: string;
  issue_number?: number;
  job_id?: number;
  revision?: number;
  pull_number?: number;
  head_sha?: string;
  retry_at?: number;
  task_id?: string;
  state_comment_id?: number;
  state_generation?: number;
}>;

export function parseTaskRequest(args: string[]): TaskRequest {
  if (
    args.length !== 1 ||
    !/^[1-9][0-9]*$/.test(args[0]) ||
    !Number.isSafeInteger(Number(args[0]))
  )
    throw new ConfigurationError("arguments_invalid");
  return { issue_number: Number(args[0]) };
}

export function assertTaskStore(
  store: Store,
  request: TaskRequest,
  repository: string,
) {
  const enrolled = store.repository();
  if (
    (enrolled &&
      enrolled.full_name.toLowerCase() !== repository.toLowerCase()) ||
    store.jobs().some((job) => job.issue_number !== request.issue_number)
  )
    throw new RuntimeError("task_state_invalid");
}

function taskState(store: Store, request: TaskRequest) {
  const job = store.job(request.issue_number);
  if (!job) throw new RuntimeError("task_state_invalid");
  return {
    job,
    investigation: new InvestigationRepository(store).current(job),
    implementation: new ImplementationRepository(store).current(job),
    monitor: new PrMonitorRepository(store).get(job.id),
    pending: new PublicationRepository(store).pending(job.id),
  };
}

export function taskIdentity(store: Store, request: TaskRequest) {
  const { job } = taskState(store, request);
  const pull = store.ownedPulls().find((item) => item.job_id === job.id);
  return {
    repository: store.repository()!.full_name,
    issue_number: job.issue_number,
    job_id: job.id,
    revision: job.revision,
    ...(pull?.number
      ? { pull_number: pull.number, head_sha: pull.head_sha ?? undefined }
      : {}),
  };
}

export function taskOutcome(
  store: Store,
  request: TaskRequest,
  monitoring: boolean,
  now = Date.now(),
): TaskResult | undefined {
  const { job, investigation, implementation, monitor, pending } = taskState(
    store,
    request,
  );
  const result = (
    outcome: TaskResult["outcome"],
    reason: TaskResult["reason"],
    retry_at?: number,
  ): TaskResult => ({
    version: 1,
    ...taskIdentity(store, request),
    outcome,
    reason,
    ...(retry_at ? { retry_at } : {}),
  });
  if (job.status === "closed") return result("closed", "issue_closed");
  const current =
    job.phase === "investigation"
      ? investigation
      : job.phase === "implementation"
        ? implementation
        : monitor;
  const retry = Math.max(current?.retry_at ?? 0, pending?.retry_at ?? 0);
  if (retry > now) return result("waiting", "retry_scheduled", retry);
  if (job.phase === "investigation" && investigation) {
    if (investigation.stage === "blocked" && !investigation.retry_stage)
      return result("blocked", "investigation_blocked");
    if (investigation.stage === "completed") {
      switch (investigation.result?.outcome) {
        case "needs_information":
          return result("waiting", "needs_information");
        case "manual_feature":
          return result("out_of_scope", "manual_feature");
        case "no_fix":
          return result("no_fix", "no_fix");
        case "blocked":
          return result("blocked", "investigation_blocked");
      }
    }
  }
  if (
    job.phase === "implementation" &&
    implementation?.stage === "blocked" &&
    !implementation.retry_stage
  )
    return result("blocked", "implementation_blocked");
  if (job.phase === "remote_review") {
    if (!monitoring) return result("waiting", "monitor_disabled");
    if (monitor?.stage === "closed") return result("closed", "pull_closed");
    if (monitor?.stage === "blocked")
      return result("blocked", "monitor_blocked");
    if (monitor?.stage === "ready" && monitor.readiness_id && !pending)
      return result("ready", "human_review");
    if (monitor?.stage === "waiting") return result("waiting", "remote_checks");
  }
}

function progress(store: Store, request: TaskRequest) {
  const { job, investigation, implementation, monitor, pending } = taskState(
    store,
    request,
  );
  return digest({
    revision: job.revision,
    phase: job.phase,
    status: job.status,
    investigation,
    implementation,
    monitor: monitor && {
      stage: monitor.stage,
      head: monitor.expected_head,
      findings: monitor.findings,
      readiness: monitor.readiness_id,
      pending_agent: monitor.pending_agent,
    },
    pending,
  });
}

export async function executeTask(
  application: Application,
  request: TaskRequest,
  signal: AbortSignal,
): Promise<TaskResult> {
  const { intake, store, investigation, monitor } = application;
  let context: IssueContext;
  try {
    context = await intake.enrollIssue(request.issue_number, signal);
    await store.checkpoint(signal);
  } catch (error) {
    if (
      error instanceof IntakeError &&
      error.code === "publication_pending" &&
      error.retryAt > Date.now()
    )
      return {
        version: 1,
        ...taskIdentity(store, request),
        outcome: "waiting",
        reason: "retry_scheduled",
        retry_at: error.retryAt,
      };
    throw error;
  }
  if (context.state === "closed")
    return {
      version: 1,
      repository: store.repository()!.full_name,
      issue_number: context.number,
      ...(store.job(request.issue_number) ? taskIdentity(store, request) : {}),
      outcome: "closed",
      reason: "issue_closed",
    };
  try {
    while (true) {
      signal.throwIfAborted();
      const deferred = taskOutcome(store, request, monitor.enabled());
      if (deferred?.reason === "retry_scheduled") return deferred;
      const before = progress(store, request);
      await investigation.reconcile();
      signal.throwIfAborted();
      await monitor.reconcile(signal);
      signal.throwIfAborted();
      await store.checkpoint(signal);
      const outcome = taskOutcome(store, request, monitor.enabled());
      if (outcome) return outcome;
      if (progress(store, request) === before)
        return {
          version: 1,
          ...taskIdentity(store, request),
          outcome: "blocked",
          reason: "no_progress",
        };
    }
  } catch (error) {
    return {
      version: 1,
      ...taskIdentity(store, request),
      outcome: "failed",
      reason: signal.aborted
        ? "cancelled"
        : error instanceof IntakeError
          ? "intake_failed"
          : "runtime_failed",
    };
  }
}

export function taskExitCode(result: TaskResult) {
  return result.outcome === "blocked" || result.outcome === "failed" ? 1 : 0;
}
