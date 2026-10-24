import { mkdtemp, rm, chmod, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/repositories/store.ts";
import Database from "better-sqlite3";
import type { IssueContext } from "../src/domain/jobs.ts";
import { fixtureSnapshot } from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";
import { digest } from "../src/domain/agents.ts";
import { PublicationRepository } from "../src/repositories/publication.ts";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
async function database() {
  const root = await mkdtemp(join(tmpdir(), "orm-storage-"));
  roots.push(root);
  const path = join(root, "state", "manager.sqlite");
  const store = new Store(path);
  stores.push(store);
  const { snapshot } = await fixtureSnapshot();
  store.saveSnapshot(snapshot);
  store.enroll({
    id: 42,
    full_name: "owner/repo",
    default_branch: "main",
    private: true,
  });
  return { root, path, store, snapshot };
}
function context(number = 1): IssueContext {
  return {
    ...makeIssue(number),
    state: "open",
    comments: [],
    source: {
      default_branch: "main",
      sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
    },
  };
}
function seed(
  store: Store,
  snapshot: Awaited<ReturnType<typeof fixtureSnapshot>>["snapshot"],
  number = 1,
) {
  store.discover([number], 1, true);
  store.applyIssue(store.nextDirty()!, context(number), snapshot);
  return store.job(number)!;
}

describe("durable SQLite repositories", () => {
  it("upgrades schema 5 additively and preserves schema 6 delivery records across reopen", async () => {
    const { store, path, snapshot } = await database();
    seed(store, snapshot);
    const jobs = store.jobs();
    const instance = new PublicationRepository(store).instance();
    store.db.exec(
      "DROP TABLE pr_observations; DROP TABLE pr_monitor_evidence; DROP TABLE pr_monitors; DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; DROP TABLE notification_backoff; DROP TABLE notification_deliveries; DROP TABLE notification_events; PRAGMA user_version=5",
    );
    store.close();
    const upgraded = new Store(path);
    stores.push(upgraded);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(10);
    expect(upgraded.jobs()).toEqual(jobs);
    expect(upgraded.snapshot(snapshot.digest)).toEqual(snapshot);
    expect(new PublicationRepository(upgraded).instance()).toBe(instance);
    upgraded.db
      .prepare("INSERT INTO notification_events VALUES(?,?,NULL)")
      .run("event", "{}");
    upgraded.db
      .prepare("INSERT INTO notification_deliveries VALUES(?,?,?,?,?)")
      .run("event", "webhook", "confirmed", 0, '{"receipt":"preserve"}');
    upgraded.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(
      reopened.db.prepare("SELECT content FROM notification_deliveries").get(),
    ).toEqual({ content: '{"receipt":"preserve"}' });
  });
  it("rolls back a conflicting schema 6 migration without changing schema 5 state", async () => {
    const { store, path, snapshot } = await database();
    seed(store, snapshot);
    const jobs = store.jobs();
    store.db.exec(
      "DROP TABLE pr_observations; DROP TABLE pr_monitor_evidence; DROP TABLE pr_monitors; DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; DROP TABLE notification_backoff; DROP TABLE notification_deliveries; DROP TABLE notification_events; CREATE TABLE notification_deliveries(marker TEXT); INSERT INTO notification_deliveries VALUES('preserve'); PRAGMA user_version=5",
    );
    store.close();
    expect(() => new Store(path)).toThrow();
    const inspected = new Database(path);
    try {
      expect(inspected.pragma("user_version", { simple: true })).toBe(5);
      expect(inspected.prepare("SELECT * FROM jobs").all()).toEqual(jobs);
      expect(
        inspected.prepare("SELECT * FROM notification_deliveries").all(),
      ).toEqual([{ marker: "preserve" }]);
      expect(
        inspected
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='notification_events'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      inspected.close();
    }
  });
  it.each(["issue_comment", "pull_request"] as const)(
    "upgrades v4 %s state without changing existing jobs, ownership, budgets or snapshots",
    async (kind) => {
      const { store, path, snapshot } = await database();
      const job = seed(store, snapshot);
      store.recordPublication({
        operation_key: "legacy",
        job_id: job.id,
        revision: job.revision,
        kind,
        object_id: "88",
        number: kind === "pull_request" ? 88 : null,
        head_sha: null,
        receipt_json: "{}",
      });
      const before = {
        jobs: store.jobs(),
        snapshots: store.snapshot(snapshot.digest),
        publications: store.db.prepare("SELECT * FROM publications").all(),
      };
      store.db.exec(
        "DROP TABLE pr_observations; DROP TABLE pr_monitor_evidence; DROP TABLE pr_monitors; DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; DROP TABLE notification_backoff; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE publication_operations; DROP TABLE publication_targets; DROP TABLE output_reviews; DROP TABLE publication_evidence; DROP TABLE publication_instance; PRAGMA user_version=4",
      );
      store.close();
      const upgraded = new Store(path);
      stores.push(upgraded);
      expect(upgraded.db.pragma("user_version", { simple: true })).toBe(10);
      expect({
        jobs: upgraded.jobs(),
        snapshots: upgraded.snapshot(snapshot.digest),
        publications: upgraded.db.prepare("SELECT * FROM publications").all(),
      }).toEqual(before);
      const repository = new PublicationRepository(upgraded),
        instance = repository.instance();
      upgraded.close();
      const reopened = new Store(path);
      stores.push(reopened);
      expect(new PublicationRepository(reopened).instance()).toBe(instance);
      expect(reopened.owns(kind, 88)).toBe(true);
      expect(() => new PublicationRepository(reopened).target(job.id)).toThrow(
        "publication_legacy_ownership",
      );
    },
  );
  it("rolls back the entire v5 migration on a schema conflict", async () => {
    const { store, path, snapshot } = await database();
    seed(store, snapshot);
    const before = store.jobs();
    store.db.exec(
      "DROP TABLE pr_observations; DROP TABLE pr_monitor_evidence; DROP TABLE pr_monitors; DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; DROP TABLE notification_backoff; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE publication_operations; DROP TABLE publication_targets; DROP TABLE output_reviews; DROP TABLE publication_evidence; DROP TABLE publication_instance; CREATE TABLE publication_evidence(marker TEXT); INSERT INTO publication_evidence VALUES('preserve'); PRAGMA user_version=4",
    );
    store.close();
    expect(() => new Store(path)).toThrow();
    const inspected = new Database(path);
    try {
      expect(inspected.pragma("user_version", { simple: true })).toBe(4);
      expect(inspected.prepare("SELECT * FROM jobs").all()).toEqual(before);
      expect(
        inspected.prepare("SELECT * FROM publication_evidence").all(),
      ).toEqual([{ marker: "preserve" }]);
      expect(
        inspected
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='publication_instance'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      inspected.close();
    }
  });
  it("keeps confirmed publication heads separate from intake-observed heads", async () => {
    const { store, snapshot } = await database(),
      job = seed(store, snapshot),
      repository = new PublicationRepository(store);
    const target = repository.target(job.id);
    target.head = "a".repeat(40);
    repository.saveTarget(target);
    store.recordPublication({
      operation_key: "pull",
      job_id: job.id,
      revision: job.revision,
      kind: "pull_request",
      object_id: "77",
      number: 77,
      head_sha: target.head,
      receipt_json: "{}",
    });
    store.reconcileKnown();
    const dirty = store.db
      .prepare("SELECT kind,number,generation FROM dirty WHERE kind='pull'")
      .get() as { kind: "pull"; number: number; generation: number };
    store.applyPull(dirty, {
      id: 77,
      number: 77,
      state: "open",
      head_sha: "b".repeat(40),
      updated_at: "2026-10-19T00:00:00Z",
      comments: [],
      reviews: [],
      review_comments: [],
      checks: [],
      statuses: [],
    });
    expect(store.ownedPull(77)!.head_sha).toBe("b".repeat(40));
    expect(repository.target(job.id).head).toBe("a".repeat(40));
  });
  it("rolls back an interrupted initial migration without leaving partial tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "orm-migration-"));
    roots.push(root);
    const path = join(root, "manager.sqlite");
    const initial = new Database(path);
    initial.exec("CREATE TABLE jobs(id INTEGER PRIMARY KEY)");
    initial.close();
    await chmod(path, 0o600);
    expect(() => new Store(path)).toThrow();
    const inspected = new Database(path);
    try {
      expect(inspected.pragma("user_version", { simple: true })).toBe(0);
      expect(
        inspected
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all(),
      ).toEqual([{ name: "jobs" }]);
    } finally {
      inspected.close();
    }
  });
  it("creates protected WAL state and rejects repository replacement and newer schemas", async () => {
    const { store, path } = await database();
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(store.db.pragma("synchronous", { simple: true })).toBe(2);
    expect(() =>
      store.enroll({
        id: 99,
        full_name: "other/repo",
        default_branch: "main",
        private: false,
      }),
    ).toThrow("repository_changed");
    store.db.pragma("user_version = 11");
    store.close();
    expect(() => new Store(path)).toThrow("schema_unsupported");
  });
  it("rejects exposed database files and symlinked state", async () => {
    const { store, path, root } = await database();
    store.close();
    await chmod(path, 0o644);
    expect(() => new Store(path)).toThrow("storage_permissions");
    await symlink(join(root, "state"), join(root, "linked"));
    expect(() => new Store(join(root, "linked", "other.sqlite"))).toThrow(
      "storage_permissions",
    );
  });
  it("rolls back failed inbox persistence and deduplicates deliveries transactionally", async () => {
    const { store } = await database();
    store.db.exec(
      "CREATE TRIGGER reject_target BEFORE INSERT ON dirty BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    expect(() =>
      store.accept("delivery", "digest", "issues", [
        { kind: "issue", number: 1 },
      ]),
    ).toThrow();
    expect(store.db.prepare("SELECT count(*) AS n FROM inbox").get()).toEqual({
      n: 0,
    });
    store.db.exec("DROP TRIGGER reject_target");
    expect(
      store.accept("delivery", "digest", "issues", [
        { kind: "issue", number: 1 },
      ]),
    ).toBe(true);
    expect(
      store.accept("delivery", "digest", "issues", [
        { kind: "issue", number: 1 },
      ]),
    ).toBe(false);
    expect(() => store.accept("delivery", "different", "issues", [])).toThrow(
      "delivery_conflict",
    );
    expect(store.counts().inbox).toBe(1);
  });
  it("fences stale reads, preserves snapshots and budgets, and reuses closed workflows", async () => {
    const { store, snapshot } = await database();
    const job = seed(store, snapshot);
    const token = store.acquireLease(job.id, job.revision)!;
    expect(
      store.updateBudget(job.id, job.revision, token, {
        active_ms: 10,
        model_requests: 2,
        repair_cycles: 1,
        infrastructure_retries: 1,
        wait_ms: 3,
      }),
    ).toBe(true);
    store.discover([1], 1, true);
    const stale = store.nextDirty()!;
    store.accept("new", "hash", "issues", [{ kind: "issue", number: 1 }]);
    expect(
      store.applyIssue(stale, { ...context(), state: "closed" }, snapshot),
    ).toBe(false);
    const next = await fixtureSnapshot("new-model");
    store.saveSnapshot(next.snapshot);
    store.applyIssue(
      store.nextDirty()!,
      { ...context(), state: "closed" },
      next.snapshot,
    );
    const closed = store.job(1)!;
    expect(closed.status).toBe("closed");
    expect(closed.snapshot_digest).toBe(snapshot.digest);
    expect(JSON.parse(closed.budget_json).model_requests).toBe(2);
    expect(
      store.updateBudget(job.id, job.revision, token, {
        active_ms: 0,
        model_requests: 0,
        repair_cycles: 0,
        infrastructure_retries: 0,
        wait_ms: 0,
      }),
    ).toBe(false);
    store.discover([1], 1, true);
    store.applyIssue(store.nextDirty()!, context(), next.snapshot);
    expect(store.jobs()).toHaveLength(1);
    expect(store.job(1)!.id).toBe(job.id);
    expect(store.job(1)!.revision).toBe(closed.revision + 1);
    expect(
      store.snapshot(snapshot.digest).roles.investigation.profile.model,
    ).toBe("fixture-model");
    expect(() => {
      store.snapshot(snapshot.digest).roles.audit.profile.model = "mutated";
    }).toThrow();
    expect(store.acquireLease(job.id, store.job(1)!.revision)).toBeUndefined();
    expect(store.releaseLease(token)).toBe(true);
  });
  it("retains cursors, pending deliveries, leases and publication receipts across connections", async () => {
    const { store, path, snapshot } = await database();
    const job = seed(store, snapshot);
    const secondJob = seed(store, snapshot, 2);
    const second = new Store(path);
    stores.push(second);
    const token = store.acquireLease(job.id, job.revision)!;
    expect(
      store.updateBudget(job.id, job.revision, token, {
        active_ms: 25,
        model_requests: 4,
        repair_cycles: 1,
        infrastructure_retries: 0,
        wait_ms: 6,
      }),
    ).toBe(true);
    expect(
      second.acquireLease(secondJob.id, secondJob.revision),
    ).toBeUndefined();
    const publication = {
      operation_key: "publish-comment",
      job_id: job.id,
      revision: job.revision,
      kind: "issue_comment" as const,
      object_id: "123",
      number: null,
      head_sha: null,
      receipt_json: '{"confirmed":true}',
    };
    store.recordPublication(publication);
    store.recordPublication(publication);
    expect(() =>
      store.recordPublication({ ...publication, receipt_json: "{}" }),
    ).toThrow("publication_conflict");
    store.discover([3], 1, false);
    store.accept("queued", "digest", "issues", [{ kind: "issue", number: 3 }]);
    store.close();
    second.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.cursor().page).toBe(2);
    expect(reopened.nextDirty()?.number).toBe(3);
    expect(reopened.counts().inbox).toBe(1);
    expect(reopened.owns("issue_comment", 123)).toBe(true);
    expect(JSON.parse(reopened.job(1)!.budget_json).model_requests).toBe(4);
    expect(
      reopened.acquireLease(secondJob.id, secondJob.revision),
    ).toBeUndefined();
    expect(reopened.releaseLease("forged")).toBe(false);
    expect(reopened.releaseLease(token)).toBe(true);
    expect(reopened.acquireLease(secondJob.id, secondJob.revision)).toBeTypeOf(
      "string",
    );
  });

  it("clears only fresh webhook deferrals and fences stale completion and failure", async () => {
    const { store, snapshot } = await database();
    seed(store, snapshot);
    const target = { kind: "issue" as const, number: 1 };
    store.accept("first", "digest", "issues", [target]);
    const stale = store.nextDirty()!;
    const retry = Date.now() + 300_000;
    store.defer(stale, "secret_in_input", retry);
    store.discover([1], 1, true);
    store.reconcileKnown();
    expect(store.nextDirty()).toBeUndefined();
    expect(store.nextRetry()).toBe(retry);
    expect(store.accept("first", "digest", "issues", [target])).toBe(false);
    expect(store.nextRetry()).toBe(retry);
    store.accept("fresh", "new-digest", "issues", [target]);
    const fresh = store.nextDirty()!;
    expect(fresh.generation).toBeGreaterThan(stale.generation);
    expect(store.counts().failed).toBe(0);
    expect(store.nextRetry()).toBeUndefined();
    store.defer(stale, "old_failure", retry);
    expect(
      store.applyIssue(stale, { ...context(), body: "stale read" }, snapshot),
    ).toBe(false);
    expect(store.counts().inbox).toBe(2);
    expect(store.applyIssue(fresh, context(), snapshot)).toBe(true);
    expect(store.counts().inbox).toBe(0);
    expect(
      store.db
        .prepare("SELECT processed FROM inbox ORDER BY delivery_id")
        .all(),
    ).toEqual([{ processed: 1 }, { processed: 1 }]);
  });

  it("upgrades v1 runtime state transactionally without rewriting old snapshots or budgets", async () => {
    const { store, path, snapshot } = await database();
    const job = seed(store, snapshot),
      token = store.acquireLease(job.id, job.revision)!;
    const legacy = JSON.parse(JSON.stringify(snapshot));
    delete legacy.digest;
    delete legacy.settings.limits.worker_processes;
    delete legacy.settings.limits.worker_output_bytes;
    delete legacy.settings.limits.worker_storage_bytes;
    legacy.digest = digest(legacy);
    store.saveSnapshot(legacy);
    store.db
      .prepare("UPDATE jobs SET snapshot_digest=? WHERE id=?")
      .run(legacy.digest, job.id);
    const before = JSON.stringify(store.snapshot(legacy.digest));
    const budget = store.job(1)!.budget_json;
    store.db.exec(
      "DROP TABLE pr_observations; DROP TABLE pr_monitor_evidence; DROP TABLE pr_monitors; DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; DROP TABLE notification_backoff; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE publication_operations; DROP TABLE publication_targets; DROP TABLE output_reviews; DROP TABLE publication_evidence; DROP TABLE publication_instance; DROP TABLE bootstrap_commands; DROP TABLE bootstrap_attempts; DROP TABLE mcp_calls; DROP TABLE artifacts; DROP TABLE agent_runs; DROP TABLE runtime_leases; PRAGMA user_version=1",
    );
    store.close();
    const upgraded = new Store(path);
    stores.push(upgraded);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(10);
    expect(JSON.stringify(upgraded.snapshot(legacy.digest))).toBe(before);
    expect(upgraded.job(1)!.budget_json).toBe(budget);
    expect(upgraded.leases()).toMatchObject([{ token }]);
    expect(upgraded.runs()).toEqual([]);
  });

  it("upgrades v2 without changing jobs or runs and preserves call receipts through recovery", async () => {
    const { store, path, snapshot } = await database();
    const job = seed(store, snapshot),
      token = store.acquireLease(job.id, job.revision)!;
    store.startRuntimeLease(token, 10000);
    const run = {
      id: "mcp-run",
      job_id: job.id,
      revision: job.revision,
      role: "investigation" as const,
      uid: 10001,
      parent_id: null,
      lease_token: token,
      binding_json: "{}",
    };
    store.startRun(run);
    const before = {
      jobs: store.jobs(),
      runs: store.runs(),
      snapshot: store.snapshot(snapshot.digest),
    };
    store.db.exec(
      "DROP TABLE pr_observations; DROP TABLE pr_monitor_evidence; DROP TABLE pr_monitors; DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; DROP TABLE notification_backoff; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE publication_operations; DROP TABLE publication_targets; DROP TABLE output_reviews; DROP TABLE publication_evidence; DROP TABLE publication_instance; DROP TABLE bootstrap_commands; DROP TABLE bootstrap_attempts; DROP TABLE mcp_calls; PRAGMA user_version=2",
    );
    store.close();
    const upgraded = new Store(path);
    stores.push(upgraded);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(10);
    expect({
      jobs: upgraded.jobs(),
      runs: upgraded.runs(),
      snapshot: upgraded.snapshot(snapshot.digest),
    }).toEqual(before);
    const receipt = {
      id: "call",
      run_id: run.id,
      job_id: job.id,
      revision: job.revision,
      role: run.role,
      alias: "context",
      tool: "read",
      credential_binding: "a".repeat(64),
      policy_identity: "b".repeat(64),
      catalog_identity: "c".repeat(64),
      request_digest: "d".repeat(64),
      started_at: Date.now(),
    };
    upgraded.startMcpCall(receipt);
    upgraded.close();
    const recovered = new Store(path);
    stores.push(recovered);
    recovered.interruptMcpCalls();
    expect(recovered.mcpCalls()).toMatchObject([
      { ...receipt, outcome: "interrupted", result_digest: null },
    ]);
    expect(recovered.mcpCalls()[0].finished_at).not.toBeNull();
    recovered.startMcpCall({ ...receipt, id: "completed" });
    recovered.finishMcpCall("completed", "completed", "e".repeat(64));
    recovered.interruptMcpCalls();
    expect(recovered.mcpCalls().at(-1)?.outcome).toBe("completed");
    expect(() => recovered.finishMcpCall("completed", "failed", null)).toThrow(
      "mcp_receipt_not_active",
    );
    recovered.finishRun(run.id, "completed", null, null);
    expect(() => recovered.startMcpCall({ ...receipt, id: "stale" })).toThrow(
      "revision_stale",
    );
  });

  it("rolls back a failed v3 migration without changing v2 data", async () => {
    const { store, path, snapshot } = await database();
    seed(store, snapshot);
    const jobs = store.jobs();
    store.db.exec(
      "DROP TABLE pr_observations; DROP TABLE pr_monitor_evidence; DROP TABLE pr_monitors; DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; DROP TABLE notification_backoff; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE publication_operations; DROP TABLE publication_targets; DROP TABLE output_reviews; DROP TABLE publication_evidence; DROP TABLE publication_instance; DROP TABLE bootstrap_commands; DROP TABLE bootstrap_attempts; DROP TABLE mcp_calls; CREATE TABLE mcp_calls(marker TEXT); INSERT INTO mcp_calls VALUES('preserve'); PRAGMA user_version=2",
    );
    store.close();
    expect(() => new Store(path)).toThrow();
    const inspected = new Database(path);
    try {
      expect(inspected.pragma("user_version", { simple: true })).toBe(2);
      expect(inspected.prepare("SELECT * FROM jobs").all()).toEqual(jobs);
      expect(inspected.prepare("SELECT * FROM mcp_calls").all()).toEqual([
        { marker: "preserve" },
      ]);
    } finally {
      inspected.close();
    }
  });

  it("upgrades v3 transactionally while preserving jobs, budgets, snapshots, sessions and MCP evidence", async () => {
    const { store, path, snapshot } = await database();
    const job = seed(store, snapshot),
      token = store.acquireLease(job.id, job.revision)!;
    store.startRuntimeLease(token, 60000);
    store.startRun({
      id: "v3-preserved",
      job_id: job.id,
      revision: job.revision,
      role: "implementation",
      uid: 10001,
      parent_id: null,
      lease_token: token,
      binding_json: '{"binding":"preserved"}',
    });
    store.startMcpCall({
      id: "v3-call",
      run_id: "v3-preserved",
      job_id: job.id,
      revision: job.revision,
      role: "implementation",
      alias: "context",
      tool: "read",
      credential_binding: "a".repeat(64),
      policy_identity: "b".repeat(64),
      catalog_identity: "c".repeat(64),
      request_digest: "d".repeat(64),
      started_at: Date.now(),
    });
    store.finishMcpCall("v3-call", "completed", "e".repeat(64));
    store.finishRun("v3-preserved", "completed", "saved-session", null);
    const before = {
      jobs: store.jobs(),
      runs: store.runs(),
      calls: store.mcpCalls(),
      snapshot: store.snapshot(snapshot.digest),
    };
    store.db.exec(
      "DROP TABLE pr_observations; DROP TABLE pr_monitor_evidence; DROP TABLE pr_monitors; DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; DROP TABLE notification_backoff; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE publication_operations; DROP TABLE publication_targets; DROP TABLE output_reviews; DROP TABLE publication_evidence; DROP TABLE publication_instance; DROP TABLE bootstrap_commands; DROP TABLE bootstrap_attempts; PRAGMA user_version=3",
    );
    store.close();
    const upgraded = new Store(path);
    stores.push(upgraded);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(10);
    expect({
      jobs: upgraded.jobs(),
      runs: upgraded.runs(),
      calls: upgraded.mcpCalls(),
      snapshot: upgraded.snapshot(snapshot.digest),
    }).toEqual(before);
    expect(
      upgraded.db.prepare("SELECT count(*) AS n FROM bootstrap_attempts").get(),
    ).toEqual({ n: 0 });
  });

  it("rolls back a failed v4 migration without changing v3 state", async () => {
    const { store, path, snapshot } = await database();
    seed(store, snapshot);
    const before = store.jobs();
    store.db.exec(
      "DROP TABLE pr_observations; DROP TABLE pr_monitor_evidence; DROP TABLE pr_monitors; DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; DROP TABLE notification_backoff; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE publication_operations; DROP TABLE publication_targets; DROP TABLE output_reviews; DROP TABLE publication_evidence; DROP TABLE publication_instance; DROP TABLE bootstrap_commands; DROP TABLE bootstrap_attempts; CREATE TABLE bootstrap_attempts(marker TEXT); INSERT INTO bootstrap_attempts VALUES('preserve'); PRAGMA user_version=3",
    );
    store.close();
    expect(() => new Store(path)).toThrow();
    const inspected = new Database(path);
    try {
      expect(inspected.pragma("user_version", { simple: true })).toBe(3);
      expect(inspected.prepare("SELECT * FROM jobs").all()).toEqual(before);
      expect(
        inspected.prepare("SELECT * FROM bootstrap_attempts").all(),
      ).toEqual([{ marker: "preserve" }]);
      expect(
        inspected
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='bootstrap_commands'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      inspected.close();
    }
  });

  it("atomically shares model budgets across connections and rejects stale leases", async () => {
    const { store, path, snapshot } = await database();
    const job = seed(store, snapshot),
      token = store.acquireLease(job.id, job.revision)!;
    const deadline = store.startRuntimeLease(token, 10000);
    const second = new Store(path);
    stores.push(second);
    expect(store.reserveModelRequest(token, 2)).toBe(true);
    expect(second.reserveModelRequest(token, 2)).toBe(true);
    expect(store.reserveModelRequest(token, 2)).toBe(false);
    expect(JSON.parse(store.job(1)!.budget_json).model_requests).toBe(2);
    const started = (
      store.db.prepare("SELECT accounted_at FROM runtime_leases").get() as {
        accounted_at: number;
      }
    ).accounted_at;
    store.accountActive(token, started + 25);
    second.accountActive(token, started + 25);
    expect(JSON.parse(store.job(1)!.budget_json).active_ms).toBe(25);
    store.discover([1], 1, true);
    store.applyIssue(
      store.nextDirty()!,
      { ...context(), body: "changed" },
      snapshot,
    );
    expect(store.runtimeCurrent(token)).toBe(false);
    expect(second.reserveModelRequest(token, 20)).toBe(false);
    store.accountActive(token, deadline + 10000);
    expect(JSON.parse(store.job(1)!.budget_json).active_ms).toBe(10000);
    expect(store.releaseLease(token)).toBe(true);
    expect(store.db.prepare("SELECT * FROM runtime_leases").all()).toEqual([]);
  });

  it("retains role occupancy and refuses an artifact until a current run finishes", async () => {
    const { store, snapshot } = await database();
    const job = seed(store, snapshot);
    const token = store.acquireLease(job.id, job.revision)!;
    store.startRuntimeLease(token, 10000);
    const run = {
      id: "run",
      job_id: job.id,
      revision: job.revision,
      role: "implementation" as const,
      uid: 10001,
      parent_id: null,
      lease_token: token,
      binding_json: "{}",
    };
    store.startRun(run);
    expect(store.releaseLease(token)).toBe(false);
    expect(() => store.startRun({ ...run, id: "other" })).toThrow();
    const artifact = store.recordArtifact({
      run_id: run.id,
      job_id: job.id,
      revision: job.revision,
      source: context().source,
      files: [],
    });
    expect(() => store.artifact(artifact, job.id, job.revision)).toThrow(
      "artifact_unavailable",
    );
    store.finishRun(run.id, "completed", "session", artifact);
    expect(
      store.sessionRun(job.id, job.revision, "implementation", "session")?.id,
    ).toBe(run.id);
    expect(
      store.sessionRun(job.id, job.revision + 1, "implementation", "session"),
    ).toBeUndefined();
    expect(
      store.sessionRun(job.id, job.revision, "audit", "session"),
    ).toBeUndefined();
    const review = {
      ...run,
      id: "review",
      role: "output_review" as const,
      uid: 10003,
      parent_id: run.id,
    };
    store.startRun(review);
    expect(store.releaseLease(token)).toBe(false);
    store.finishRun(review.id, "failed", null, null);
    expect(store.artifact(artifact, job.id, job.revision)).toMatchObject({
      run_id: run.id,
    });
    store.startRun({ ...run, id: "next" });
    store.discover([1], 1, true);
    store.applyIssue(
      store.nextDirty()!,
      { ...context(), body: "changed" },
      snapshot,
    );
    expect(() =>
      store.recordArtifact({
        run_id: "next",
        job_id: job.id,
        revision: job.revision,
        source: context().source,
        files: [],
      }),
    ).toThrow("revision_stale");
  });
});
