import { mkdtemp, rm, chmod, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/repositories/store.ts";
import Database from "better-sqlite3";
import type { IssueContext } from "../src/domain/jobs.ts";
import { fixtureSnapshot } from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";

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
    store.db.pragma("user_version = 2");
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
});
