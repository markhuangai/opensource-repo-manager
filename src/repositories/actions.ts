import type { Store } from "./store.ts";
import type { RunSnapshot } from "../config/load.ts";
import { digest } from "../domain/agents.ts";
import { budgetUsage, type IssueContext } from "../domain/jobs.ts";
import { PublicationRepository } from "./publication.ts";
import { InvestigationRepository } from "./investigation.ts";
import { ImplementationRepository } from "./implementation.ts";
import { PrMonitorRepository } from "./pr-monitor.ts";
import {
  StateError,
  taskStateSchema,
  type DurablePublication,
  type StateComment,
  type TaskState,
} from "../actions/state.ts";
import type { FrozenScope } from "../services/implementation/contracts.ts";
import type {
  OwnedPull,
  PublicationReceipt,
} from "../services/publication/contracts.ts";
import { taskOutcome } from "../actions/task.ts";
import { currentContinuation } from "../services/clarification.ts";

export function issueDigest(context: IssueContext) {
  return digest({ id: context.id, title: context.title, body: context.body });
}

export function compactPull(pull: OwnedPull): NonNullable<TaskState["pull"]> {
  if (pull.author_id === null) throw new StateError("state_invalid");
  return {
    id: pull.id,
    number: pull.number,
    author_id: pull.author_id,
    head: pull.head,
    base: pull.base,
    title_digest: digest(pull.title),
    body_digest: digest(pull.body),
  };
}

export class ActionsRepository {
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS actions_checkpoint (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      body TEXT NOT NULL, intent TEXT, scope_json TEXT, scope_review TEXT,
      reconstructed INTEGER NOT NULL DEFAULT 0
    )`);
  }

  local() {
    return this.store.db
      .prepare("SELECT * FROM actions_checkpoint WHERE singleton=1")
      .get() as
      | {
          body: string;
          intent: string | null;
          scope_json: string | null;
          scope_review: string | null;
          reconstructed: number;
        }
      | undefined;
  }

  importCheckpoint(path: string, body: string) {
    if (this.store.jobs().length || this.local())
      throw new StateError("state_local_conflict");
    const db = this.store.db;
    db.prepare("ATTACH DATABASE ? AS checkpoint").run(path);
    try {
      const definitions = (schema: "main" | "checkpoint") =>
        db
          .prepare(
            `SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
          )
          .all();
      if (
        digest(definitions("main")) !== digest(definitions("checkpoint")) ||
        db.pragma("checkpoint.user_version", { simple: true }) !==
          db.pragma("main.user_version", { simple: true }) ||
        db.pragma("checkpoint.quick_check", { simple: true }) !== "ok" ||
        (db.pragma("checkpoint.foreign_key_check") as unknown[]).length
      )
        throw new StateError("session_schema_unsupported");
      const tables = (
        db
          .prepare(
            "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map(({ name }) => `"${name.replaceAll('"', '""')}"`);
      db.transaction(() => {
        db.pragma("defer_foreign_keys = ON");
        for (const table of tables) db.exec(`DELETE FROM main.${table}`);
        // WHERE disables SQLite's transfer optimization, which leaves deferred foreign-key counters unresolved across attached databases.
        for (const table of tables)
          db.exec(
            `INSERT INTO main.${table} SELECT * FROM checkpoint.${table} WHERE 1`,
          );
        this.acknowledge(body);
      }).immediate();
    } finally {
      db.exec("DETACH DATABASE checkpoint");
    }
  }

  intent(body: string) {
    this.store.db
      .prepare("UPDATE actions_checkpoint SET intent=? WHERE singleton=1")
      .run(body);
  }

  acknowledge(body: string) {
    this.store.db
      .prepare(
        "INSERT INTO actions_checkpoint(singleton,body) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET body=excluded.body,intent=NULL",
      )
      .run(body);
  }

  scope(scope: FrozenScope, review: string) {
    this.store.db
      .prepare(
        "UPDATE actions_checkpoint SET scope_json=?,scope_review=? WHERE singleton=1",
      )
      .run(JSON.stringify(scope), review);
  }

  confirmReconstruction(state: TaskState) {
    const job = this.store.job(state.issue.number);
    if (!job) return;
    const investigation = new InvestigationRepository(this.store).current(job);
    if (
      investigation?.stage !== "completed" ||
      !investigation.publication_id ||
      new PublicationRepository(this.store).operation(
        investigation.publication_id,
      )?.status !== "confirmed"
    )
      return;
    const scope = new ImplementationRepository(this.store).current(job)?.scope;
    if (state.scope && (!scope || digest(scope) !== state.scope_digest)) return;
    this.store.db
      .prepare(
        "UPDATE actions_checkpoint SET reconstructed=0 WHERE singleton=1",
      )
      .run();
  }

  project(previous: TaskState, snapshot: RunSnapshot): TaskState {
    const state = structuredClone(previous),
      job = this.store.job(state.issue.number);
    if (!job) return state;
    const context = JSON.parse(job.input_json) as IssueContext;
    if (job.snapshot_digest !== snapshot.digest)
      throw new StateError("state_incompatible");
    if (
      state.scope &&
      (state.scope.revision !== job.revision ||
        digest(state.scope.source) !== digest(context.source))
    )
      throw new StateError("state_incompatible");
    state.job = {
      id: job.id,
      revision: job.revision,
      phase: job.phase as NonNullable<TaskState["job"]>["phase"],
      status: job.status,
      input_digest: job.input_digest,
      issue_digest: issueDigest(context),
      snapshot_digest: job.snapshot_digest,
      source: context.source,
    };
    for (const lease of this.store.leases())
      this.store.accountActive(lease.token);
    state.budget = budgetUsage.parse(
      JSON.parse(this.store.jobById(job.id)!.budget_json),
    );
    const active = this.store.db
      .prepare("SELECT accounted_at,deadline FROM runtime_leases")
      .all() as NonNullable<TaskState["active"]>[];
    if (active.length > 1) throw new StateError("state_conflict");
    state.active = active[0] ?? null;
    const investigation = new InvestigationRepository(this.store).current(job);
    const implementation = new ImplementationRepository(this.store).current(
      job,
    );
    const monitor = new PrMonitorRepository(this.store).get(job.id);
    const publications = new PublicationRepository(this.store),
      target = publications.target(job.id);
    state.branch = target.branch;
    state.head = target.head;
    if (target.pull) state.pull = compactPull(target.pull);
    const local = this.local();
    if (local?.scope_json && local.scope_review) {
      const scope = JSON.parse(local.scope_json) as FrozenScope;
      if (scope.revision !== job.revision)
        throw new StateError("state_incompatible");
      state.scope = scope as TaskState["scope"];
      state.scope_digest = digest(scope);
    }
    if (investigation?.publication_id && investigation.result) {
      const operation = publications.operation(investigation.publication_id);
      if (
        operation?.review_id &&
        publications.reviewed(operation.review_id).approved
      ) {
        state.findings = structuredClone(investigation.result);
        if (
          !currentContinuation(this.store, job.id) &&
          (!state.question || !("version" in state.question))
        )
          state.question =
            investigation.result.outcome === "needs_information"
              ? {
                  questions: [...investigation.result.questions],
                  input_digest: job.input_digest,
                }
              : null;
      }
    }
    const continuation = currentContinuation(this.store, job.id);
    if (continuation) {
      state.question =
        continuation.question && structuredClone(continuation.question);
      if (state.question && "version" in state.question) {
        const question = state.question;
        const step = publications
          .operation(question.publication_id)
          ?.steps.find((step) => step.kind === "question_comment");
        if (step?.object_id) question.comment_id = step.object_id;
        if (
          previous.question &&
          "version" in previous.question &&
          previous.question.id === question.id
        )
          question.answers = structuredClone(previous.question.answers);
      }
    }
    const current =
      job.phase === "investigation"
        ? investigation
        : job.phase === "implementation"
          ? implementation
          : monitor;
    state.retry_at = Math.max(
      current?.retry_at ?? 0,
      publications.pending(job.id)?.retry_at ?? 0,
    );
    state.wait_accounted_at = monitor
      ? monitor.wait_accounted_at
      : state.wait_accounted_at;
    const pending = publications.pending(job.id);
    if (pending?.review_id && pending.actor && pending.payload)
      state.pending = this.publication(pending);
    else if (state.pending) {
      const operation = publications.operation(state.pending.id);
      if (operation?.review_id && operation.actor && operation.payload)
        state.pending = this.publication(operation);
    }
    const outcome = taskOutcome(
      this.store,
      { issue_number: job.issue_number },
      snapshot.settings.pr_monitor.enabled,
    );
    state.outcome = outcome?.outcome ?? null;
    state.reason = outcome?.reason ?? null;
    return state;
  }

  private publication(receipt: PublicationReceipt): DurablePublication {
    const review = new PublicationRepository(this.store).reviewed(
      receipt.review_id!,
    );
    if (!review.approved) throw new StateError("state_unreviewed");
    const payload = receipt.payload as {
      pull?: { title: string; body: string };
      comment?: string;
      feedback?: { thread: string | null; body: string };
    };
    return {
      id: receipt.id,
      revision: receipt.revision,
      kind: receipt.proposal.kind,
      actor: receipt.actor!,
      source: receipt.source,
      branch: receipt.target.branch,
      commit: receipt.commit,
      review_id: review.id,
      review_binding: review.binding,
      policy_identity: review.policy_identity,
      status: receipt.status === "prepared" ? "reviewed" : receipt.status,
      retry_at: receipt.retry_at,
      retry_pending: receipt.retry_pending,
      steps: receipt.steps.map((step) => ({
        kind: step.kind,
        state: step.state,
        before_digest: digest(step.before),
        after_digest: digest(step.after),
        object_id:
          step.kind === "question_comment"
            ? (step.object_id ?? null)
            : step.kind === "comment"
              ? (receipt.target.comment?.id ?? null)
              : step.kind === "pull"
                ? (receipt.target.pull?.id ?? null)
                : null,
        thread_id: payload.feedback?.thread ?? null,
        title_digest: step.kind === "pull" ? digest(payload.pull!.title) : null,
        body_digest:
          step.kind === "pull"
            ? digest(payload.pull!.body)
            : step.kind === "comment" || step.kind === "question_comment"
              ? digest(payload.comment!)
              : ["feedback_reply", "thread_resolution"].includes(step.kind)
                ? digest(payload.feedback!.body)
                : null,
      })),
    };
  }

  restore(
    comment: StateComment,
    context: IssueContext,
    snapshot: RunSnapshot,
    pull?: OwnedPull,
  ) {
    return this.store.db
      .transaction(() => {
        const { state } = comment,
          prior = this.local(),
          job = state.job;
        if (job && job.snapshot_digest !== snapshot.digest)
          throw new StateError("state_incompatible");
        if (
          prior &&
          prior.body !== comment.body &&
          prior.intent !== comment.body
        )
          throw new StateError("state_local_conflict");
        if (!prior && this.store.jobs().length)
          throw new StateError("state_legacy_unbound");
        const reconstructed = !prior || prior.reconstructed === 1;
        this.store.enroll(state.repository);
        this.store.saveSnapshot(snapshot);
        this.store.db
          .prepare("UPDATE publication_instance SET id=?")
          .run(state.publication_instance);
        if (job && !this.store.job(state.issue.number)) {
          const input = JSON.stringify({
            ...context,
            // Refreshed comments lack the frozen boundary; replies enter through admission.
            comments: [],
            source: job.source,
            updated_at: undefined,
          });
          this.store.db
            .prepare(
              "INSERT INTO jobs(id,issue_id,issue_number,revision,phase,status,input_digest,input_json,snapshot_digest,budget_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              job.id,
              state.issue.id,
              state.issue.number,
              job.revision,
              state.pull ? "remote_review" : "investigation",
              job.status,
              job.input_digest,
              input,
              job.snapshot_digest,
              JSON.stringify(state.budget),
            );
        }
        if (job) {
          const localJob = this.store.job(state.issue.number);
          if (localJob?.id !== job.id || localJob.issue_id !== state.issue.id)
            throw new StateError("state_local_conflict");
          if (
            !taskStateSchema.shape.job
              .unwrap()
              .shape.phase.safeParse(localJob.phase).success
          )
            throw new StateError("state_invalid");
          this.store.db
            .prepare("UPDATE jobs SET budget_json=? WHERE id=?")
            .run(JSON.stringify(state.budget), job.id);
          this.store.db
            .prepare(
              "UPDATE pr_monitors SET content=json_set(content,'$.wait_accounted_at',?) WHERE job_id=?",
            )
            .run(state.wait_accounted_at, job.id);
          const table =
            job.phase === "investigation"
              ? "investigations"
              : job.phase === "implementation"
                ? "implementations"
                : "pr_monitors";
          this.store.db
            .prepare(
              `UPDATE ${table} SET content=json_set(content,'$.retry_at',max(coalesce(json_extract(content,'$.retry_at'),0),?)) WHERE job_id=?`,
            )
            .run(state.retry_at, job.id);
          this.store.db
            .prepare("UPDATE runtime_leases SET deadline=accounted_at")
            .run();
          const publications = new PublicationRepository(this.store),
            target = publications.target(job.id);
          target.branch = state.branch;
          target.head = state.head;
          target.comment = {
            id: state.comment_id!,
            body: comment.narrative,
            author_id: state.author_id,
          };
          if (pull) {
            const { id, number, title, body, head, base, author_id } = pull;
            target.pull = { id, number, title, body, head, base, author_id };
          }
          publications.saveTarget(target);
          if (state.pending) {
            const operation = publications.operation(state.pending.id);
            if (operation) {
              if (
                operation.review_id !== state.pending.review_id ||
                operation.steps.length !== state.pending.steps.length ||
                operation.steps.some(
                  (step, index) =>
                    step.kind !== state.pending!.steps[index].kind ||
                    digest(step.after) !==
                      state.pending!.steps[index].after_digest,
                )
              )
                throw new StateError("state_local_conflict");
              operation.status = state.pending.status;
              operation.retry_at = state.pending.retry_at;
              operation.retry_pending = state.pending.retry_pending;
              operation.target = target;
              for (const [index, step] of operation.steps.entries()) {
                step.state = state.pending.steps[index].state;
                if (
                  step.kind === "question_comment" &&
                  state.pending.steps[index].object_id
                )
                  step.object_id = state.pending.steps[index].object_id!;
                if (step.state === "confirmed")
                  publications.finishStep(operation, step.kind);
              }
              publications.save(operation);
            }
          }
          this.own(
            "issue_comment",
            state.comment_id!,
            job.id,
            job.revision,
            null,
            null,
          );
          if (
            state.question &&
            "version" in state.question &&
            state.question.comment_id
          )
            this.own(
              "issue_comment",
              state.question.comment_id,
              job.id,
              job.revision,
              null,
              null,
            );
          if (state.pull)
            this.own(
              "pull_request",
              state.pull.id,
              job.id,
              job.revision,
              state.pull.number,
              state.head,
            );
        }
        this.acknowledge(comment.body);
        this.store.db
          .prepare(
            "UPDATE actions_checkpoint SET reconstructed=? WHERE singleton=1",
          )
          .run(Number(reconstructed));
        return reconstructed;
      })
      .immediate();
  }

  own(
    kind: "issue_comment" | "pull_request",
    id: number,
    jobId: number,
    revision: number,
    number: number | null,
    head: string | null,
  ) {
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO publications(operation_key,job_id,revision,kind,object_id,number,head_sha,receipt_json) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        `actions:${kind}:${id}`,
        jobId,
        revision,
        kind,
        String(id),
        number,
        head,
        JSON.stringify({ authority: "actions" }),
      );
  }
}
