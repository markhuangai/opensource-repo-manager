import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/repositories/store.ts";
import { InvestigationRepository } from "../src/repositories/investigation.ts";
import { ImplementationRepository } from "../src/repositories/implementation.ts";
import { PublicationRepository } from "../src/repositories/publication.ts";
import { fixtureSnapshot } from "./fixtures.ts";
import { digest, type ArtifactManifest } from "../src/domain/agents.ts";
import type { IssueContext } from "../src/domain/jobs.ts";
import {
  implementationPlanSchema,
  implementationAuditSchema,
} from "../src/services/implementation/contracts.ts";
import {
  artifactFiles,
  candidateChanges,
  assertWorkspace,
} from "../src/services/implementation/verify.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orm-implementation-"));
  cleanup.push(() => rm(root, { recursive: true }));
  const path = join(root, "state", "manager.sqlite"),
    store = new Store(path);
  cleanup.push(() => {
    if (store.db.open) store.close();
  });
  const { snapshot } = await fixtureSnapshot();
  store.saveSnapshot(snapshot);
  store.enroll({
    id: 42,
    full_name: "owner/repo",
    default_branch: "main",
    private: false,
  });
  const context: IssueContext = {
    id: 101,
    number: 1,
    title: "Bug",
    body: "A concrete maintenance defect",
    state: "open",
    updated_at: "2026-10-21T00:00:00Z",
    comments: [],
    source: {
      default_branch: "main",
      sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
    },
  };
  const apply = () =>
    store.applyIssue(store.refreshIssue(1), context, snapshot);
  apply();
  const investigations = new InvestigationRepository(store),
    publications = new PublicationRepository(store),
    repository = new ImplementationRepository(store);
  const investigation = investigations.ensure(store.job(1)!);
  const handoff = (
    outcome:
      "maintenance_candidate" | "manual_feature" = "maintenance_candidate",
  ) => {
    investigation.result = {
      outcome,
      summary: "Verified defect",
      objective: "Fix the existing behavior",
      proof: "source",
      evidence_ids: [],
      questions: [],
    };
    const operation = publications.begin({
      id: "c".repeat(64),
      job_id: 1,
      revision: 1,
      status: "confirmed",
      failure: null,
      retry_at: 0,
      retry_pending: false,
      proposal: {
        kind: "investigation",
        job_id: 1,
        revision: 1,
        investigation_id: investigation.id,
      },
      source: context.source,
      target: publications.target(1),
      actor: { id: 7, login: "fixture" },
      timestamp: new Date().toISOString(),
      review_id: "review",
      payload: { narrative: "Reviewed defect" },
      commit: null,
      steps: [],
    });
    investigation.publication_id = operation.id;
    investigations.save(investigation);
    investigations.finish(investigation);
    return store.job(1)!;
  };
  return {
    root,
    path,
    store,
    snapshot,
    context,
    apply,
    investigations,
    investigation,
    publications,
    repository,
    handoff,
  };
}

describe("durable maintenance implementation", () => {
  it("requires the reviewed maintenance handoff and excludes feature outcomes", async () => {
    const f = await fixture();
    expect(() => f.repository.ensure(f.store.job(1)!)).toThrow(
      "implementation_handoff_invalid",
    );
    f.handoff("manual_feature");
    expect(() => f.repository.ensure(f.store.job(1)!)).toThrow(
      "implementation_handoff_invalid",
    );
  });

  it("deduplicates source-only handoffs and preserves frozen checkpoints across restart", async () => {
    const f = await fixture(),
      job = f.handoff(),
      record = f.repository.ensure(job);
    record.stage = "auditing";
    record.artifact_digest = "d".repeat(64);
    f.repository.save(record);
    expect(f.repository.ensure(job)).toEqual(record);
    f.store.close();
    const restarted = new Store(f.path);
    cleanup.push(() => restarted.close());
    expect(new ImplementationRepository(restarted).current(job)).toEqual(
      record,
    );
    expect(restarted.job(1)!.phase).toBe("implementation");
  });

  it("rejects changed scope and stale source without resetting lifetime budgets", async () => {
    const f = await fixture(),
      record = f.repository.ensure(f.handoff());
    const plan = implementationPlanSchema.parse({
      acceptance: ["Existing behavior is fixed"],
      paths: ["src", "tests"],
      regression: { cwd: ".", argv: ["node", "tests/regression.mjs"] },
      checks: [],
    });
    record.scope = {
      job_id: 1,
      revision: 1,
      investigation_id: record.investigation_id,
      source: record.source,
      snapshot_digest: record.snapshot_digest,
      objective: "Fix the existing behavior",
      plan,
      checks: [plan.regression],
      remote_checks: [],
    };
    record.scope_digest = digest(record.scope);
    f.repository.assertCurrent(record);
    record.scope.objective = "Add a feature";
    expect(() => f.repository.assertCurrent(record)).toThrow(
      "implementation_scope_changed",
    );
    record.scope.objective = "Fix the existing behavior";
    f.repository.repair(record, ["A missing in-scope behavior"]);
    const used = f.store.job(1)!.budget_json;
    f.context.source = { ...f.context.source, sha: "e".repeat(40) };
    f.apply();
    expect(() => f.repository.assertCurrent(record)).toThrow("revision_stale");
    expect(f.store.job(1)!.phase).toBe("investigation");
    expect(f.store.job(1)!.budget_json).toBe(used);
  });

  it("persists the last permitted repair and invalidates selected certification", async () => {
    const f = await fixture(),
      record = f.repository.ensure(f.handoff());
    record.audit_id = "audit";
    record.test_id = "tests";
    record.candidate_bootstrap = "bootstrap";
    record.milestone_done = true;
    for (
      let cycle = 0;
      cycle < f.snapshot.settings.limits.repair_cycles;
      cycle++
    )
      f.repository.repair(record, ["Correct this acceptance gap"]);
    expect(record).toMatchObject({
      stage: "implementing",
      audit_id: null,
      test_id: null,
      candidate_bootstrap: null,
      milestone_done: false,
    });
    expect(() => f.repository.repair(record, ["Another gap"])).toThrow(
      "repair_budget_exhausted",
    );
    const budget = f.store.job(1)!.budget_json;
    f.store.close();
    const restarted = new Store(f.path);
    cleanup.push(() => restarted.close());
    expect(restarted.job(1)!.budget_json).toBe(budget);
  });

  it("keeps owned PR work in remote waiting after issue and source changes", async () => {
    const f = await fixture();
    f.handoff();
    f.store.recordPublication({
      operation_key: "owned-pr",
      job_id: 1,
      revision: 1,
      kind: "pull_request",
      object_id: "77",
      number: 77,
      head_sha: "d".repeat(40),
      receipt_json: "{}",
    });
    f.context.body = "New human information";
    f.context.source.sha = "e".repeat(40);
    f.apply();
    expect(f.store.job(1)).toMatchObject({
      phase: "remote_review",
      revision: 2,
    });
    expect(f.store.ownedPull(77)?.object_id).toBe("77");
  });

  it("migrates schema 8 additively without changing jobs or existing ownership", async () => {
    const f = await fixture();
    f.handoff();
    const jobs = f.store.jobs(),
      instance = f.publications.instance();
    f.store.db.exec("DROP TABLE implementations; PRAGMA user_version=8");
    f.store.close();
    const upgraded = new Store(f.path);
    cleanup.push(() => upgraded.close());
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(9);
    expect(upgraded.jobs()).toEqual(jobs);
    expect(new PublicationRepository(upgraded).instance()).toBe(instance);
    expect(new ImplementationRepository(upgraded).all()).toEqual([]);
  });

  it("rolls back a conflicting schema 9 migration", async () => {
    const f = await fixture();
    const jobs = f.store.jobs();
    f.store.db.exec(
      "DROP TABLE implementations; CREATE TABLE implementations(marker TEXT); INSERT INTO implementations VALUES('preserve'); PRAGMA user_version=8",
    );
    f.store.close();
    expect(() => new Store(f.path)).toThrow();
    const raw = new Database(f.path);
    try {
      expect(raw.pragma("user_version", { simple: true })).toBe(8);
      expect(raw.prepare("SELECT * FROM jobs").all()).toEqual(jobs);
      expect(raw.prepare("SELECT * FROM implementations").all()).toEqual([
        { marker: "preserve" },
      ]);
    } finally {
      raw.close();
    }
  });
});

describe("candidate and verification boundaries", () => {
  const source = {
    sha: "a".repeat(40),
    tree_sha: "b".repeat(40),
    default_branch: "main",
  };
  const base: ArtifactManifest = {
    run_id: randomUUID(),
    job_id: 1,
    revision: 1,
    source,
    files: [
      { path: "src/bug.ts", kind: "file", mode: 0o644, digest: "c".repeat(64) },
    ],
  };
  it("checks changed, added, deleted and protected paths against frozen scope", () => {
    const changed = structuredClone(base);
    changed.files[0] = {
      ...changed.files[0],
      kind: "file",
      digest: "d".repeat(64),
    };
    expect(candidateChanges(base, changed, ["src"])).toEqual(["src/bug.ts"]);
    expect(() => candidateChanges(base, changed, ["tests"])).toThrow(
      "implementation_out_of_scope",
    );
    expect(() =>
      candidateChanges(base, structuredClone(base), ["src"]),
    ).toThrow("implementation_no_change");
    changed.files = [
      {
        path: ".github/workflows/build.yml",
        kind: "file",
        mode: 0o644,
        digest: "d".repeat(64),
      },
    ];
    expect(() => candidateChanges(base, changed, ["src", ".github"])).toThrow(
      "publication_path_protected",
    );
    changed.files = [];
    expect(candidateChanges(base, changed, ["src"])).toEqual(["src/bug.ts"]);
    changed.source.sha = "f".repeat(40);
    expect(() => candidateChanges(base, changed, ["src"])).toThrow(
      "artifact_source_mismatch",
    );
  });

  it("compares audited files independently of run metadata and array ordering", () => {
    const other = { ...structuredClone(base), run_id: randomUUID() };
    expect(artifactFiles(other)).toBe(artifactFiles(base));
    other.files.push({
      path: "extra",
      kind: "file",
      mode: 0o644,
      digest: "e".repeat(64),
    });
    expect(artifactFiles(other)).not.toBe(artifactFiles(base));
  });

  it("detects real source mutations and symlink parent substitution", async () => {
    const root = await mkdtemp(join(tmpdir(), "orm-verify-source-"));
    cleanup.push(() => rm(root, { recursive: true }));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/bug.ts"), "original", { mode: 0o644 });
    const manifest = structuredClone(base);
    manifest.files = [
      {
        path: "src/bug.ts",
        kind: "file",
        mode: 0o644,
        digest: createHash("sha256").update("original").digest("hex"),
      },
    ];
    await assertWorkspace(root, manifest);
    await writeFile(join(root, "src/bug.ts"), "changed");
    await expect(assertWorkspace(root, manifest)).rejects.toThrow(
      "implementation_source_mutated",
    );
    await rm(join(root, "src"), { recursive: true });
    await mkdir(join(root, "other"));
    await writeFile(join(root, "other/bug.ts"), "original");
    await symlink("other", join(root, "src"));
    await expect(assertWorkspace(root, manifest)).rejects.toThrow(
      "implementation_source_mutated",
    );
  });

  it("rejects added files that change real Node module resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "orm-verify-membership-"));
    cleanup.push(() => rm(root, { recursive: true }));
    const files = {
      "package.json": '{"type":"commonjs"}',
      "bug.json": '{"ok":false}',
      "check.cjs":
        'require("node:assert/strict").equal(require("./bug").ok, true);',
    };
    for (const [path, content] of Object.entries(files))
      await writeFile(join(root, path), content, { mode: 0o644 });
    const manifest: ArtifactManifest = {
      ...base,
      files: Object.entries(files).map(([path, content]) => ({
        path,
        kind: "file",
        mode: 0o644,
        digest: createHash("sha256").update(content).digest("hex"),
      })),
    };
    const run = () => spawnSync(process.execPath, ["check.cjs"], { cwd: root });
    expect(run().status).toBe(1);
    await assertWorkspace(root, manifest);
    await writeFile(join(root, "bug.js"), "module.exports = {ok: true};");
    expect(run().status).toBe(0);
    await expect(assertWorkspace(root, manifest)).rejects.toThrow(
      "implementation_source_mutated",
    );
    await rm(join(root, "bug.js"));
    await symlink("bug.json", join(root, "bug.js"));
    await expect(assertWorkspace(root, manifest)).rejects.toThrow(
      "implementation_source_mutated",
    );
  });

  it("permits dependency outputs while protecting original dependency source", async () => {
    const root = await mkdtemp(join(tmpdir(), "orm-verify-dependencies-"));
    cleanup.push(() => rm(root, { recursive: true }));
    const path = "node_modules/tracked.cjs";
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, path), "original", { mode: 0o644 });
    const manifest: ArtifactManifest = {
      ...base,
      files: [
        {
          path,
          kind: "file",
          mode: 0o644,
          digest: createHash("sha256").update("original").digest("hex"),
        },
      ],
    };
    for (const output of [
      "node_modules/dependency/index.cjs",
      "packages/child/node_modules/dependency/index.cjs",
      ".yarn/cache/dependency.zip",
      ".yarn/install-state.gz",
      ".yarn/unplugged/dependency/index.cjs",
      ".pnp.cjs",
      ".pnp.loader.mjs",
      ".git/HEAD",
    ]) {
      await mkdir(join(root, output, ".."), { recursive: true });
      await writeFile(join(root, output), "generated");
    }
    await assertWorkspace(root, manifest);
    await writeFile(join(root, path), "changed");
    await expect(assertWorkspace(root, manifest)).rejects.toThrow(
      "implementation_source_mutated",
    );
  });

  it("rejects malformed audit bindings and unsafe command paths", () => {
    expect(
      implementationAuditSchema.safeParse({
        approved: true,
        findings: [],
        scope_digest: "forged",
        artifact_digest: "d".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      implementationPlanSchema.safeParse({
        acceptance: ["Fix"],
        paths: ["../escape"],
        regression: { cwd: ".", argv: ["node", "test.mjs"] },
        checks: [],
      }).success,
    ).toBe(false);
  });
});
