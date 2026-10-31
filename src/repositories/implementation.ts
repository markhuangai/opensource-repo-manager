import { randomUUID } from "node:crypto";
import { digest, RuntimeError } from "../domain/agents.ts";
import { budgetUsage, type IssueContext, type Job } from "../domain/jobs.ts";
import type { Store } from "./store.ts";
import { InvestigationRepository } from "./investigation.ts";
import { PublicationRepository } from "./publication.ts";
import type { Implementation } from "../services/implementation/contracts.ts";
import { bugEvidenceSchema } from "../services/investigation/contracts.ts";

export class ImplementationRepository {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  all(): Implementation[] {
    return (
      this.store.db
        .prepare("SELECT content FROM implementations ORDER BY rowid")
        .all() as { content: string }[]
    ).map((row) => JSON.parse(row.content) as Implementation);
  }

  current(job: Job): Implementation | undefined {
    const row = this.store.db
      .prepare(
        "SELECT content FROM implementations WHERE job_id=? AND revision=?",
      )
      .get(job.id, job.revision) as { content: string } | undefined;
    return row && (JSON.parse(row.content) as Implementation);
  }

  ensure(job: Job): Implementation {
    const previous = this.current(job);
    if (previous) return previous;
    const investigation = new InvestigationRepository(this.store).current(job);
    const publication = investigation?.publication_id
      ? new PublicationRepository(this.store).operation(
          investigation.publication_id,
        )
      : undefined;
    if (
      job.phase !== "implementation" ||
      investigation?.stage !== "completed" ||
      investigation.result?.outcome !== "maintenance_candidate" ||
      !bugEvidenceSchema.safeParse(investigation.result?.bug).success ||
      publication?.status !== "confirmed"
    )
      throw new RuntimeError("implementation_handoff_invalid");
    const record: Implementation = {
      id: randomUUID(),
      job_id: job.id,
      revision: job.revision,
      investigation_id: investigation.id,
      source: investigation.source,
      snapshot_digest: job.snapshot_digest,
      stage: "queued",
      scope: null,
      scope_digest: null,
      baseline_digest: null,
      artifact_digest: null,
      result: null,
      bootstrap_receipt: null,
      candidate_bootstrap: null,
      milestone_done: false,
      audit_id: null,
      test_id: null,
      audits: [],
      tests: [],
      agent_pending: null,
      recovery_attempts: [],
      publication_id: null,
      status_operation: null,
      status_generation: 0,
      feedback: [],
      failure: null,
      retry_at: 0,
      retry_stage: null,
      started_at: Date.now(),
    };
    this.store.db
      .prepare("INSERT INTO implementations VALUES(?,?,?,?,?)")
      .run(
        record.id,
        job.id,
        job.revision,
        record.stage,
        JSON.stringify(record),
      );
    return record;
  }

  save(record: Implementation) {
    this.store.db
      .prepare("UPDATE implementations SET state=?,content=? WHERE id=?")
      .run(record.stage, JSON.stringify(record), record.id);
  }

  assertCurrent(record: Implementation) {
    const job = this.store.jobById(record.job_id);
    if (
      !job ||
      job.status !== "pending" ||
      job.revision !== record.revision ||
      job.snapshot_digest !== record.snapshot_digest ||
      digest((JSON.parse(job.input_json) as IssueContext).source) !==
        digest(record.source)
    )
      throw new RuntimeError("revision_stale");
    if (record.scope && digest(record.scope) !== record.scope_digest)
      throw new RuntimeError("implementation_scope_changed");
    if (
      !bugEvidenceSchema.safeParse(
        new InvestigationRepository(this.store).get(record.investigation_id)
          .result?.bug,
      ).success
    )
      throw new RuntimeError("implementation_handoff_invalid");
    this.store.assertPublishedScope(job.id);
    if (this.store.hasUncertainMcpWrite(job.id))
      throw new RuntimeError("mcp_write_uncertain");
    return job;
  }

  repair(record: Implementation, findings: string[]) {
    return this.store.db
      .transaction(() => {
        const job = this.assertCurrent(record);
        const usage = budgetUsage.parse(JSON.parse(job.budget_json));
        if (
          usage.repair_cycles >=
          this.store.snapshot(job.snapshot_digest).settings.limits.repair_cycles
        )
          throw new RuntimeError("repair_budget_exhausted");
        usage.repair_cycles++;
        this.store.db
          .prepare("UPDATE jobs SET budget_json=? WHERE id=?")
          .run(JSON.stringify(usage), job.id);
        record.feedback = findings;
        record.stage = "implementing";
        record.audit_id = null;
        record.test_id = null;
        record.candidate_bootstrap = null;
        record.milestone_done = false;
        this.save(record);
      })
      .immediate();
  }

  repairPublished(record: Implementation, findings: string[]) {
    this.store.db
      .transaction(() => {
        if (record.stage !== "remote_review" || !record.publication_id)
          throw new RuntimeError("pr_repair_state_invalid");
        this.repair(record, findings);
        record.publication_id = null;
        record.status_operation = null;
        record.status_generation++;
        this.save(record);
        this.store.db
          .prepare("UPDATE jobs SET phase='implementation' WHERE id=?")
          .run(record.job_id);
      })
      .immediate();
  }

  finish(record: Implementation) {
    const publications = new PublicationRepository(this.store);
    const operation =
      record.publication_id && publications.operation(record.publication_id);
    if (
      !operation ||
      operation.status !== "confirmed" ||
      operation.proposal.kind !== "change" ||
      !operation.target.pull
    )
      throw new RuntimeError("implementation_publication_unconfirmed");
    this.store.db
      .transaction(() => {
        record.stage = "remote_review";
        record.retry_stage = null;
        record.failure = null;
        this.save(record);
        this.store.db
          .prepare(
            "UPDATE jobs SET phase='remote_review' WHERE id=? AND status='pending'",
          )
          .run(record.job_id);
      })
      .immediate();
  }
}
