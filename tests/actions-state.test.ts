import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitReplies } from "../src/services/clarification.ts";
import {
  renderQuestion,
  type Question,
} from "../src/services/clarification-contracts.ts";
import { Octokit } from "@octokit/rest";
import { OctokitWriter } from "../src/adapters/github/writer.ts";
import { OctokitReader } from "../src/adapters/github/reader.ts";
import { ActionsState } from "../src/actions/persistence.ts";
import { ActionsArtifacts } from "../src/actions/artifacts.ts";
import { fileDigest } from "../src/actions/bundle.ts";
import type { ArtifactTransport } from "../src/adapters/github/artifacts.ts";
import {
  StateCodec,
  stateBytes,
  commentBytes,
  stateMarker,
} from "../src/actions/state.ts";
import { Store } from "../src/repositories/store.ts";
import { ActionsRepository } from "../src/repositories/actions.ts";
import { PublicationRepository } from "../src/repositories/publication.ts";
import { InvestigationRepository } from "../src/repositories/investigation.ts";
import { PrMonitorRepository } from "../src/repositories/pr-monitor.ts";
import { ImplementationRepository } from "../src/repositories/implementation.ts";
import { IntakeService } from "../src/services/intake.ts";
import { ModelRelay } from "../src/services/model-relay.ts";
import { createServer } from "node:http";
import { separateSecrets } from "../src/config/secrets.ts";
import { digest } from "../src/domain/agents.ts";
import { fixtureConfiguration, fixtureSnapshot } from "./fixtures.ts";
import { createPublicationFixture } from "./fixtures/publication.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orm-actions-state-"));
  cleanups.push(() => rm(root, { recursive: true }));
  const remote = await createPublicationFixture(join(root, "remote"));
  cleanups.push(remote.close);
  remote.state.issues.set(1, {
    id: 1001,
    number: 1,
    title: "Bug",
    body: "Existing behavior is broken",
    updated_at: "2026-10-21T00:00:00Z",
  });
  const client = new Octokit({
    auth: remote.state.token,
    baseUrl: remote.url,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const writer = new OctokitWriter("owner/repo", client),
    reader = new OctokitReader("owner/repo", client);
  const config = fixtureConfiguration(),
    { snapshot } = await fixtureSnapshot("fixture-model", config);
  const key = randomBytes(32).toString("base64"),
    { secrets } = separateSecrets(config, key),
    codec = new StateCodec(key);
  const database = (file = join(root, randomUUID(), "state.sqlite")) => {
    const store = new Store(file);
    cleanups.push(async () => {
      if (store.db.open) store.close();
    });
    return store;
  };
  const open = (store: Store, artifacts?: ActionsArtifacts) =>
    ActionsState.open(store, snapshot, secrets, 1, signal(), {
      writer,
      reader,
      artifacts,
    });
  const store = database();
  const read = () => {
    const row = remote.state.comments
      .get(1)!
      .find((row) => row.body.includes("<!-- orm:task-state:"))!;
    return codec.decode(row.body, {
      repository_id: 42,
      issue_id: 1001,
      comment_id: row.id,
      author_id: 7,
    });
  };
  const archived = `${store.db.name}.artifact`,
    transport: ArtifactTransport = {
      async verify() {},
      async upload(path, identity, limit, signal) {
        await copyFile(path, archived);
        return {
          ...identity,
          ...(await fileDigest(archived, limit, signal)),
          artifact_id: 1,
          expires_at: Date.now() + 86400000,
        };
      },
      async download(_reference, directory) {
        const path = join(directory, "checkpoint.orm");
        try {
          await copyFile(archived, path);
          return path;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return undefined;
        }
      },
    };
  const artifactsFor = async (store: Store) => {
    const artifacts = new ActionsArtifacts(
      {
        repository: "owner/repo",
        repository_id: 42,
        run_id: 100,
        run_attempt: 1,
        head_sha: remote.source.sha,
        results_url: "https://results.actions.githubusercontent.com",
      },
      snapshot,
      secrets,
      `${store.db.name}.runtime`,
      transport,
    );
    await artifacts.initialize(signal());
    return artifacts;
  };
  return {
    artifactsFor,
    deleteArtifact: () => rm(archived),
    remote,
    writer,
    reader,
    snapshot,
    secrets,
    key,
    codec,
    database,
    store,
    open,
    read,
  };
}

describe("authenticated Actions task authority", () => {
  it("enrolls once, restores identity and budgets to an empty database, and retains PAT-owner human comments", async () => {
    const f = await setup(),
      first = await f.open(f.store),
      identity = first.identifiers();
    const lease = f.store.acquireLease(1, 1)!;
    f.store.startRuntimeLease(lease, 60000);
    expect(f.store.reserveModelRequest(lease, 10)).toBe(true);
    await f.store.checkpoint(signal());
    f.store.accountActive(lease);
    f.store.releaseLease(lease);
    await f.store.checkpoint(signal());
    const before = f.read().state;
    f.remote.state.comments.get(1)!.push({
      id: 999,
      body: "A factual reply from the token owner",
      author_id: 7,
    });
    const fresh = f.database(),
      recovered = await f.open(fresh);
    expect(recovered.identifiers().task_id).toBe(identity.task_id);
    expect(recovered.identifiers().state_comment_id).toBe(
      identity.state_comment_id,
    );
    expect(f.read().state.budget.model_requests).toBe(1);
    expect(f.read().state.budget.active_ms).toBe(before.budget.active_ms);
    expect(new PublicationRepository(fresh).instance()).toBe(
      before.publication_instance,
    );
    expect(fresh.owns("issue_comment", 999)).toBe(false);
    expect(fresh.owns("issue_comment", identity.state_comment_id)).toBe(true);
    expect(f.remote.state.issueLabels.get(1)).toEqual(["orm:managed"]);
    expect(f.remote.state.comments.get(1)).toHaveLength(2);
    const intake = new IntakeService(fresh, f.reader, f.snapshot, f.secrets, {
      info() {},
      error() {},
    });
    await intake.enrollIssue(1, signal());
    expect(fresh.job(1)!.revision).toBe(before.job!.revision);
    await intake.stop();
    expect(
      f.remote.state.requests.some(
        (request) => request.path === "/repos/owner/repo/issues",
      ),
    ).toBe(false);
  });

  it("imports a populated checkpoint atomically and overlays newer durable budgets", async () => {
    const f = await setup();
    await f.open(f.store);
    const archived = f.read(),
      path = `${f.store.db.name}.checkpoint`;
    await f.store.db.backup(path);
    f.store.reserveInfrastructureRetry(1);
    await f.store.checkpoint(signal());
    const current = f.read(),
      fresh = f.database(),
      repository = new ActionsRepository(fresh);
    repository.importCheckpoint(path, current.body);
    expect(fresh.jobs()).toHaveLength(1);
    expect(fresh.db.pragma("foreign_key_check")).toEqual([]);
    expect(JSON.parse(fresh.job(1)!.budget_json)).toEqual(
      archived.state.budget,
    );
    expect(repository.local()!.body).toBe(current.body);
    await f.open(fresh);
    expect(JSON.parse(fresh.job(1)!.budget_json)).toEqual(current.state.budget);
    expect(f.read().state.task_id).toBe(archived.state.task_id);
  });

  it.each(["acknowledge", "reconstructed"])(
    "rolls back partial restoration at %s and retries from durable authority",
    async (boundary) => {
      const f = await setup(),
        first = await f.open(f.store);
      f.store.reserveInfrastructureRetry(1);
      await f.store.checkpoint(signal());
      const before = f.read(),
        fresh = f.database(),
        file = fresh.db.name,
        repository = new ActionsRepository(fresh),
        event =
          boundary === "acknowledge" ? "INSERT" : "UPDATE OF reconstructed";
      fresh.db.exec(`CREATE TRIGGER interrupt_restore BEFORE ${event}
        ON actions_checkpoint BEGIN SELECT RAISE(ABORT,'restore_interrupted'); END`);
      await expect(f.open(fresh)).rejects.toThrow("restore_interrupted");
      expect(fresh.jobs()).toEqual([]);
      expect(fresh.repository()).toBeUndefined();
      expect(repository.local()).toBeUndefined();
      expect(f.read().body).toBe(before.body);
      fresh.db.exec("DROP TRIGGER interrupt_restore");
      fresh.close();

      const reopened = f.database(file),
        recovered = await f.open(reopened);
      expect(recovered.identifiers().task_id).toBe(first.identifiers().task_id);
      expect(recovered.recoveryContext()).toBeDefined();
      expect(recovered.repository.local()!.reconstructed).toBe(1);
      expect(JSON.parse(reopened.job(1)!.budget_json)).toEqual(
        before.state.budget,
      );
      expect(f.read().state.budget).toEqual(before.state.budget);
      expect(f.remote.state.comments.get(1)).toHaveLength(1);
    },
  );

  it("reconciles lost enrollment, creation and update responses without another comment", async () => {
    const f = await setup();
    f.remote.state.dropAfter = "comment";
    const manager = await f.open(f.store);
    const id = manager.identifiers().state_comment_id;
    f.remote.state.dropAfter = "comment";
    await f.store.checkpoint(signal());
    await f.open(f.store);
    expect(f.remote.state.comments.get(1)).toHaveLength(1);
    expect(f.read().state.comment_id).toBe(id);
  });

  for (const failure of [
    "missing",
    "edited",
    "duplicate",
    "foreign",
    "key",
    "schema",
  ] as const) {
    it(`blocks ${failure} canonical state without charged work or fresh enrollment`, async () => {
      const f = await setup();
      await f.open(f.store);
      const row = f.remote.state.comments.get(1)![0],
        before = f.remote.state.mutations.length;
      if (failure === "missing") f.remote.state.comments.set(1, []);
      if (failure === "edited")
        row.body = row.body.replace("bounded", "unbounded");
      if (failure === "duplicate")
        f.remote.state.comments.get(1)!.push({ ...row, id: row.id + 1000 });
      if (failure === "foreign") row.id += 1000;
      if (failure === "schema")
        row.body = row.body.replace("orm:task-state:v1:", "orm:task-state:v2:");
      if (failure === "key") {
        const config = fixtureConfiguration();
        await fixtureSnapshot("fixture-model", config);
        const { secrets } = separateSecrets(
          config,
          randomBytes(32).toString("base64"),
        );
        await expect(
          ActionsState.open(f.database(), f.snapshot, secrets, 1, signal(), {
            writer: f.writer,
            reader: f.reader,
          }),
        ).rejects.toMatchObject({ code: "state_invalid" });
      } else
        await expect(f.open(f.database())).rejects.toMatchObject({
          code:
            failure === "missing"
              ? "state_missing"
              : failure === "duplicate"
                ? "state_conflict"
                : "state_invalid",
        });
      expect(f.remote.state.mutations).toHaveLength(before);
    });
  }

  it("rejects label-only initialization and legacy local databases", async () => {
    const f = await setup();
    f.remote.state.issueLabels.set(1, ["orm:managed"]);
    await expect(f.open(f.store)).rejects.toMatchObject({
      code: "state_missing",
    });
    f.remote.state.issueLabels.clear();
    f.store.enroll(await f.reader.repository(signal()));
    f.store.saveSnapshot(f.snapshot);
    f.store.applyIssue(
      f.store.refreshIssue(1),
      await f.reader.issue(1, f.store.repository()!, signal()),
      f.snapshot,
    );
    await expect(f.open(f.store)).rejects.toMatchObject({
      code: "state_legacy_unbound",
    });
  });

  it("serializes reservations and stops a stale writer instead of overwriting a newer generation", async () => {
    const f = await setup();
    await f.open(f.store);
    const lease = f.store.acquireLease(1, 1)!;
    f.store.startRuntimeLease(lease, 60000);
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        expect(f.store.reserveModelRequest(lease, 3)).toBe(true);
        await f.store.checkpoint(signal());
      }),
    );
    expect(f.read().state.budget.model_requests).toBe(3);
    const second = f.database();
    await f.open(second);
    const generation = f.read().state.generation;
    await expect(f.store.checkpoint(signal())).rejects.toMatchObject({
      code: "state_conflict",
    });
    expect(f.read().state.generation).toBe(generation);
  });

  it("charges interrupted active time through its saved deadline exactly once", async () => {
    const f = await setup();
    await f.open(f.store);
    const lease = f.store.acquireLease(1, 1)!;
    f.store.startRuntimeLease(lease, 60000);
    await f.store.checkpoint(signal());
    const original = f.read();
    original.state.active = {
      accounted_at: Date.now() - 5000,
      deadline: Date.now() - 2000,
    };
    original.state.budget.active_ms = 100;
    f.remote.state.comments.get(1)![0].body = f.codec.encode(
      original.state,
      original.narrative,
    );
    const fresh = f.database();
    await f.open(fresh);
    expect(f.read().state.budget.active_ms).toBe(3100);
    expect(f.read().state.active).toBeNull();
    await f.open(fresh);
    expect(f.read().state.budget.active_ms).toBe(3100);
  });

  it("preserves spent repair cycles and their exhaustion after restoring only comment authority", async () => {
    const f = await setup();
    await f.open(f.store);
    const handoff = (store: Store) => {
      const job = store.job(1)!,
        investigations = new InvestigationRepository(store),
        publications = new PublicationRepository(store),
        implementations = new ImplementationRepository(store);
      const investigation = investigations.ensure(job);
      investigation.result = {
        outcome: "maintenance_candidate",
        bug: {
          expected_behavior: "Documented existing behavior",
          observed_behavior: "Supported behavior fails",
          existing_contract: "Verified supported source contract",
        },
        summary: "The fixture source violates its documented behavior",
        objective: "Restore existing behavior",
        proof: "source",
        evidence_ids: [],
        questions: [],
      };
      const operation = publications.begin({
        id: digest({ investigation: investigation.id }),
        job_id: job.id,
        revision: job.revision,
        status: "confirmed",
        failure: null,
        retry_at: 0,
        retry_pending: false,
        proposal: {
          kind: "investigation",
          job_id: job.id,
          revision: job.revision,
          investigation_id: investigation.id,
        },
        source: investigation.source,
        target: publications.target(job.id),
        actor: f.remote.state.actor,
        timestamp: new Date().toISOString(),
        review_id: null,
        payload: null,
        commit: null,
        steps: [],
      });
      investigation.publication_id = operation.id;
      investigations.save(investigation);
      investigations.finish(investigation);
      return { implementations, record: implementations.ensure(store.job(1)!) };
    };
    const first = handoff(f.store),
      limit = f.snapshot.settings.limits.repair_cycles;
    expect(limit).toBeGreaterThan(0);
    for (let index = 0; index < limit; index++)
      first.implementations.repair(first.record, [
        "Fix the supported regression",
      ]);
    await f.store.checkpoint(signal());
    expect(f.read().state.budget.repair_cycles).toBe(limit);
    const fresh = f.database();
    await f.open(fresh);
    const recovered = handoff(fresh);
    expect(JSON.parse(fresh.job(1)!.budget_json).repair_cycles).toBe(limit);
    expect(() =>
      recovered.implementations.repair(recovered.record, ["One more attempt"]),
    ).toThrow("repair_budget_exhausted");
    await fresh.checkpoint(signal());
    expect(f.read().state.budget.repair_cycles).toBe(limit);
  });

  it("enforces byte limits and authentication over narrative, schema and canonical identity", async () => {
    const f = await setup();
    await f.open(f.store);
    const saved = f.read();
    expect(Buffer.byteLength(saved.body)).toBeLessThan(commentBytes);
    expect(Buffer.byteLength(JSON.stringify(saved.state))).toBeLessThan(
      stateBytes,
    );
    expect(() => f.codec.encode(saved.state, "é".repeat(commentBytes))).toThrow(
      "state_size_limit",
    );
    expect(() =>
      f.codec.encode(
        saved.state,
        "Quoted metadata: <!-- orm:task-state:v1:untrusted -->",
      ),
    ).toThrow("state_invalid");
    expect(() =>
      f.codec.encode({ ...saved.state, version: 2 } as never, saved.narrative),
    ).toThrow("state_invalid");
    const large = structuredClone(saved.state);
    large.scope = {
      job_id: 1,
      revision: 1,
      investigation_id: randomUUID(),
      source: f.remote.source,
      snapshot_digest: f.snapshot.digest,
      objective: "x",
      plan: {
        acceptance: Array(32).fill("x".repeat(4096)),
        paths: ["app.txt"],
        regression: { cwd: ".", argv: ["true"] },
        checks: [],
      },
      checks: [],
      remote_checks: [],
    };
    large.scope_digest = digest(large.scope);
    expect(() => f.codec.encode(large, saved.narrative)).toThrow(
      "state_size_limit",
    );
  });

  it("keeps metadata edits outside the reviewed narrative and rejects unreviewed replacement text", async () => {
    const f = await setup(),
      manager = await f.open(f.store);
    const before = (await manager.writer.comments(1, signal()))[0];
    await f.store.checkpoint(signal());
    const after = (await manager.writer.comments(1, signal()))[0];
    expect(after).toEqual(before);
    await expect(
      manager.writer.comment(1, before.id, "unreviewed", signal()),
    ).rejects.toMatchObject({ code: "state_unreviewed" });
    const body = f.remote.state.comments.get(1)![0].body;
    expect(body).not.toContain(f.key);
    expect(JSON.stringify(f.read().state)).not.toMatch(
      /system_prompt|session_id|OPERATOR_SYSTEM_CANARY/,
    );
  });

  it("acknowledges a model reservation before any provider request and blocks forwarding when the state write fails", async () => {
    const f = await setup();
    await f.open(f.store);
    let providerRequests = 0;
    const upstream = createServer((_request, response) => {
      providerRequests++;
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const lease = f.store.acquireLease(1, 1)!;
    const deadline = f.store.startRuntimeLease(lease, 60000);
    const relay = new ModelRelay(
      f.store,
      `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
      f.secrets,
    );
    await relay.start();
    cleanups.push(() => relay.close());
    const grant = relay.authorize({
      lease,
      deadline,
      requests: 10,
      bytes: 1048576,
      profile: { sdk: "codex", model: "fixture-model", effort: "high" },
      signal: signal(),
      current: () => f.store.runtimeCurrent(lease),
    });
    let release: () => void = () => {},
      arrived: () => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        arrived = resolve;
      });
    f.remote.state.holdBefore = async () => {
      arrived();
      await held;
    };
    const request = () =>
      fetch(grant.url + "/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.authorization}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "fixture-model" }),
      });
    const response = request();
    await entered;
    expect(providerRequests).toBe(0);
    release();
    expect((await response).status).toBe(200);
    expect(f.read().state.budget.model_requests).toBe(1);
    expect(providerRequests).toBe(1);
    f.remote.state.holdBefore = undefined;
    f.remote.state.rejectBefore = "comment";
    expect((await request()).status).toBeGreaterThanOrEqual(400);
    expect(providerRequests).toBe(1);
  });

  it("allows fresh recovery after confirmed artifact deletion when no PR is owned", async () => {
    const f = await setup();
    await f.open(f.store, await f.artifactsFor(f.store));
    f.store.reserveInfrastructureRetry(1);
    await f.store.checkpoint(signal(), true);
    const saved = f.read(),
      row = f.remote.state.comments.get(1)![0];
    row.body = f.codec.encode(
      {
        ...saved.state,
        generation: saved.state.generation + 1,
        outcome: "blocked",
        reason: "recovery_evidence_missing",
      },
      saved.narrative,
    );
    await f.deleteArtifact();
    const fresh = f.database(),
      recovered = await f.open(fresh, await f.artifactsFor(fresh));
    expect(recovered.identifiers().session_recovery).toBe("expired_or_deleted");
    expect(recovered.result()).toBeUndefined();
    expect(JSON.parse(fresh.job(1)!.budget_json)).toEqual(saved.state.budget);
    expect(fresh.ownedPulls()).toEqual([]);
  });

  it("restores an older checkpoint after durable task progress advances", async () => {
    const f = await setup();
    await f.open(f.store, await f.artifactsFor(f.store));
    await f.store.checkpoint(signal(), true);
    const archived = f.read().state;
    f.store.db
      .prepare("UPDATE jobs SET phase='implementation' WHERE id=1")
      .run();
    f.store.reserveInfrastructureRetry(1);
    await f.store.checkpoint(signal());
    const current = f.read().state;
    expect(current.job!.phase).not.toBe(archived.job!.phase);
    expect(current.session_artifact).toEqual(archived.session_artifact);
    const fresh = f.database(),
      recovered = await f.open(fresh, await f.artifactsFor(fresh));
    expect(recovered.result()).toBeUndefined();
    expect(recovered.identifiers().task_id).toBe(current.task_id);
    expect(JSON.parse(fresh.job(1)!.budget_json)).toEqual(current.budget);
    expect(fresh.ownedPulls()).toEqual([]);
  });

  it("recovers newly accepted scope without permitting conflicting frozen scope", async () => {
    const f = await setup(),
      original = await f.open(f.store, await f.artifactsFor(f.store));
    f.store.db
      .prepare("UPDATE jobs SET phase='implementation' WHERE id=1")
      .run();
    f.store.db.prepare("UPDATE actions_checkpoint SET reconstructed=0").run();
    await f.store.checkpoint(signal(), true);
    const archived = f.read().state;
    const review = (store: Store) =>
      new PublicationRepository(store).review({
        id: randomUUID(),
        job_id: 1,
        revision: 1,
        binding: "b".repeat(64),
        policy_identity: "fixture-review-policy",
        approved: true,
        run_id: randomUUID(),
        created_at: Date.now(),
      });
    const scope = {
      job_id: 1,
      revision: 1,
      investigation_id: randomUUID(),
      source: f.remote.source,
      snapshot_digest: f.snapshot.digest,
      objective: "Restore existing behavior",
      plan: {
        acceptance: ["The documented behavior works"],
        paths: ["app.txt"],
        regression: { cwd: ".", argv: ["true"] },
        checks: [],
      },
      checks: [],
      remote_checks: [],
    };
    f.store.reserveInfrastructureRetry(1);
    await original.acceptScope(scope, review(f.store).id, signal());
    const current = f.read().state;
    expect(current.session_artifact).toEqual(archived.session_artifact);
    expect(archived.scope).toBeNull();
    const fresh = f.database(),
      recovered = await f.open(fresh, await f.artifactsFor(fresh));
    expect(recovered.result()).toBeUndefined();
    expect(new ActionsRepository(fresh).local()!.reconstructed).toBe(0);
    expect(recovered.recoveryContext()?.scope).toEqual(scope);
    expect(JSON.parse(fresh.job(1)!.budget_json)).toEqual(current.budget);
    await recovered.acceptScope(scope, review(fresh).id, signal());
    expect(recovered.recoveryContext()).toBeUndefined();
    expect(f.read().state.scope_digest).toBe(digest(scope));
    await fresh.checkpoint(signal(), true);
    const saved = f.read(),
      conflicting = { ...scope, objective: "A different frozen objective" };
    f.remote.state.comments.get(1)![0].body = f.codec.encode(
      {
        ...saved.state,
        generation: saved.state.generation + 1,
        scope: conflicting,
        scope_digest: digest(conflicting),
      },
      saved.narrative,
    );
    const blocked = f.database();
    await expect(
      f.open(blocked, await f.artifactsFor(blocked)),
    ).rejects.toMatchObject({ code: "session_incompatible" });
    expect(blocked.jobs()).toEqual([]);
  });

  it("retains newer authenticated PR findings over an older checkpoint without inventing validation receipts", async () => {
    const f = await setup();
    await f.open(f.store);
    const target = new PublicationRepository(f.store).target(1);
    const commit = f.remote.commit(
      { "app.txt": "fixed\n" },
      f.remote.source.sha,
    );
    f.remote.git(["update-ref", `refs/heads/${target.branch}`, commit.sha]);
    await f.writer.updatePull(
      null,
      {
        title: "Fix",
        body: "Verified existing behavior",
        branch: target.branch,
        base: "main",
      },
      signal(),
    );
    const pull = await f.writer.pull(f.remote.state.pulls[0].number, signal());
    const saved = f.read(),
      state = saved.state,
      investigationId = randomUUID(),
      implementationId = randomUUID();
    state.scope = {
      job_id: 1,
      revision: 1,
      investigation_id: investigationId,
      source: state.job!.source,
      snapshot_digest: f.snapshot.digest,
      objective: "Restore existing behavior",
      plan: {
        acceptance: ["Existing behavior works"],
        paths: ["app.txt"],
        regression: { cwd: ".", argv: ["true"] },
        checks: [],
      },
      checks: [],
      remote_checks: [],
    };
    state.scope_digest = digest(state.scope);
    state.findings = {
      outcome: "maintenance_candidate",
      summary: "Confirmed defect",
      objective: state.scope.objective,
      proof: "source",
      evidence_ids: [],
      questions: [],
      bug: {
        expected_behavior: "Existing behavior",
        observed_behavior: "Broken behavior",
        existing_contract: "Documented contract",
      },
    };
    state.head = commit.sha;
    state.pull = {
      id: pull.id,
      number: pull.number,
      author_id: pull.author_id!,
      head: commit.sha,
      base: "main",
      title_digest: digest(pull.title),
      body_digest: digest(pull.body),
    };
    state.pr = {
      version: 1,
      implementation_id: implementationId,
      publication_id: "d".repeat(64),
      actor: f.remote.state.actor,
      head: commit.sha,
      published_at: Date.now(),
      evidence_ids: [],
      monitor: {
        id: randomUUID(),
        policy_digest: digest(f.snapshot.settings.pr_monitor),
        policy_generation: 1,
        generation: 1,
        stage: "waiting",
        failure: null,
        notification_id: null,
        findings: [],
      },
    };
    f.remote.state.comments
      .get(1)!
      .find((row) => row.id === state.comment_id)!.body = f.codec.encode(
      state,
      saved.narrative,
    );
    const working = f.database(),
      artifacts = await f.artifactsFor(working);
    await f.open(working, artifacts);
    await working.checkpoint(signal(), true);
    const reference = f.read().state.session_artifact;
    expect(reference).not.toBeNull();
    const monitors = new PrMonitorRepository(working),
      monitor = monitors.get(1)!;
    monitor.generation++;
    monitor.notification_id = "f".repeat(64);
    monitors.save(monitor);
    await working.checkpoint(signal());
    const cursors = f.read(),
      compatible = f.database(),
      compatibleArtifacts = await f.artifactsFor(compatible);
    expect(
      await compatibleArtifacts.restore(compatible, cursors, signal()),
    ).toBe("restored");
    await f.open(compatible, compatibleArtifacts);
    expect(new PrMonitorRepository(compatible).get(1)!.notification_id).toBe(
      monitor.notification_id,
    );
    expect(new PrMonitorRepository(compatible).get(1)!.generation).toBe(
      monitor.generation,
    );
    monitor.findings.push({
      surface_id: "comment:900",
      disposition: "informational",
      explanation: "No correction requested",
      citations: [],
      surface: {
        id: "comment:900",
        kind: "comment",
        author: "reviewer",
        reviewed_sha: commit.sha,
        thread_id: null,
        body: "Informational",
        digest: "e".repeat(64),
      },
      run_id: randomUUID(),
      assessed_head: commit.sha,
      fixed_head: null,
      publication_id: null,
      evidence: [],
    });
    new PrMonitorRepository(compatible).save(monitor);
    await compatible.checkpoint(signal());
    const current = f.read().state;
    expect(current.session_artifact).toEqual(reference);
    const fresh = f.database();
    await f.open(fresh, await f.artifactsFor(fresh));
    expect(new PrMonitorRepository(fresh).get(1)!.findings).toEqual(
      current.pr!.monitor!.findings,
    );
    expect(f.read().state.pr!.monitor!.generation).toBe(
      current.pr!.monitor!.generation,
    );
    const implementation = new ImplementationRepository(fresh).current(
      fresh.job(1)!,
    )!;
    expect(implementation.recovering).toBe(true);
    expect(implementation.audits).toEqual([]);
    expect(implementation.tests).toEqual([]);
    expect(fresh.runs()).toEqual([]);
    expect(f.read().state.budget).toEqual(current.budget);
    const interrupted = f.read();
    const intent = {
      ...state.pr,
      resume_publication: {
        id: "f".repeat(64),
        revision: 1,
        kind: "feedback" as const,
        actor: f.remote.state.actor,
        source: f.remote.source,
        branch: target.branch,
        commit: null,
        review_id: randomUUID(),
        review_binding: "b".repeat(64),
        policy_identity: "fixture-review-policy",
        status: "reviewed" as const,
        retry_at: 0,
        retry_pending: false,
        intent: {
          payload: { feedback: { body: "Reviewed", thread: null } },
          steps: [{ before: null, after: "Reviewed" }],
        },
        steps: [
          {
            kind: "feedback_reply" as const,
            state: "prepared" as const,
            before_digest: digest(null),
            after_digest: digest("Reviewed"),
            object_id: null,
            thread_id: null,
            title_digest: null,
            body_digest: digest("Reviewed"),
          },
        ],
      },
    };
    interrupted.state.pr = {
      ...interrupted.state.pr!,
      resume_publication: intent.resume_publication,
    };
    f.remote.state.comments
      .get(1)!
      .find((row) => row.id === state.comment_id)!.body = f.codec.encode(
      interrupted.state,
      interrupted.narrative,
    );
    const again = f.database();
    const continued = await f.open(again, await f.artifactsFor(again));
    expect(continued.publicationIntent(intent.resume_publication.id)).toEqual(
      intent.resume_publication,
    );
    await again.checkpoint(signal());
    const twice = f.database();
    const resumed = await f.open(twice, await f.artifactsFor(twice));
    expect(resumed.publicationIntent(intent.resume_publication.id)).toEqual(
      intent.resume_publication,
    );
  });

  it.each(["empty", "retained", "checkpoint"])(
    "recovers a created PR after response loss with %s local storage",
    async (storage) => {
      const f = await setup();
      await f.open(f.store);
      if (storage === "checkpoint") {
        await f.open(f.store, await f.artifactsFor(f.store));
        await f.store.checkpoint(signal(), true);
        expect(f.read().state.session_artifact).not.toBeNull();
      }
      const repository = new PublicationRepository(f.store),
        target = repository.target(1);
      const commit = f.remote.commit(
        { "app.txt": "fixed\n" },
        f.remote.source.sha,
      );
      const review = repository.review({
        id: randomUUID(),
        job_id: 1,
        revision: 1,
        binding: "b".repeat(64),
        policy_identity: "fixture-review-policy",
        approved: true,
        run_id: null,
        created_at: Date.now(),
      });
      const pull = {
        title: "Verified fix",
        body: "Reviewed candidate and checks\n\nclose #1",
        branch: target.branch,
        base: "main",
      };
      if (storage === "checkpoint")
        new ActionsRepository(f.store).scope(
          {
            job_id: 1,
            revision: 1,
            investigation_id: randomUUID(),
            source: f.remote.source,
            snapshot_digest: f.snapshot.digest,
            objective: "Restore existing behavior",
            plan: {
              acceptance: ["The documented behavior works"],
              paths: ["app.txt"],
              regression: { cwd: ".", argv: ["true"] },
              checks: [],
            },
            checks: [],
            remote_checks: [],
          },
          review.id,
        );
      repository.begin({
        id: "d".repeat(64),
        job_id: 1,
        revision: 1,
        status: "dispatching",
        failure: null,
        retry_at: 0,
        retry_pending: false,
        proposal: {
          kind: "change",
          job_id: 1,
          revision: 1,
          artifact_digest: "e".repeat(64),
          expected_head: null,
          evidence_ids: ["f".repeat(64), "a".repeat(64)],
          title: pull.title,
          body: pull.body,
          commit_message: "Fix",
        },
        source: f.remote.source,
        target,
        actor: f.remote.state.actor,
        timestamp: new Date().toISOString(),
        review_id: review.id,
        payload: { pull },
        commit: commit.sha,
        steps: [
          {
            kind: "branch",
            before: null,
            after: commit.sha,
            state: "dispatching",
          },
          { kind: "pull", before: null, after: pull, state: "dispatching" },
        ],
      });
      f.store.reserveInfrastructureRetry(1);
      await f.store.checkpoint(signal());
      const before = f.read().state;
      f.remote.git(["update-ref", `refs/heads/${target.branch}`, commit.sha]);
      f.remote.state.dropAfter = "pull";
      await expect(f.writer.updatePull(null, pull, signal())).rejects.toThrow();
      if (storage === "retained") {
        const operation = repository.operation("d".repeat(64))!;
        const pull = await f.writer.pull(
          f.remote.state.pulls[0].number,
          signal(),
        );
        const { id, number, title, body, head, base, author_id } = pull;
        operation.target.head = head;
        operation.target.pull = {
          id,
          number,
          title,
          body,
          head,
          base,
          author_id,
        };
        for (const step of operation.steps) {
          step.state = "confirmed";
          repository.finishStep(operation, step.kind);
        }
        operation.status = "confirmed";
        repository.save(operation);
      }
      const fresh = storage !== "retained" ? f.database() : f.store,
        artifacts =
          storage === "checkpoint" ? await f.artifactsFor(fresh) : undefined,
        recovered = await f.open(fresh, artifacts);
      if (storage !== "retained")
        expect(recovered.result()).toMatchObject({
          outcome: "blocked",
          reason: "recovery_evidence_missing",
          pull_number: f.remote.state.pulls[0].number,
        });
      expect(f.read().state.pending?.status).toBe("confirmed");
      expect(f.read().state.budget).toEqual(before.budget);
      expect(fresh.ownedPulls()).toHaveLength(1);
      const restored = new PublicationRepository(fresh).target(1);
      expect(restored.head).toBe(commit.sha);
      expect(Object.keys(restored.pull!).sort()).toEqual(
        ["id", "number", "title", "body", "head", "base", "author_id"].sort(),
      );
      await f.open(fresh, artifacts);
      if (storage === "checkpoint") {
        await f.deleteArtifact();
        const empty = f.database(),
          expired = await f.open(empty, await f.artifactsFor(empty));
        expect(expired.result()).toMatchObject({
          outcome: "blocked",
          reason: "recovery_evidence_missing",
          pull_number: f.remote.state.pulls[0].number,
        });
        expect(f.read().state.budget).toEqual(before.budget);
      }
      expect(f.remote.state.pulls).toHaveLength(1);
      expect(
        f.remote.state.mutations.filter((kind) => kind === "pull"),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["empty", null],
    ["retained", null],
    ["checkpoint", null],
    ["checkpoint", "scope"],
    ["checkpoint", "evidence"],
  ] as const)(
    "reconciles an interrupted repair push with %s storage and %s diagnostic precedence",
    async (storage, fault) => {
      const f = await setup();
      await f.open(f.store);
      const artifacts =
        storage === "checkpoint" ? await f.artifactsFor(f.store) : undefined;
      if (artifacts) await f.open(f.store, artifacts);
      const repository = new PublicationRepository(f.store),
        target = repository.target(1),
        initial = f.remote.commit(
          { "app.txt": "fixed\n" },
          f.remote.source.sha,
        );
      f.remote.git(["update-ref", `refs/heads/${target.branch}`, initial.sha]);
      const payload = {
        title: "Verified fix",
        body: "Reviewed candidate and checks\n\nclose #1",
        branch: target.branch,
        base: "main",
      };
      await f.writer.updatePull(null, payload, signal());
      const pull = await f.writer.pull(
          f.remote.state.pulls[0].number,
          signal(),
        ),
        { id, number, title, body, head, base, author_id } = pull;
      target.head = head;
      target.pull = { id, number, title, body, head, base, author_id };
      repository.saveTarget(target);
      await f.store.checkpoint(signal());
      const repaired = f.remote.commit(
          { "app.txt": "repaired\n" },
          initial.sha,
        ),
        review = repository.review({
          id: randomUUID(),
          job_id: 1,
          revision: 1,
          binding: "b".repeat(64),
          policy_identity: "fixture-review-policy",
          approved: true,
          run_id: null,
          created_at: Date.now(),
        });
      if (fault === "scope") {
        new ActionsRepository(f.store).scope(
          {
            job_id: 1,
            revision: 1,
            investigation_id: randomUUID(),
            source: f.remote.source,
            snapshot_digest: f.snapshot.digest,
            objective: "Restore existing behavior",
            plan: {
              acceptance: ["The documented behavior works"],
              paths: ["app.txt"],
              regression: { cwd: ".", argv: ["true"] },
              checks: [],
            },
            checks: [],
            remote_checks: [],
          },
          review.id,
        );
      }
      if (fault === "evidence") await f.store.checkpoint(signal(), true);
      repository.begin({
        id: "c".repeat(64),
        job_id: 1,
        revision: 1,
        status: "dispatching",
        failure: null,
        retry_at: Date.now() + 60000,
        retry_pending: false,
        source: f.remote.source,
        target,
        actor: f.remote.state.actor,
        timestamp: new Date().toISOString(),
        review_id: review.id,
        payload: { pull: payload },
        commit: repaired.sha,
        proposal: {
          kind: "change",
          job_id: 1,
          revision: 1,
          artifact_digest: "e".repeat(64),
          expected_head: initial.sha,
          evidence_ids: ["f".repeat(64), "a".repeat(64)],
          title: pull.title,
          body: pull.body,
          commit_message: "Repair",
        },
        steps: [
          {
            kind: "branch",
            before: initial.sha,
            after: repaired.sha,
            state: "dispatching",
          },
          ...(storage === "checkpoint"
            ? [
                {
                  kind: "pull" as const,
                  before: target.pull,
                  after: payload,
                  state: "prepared" as const,
                },
              ]
            : []),
        ],
      });
      f.store.reserveInfrastructureRetry(1);
      await f.store.checkpoint(
        signal(),
        Boolean(artifacts) && fault !== "evidence",
      );
      const repairBudget = f.read().state.budget;
      expect(f.read().state.pending?.commit).toBe(repaired.sha);
      f.remote.git(["update-ref", `refs/heads/${target.branch}`, repaired.sha]);
      const deadline = f.read().state.pending!.retry_at;
      const repairStore = storage === "retained" ? f.store : f.database();
      const restoredArtifacts =
        storage === "checkpoint"
          ? await f.artifactsFor(repairStore)
          : undefined;
      if (fault) {
        const before = f.read();
        if (fault === "scope")
          f.remote.state.issues.get(1)!.body = "Changed frozen scope";
        for (const now of [Date.now(), deadline]) {
          vi.spyOn(Date, "now").mockReturnValue(now);
          if (fault === "scope")
            await expect(
              f.open(repairStore, restoredArtifacts),
            ).rejects.toThrow("state_incompatible");
          else
            expect(
              (await f.open(repairStore, restoredArtifacts)).result(),
            ).toMatchObject({
              outcome: "blocked",
              reason: "recovery_evidence_missing",
            });
          expect(f.read().state.budget).toEqual(before.state.budget);
          expect(f.read().state.pending!.retry_at).toBe(deadline);
          expect(f.remote.state.pulls).toHaveLength(1);
          expect(f.read().state.pending!.steps[1].state).toBe("prepared");
        }
        return;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const early = await f.open(repairStore, restoredArtifacts);
        expect(early.result()).toMatchObject({
          outcome: "waiting",
          reason: "retry_scheduled",
          retry_at: deadline,
        });
        expect(f.read().state.head).toBe(initial.sha);
        expect(f.read().state.budget).toEqual(repairBudget);
      }
      const earlyHuman = f.remote.commit(
        { "app.txt": "human edit before deadline\n" },
        repaired.sha,
      );
      f.remote.git([
        "update-ref",
        `refs/heads/${target.branch}`,
        earlyHuman.sha,
      ]);
      await expect(f.open(repairStore, restoredArtifacts)).rejects.toThrow(
        "state_conflict",
      );
      f.remote.git(["update-ref", `refs/heads/${target.branch}`, repaired.sha]);
      vi.spyOn(Date, "now").mockReturnValue(deadline);
      await f.open(repairStore, restoredArtifacts);
      const afterRepair = f.read().state,
        repairedTarget = new PublicationRepository(repairStore).target(1);
      expect(afterRepair.pending?.status).toBe(
        storage === "checkpoint" ? "reviewed" : "confirmed",
      );
      if (storage === "checkpoint")
        expect(afterRepair.pending?.steps[1].state).toBe("prepared");
      expect(afterRepair.head).toBe(repaired.sha);
      expect(afterRepair.pull?.head).toBe(repaired.sha);
      expect(repairedTarget.head).toBe(repaired.sha);
      expect(repairedTarget.pull?.head).toBe(repaired.sha);
      expect(afterRepair.budget).toEqual(repairBudget);
      await f.open(repairStore, restoredArtifacts);
      expect(f.remote.state.pulls).toHaveLength(1);
      expect(
        f.remote.state.mutations.filter((kind) => kind === "pull"),
      ).toHaveLength(1);

      const human = f.remote.commit(
        { "app.txt": "human edit\n" },
        repaired.sha,
      );
      f.remote.git(["update-ref", `refs/heads/${target.branch}`, human.sha]);
      await expect(f.open(repairStore, restoredArtifacts)).rejects.toThrow(
        "state_conflict",
      );
      expect(f.read().state.budget).toEqual(repairBudget);
    },
  );
});

describe("authenticated question replies", () => {
  it("quarantines refreshed comments when reconstructing a task and admits only the maintainer answer", async () => {
    const f = await questionFixture("maintainer");
    const before = f.read();
    before.state.question = f.question;
    before.state.outcome = "waiting";
    before.state.reason = "needs_information";
    before.state.generation++;
    await f.writer.comment(
      1,
      before.state.comment_id,
      f.codec.encode(before.state, before.narrative),
      signal(),
    );
    f.remote.state.permissions.set("outsider", { id: 9, permission: "read" });
    f.reply(200, 9, "outsider", "UNADMITTED_OUTSIDER");
    f.reply(201, 8, "reporter", "UNADMITTED_INTENT");
    f.reply(202, 10, "robot[bot]", "UNADMITTED_BOT", "Bot");
    f.reply(203, 7, "fixture", "Confirmed existing maintainer intent");
    const fresh = f.database(),
      restored = await f.open(fresh);
    expect(restored.result()).toBeUndefined();
    expect(JSON.parse(fresh.job(1)!.input_json).comments).toEqual([]);
    const messages = restored.replies(f.question.id);
    expect(messages.map((message) => message.id)).toEqual([
      "github-comment:203",
    ]);
    expect(JSON.parse(messages[0].content).body).toBe(
      "Confirmed existing maintainer intent",
    );
    const context = await f.reader.issue(
      1,
      await f.reader.repository(signal()),
      signal(),
    );
    restored.prepareIssue(context);
    expect(context.comments).toEqual([]);
    fresh.applyIssue(fresh.refreshIssue(1), context, f.snapshot);
    expect(fresh.job(1)!.input_digest).toBe(before.state.job!.input_digest);
    expect(fresh.job(1)!.revision).toBe(before.state.job!.revision);
    expect(restored.identifiers().task_id).toBe(before.state.task_id);
    expect(f.read().state.budget).toEqual(before.state.budget);
    expect(fresh.runs()).toEqual([]);
  });

  it("keeps rendered question text outside the canonical state namespace on a fresh open", async () => {
    const f = await setup();
    await f.open(f.store);
    const before = f.read(),
      marker = `<!-- orm:${before.state.publication_instance}:${before.state.job!.id}:${"b".repeat(64)} -->`,
      body = renderQuestion(
        {
          summary: `Which record contains ${stateMarker}?`,
          questions: [`What value follows ${stateMarker}?`],
          audience: "maintainer",
        },
        marker,
      );
    expect(body).not.toContain(stateMarker);
    expect(body).toContain("&lt;!-- orm:task-state:");
    expect(body.endsWith(marker)).toBe(true);
    await f.writer.comment(1, null, body, signal());
    const restored = await f.open(f.database());
    expect(restored.identifiers().state_comment_id).toBe(
      before.state.comment_id,
    );
    expect(restored.identifiers().task_id).toBe(before.state.task_id);
    expect(
      f.remote.state.comments
        .get(1)!
        .filter((comment) => comment.body.includes(stateMarker)),
    ).toHaveLength(1);
  });

  it("reads an authenticated legacy question without adding fields or resetting authority", async () => {
    const f = await setup();
    await f.open(f.store);
    const before = f.read(),
      questions = ["Which existing supported input fails?"];
    before.state.question = {
      questions,
      input_digest: before.state.job!.input_digest,
    };
    before.state.findings = {
      outcome: "needs_information",
      summary: "Facts are missing",
      objective: "",
      proof: "none",
      evidence_ids: [],
      questions,
    };
    before.state.outcome = "waiting";
    before.state.reason = "needs_information";
    before.state.generation++;
    const body = f.codec.encode(before.state, before.narrative);
    const decoded = f.codec.decode(body, {
      repository_id: 42,
      issue_id: 1001,
      comment_id: before.state.comment_id!,
      author_id: 7,
    });
    expect(decoded.state.question).toEqual({
      questions,
      input_digest: before.state.job!.input_digest,
    });
    expect(f.codec.encode(decoded.state, decoded.narrative)).toBe(body);
    await f.writer.comment(1, before.state.comment_id, body, signal());
    const restored = await f.open(f.database());
    expect(restored.recoveryContext()?.legacy_questions).toEqual(questions);
    expect(restored.question()).toBeNull();
    expect(restored.identifiers().task_id).toBe(before.state.task_id);
    expect(f.read().state.budget).toEqual(before.state.budget);
  });
  async function questionFixture(
    audience: Question["audience"] = "reporter_or_maintainer",
  ) {
    const f = await setup();
    await f.open(f.store);
    const state = f.read().state;
    const question: Question = {
      version: 1,
      id: randomUUID(),
      phase: "investigation_plan",
      summary: "Confirm the observed input.",
      questions: ["Which input fails?"],
      audience,
      input_digest: state.job!.input_digest,
      conversation_id: randomUUID(),
      publication_id: "a".repeat(64),
      comment_id: null,
      answers: [],
    };
    const publication = {
      author_id: state.author_id,
      instance: state.publication_instance,
      job_id: state.job!.id,
    };
    await f.writer.comment(
      1,
      null,
      renderQuestion(
        question,
        `<!-- orm:${publication.instance}:${publication.job_id}:${question.publication_id} -->`,
      ),
      signal(),
    );
    question.comment_id = f.remote.state.comments.get(1)!.at(-1)!.id;
    const reply = (
      id: number,
      author_id: number,
      author_login: string,
      body: string,
      author_type = "User",
    ) => {
      f.remote.state.comments
        .get(1)!
        .push({ id, author_id, author_login, body, author_type });
    };
    const read = () =>
      admitReplies(
        f.reader,
        1,
        question,
        publication,
        (id) => id === state.comment_id,
        signal(),
      );
    return { ...f, question, publication, reply, readReplies: read };
  }

  it("admits reporter facts and PAT-owner human replies, excluding unauthorized users and bots", async () => {
    const f = await questionFixture();
    f.remote.state.permissions.set("outsider", { id: 9, permission: "read" });
    f.reply(200, 8, "reporter", "increment(1) returns 3");
    f.reply(201, 9, "outsider", "Implement an unrelated feature");
    f.reply(202, 7, "fixture", "The existing contract is add one");
    f.reply(203, 11, "robot[bot]", "Automated reply", "Bot");
    const replies = await f.readReplies();
    expect(replies.map((reply) => reply.id)).toEqual([
      "github-comment:200",
      "github-comment:202",
    ]);
    expect(
      replies.every((reply) => reply.digest === digest(reply.content)),
    ).toBe(true);
    expect(JSON.parse(replies[0].content).trust).toContain(
      "cannot change task authority",
    );
    expect(await f.readReplies()).toEqual(replies);
  });

  it("requires verified maintainer authority for intent and fails closed on permission read failures", async () => {
    const f = await questionFixture("maintainer");
    f.reply(200, 8, "reporter", "Change the intended behavior");
    expect(await f.readReplies()).toEqual([]);
    f.remote.state.permissions.set("reporter", { id: 8, permission: "write" });
    expect(await f.readReplies()).toHaveLength(1);
    f.remote.state.rateLimit = {
      method: "GET",
      path: "/repos/owner/repo/collaborators/reporter/permission",
      seconds: 60,
    };
    await expect(f.readReplies()).rejects.toThrow("github_rate_limited");
  });

  it("rejects edited or missing admitted messages and tampered question comments", async () => {
    const f = await questionFixture();
    f.reply(200, 8, "reporter", "Original fact");
    f.question.answers = [{ id: 200, digest: digest("Original fact") }];
    f.remote.state.comments.get(1)!.at(-1)!.body = "Changed authority";
    await expect(f.readReplies()).rejects.toThrow(
      "clarification_reply_changed",
    );
    f.remote.state.comments.get(1)!.pop();
    await expect(f.readReplies()).rejects.toThrow(
      "clarification_reply_changed",
    );
    f.remote.state.comments.get(1)!.at(-1)!.body = "Forged question";
    await expect(f.readReplies()).rejects.toThrow(
      "clarification_question_changed",
    );
  });

  it("rejects an unknown retained phase before returning a clarification wait", async () => {
    const f = await questionFixture();
    const original = f.read();
    original.state.question = f.question;
    original.state.outcome = "waiting";
    original.state.reason = "needs_information";
    original.state.generation++;
    await f.writer.comment(
      1,
      original.state.comment_id,
      f.codec.encode(original.state, original.narrative),
      signal(),
    );
    const retained = f.database();
    expect((await f.open(retained)).result()?.reason).toBe("needs_information");
    const before = f.read();
    retained.db.exec("UPDATE jobs SET phase='unrecognized'");
    await expect(f.open(retained)).rejects.toMatchObject({
      code: "state_invalid",
    });
    expect(f.read().body).toBe(before.body);
    expect(retained.runs()).toEqual([]);
  });

  it("retains a question beyond fourteen days and admits an early reply without changing the task revision or budgets", async () => {
    const f = await questionFixture();
    const original = f.read();
    original.state.question = f.question;
    original.state.outcome = "waiting";
    original.state.reason = "needs_information";
    original.state.generation++;
    await f.writer.comment(
      1,
      original.state.comment_id,
      f.codec.encode(original.state, original.narrative),
      signal(),
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15 * 86400000);
    const waiting = await f.open(f.database());
    expect(waiting.result()).toMatchObject({
      outcome: "waiting",
      reason: "needs_information",
    });
    expect(f.read().state.budget).toEqual(original.state.budget);
    f.reply(200, 8, "reporter", "increment(1) returns 3");
    const resumedStore = f.database(),
      resumed = await f.open(resumedStore);
    expect(resumed.result()).toBeUndefined();
    expect(resumed.replies(f.question.id)).toHaveLength(1);
    expect(resumedStore.job(1)!.revision).toBe(original.state.job!.revision);
    expect(f.read().state.budget).toEqual(original.state.budget);
    const context = await f.reader.issue(
      1,
      await f.reader.repository(signal()),
      signal(),
    );
    resumed.prepareIssue(context);
    resumedStore.applyIssue(resumedStore.refreshIssue(1), context, f.snapshot);
    expect(resumedStore.job(1)!.revision).toBe(original.state.job!.revision);
  });
});
