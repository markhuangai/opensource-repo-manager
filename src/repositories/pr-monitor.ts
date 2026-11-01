import { randomUUID } from "node:crypto";
import { digest, RuntimeError } from "../domain/agents.ts";
import { budgetUsage } from "../domain/jobs.ts";
import type { Store } from "./store.ts";
import { ImplementationRepository } from "./implementation.ts";
import { PublicationRepository } from "./publication.ts";
import type { Implementation } from "../services/implementation/contracts.ts";
import type {
  PrMonitor,
  PrReadiness,
  PrSnapshot,
} from "../services/pr-monitor/contracts.ts";
import { readinessReadFailures } from "../services/pr-monitor/contracts.ts";

export class PrMonitorRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  all(): PrMonitor[] {
    return (
      this.store.db
        .prepare("SELECT content FROM pr_monitors ORDER BY rowid")
        .all() as { content: string }[]
    ).map((row) => JSON.parse(row.content) as PrMonitor);
  }

  get(jobId: number): PrMonitor | undefined {
    const row = this.store.db
      .prepare("SELECT content FROM pr_monitors WHERE job_id=?")
      .get(jobId) as { content: string } | undefined;
    return row && (JSON.parse(row.content) as PrMonitor);
  }

  ensure(
    implementation: Implementation,
    policyDigest: string,
    now = Date.now(),
  ): PrMonitor {
    const existing = this.get(implementation.job_id);
    if (existing) return existing;
    const publications = new PublicationRepository(this.store);
    const origin = new ImplementationRepository(this.store).published(
      implementation,
    );
    const target = publications.target(implementation.job_id);
    if (
      !origin ||
      !target.pull ||
      target.head !== origin.head ||
      implementation.recovering ||
      !implementation.scope ||
      !implementation.artifact_digest ||
      !implementation.audit_id ||
      !implementation.test_id
    )
      throw new RuntimeError("pr_handoff_invalid");
    const started = origin.published_at ?? now;
    const record: PrMonitor = {
      id: randomUUID(),
      job_id: implementation.job_id,
      implementation_id: implementation.id,
      revision: implementation.revision,
      pull_number: target.pull.number,
      expected_head: origin.head,
      observed_head: null,
      publication_id: origin.id,
      stage: "waiting",
      policy_digest: policyDigest,
      policy_generation: 1,
      generation: 0,
      snapshot_digest: null,
      assessment_digest: null,
      findings: [],
      pending_agent: null,
      recovery_attempts: [],
      mcp_done_for: null,
      readiness_id: null,
      status_operation: null,
      status_text: null,
      notification_id: null,
      started_at: started,
      head_published_at: origin.published_at,
      wait_accounted_at: Math.min(started, now),
      retry_at: 0,
      failure: null,
    };
    this.store.db
      .prepare("INSERT INTO pr_monitors VALUES(?,?,?,?)")
      .run(record.id, record.job_id, record.stage, JSON.stringify(record));
    return record;
  }

  save(record: PrMonitor) {
    this.store.db
      .prepare("UPDATE pr_monitors SET state=?,content=? WHERE id=?")
      .run(record.stage, JSON.stringify(record), record.id);
  }

  implementation(record: PrMonitor) {
    const implementation = new ImplementationRepository(this.store)
      .all()
      .find((item) => item.id === record.implementation_id);
    if (!implementation) throw new RuntimeError("pr_handoff_invalid");
    return implementation;
  }

  current(record: PrMonitor) {
    const job = this.store.jobById(record.job_id);
    if (!job || job.status !== "pending" || job.revision !== record.revision)
      throw new RuntimeError("revision_stale");
    if (this.store.hasUncertainMcpWrite(job.id))
      throw new RuntimeError("mcp_write_uncertain");
    const implementation = this.implementation(record);
    if (
      !implementation.scope ||
      digest(implementation.scope) !== implementation.scope_digest
    )
      throw new RuntimeError("implementation_scope_changed");
    this.store.assertPublishedScope(job.id);
    return job;
  }

  accountWait(record: PrMonitor, now = Date.now()) {
    if (record.wait_accounted_at === null) return;
    this.store.db
      .transaction(() => {
        const job = this.store.jobById(record.job_id)!;
        const usage = budgetUsage.parse(JSON.parse(job.budget_json));
        usage.wait_ms += Math.max(0, now - record.wait_accounted_at!);
        this.store.db
          .prepare("UPDATE jobs SET budget_json=? WHERE id=?")
          .run(JSON.stringify(usage), job.id);
        record.wait_accounted_at = now;
        this.save(record);
      })
      .immediate();
  }

  evidence<T extends PrReadiness | { job_id: number; snapshot: PrSnapshot }>(
    value: T,
  ) {
    const id = digest(value);
    this.store.db
      .prepare("INSERT OR IGNORE INTO pr_monitor_evidence VALUES(?,?,?)")
      .run(id, value.job_id, JSON.stringify(value));
    return id;
  }

  read<T>(id: string): T {
    const row = this.store.db
      .prepare("SELECT content FROM pr_monitor_evidence WHERE id=?")
      .get(id) as { content: string } | undefined;
    const value: unknown = row && JSON.parse(row.content);
    if (!value || digest(value) !== id)
      throw new RuntimeError("pr_evidence_missing");
    return value as T;
  }

  readiness(id: string) {
    const evidence = this.read<PrReadiness>(id),
      record = this.get(evidence.job_id);
    if (
      !record ||
      record.readiness_id !== id ||
      evidence.monitor_id !== record.id ||
      evidence.head_sha !== record.expected_head ||
      evidence.head_sha !== record.observed_head ||
      evidence.policy_digest !== record.policy_digest ||
      evidence.revision !== record.revision
    )
      throw new RuntimeError("pr_readiness_stale");
    this.current(record);
    if (
      ["waiting", "queued"].includes(record.stage) &&
      readinessReadFailures.has(record.failure ?? "")
    )
      throw new RuntimeError("pr_readiness_unavailable");
    if (!["ready", "queued"].includes(record.stage) || record.failure)
      throw new RuntimeError("pr_readiness_stale");
    return evidence;
  }
}
