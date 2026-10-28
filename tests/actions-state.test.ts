import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import { OctokitWriter } from "../src/adapters/github/writer.ts";
import { OctokitReader } from "../src/adapters/github/reader.ts";
import { ActionsState } from "../src/actions/persistence.ts";
import { StateCodec, stateBytes, commentBytes } from "../src/actions/state.ts";
import { Store } from "../src/repositories/store.ts";
import { PublicationRepository } from "../src/repositories/publication.ts";
import { InvestigationRepository } from "../src/repositories/investigation.ts";
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
  const database = () => {
    const store = new Store(join(root, randomUUID(), "state.sqlite"));
    cleanups.push(async () => {
      if (store.db.open) store.close();
    });
    return store;
  };
  const open = (store: Store) =>
    ActionsState.open(store, snapshot, secrets, 1, signal(), {
      writer,
      reader,
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
  return {
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
    expect(fresh.job(1)!.revision).toBe(before.job!.revision + 1);
    await intake.stop();
    expect(
      f.remote.state.requests.some(
        (request) => request.path === "/repos/owner/repo/issues",
      ),
    ).toBe(false);
  });

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

  it.each(["empty", "retained"])(
    "recovers a created PR after response loss with %s local storage",
    async (storage) => {
      const f = await setup();
      await f.open(f.store);
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
      const fresh = storage === "empty" ? f.database() : f.store,
        recovered = await f.open(fresh);
      if (storage === "empty")
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
      await f.open(fresh);
      expect(f.remote.state.pulls).toHaveLength(1);
      expect(
        f.remote.state.mutations.filter((kind) => kind === "pull"),
      ).toHaveLength(1);
    },
  );
});
