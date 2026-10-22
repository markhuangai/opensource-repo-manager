import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { digest } from "../src/domain/agents.ts";
import { Store } from "../src/repositories/store.ts";
import { McpWriteRepository } from "../src/repositories/mcp-writes.ts";
import { snapshotTool, writeTool } from "../src/services/mcp/catalog.ts";
import {
  canonical,
  reviewedWriteInput,
  type McpWriteOperation,
} from "../src/services/mcp-writes/contracts.ts";
import { resolveWriteEvidence } from "../src/services/mcp-writes/evidence.ts";
import { PublicationRepository } from "../src/repositories/publication.ts";
import {
  policyIdentity,
  PublicationScanner,
} from "../src/services/publication/scanner.ts";
import { fixtureSnapshot } from "./fixtures.ts";
import { createPublicationFixture } from "./fixtures/publication.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orm-writes-"));
  cleanups.push(() => rm(root, { recursive: true }));
  const loaded = await fixtureSnapshot(),
    path = join(root, "state", "db"),
    store = new Store(path);
  cleanups.push(async () => {
    if (store.db.open) store.close();
  });
  store.enroll({
    id: 42,
    full_name: "owner/repo",
    default_branch: "main",
    private: false,
  });
  store.saveSnapshot(loaded.snapshot);
  const context = {
    id: 11,
    number: 1,
    state: "open" as const,
    title: "Captured fact",
    body: "The issue requests a correction.",
    updated_at: "2026-10-20",
    comments: [],
    source: {
      sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
      default_branch: "main",
    },
  };
  store.discover([1], 1, true);
  store.applyIssue(store.nextDirty()!, context, loaded.snapshot);
  const job = store.job(1)!,
    repository = new McpWriteRepository(store);
  const operation = (id = "operation"): McpWriteOperation => ({
    id,
    job_id: job.id,
    revision: job.revision,
    state: "proposed",
    binding: {
      repository_id: 42,
      repository: "owner/repo",
      job_id: job.id,
      revision: job.revision,
      phase: job.phase,
      run_id: "parent",
      role: "implementation",
      snapshot_digest: job.snapshot_digest,
      source: context.source,
      artifact_digest: null,
      alias: "generic",
      endpoint: "https://example.invalid/mcp",
      tool: "store_record",
      credential_binding: "a".repeat(64),
      policy_identity: "b".repeat(64),
      scanner_policy: policyIdentity,
      catalog_identity: "c".repeat(64),
      review_required: false,
      idempotency_argument: "key",
    },
    request_digest: digest({ key: "controller-key", text: "captured" }),
    arguments: { key: "controller-key", text: "captured" },
    purpose: null,
    evidence: null,
    idempotency_key: "controller-key",
    review_id: null,
    review: "not_required",
    deadline: Date.now() + 60000,
    created_at: Date.now(),
    updated_at: Date.now(),
    failure: null,
    response: null,
    notification: null,
  });
  return { root, path, loaded, store, job, context, repository, operation };
}

describe("MCP write schema and evidence contracts", () => {
  const provider = {
    name: "remember",
    inputSchema: {
      type: "object" as const,
      properties: { text: { type: "string" }, key: { type: "string" } },
      required: ["text", "key"],
      additionalProperties: false,
      minProperties: 2,
      maxProperties: 2,
    },
  };
  it("projects a controller-owned key and independently validates final upstream arguments", () => {
    const upstream = snapshotTool(provider),
      visible = writeTool(provider, false, "key");
    expect(visible.input({ text: "claim" })).toBe(true);
    expect(visible.input({ text: "claim", key: "worker" })).toBe(false);
    expect(visible.tool.inputSchema.properties).not.toHaveProperty("key");
    expect(upstream.input({ text: "claim" })).toBe(false);
    expect(upstream.input({ text: "claim", key: "generated" })).toBe(true);
    const reviewed = writeTool(provider, true, "key");
    expect(
      reviewed.input({
        arguments: { text: "claim" },
        purpose: "Save captured context",
        evidence: [{ kind: "job" }],
      }),
    ).toBe(true);
    expect(reviewed.input({ text: "claim" })).toBe(false);
    expect(
      reviewed.input({
        arguments: { text: "claim", key: "worker" },
        purpose: "purpose",
        evidence: [{ kind: "job" }],
      }),
    ).toBe(false);
  });
  it("keeps 2020 schema constraints and rejects unsafe references or key dependencies before discovery", () => {
    const modern = {
      name: "store",
      inputSchema: {
        type: "object" as const,
        $schema: "https://json-schema.org/draft/2020-12/schema",
        properties: { text: { type: "string" } },
        unevaluatedProperties: false,
      },
    };
    const projected = writeTool(modern, true);
    expect(
      projected.input({
        arguments: { text: "claim", extra: 1 },
        purpose: "purpose",
        evidence: [{ kind: "job" }],
      }),
    ).toBe(false);
    for (const inputSchema of [
      {
        ...provider.inputSchema,
        properties: {
          ...provider.inputSchema.properties,
          key: {
            type: "string",
            const: "00000000-0000-4000-8000-000000000000",
          },
        },
      },
      {
        ...provider.inputSchema,
        properties: {
          ...provider.inputSchema.properties,
          key: { type: "string", pattern: "^fixed$" },
        },
      },
      { ...provider.inputSchema, maxProperties: 0 },
      { ...provider.inputSchema, dependentRequired: { text: ["key"] } },
      { ...provider.inputSchema, allOf: [{ required: ["key"] }] },
      {
        ...provider.inputSchema,
        properties: { text: { $ref: "#/$defs/text" }, key: { type: "string" } },
        $defs: { text: { type: "string" } },
      },
      {
        ...provider.inputSchema,
        patternProperties: { "^key$": { type: "string" } },
      },
    ])
      expect(() =>
        writeTool({ ...provider, inputSchema }, true, "key"),
      ).toThrow("mcp_schema_projection_unsafe");
  });
  it("rejects arbitrary proof text, URLs, empty purposes, ranges and unknown envelope fields", () => {
    const base = {
      arguments: { text: "claim" },
      purpose: "purpose",
      evidence: [{ kind: "job" }],
    };
    for (const value of [
      { ...base, purpose: " " },
      { ...base, evidence: [] },
      { ...base, evidence: [{ kind: "job", proof: "invented" }] },
      {
        ...base,
        evidence: [
          { kind: "source", path: "../escape", start_line: 1, end_line: 2 },
        ],
      },
      { ...base, evidence: [{ kind: "url", url: "https://proof.invalid" }] },
    ])
      expect(reviewedWriteInput.safeParse(value).success).toBe(false);
    expect(canonical({ z: 1, a: { z: 2, a: 3 } })).toEqual({
      a: { a: 3, z: 2 },
      z: 1,
    });
    expect(JSON.stringify(canonical({ z: 1, a: 2 }))).toBe('{"a":2,"z":1}');
  });
  it("resolves captured job evidence and rejects mismatched controller publication receipts", async () => {
    const f = await setup(),
      binding = f.operation().binding,
      signal = new AbortController().signal;
    expect(
      await resolveWriteEvidence(
        f.store,
        f.loaded.secrets,
        f.root,
        binding,
        [{ kind: "job" }],
        1048576,
        signal,
      ),
    ).toMatchObject([{ context: { title: "Captured fact" } }]);
    await expect(
      resolveWriteEvidence(
        f.store,
        f.loaded.secrets,
        f.root,
        binding,
        [{ kind: "job" }],
        10,
        signal,
      ),
    ).rejects.toThrow("mcp_write_evidence_limit");
    const token = f.store.acquireLease(f.job.id, 1)!;
    f.store.startRuntimeLease(token, 10000);
    f.store.startRun({
      id: "artifact-run",
      job_id: f.job.id,
      revision: 1,
      role: "implementation",
      uid: 10001,
      parent_id: null,
      lease_token: token,
      binding_json: "{}",
    });
    const artifact = f.store.recordArtifact({
      run_id: "artifact-run",
      job_id: f.job.id,
      revision: 1,
      source: binding.source,
      files: [],
    });
    f.store.finishRun("artifact-run", "completed", null, artifact);
    f.store.releaseLease(token);
    const publications = new PublicationRepository(f.store),
      id = publications.recordEvidence({
        job_id: f.job.id,
        revision: 1,
        kind: "test",
        source_sha: binding.source.sha,
        artifact_digest: artifact,
        outcome: "passed",
        details: { result: "passed" },
      });
    await expect(
      resolveWriteEvidence(
        f.store,
        f.loaded.secrets,
        f.root,
        binding,
        [{ kind: "publication_evidence", id }],
        1048576,
        signal,
      ),
    ).rejects.toThrow("mcp_write_evidence_mismatch");
    const result = await resolveWriteEvidence(
      f.store,
      f.loaded.secrets,
      f.root,
      { ...binding, artifact_digest: artifact },
      [{ kind: "publication_evidence", id }],
      1048576,
      signal,
    );
    expect(result).toMatchObject([
      { receipt: { kind: "test", outcome: "passed" } },
    ]);
  });
  it("reads pinned source through isolated Git and rejects links, binaries, paths and invalid ranges", async () => {
    const f = await setup(),
      remote = await createPublicationFixture(join(f.root, "remote"));
    cleanups.push(remote.close);
    const target = remote.git(["hash-object", "-w", "--stdin"], "app.txt"),
      tree = remote.git(
        ["mktree"],
        remote.git(["ls-tree", remote.source.sha]) +
          `\n120000 blob ${target}\tcurrent\n`,
      ),
      commit = remote.git(
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        `tree ${tree}\nparent ${remote.source.sha}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nlinked fixture\n`,
      );
    remote.git(["update-ref", "refs/heads/main", commit]);
    const source = { ...remote.source, sha: commit, tree_sha: tree };
    f.store.discover([1], 1, true);
    f.store.applyIssue(
      f.store.nextDirty()!,
      { ...f.context, source },
      f.loaded.snapshot,
    );
    const binding = {
        ...f.operation().binding,
        revision: f.store.job(1)!.revision,
        source,
      },
      signal = new AbortController().signal;
    const resolve = (path: string, start_line = 1, end_line = 1) =>
      resolveWriteEvidence(
        f.store,
        f.loaded.secrets,
        join(f.root, "evidence"),
        binding,
        [{ kind: "source", path, start_line, end_line }],
        1048576,
        signal,
        () => remote.url + "/owner/repo.git",
      );
    expect(await resolve("app.txt")).toMatchObject([
      { text: remote.initial["app.txt"].toString().trim() },
    ]);
    await expect(resolve("image.bin")).rejects.toThrow(
      "publication_binary_unsupported",
    );
    await expect(resolve("missing")).rejects.toThrow(
      "mcp_write_evidence_path_invalid",
    );
    await expect(resolve("current")).rejects.toThrow(
      "mcp_write_evidence_path_invalid",
    );
    await expect(resolve("app.txt", 2, 1)).rejects.toThrow(
      "mcp_write_evidence_range_invalid",
    );
    await expect(resolve("app.txt", 1, 1000)).rejects.toThrow(
      "mcp_write_evidence_range_invalid",
    );
    const scanner = new PublicationScanner(
      join(f.root, "scans"),
      f.loaded.secrets,
    );
    await expect(
      scanner.scan({ text: f.loaded.secrets.get("github.token") }, signal),
    ).rejects.toThrow("publication_secret");
  });
});

describe("durable MCP writes", () => {
  it("serves readiness within a bounded heap after retaining large provider results", async () => {
    const f = await setup();
    f.store.db.transaction(() => {
      for (let number = 2; number < 202; number++) {
        f.store.discover([number], 1, true);
        f.store.applyIssue(
          f.store.nextDirty()!,
          { ...f.context, id: 10000 + number, number },
          f.loaded.snapshot,
        );
        const job = f.store.job(number)!,
          operation = f.operation(`history-${number}`);
        operation.job_id = job.id;
        operation.binding = { ...operation.binding, job_id: job.id };
        f.repository.begin(operation);
        f.repository.dispatch(operation, false);
        f.repository.finish(
          operation,
          {
            kind: "result",
            value: {
              content: [{ type: "text", text: "x".repeat(128 * 1024) }],
            },
          },
          null,
        );
      }
    })();
    const script = `
      import {Store} from ${JSON.stringify(new URL("../src/repositories/store.ts", import.meta.url).href)};
      import {McpWriteService} from ${JSON.stringify(new URL("../src/services/mcp-writes/index.ts", import.meta.url).href)};
      import {createApp} from ${JSON.stringify(new URL("../src/http/app.ts", import.meta.url).href)};
      const store = new Store(process.argv[1]);
      const service = new McpWriteService(null, store, null, null);
      await service.initialize();
      const app = createApp(undefined, undefined, undefined, service);
      await app.ready();
      globalThis.gc();
      const response = await app.inject({method:'GET',url:'/readyz'});
      console.log(JSON.stringify({status:response.statusCode,body:response.json()}));
      await app.close();
      store.close();
    `;
    const output = execFileSync(
      process.execPath,
      [
        "--expose-gc",
        "--max-old-space-size=64",
        "--input-type=module",
        "-e",
        script,
        f.path,
      ],
      { encoding: "utf8", timeout: 10000, stdio: "pipe" },
    );
    expect(JSON.parse(output)).toMatchObject({
      status: 503,
      body: {
        reason: "automation_not_implemented",
        mcp_writes: { response_recorded: 200, uncertain: 0, reason: null },
      },
    });
  });

  it("counts every state and notification failure while reconciling only interrupted writes", async () => {
    const f = await setup(),
      states = [
        "proposed",
        "rejected",
        "dispatching",
        "response_recorded",
        "uncertain",
      ] as const;
    for (const [index, state] of states.entries()) {
      const number = index + 2;
      f.store.discover([number], 1, true);
      f.store.applyIssue(
        f.store.nextDirty()!,
        { ...f.context, id: 10000 + number, number },
        f.loaded.snapshot,
      );
      const job = f.store.job(number)!,
        operation = f.operation(state);
      operation.job_id = job.id;
      operation.binding = { ...operation.binding, job_id: job.id };
      f.repository.begin(operation);
      if (state === "rejected") {
        operation.state = "rejected";
        f.repository.save(operation);
      } else if (state !== "proposed") {
        f.repository.dispatch(operation, false);
        if (state !== "dispatching")
          f.repository.finish(
            operation,
            state === "response_recorded"
              ? { kind: "result", value: { content: [] } }
              : null,
            state === "uncertain" ? "mcp_timeout" : null,
          );
        if (state === "uncertain") {
          operation.notification = "failed";
          f.repository.save(operation);
        }
      }
    }
    expect(f.repository.counts()).toEqual({
      proposed: 1,
      rejected: 1,
      dispatching: 1,
      response_recorded: 1,
      uncertain: 1,
      notification_failed: 1,
    });
    expect(f.repository.all(["uncertain"]).map((op) => op.id)).toEqual([
      "uncertain",
    ]);
    const settled = f.repository.receipt("response_recorded");
    f.repository.interrupt();
    expect(f.repository.counts()).toEqual({
      proposed: 0,
      rejected: 2,
      dispatching: 0,
      response_recorded: 1,
      uncertain: 2,
      notification_failed: 1,
    });
    expect(f.repository.receipt("response_recorded")).toEqual(settled);
  });

  it("blocks ordinary leases when response persistence fails after dispatch intent", async () => {
    const f = await setup(),
      op = f.operation(),
      token = f.store.acquireLease(f.job.id, 1)!;
    f.store.startRuntimeLease(token, 10000);
    f.repository.begin(op);
    f.repository.dispatch(op, false);
    f.store.db
      .exec(`CREATE TRIGGER fail_mcp_response BEFORE UPDATE ON mcp_write_operations
      WHEN NEW.state IN ('response_recorded','uncertain')
      BEGIN SELECT RAISE(ABORT,'fixture_response_storage_failure'); END`);
    expect(() =>
      f.repository.finish(
        op,
        {
          kind: "result",
          value: { content: [{ type: "text", text: "provider recorded" }] },
        },
        null,
      ),
    ).toThrow("fixture_response_storage_failure");
    expect(() => f.repository.finish(op, null, "mcp_write_failed")).toThrow(
      "fixture_response_storage_failure",
    );
    expect(f.repository.receipt(op.id).state).toBe("dispatching");
    expect(f.store.releaseLease(token)).toBe(true);
    expect(f.store.acquireLease(f.job.id, 1)).toBeUndefined();
  });
  it("serializes aliases per job and preserves uncertain holds across revisions and restarts", async () => {
    const f = await setup(),
      operation = f.operation(),
      token = f.store.acquireLease(f.job.id, 1)!;
    f.store.startRuntimeLease(token, 10000);
    f.repository.begin(operation);
    expect(() =>
      f.repository.begin({
        ...f.operation("second"),
        binding: { ...operation.binding, alias: "other" },
      }),
    ).toThrow("mcp_write_busy");
    f.repository.dispatch(operation, false);
    f.repository.interrupt();
    expect(f.store.runtimeCurrent(token)).toBe(false);
    expect(f.store.reserveModelRequest(token, 20)).toBe(false);
    f.store.releaseLease(token);
    expect(f.store.acquireLease(f.job.id, 1)).toBeUndefined();
    const recovery = f.store.acquireMcpWriteRecovery(operation.id)!;
    f.store.startRuntimeLease(recovery, 10000);
    expect(f.store.mcpWriteRecoveryCurrent(recovery, operation.id)).toBe(true);
    expect(f.store.mcpWriteRecoveryCurrent(recovery, "other")).toBe(false);
    expect(() =>
      f.store.startRun({
        id: "forged",
        job_id: f.job.id,
        revision: 1,
        role: "implementation",
        uid: 10001,
        parent_id: null,
        lease_token: recovery,
        binding_json: "{}",
      }),
    ).toThrow("revision_stale");
    f.store.releaseLease(recovery);
    f.store.discover([1], 1, true);
    f.store.applyIssue(
      f.store.nextDirty()!,
      { ...f.context, body: "Changed revision" },
      f.loaded.snapshot,
    );
    expect(f.store.job(1)!.revision).toBe(2);
    expect(f.store.acquireLease(f.job.id, 2)).toBeUndefined();
    expect(f.store.acquireMcpWriteRecovery(operation.id)).toBeUndefined();
    f.store.close();
    const reopened = new Store(f.path);
    try {
      expect(reopened.hasUncertainMcpWrite(f.job.id)).toBe(true);
      expect(
        new McpWriteRepository(reopened).receipt(operation.id).attempts,
      ).toMatchObject([{ state: "uncertain" }]);
    } finally {
      reopened.close();
    }
  });
  it("atomically consumes shared retries, retains original request/deadline and returns bounded response receipts", async () => {
    const f = await setup(),
      op = f.operation();
    f.repository.begin(op);
    f.repository.dispatch(op, false);
    f.repository.finish(op, null, "mcp_write_interrupted");
    const before = {
      digest: op.request_digest,
      args: JSON.stringify(op.arguments),
      deadline: op.deadline,
    };
    for (let i = 0; i < 2; i++) {
      f.repository.dispatch(op, true);
      f.repository.finish(op, null, "mcp_write_interrupted");
    }
    expect(() => f.repository.dispatch(op, true)).toThrow(
      "infrastructure_budget_exhausted",
    );
    expect(JSON.parse(f.store.job(1)!.budget_json).infrastructure_retries).toBe(
      2,
    );
    expect({
      digest: op.request_digest,
      args: JSON.stringify(op.arguments),
      deadline: op.deadline,
    }).toEqual(before);
    expect(f.repository.receipt(op.id).state).toBe("uncertain");
    expect(f.repository.attempts(op.id)).toHaveLength(3);
  });
  it("rejects expired or changed requests without consuming attempts and preserves recorded tool errors", async () => {
    const f = await setup(),
      op = f.operation();
    f.repository.begin(op);
    op.arguments!.text = "changed";
    expect(() => f.repository.dispatch(op, false)).toThrow(
      "mcp_write_identity_mismatch",
    );
    op.arguments!.text = "captured";
    expect(f.repository.attempts(op.id)).toEqual([]);
    f.repository.dispatch(op, false);
    f.repository.finish(
      op,
      {
        kind: "result",
        value: {
          content: [{ type: "text", text: "rejected" }],
          structuredContent: { accepted: false },
          isError: true,
        },
      },
      null,
    );
    expect(f.repository.receipt(op.id)).toMatchObject({
      state: "response_recorded",
      review: "not_required",
      response: {
        value: { isError: true, structuredContent: { accepted: false } },
      },
    });
    f.repository.interrupt();
    expect(f.repository.receipt(op.id).state).toBe("response_recorded");
    expect(f.store.acquireLease(f.job.id, 1)).toBeTruthy();
  });
  it("retains an expired original deadline without starting transmission", async () => {
    const f = await setup(),
      op = f.operation();
    op.deadline = Date.now() - 1;
    f.repository.begin(op);
    expect(() => f.repository.dispatch(op, false)).toThrow(
      "mcp_write_deadline_expired",
    );
    expect(f.repository.attempts(op.id)).toEqual([]);
  });
  it("upgrades v6 additively and rolls back a conflicting schema-7 migration", async () => {
    const f = await setup(),
      before = {
        jobs: f.store.jobs(),
        snapshot: JSON.stringify(f.store.snapshot(f.loaded.snapshot.digest)),
      };
    f.store.db.exec(
      "DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; PRAGMA user_version=6",
    );
    f.store.close();
    const upgraded = new Store(f.path);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(9);
    expect({
      jobs: upgraded.jobs(),
      snapshot: JSON.stringify(upgraded.snapshot(f.loaded.snapshot.digest)),
    }).toEqual(before);
    upgraded.db.exec(
      "DROP TABLE implementations; DROP TABLE investigations; DROP TABLE investigation_evidence; DROP TABLE mcp_read_results; DROP TABLE mcp_write_recovery_leases; DROP TABLE mcp_write_attempts; DROP TABLE mcp_write_operations; CREATE TABLE mcp_write_attempts(marker TEXT); INSERT INTO mcp_write_attempts VALUES('preserve'); PRAGMA user_version=6",
    );
    upgraded.close();
    expect(() => new Store(f.path)).toThrow();
    const inspect = new Database(f.path);
    try {
      expect(inspect.pragma("user_version", { simple: true })).toBe(6);
      expect(inspect.prepare("SELECT * FROM mcp_write_attempts").all()).toEqual(
        [{ marker: "preserve" }],
      );
      expect(
        inspect
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='mcp_write_operations'",
          )
          .all(),
      ).toEqual([]);
      expect(inspect.prepare("SELECT * FROM jobs").all()).toEqual(before.jobs);
    } finally {
      inspect.close();
    }
  });
});
