import { randomUUID } from "node:crypto";
import { digest, RuntimeError } from "../domain/agents.ts";
import type { IssueContext, Job } from "../domain/jobs.ts";
import type { Store } from "./store.ts";
import { PublicationRepository } from "./publication.ts";
import type {
  Investigation,
  InvestigationEvidence,
} from "../services/investigation/contracts.ts";

export class InvestigationRepository {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  all(): Investigation[] {
    return (
      this.store.db
        .prepare("SELECT content FROM investigations ORDER BY rowid")
        .all() as { content: string }[]
    ).map((row) => JSON.parse(row.content) as Investigation);
  }

  get(id: string): Investigation {
    const row = this.store.db
      .prepare("SELECT content FROM investigations WHERE id=?")
      .get(id) as { content: string } | undefined;
    if (!row) throw new RuntimeError("investigation_missing");
    return JSON.parse(row.content) as Investigation;
  }

  current(job: Job): Investigation | undefined {
    const row = this.store.db
      .prepare(
        "SELECT content FROM investigations WHERE job_id=? AND revision=?",
      )
      .get(job.id, job.revision) as { content: string } | undefined;
    return row && (JSON.parse(row.content) as Investigation);
  }

  ensure(job: Job): Investigation {
    const existing = this.current(job);
    if (existing) return existing;
    const publications = new PublicationRepository(this.store);
    const previous = this.all()
      .filter(
        (item) =>
          item.job_id === job.id &&
          item.publication_id &&
          publications.operation(item.publication_id)?.status === "confirmed",
      )
      .at(-1);
    const record: Investigation = {
      id: randomUUID(),
      job_id: job.id,
      revision: job.revision,
      source: (JSON.parse(job.input_json) as IssueContext).source,
      snapshot_digest: job.snapshot_digest,
      stage: "queued",
      plan: null,
      agent_pending: false,
      recovery_attempts: [],
      result: null,
      evidence_ids: [],
      bootstrap_receipt: null,
      publication_id: null,
      status_operation: null,
      previous_operation: previous?.publication_id ?? null,
      failure: null,
      retry_at: 0,
      retry_stage: null,
      started_at: Date.now(),
    };
    this.store.db
      .prepare("INSERT INTO investigations VALUES(?,?,?,?,?)")
      .run(
        record.id,
        job.id,
        job.revision,
        record.stage,
        JSON.stringify(record),
      );
    return record;
  }

  save(record: Investigation) {
    this.store.db
      .prepare("UPDATE investigations SET state=?,content=? WHERE id=?")
      .run(record.stage, JSON.stringify(record), record.id);
  }

  assertCurrent(record: Investigation) {
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
    if (this.store.hasUncertainMcpWrite(job.id))
      throw new RuntimeError("mcp_write_uncertain");
    return job;
  }

  recordEvidence(evidence: InvestigationEvidence) {
    const job = this.store.jobById(evidence.job_id);
    if (
      !job ||
      job.revision !== evidence.revision ||
      digest((JSON.parse(job.input_json) as IssueContext).source) !==
        digest(evidence.source)
    )
      throw new RuntimeError("investigation_evidence_mismatch");
    const id = digest(evidence);
    this.store.db
      .prepare("INSERT OR IGNORE INTO investigation_evidence VALUES(?,?,?,?)")
      .run(id, evidence.job_id, evidence.revision, JSON.stringify(evidence));
    return id;
  }

  evidence(
    id: string,
    job: number,
    revision: number,
    source: InvestigationEvidence["source"],
  ) {
    const row = this.store.db
      .prepare(
        "SELECT content FROM investigation_evidence WHERE id=? AND job_id=? AND revision=?",
      )
      .get(id, job, revision) as { content: string } | undefined;
    if (!row) throw new RuntimeError("investigation_evidence_missing");
    const value = JSON.parse(row.content) as InvestigationEvidence;
    if (digest(value) !== id || digest(value.source) !== digest(source))
      throw new RuntimeError("investigation_evidence_mismatch");
    return value;
  }

  finish(record: Investigation) {
    this.store.db
      .transaction(() => {
        this.assertCurrent(record);
        const publication = this.store.db
          .prepare(
            "SELECT status FROM publication_operations WHERE id=? AND job_id=?",
          )
          .get(record.publication_id, record.job_id) as
          { status: string } | undefined;
        if (publication?.status !== "confirmed" || !record.result)
          throw new RuntimeError("investigation_publication_unconfirmed");
        record.stage =
          record.result.outcome === "blocked" ? "blocked" : "completed";
        record.retry_stage = null;
        record.failure =
          record.result.outcome === "blocked" ? "investigation_blocked" : null;
        this.save(record);
        if (record.result.outcome === "maintenance_candidate")
          this.store.db
            .prepare(
              "UPDATE jobs SET phase='implementation' WHERE id=? AND revision=?",
            )
            .run(record.job_id, record.revision);
      })
      .immediate();
  }

  reserveRetry(record: Investigation) {
    return this.store.db
      .transaction(() => {
        const job = this.assertCurrent(record);
        return this.store.reserveInfrastructureRetry(job.id);
      })
      .immediate();
  }
}
