import { immutable } from "../config/bundles.ts";
import { digest, RuntimeError } from "../domain/agents.ts";
import { budgetUsage } from "../domain/jobs.ts";
import type {
  McpWriteOperation,
  McpWriteAttempt,
  WriteResponse,
} from "../services/mcp-writes/contracts.ts";
import type { Store } from "./store.ts";

export class McpWriteRepository {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  operation(id: string): McpWriteOperation {
    const row = this.store.db
      .prepare("SELECT content FROM mcp_write_operations WHERE id=?")
      .get(id) as { content: string } | undefined;
    if (!row) throw new RuntimeError("mcp_write_missing");
    return JSON.parse(row.content) as McpWriteOperation;
  }

  all(): McpWriteOperation[] {
    return (
      this.store.db
        .prepare("SELECT content FROM mcp_write_operations ORDER BY rowid")
        .all() as { content: string }[]
    ).map((row) => JSON.parse(row.content) as McpWriteOperation);
  }

  attempts(id: string): McpWriteAttempt[] {
    return (
      this.store.db
        .prepare(
          "SELECT content FROM mcp_write_attempts WHERE operation_id=? ORDER BY number",
        )
        .all(id) as { content: string }[]
    ).map((row) => JSON.parse(row.content) as McpWriteAttempt);
  }

  begin(operation: McpWriteOperation) {
    this.store.db
      .transaction(() => {
        if (this.store.hasUncertainMcpWrite(operation.job_id))
          throw new RuntimeError("mcp_write_job_blocked");
        if (
          this.store.db
            .prepare(
              "SELECT 1 FROM mcp_write_operations WHERE job_id=? AND state IN ('proposed','dispatching')",
            )
            .get(operation.job_id)
        )
          throw new RuntimeError("mcp_write_busy");
        this.store.db
          .prepare("INSERT INTO mcp_write_operations VALUES(?,?,?,?,?)")
          .run(
            operation.id,
            operation.job_id,
            operation.revision,
            operation.state,
            JSON.stringify(operation),
          );
      })
      .immediate();
  }

  save(operation: McpWriteOperation) {
    operation.updated_at = Date.now();
    this.store.db
      .prepare("UPDATE mcp_write_operations SET state=?,content=? WHERE id=?")
      .run(operation.state, JSON.stringify(operation), operation.id);
  }

  dispatch(operation: McpWriteOperation, recovery: boolean) {
    this.store.db
      .transaction(() => {
        const previous = this.operation(operation.id);
        if (
          previous.state !== (recovery ? "uncertain" : "proposed") ||
          !operation.arguments ||
          digest(operation.arguments) !== operation.request_digest
        )
          throw new RuntimeError("mcp_write_identity_mismatch");
        if (
          digest({
            binding: previous.binding,
            arguments: previous.arguments,
            deadline: previous.deadline,
            idempotency_key: previous.idempotency_key,
            purpose: previous.purpose,
            evidence: previous.evidence,
          }) !==
          digest({
            binding: operation.binding,
            arguments: operation.arguments,
            deadline: operation.deadline,
            idempotency_key: operation.idempotency_key,
            purpose: operation.purpose,
            evidence: operation.evidence,
          })
        )
          throw new RuntimeError("mcp_write_identity_mismatch");
        if (Date.now() >= operation.deadline)
          throw new RuntimeError("mcp_write_deadline_expired");
        const job = this.store.jobById(operation.job_id);
        if (
          !job ||
          job.revision !== operation.revision ||
          job.status !== "pending"
        )
          throw new RuntimeError("revision_stale");
        const attempts = this.attempts(operation.id);
        if (recovery) {
          const usage = budgetUsage.parse(JSON.parse(job.budget_json));
          const limit = this.store.snapshot(job.snapshot_digest).settings.limits
            .infrastructure_retries;
          if (usage.infrastructure_retries >= limit)
            throw new RuntimeError("infrastructure_budget_exhausted");
          usage.infrastructure_retries++;
          this.store.db
            .prepare("UPDATE jobs SET budget_json=? WHERE id=?")
            .run(JSON.stringify(usage), job.id);
        }
        const attempt: McpWriteAttempt = {
          operation_id: operation.id,
          number: attempts.length + 1,
          started_at: Date.now(),
          finished_at: null,
          state: "dispatching",
          request_digest: operation.request_digest,
        };
        operation.state = "dispatching";
        operation.failure = null;
        this.save(operation);
        this.store.db
          .prepare("INSERT INTO mcp_write_attempts VALUES(?,?,?)")
          .run(operation.id, attempt.number, JSON.stringify(attempt));
      })
      .immediate();
  }

  finish(
    operation: McpWriteOperation,
    response: WriteResponse | null,
    failure: string | null,
  ) {
    this.store.db
      .transaction(() => {
        const current = this.operation(operation.id);
        if (current.state !== "dispatching")
          throw new RuntimeError("mcp_write_not_dispatching");
        operation.state = response ? "response_recorded" : "uncertain";
        operation.response = response;
        operation.failure = failure;
        if (!response && operation.notification !== "enqueued")
          operation.notification = "pending";
        this.save(operation);
        const attempt = this.attempts(operation.id).at(-1)!;
        attempt.state = operation.state;
        attempt.finished_at = Date.now();
        this.store.db
          .prepare(
            "UPDATE mcp_write_attempts SET content=? WHERE operation_id=? AND number=?",
          )
          .run(JSON.stringify(attempt), operation.id, attempt.number);
      })
      .immediate();
  }

  interrupt() {
    for (const operation of this.all()) {
      if (operation.state === "dispatching")
        this.finish(operation, null, "mcp_write_interrupted");
      else if (operation.state === "proposed") {
        operation.state = "rejected";
        operation.failure = "mcp_write_interrupted_before_dispatch";
        this.save(operation);
      }
    }
  }

  receipt(id: string) {
    return immutable({ ...this.operation(id), attempts: this.attempts(id) });
  }
}
