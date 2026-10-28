import { randomUUID } from "node:crypto";
import {
  createGitHubReader,
  type GitHubReader,
} from "../adapters/github/reader.ts";
import {
  createGitHubWriter,
  type GitHubWriter,
  type RemotePull,
} from "../adapters/github/writer.ts";
import type { RunSnapshot } from "../config/load.ts";
import type { SecretAccessor } from "../config/secrets.ts";
import { digest } from "../domain/agents.ts";
import { initialBudget, type IssueContext } from "../domain/jobs.ts";
import type { TaskDurability } from "../domain/durability.ts";
import {
  ActionsRepository,
  compactPull,
  issueDigest,
} from "../repositories/actions.ts";
import { PublicationRepository } from "../repositories/publication.ts";
import type { Store } from "../repositories/store.ts";
import type { FrozenScope } from "../services/implementation/contracts.ts";
import type { ReviewRequest } from "../services/publication/contracts.ts";
import {
  StateCodec,
  StateError,
  stateMarker,
  type StateComment,
  type TaskState,
} from "./state.ts";
import type { TaskResult } from "./task.ts";

export interface TaskStateTransport extends GitHubWriter {
  taskIssue(
    number: number,
    signal: AbortSignal,
  ): Promise<{
    id: number;
    number: number;
    state: "open" | "closed";
    managed: boolean;
  }>;
  enrollManaged(number: number, signal: AbortSignal): Promise<void>;
}

export class ActionsState implements TaskDurability {
  readonly repository: ActionsRepository;
  readonly writer: GitHubWriter;
  private readonly codec: StateCodec;
  private comment!: StateComment;
  private queue: Promise<unknown> = Promise.resolve();
  private fault: StateError | undefined;
  private reconstructed = false;
  private restoredResult: TaskResult | undefined;
  private constructor(
    private readonly store: Store,
    private readonly snapshot: RunSnapshot,
    private readonly secrets: SecretAccessor,
    private readonly transport: TaskStateTransport,
  ) {
    this.repository = new ActionsRepository(store);
    this.codec = new StateCodec(secrets.get("actions.session_key"));
    this.writer = {
      repository: transport.repository.bind(transport),
      actor: transport.actor.bind(transport),
      issueOpen: transport.issueOpen.bind(transport),
      branch: transport.branch.bind(transport),
      pulls: transport.pulls.bind(transport),
      pull: transport.pull.bind(transport),
      thread: transport.thread.bind(transport),
      replyThread: transport.replyThread.bind(transport),
      resolveThread: transport.resolveThread.bind(transport),
      updatePull: transport.updatePull.bind(transport),
      comments: (issue, signal) =>
        this.serial(async () => {
          const rows = await transport.comments(issue, signal);
          if (issue !== this.comment.state.issue.number) return rows;
          this.verifyRows(rows);
          return rows.map((row) =>
            row.id === this.comment.state.comment_id
              ? { ...row, body: this.comment.narrative }
              : row,
          );
        }, signal),
      comment: (issue, id, body, signal) => {
        if (issue !== this.comment.state.issue.number)
          return transport.comment(issue, id, body, signal);
        return this.serial(async () => {
          if (id !== this.comment.state.comment_id)
            throw new StateError("state_conflict");
          const pending = new PublicationRepository(store).pending(
            this.comment.state.job!.id,
          );
          const payload = pending?.payload as { comment?: string } | undefined;
          if (
            !pending?.review_id ||
            payload?.comment !== body ||
            !pending.steps.some(
              (step) => step.kind === "comment" && step.state === "dispatching",
            )
          )
            throw new StateError("state_unreviewed");
          await this.write(
            this.repository.project(this.comment.state, snapshot),
            body,
            signal,
          );
        }, signal);
      },
    };
  }

  static async open(
    store: Store,
    snapshot: RunSnapshot,
    secrets: SecretAccessor,
    number: number,
    signal: AbortSignal,
    options: { writer?: TaskStateTransport; reader?: GitHubReader } = {},
  ) {
    const transport =
      options.writer ??
      createGitHubWriter(
        snapshot.settings.github.repository,
        secrets.get("github.token"),
        () => {},
      );
    const reader =
      options.reader ??
      createGitHubReader(
        snapshot.settings.github.repository,
        secrets.get("github.token"),
      );
    const manager = new ActionsState(store, snapshot, secrets, transport);
    await manager.initialize(number, reader, signal);
    store.durability = manager;
    return manager;
  }

  private async initialize(
    number: number,
    reader: GitHubReader,
    signal: AbortSignal,
  ) {
    if (!this.repository.local() && this.store.jobs().length)
      throw new StateError("state_legacy_unbound");
    const repository = await this.transport.repository(signal),
      actor = await this.transport.actor(signal),
      issue = await this.transport.taskIssue(number, signal);
    if (
      repository.full_name.toLowerCase() !==
      this.snapshot.settings.github.repository.toLowerCase()
    )
      throw new StateError("state_invalid");
    let rows = await this.transport.comments(number, signal);
    const candidates = rows.filter(
      (row) => row.author_id === actor.id && row.body.includes(stateMarker),
    );
    if (candidates.length > 1) throw new StateError("state_conflict");
    let canonicalId: number;
    if (candidates.length === 1) {
      canonicalId = candidates[0].id;
      this.comment = this.codec.decode(candidates[0].body, {
        repository_id: repository.id,
        issue_id: issue.id,
        comment_id: canonicalId,
        author_id: actor.id,
      });
      if (
        this.comment.state.issue.number !== number ||
        digest(this.comment.state.repository) !== digest(repository)
      )
        throw new StateError("state_incompatible");
    } else {
      if (issue.managed || this.repository.local())
        throw new StateError("state_missing");
      if (this.store.jobs().length)
        throw new StateError("state_legacy_unbound");
      await this.transport.enrollManaged(number, signal);
      const instance = randomUUID(),
        limits = this.snapshot.settings.limits;
      const state: TaskState = {
        version: 1,
        repository,
        issue: { id: issue.id, number },
        task_id: randomUUID(),
        publication_instance: instance,
        comment_id: null,
        author_id: actor.id,
        generation: 0,
        initializing: true,
        job: null,
        budget: { ...initialBudget },
        limits: {
          active_ms: limits.active_minutes * 60000,
          model_requests: limits.model_requests,
          repair_cycles: limits.repair_cycles,
          infrastructure_retries: limits.infrastructure_retries,
          wait_ms: limits.wait_hours * 3600000,
        },
        active: null,
        wait_accounted_at: null,
        retry_at: 0,
        findings: null,
        scope: null,
        scope_digest: null,
        question: null,
        outcome: null,
        reason: null,
        branch: `orm/${instance}/issue-${number}`,
        head: null,
        pull: null,
        pending: null,
        session_artifact: null,
      };
      const narrative =
          "This issue is enrolled for bounded maintenance. No diagnosis or completion is claimed.",
        body = this.codec.encode(state, narrative);
      try {
        await this.transport.comment(number, null, body, signal);
      } catch {
        signal.throwIfAborted();
      }
      rows = await this.transport.comments(number, signal);
      const matches = rows.filter(
        (row) => row.author_id === actor.id && row.body.includes(stateMarker),
      );
      if (matches.length !== 1 || matches[0].body !== body)
        throw new StateError(
          matches.length ? "state_conflict" : "state_missing",
        );
      canonicalId = matches[0].id;
      this.comment = this.codec.decode(body, {
        repository_id: repository.id,
        issue_id: issue.id,
        comment_id: canonicalId,
        author_id: actor.id,
      });
    }
    if (this.comment.state.initializing) {
      const next = {
        ...this.comment.state,
        comment_id: canonicalId,
        initializing: false,
      };
      await this.write(next, this.comment.narrative, signal, canonicalId);
    }
    if (!(await this.transport.taskIssue(number, signal)).managed)
      await this.transport.enrollManaged(number, signal);
    const local = this.repository.local();
    if (
      local &&
      local.body !== this.comment.body &&
      local.intent !== this.comment.body
    )
      throw new StateError("state_local_conflict");
    await this.reconcile(signal);
    const context = await reader.issue(number, repository, signal);
    context.comments = context.comments.filter(
      (comment) =>
        comment.id !== canonicalId &&
        !this.store.owns("issue_comment", comment.id),
    );
    if (this.secrets.containsCredentials(context))
      throw new StateError("state_invalid");
    const state = this.comment.state;
    if (state.active) {
      state.budget.active_ms += Math.max(
        0,
        Math.min(Date.now(), state.active.deadline) - state.active.accounted_at,
      );
      state.active = null;
    }
    let pull: RemotePull | undefined;
    if (state.pull) {
      pull = await this.transport.pull(state.pull.number, signal);
      if (
        digest(compactPull(pull)) !== digest(state.pull) ||
        pull.branch !== state.branch ||
        pull.repository_id !== repository.id ||
        pull.base_repository_id !== repository.id
      )
        throw new StateError("state_conflict");
    }
    if (
      context.state !== "closed" &&
      pull?.state !== "closed" &&
      state.scope &&
      ((!pull && digest(context.source) !== digest(state.scope.source)) ||
        issueDigest(context) !== state.job?.issue_digest)
    )
      throw new StateError("state_incompatible");
    this.reconstructed = this.repository.restore(
      this.comment,
      context,
      this.snapshot,
      pull,
    );
    if (!state.job) {
      this.store.applyIssue(
        this.store.refreshIssue(number),
        context,
        this.snapshot,
      );
      this.bindComment();
    }
    if (
      state.job &&
      (this.reconstructed ||
        context.state === "closed" ||
        pull?.state === "closed")
    )
      this.restoredResult = this.recoveryResult(context, pull);
    if (
      !this.restoredResult &&
      state.pending &&
      !["confirmed", "blocked"].includes(state.pending.status) &&
      state.pending.retry_at > Date.now()
    )
      this.restoredResult = {
        version: 1,
        repository: state.repository.full_name,
        issue_number: state.issue.number,
        job_id: state.job?.id,
        revision: state.job?.revision,
        outcome: "waiting",
        reason: "retry_scheduled",
        retry_at: state.pending.retry_at,
        ...(state.pull
          ? { pull_number: state.pull.number, head_sha: state.pull.head }
          : {}),
      };
    await this.write(
      this.restoredResult
        ? state
        : this.repository.project(state, this.snapshot),
      this.comment.narrative,
      signal,
    );
  }

  private recoveryResult(
    context: IssueContext,
    pull?: RemotePull,
  ): TaskResult | undefined {
    const state = this.comment.state,
      job = state.job!;
    const base = {
      version: 1 as const,
      repository: state.repository.full_name,
      issue_number: state.issue.number,
      job_id: job.id,
      revision: job.revision,
      ...(state.pull
        ? { pull_number: state.pull.number, head_sha: state.pull.head }
        : {}),
    };
    if (context.state === "closed" || pull?.state === "closed")
      return {
        ...base,
        outcome: "closed",
        reason: context.state === "closed" ? "issue_closed" : "pull_closed",
      };
    if (
      state.pull ||
      state.head ||
      state.pending?.steps.some(
        (step) =>
          ["branch", "pull", "feedback_reply", "thread_resolution"].includes(
            step.kind,
          ) && step.state !== "prepared",
      )
    )
      return {
        ...base,
        outcome: "blocked",
        reason: "recovery_evidence_missing",
      };
    if (
      state.pending &&
      state.pending.steps.some((step) =>
        ["dispatching", "uncertain"].includes(step.state),
      )
    )
      return { ...base, outcome: "blocked", reason: "state_write_uncertain" };
    const input = { ...context, source: job.source, updated_at: undefined };
    const unchanged = digest(input) === job.input_digest;
    if (
      unchanged &&
      [
        "needs_information",
        "manual_feature",
        "no_fix",
        "investigation_blocked",
        "implementation_blocked",
      ].includes(state.reason ?? "") &&
      state.outcome
    )
      return {
        ...base,
        outcome: state.outcome,
        reason: state.reason as TaskResult["reason"],
      };
    if (state.retry_at > Date.now())
      return {
        ...base,
        outcome: "waiting",
        reason: "retry_scheduled",
        retry_at: state.retry_at,
      };
    return undefined;
  }

  result() {
    return this.restoredResult;
  }
  failure() {
    return this.fault;
  }
  identifiers() {
    return {
      task_id: this.comment.state.task_id,
      state_comment_id: this.comment.state.comment_id!,
      state_generation: this.comment.state.generation,
    };
  }

  recoveryContext() {
    if (!this.reconstructed) return undefined;
    return {
      findings:
        this.comment.state.findings?.summary ??
        "No reviewed findings survived. Establish fresh evidence.",
      scope: this.comment.state.scope as FrozenScope | null,
    };
  }

  scopeRequest(scope: FrozenScope): ReviewRequest {
    return {
      job_id: scope.job_id,
      revision: scope.revision,
      destination: {
        repository: this.comment.state.repository.full_name,
        issue: this.comment.state.issue.number,
        comment_id: this.comment.state.comment_id,
      },
      payload: { frozen_scope: scope },
      evidence: { source: scope.source, objective: scope.objective },
    };
  }

  async acceptScope(scope: FrozenScope, reviewId: string, signal: AbortSignal) {
    const review = new PublicationRepository(this.store).reviewed(reviewId);
    if (
      !review.approved ||
      !review.run_id ||
      review.job_id !== scope.job_id ||
      review.revision !== scope.revision
    )
      throw new StateError("state_unreviewed");
    if (
      this.comment.state.scope &&
      digest(scope) !== this.comment.state.scope_digest
    )
      throw new StateError("state_incompatible");
    this.repository.scope(scope, reviewId);
    await this.checkpoint(signal);
  }

  checkpoint(signal: AbortSignal) {
    return this.serial(async () => {
      this.bindComment();
      const state = this.restoredResult
        ? {
            ...this.comment.state,
            outcome: this.restoredResult.outcome,
            reason: this.restoredResult.reason,
          }
        : this.repository.project(this.comment.state, this.snapshot);
      await this.write(state, this.comment.narrative, signal);
      if (!this.restoredResult) this.repository.confirmReconstruction(state);
    }, signal);
  }

  private bindComment() {
    const job = this.store.job(this.comment.state.issue.number);
    if (!job) return;
    const publications = new PublicationRepository(this.store),
      target = publications.target(job.id);
    if (target.comment && target.comment.id !== this.comment.state.comment_id)
      throw new StateError("state_conflict");
    target.comment = {
      id: this.comment.state.comment_id!,
      body: this.comment.narrative,
      author_id: this.comment.state.author_id,
    };
    target.branch = this.comment.state.branch;
    publications.saveTarget(target);
    this.repository.own(
      "issue_comment",
      this.comment.state.comment_id!,
      job.id,
      job.revision,
      null,
      null,
    );
  }

  private async serial<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const task = this.queue.then(async () => {
      signal?.throwIfAborted();
      if (this.fault) throw this.fault;
      try {
        return await operation();
      } catch (error) {
        if (signal?.aborted) throw error;
        this.fault =
          error instanceof StateError
            ? error
            : new StateError("state_unavailable");
        throw this.fault;
      }
    });
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private verifyRows(rows: Awaited<ReturnType<GitHubWriter["comments"]>>) {
    const state = this.comment.state;
    const canonical = rows.find((row) => row.id === state.comment_id);
    if (!canonical) throw new StateError("state_missing");
    const others = rows.filter(
      (row) =>
        row.id !== canonical.id &&
        row.author_id === state.author_id &&
        row.body.includes(stateMarker),
    );
    if (others.length) throw new StateError("state_conflict");
    this.codec.decode(canonical.body, {
      repository_id: state.repository.id,
      issue_id: state.issue.id,
      comment_id: canonical.id,
      author_id: canonical.author_id ?? 0,
    });
    if (canonical.body !== this.comment.body)
      throw new StateError("state_conflict");
  }

  private async write(
    input: TaskState,
    narrative: string,
    signal: AbortSignal,
    initializingId?: number,
  ) {
    signal.throwIfAborted();
    const previous = this.comment,
      id = initializingId ?? previous.state.comment_id!;
    const rows = await this.transport.comments(input.issue.number, signal);
    if (initializingId) {
      if (
        rows.filter(
          (row) =>
            row.author_id === input.author_id && row.body.includes(stateMarker),
        ).length !== 1 ||
        !rows.some((row) => row.id === id && row.body === previous.body)
      )
        throw new StateError("state_conflict");
    } else this.verifyRows(rows);
    const state = { ...input, generation: previous.state.generation + 1 },
      body = this.codec.encode(state, narrative);
    if (this.secrets.containsCredentials({ state, narrative }))
      throw new StateError("state_secret");
    this.repository.intent(body);
    try {
      await this.transport.comment(state.issue.number, id, body, signal);
    } catch {
      signal.throwIfAborted();
    }
    const readback = await this.transport.comments(state.issue.number, signal);
    const confirmed = readback.filter(
      (row) =>
        row.id === id && row.author_id === state.author_id && row.body === body,
    );
    if (
      confirmed.length !== 1 ||
      readback.some(
        (row) =>
          row.id !== id &&
          row.author_id === state.author_id &&
          row.body.includes(stateMarker),
      )
    )
      throw new StateError("state_write_uncertain");
    this.comment = this.codec.decode(body, {
      repository_id: state.repository.id,
      issue_id: state.issue.id,
      comment_id: id,
      author_id: state.author_id,
    });
    this.repository.acknowledge(body);
  }

  private async reconcile(signal: AbortSignal) {
    const state = this.comment.state,
      pending = state.pending;
    if (!pending || ["confirmed", "blocked"].includes(pending.status)) return;
    if (pending.retry_at > Date.now()) return;
    for (const step of pending.steps) {
      if (!["dispatching", "uncertain"].includes(step.state)) continue;
      let matched = false;
      if (step.kind === "comment")
        matched = digest(this.comment.narrative) === step.body_digest;
      else if (step.kind === "branch") {
        const branch = await this.transport.branch(pending.branch, signal);
        matched = branch.head === pending.commit;
        if (matched) {
          state.head = branch.head;
          if (state.pull) state.pull.head = branch.head!;
        }
      } else if (step.kind === "pull") {
        const matches = (
          await this.transport.pulls(pending.branch, signal)
        ).filter(
          (pull) =>
            pull.author_id === pending.actor.id &&
            pull.repository_id === state.repository.id &&
            pull.base_repository_id === state.repository.id &&
            pull.branch === pending.branch &&
            pull.head === pending.commit &&
            pull.base === pending.source.default_branch &&
            !pull.draft &&
            digest(pull.title) === step.title_digest &&
            digest(pull.body) === step.body_digest &&
            (step.object_id === null || pull.id === step.object_id),
        );
        matched = matches.length === 1;
        if (matched) {
          state.pull = compactPull(matches[0]);
          state.head = matches[0].head;
          step.object_id = matches[0].id;
        }
      } else if (step.thread_id) {
        const thread = await this.transport.thread(step.thread_id, signal);
        if (
          thread.repository_id === state.repository.id &&
          thread.pull_id === state.pull?.id
        ) {
          const matches = thread.comments.filter(
            (comment) =>
              comment.author_login?.toLowerCase().replace(/\[bot\]$/, "") ===
                pending.actor.login.toLowerCase().replace(/\[bot\]$/, "") &&
              digest(comment.body) === step.body_digest,
          );
          matched =
            matches.length === 1 &&
            (step.kind === "feedback_reply" || thread.resolved);
        }
      } else if (step.kind === "feedback_reply" && state.pull) {
        matched =
          (await this.transport.comments(state.pull.number, signal)).filter(
            (comment) =>
              comment.author_id === pending.actor.id &&
              digest(comment.body) === step.body_digest,
          ).length === 1;
      }
      if (!matched) throw new StateError("state_write_uncertain");
      step.state = "confirmed";
    }
    pending.status = pending.steps.every((step) => step.state === "confirmed")
      ? "confirmed"
      : "reviewed";
    if (pending.status === "confirmed") pending.retry_pending = false;
  }
}
