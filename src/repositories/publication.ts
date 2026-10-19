import { randomUUID } from "node:crypto";
import { immutable } from "../config/bundles.ts";
import { budgetUsage } from "../domain/jobs.ts";
import { digest, RuntimeError } from "../domain/agents.ts";
import type { Store } from "./store.ts";
import {
  evidenceSchema,
  type PublicationEvidence,
  type PublicationReceipt,
  type PublicationTarget,
  type ReviewReceipt,
} from "../services/publication/contracts.ts";

export class PublicationRepository {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  current(job: number, revision: number) {
    const current = this.store.jobById(job);
    if (
      !current ||
      current.revision !== revision ||
      current.status !== "pending"
    )
      throw new RuntimeError("revision_stale");
    return current;
  }

  instance(): string {
    return (
      this.store.db.prepare("SELECT id FROM publication_instance").get() as {
        id: string;
      }
    ).id;
  }

  recordEvidence(input: PublicationEvidence) {
    const evidence = evidenceSchema.parse(input);
    this.current(evidence.job_id, evidence.revision);
    this.store.artifact(
      evidence.artifact_digest,
      evidence.job_id,
      evidence.revision,
    );
    const id = digest(evidence);
    this.store.db
      .prepare("INSERT OR IGNORE INTO publication_evidence VALUES(?,?)")
      .run(id, JSON.stringify(evidence));
    return id;
  }

  evidence(id: string): PublicationEvidence {
    const value = this.read<PublicationEvidence>("publication_evidence", id);
    if (!value || digest(value) !== id)
      throw new RuntimeError("publication_evidence_missing");
    return evidenceSchema.parse(value);
  }

  target(job: number): PublicationTarget {
    const value = this.store.db
      .prepare("SELECT content FROM publication_targets WHERE job_id=?")
      .get(job) as { content: string } | undefined;
    if (value) return JSON.parse(value.content) as PublicationTarget;
    const current = this.store.jobById(job);
    if (!current) throw new RuntimeError("request_invalid");
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM publications WHERE job_id=? AND kind IN ('issue_comment','pull_request','commit')",
        )
        .get(job)
    )
      throw new RuntimeError("publication_legacy_ownership");
    return {
      job_id: job,
      branch: `orm/${this.instance()}/issue-${current.issue_number}`,
      head: null,
      comment: null,
      pull: null,
    };
  }

  saveTarget(target: PublicationTarget) {
    this.store.db
      .prepare(
        "INSERT INTO publication_targets VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET content=excluded.content",
      )
      .run(target.job_id, JSON.stringify(target));
  }

  review(receipt: ReviewReceipt) {
    this.current(receipt.job_id, receipt.revision);
    this.store.db
      .prepare("INSERT INTO output_reviews VALUES(?,?)")
      .run(receipt.id, JSON.stringify(receipt));
    return immutable(receipt);
  }

  reviewed(id: string) {
    const receipt = this.read<ReviewReceipt>("output_reviews", id);
    if (!receipt) throw new RuntimeError("output_review_missing");
    return receipt;
  }

  operation(id: string) {
    return this.read<PublicationReceipt>("publication_operations", id);
  }

  begin(receipt: PublicationReceipt) {
    return this.store.db
      .transaction(() => {
        this.current(receipt.job_id, receipt.revision);
        const previous = this.operation(receipt.id);
        if (previous) return previous;
        const pending = this.store.db
          .prepare(
            "SELECT id FROM publication_operations WHERE job_id=? AND status NOT IN ('confirmed','blocked')",
          )
          .get(receipt.job_id);
        if (pending) throw new RuntimeError("publication_pending");
        this.store.db
          .prepare("INSERT INTO publication_operations VALUES(?,?,?,?)")
          .run(
            receipt.id,
            receipt.job_id,
            receipt.status,
            JSON.stringify(receipt),
          );
        return receipt;
      })
      .immediate();
  }

  save(receipt: PublicationReceipt) {
    this.store.db
      .prepare(
        "UPDATE publication_operations SET status=?,content=? WHERE id=?",
      )
      .run(receipt.status, JSON.stringify(receipt), receipt.id);
  }

  retry(receipt: PublicationReceipt) {
    this.providerReady();
    if (Date.now() < receipt.retry_at)
      throw new RuntimeError("publication_backoff");
    if (!receipt.retry_pending) return;
    this.store.db
      .transaction(() => {
        const job = this.store.jobById(receipt.job_id);
        if (!job) throw new RuntimeError("request_invalid");
        const usage = budgetUsage.parse(JSON.parse(job.budget_json));
        const limit = this.store.snapshot(job.snapshot_digest).settings.limits
          .infrastructure_retries;
        if (usage.infrastructure_retries >= limit)
          throw new RuntimeError("infrastructure_budget_exhausted");
        usage.infrastructure_retries++;
        this.store.db
          .prepare("UPDATE jobs SET budget_json=? WHERE id=?")
          .run(JSON.stringify(usage), job.id);
        receipt.retry_pending = false;
        receipt.retry_at = 0;
        this.save(receipt);
      })
      .immediate();
  }

  providerReady() {
    const { retry_at } = this.store.db
      .prepare("SELECT retry_at FROM publication_instance")
      .get() as { retry_at: number };
    if (Date.now() < retry_at) throw new RuntimeError("publication_backoff");
  }

  deferProvider(deadline: number) {
    this.store.db
      .prepare("UPDATE publication_instance SET retry_at=max(retry_at,?)")
      .run(deadline);
  }

  finishStep(receipt: PublicationReceipt, kind: "comment" | "branch" | "pull") {
    this.store.db
      .transaction(() => {
        this.saveTarget(receipt.target);
        this.save(receipt);
        const object =
          kind === "comment"
            ? receipt.target.comment
            : kind === "pull"
              ? receipt.target.pull
              : null;
        if (
          object &&
          !this.store.owns(
            kind === "comment" ? "issue_comment" : "pull_request",
            object.id,
          )
        ) {
          this.store.db
            .prepare(
              "INSERT INTO publications(operation_key,job_id,revision,kind,object_id,number,head_sha,receipt_json) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              randomUUID(),
              receipt.job_id,
              receipt.revision,
              kind === "comment" ? "issue_comment" : "pull_request",
              String(object.id),
              "number" in object ? object.number : null,
              receipt.target.head,
              JSON.stringify({ operation_id: receipt.id }),
            );
        }
      })
      .immediate();
  }

  private read<T>(
    table: "publication_evidence" | "output_reviews" | "publication_operations",
    id: string,
  ): T | undefined {
    const row = this.store.db
      .prepare(`SELECT content FROM ${table} WHERE id=?`)
      .get(id) as { content: string } | undefined;
    return row ? (JSON.parse(row.content) as T) : undefined;
  }
}
