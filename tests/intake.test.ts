import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/repositories/store.ts";
import { IntakeService } from "../src/services/intake.ts";
import { createApp } from "../src/http/app.ts";
import { fixtureGitHub, fixtureSnapshot } from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(enroll = true) {
  const root = await mkdtemp(join(tmpdir(), "orm-intake-"));
  const github = await fixtureGitHub();
  const loaded = await fixtureSnapshot();
  const path = join(root, "state", "manager.sqlite");
  const store = new Store(path);
  const logs: string[] = [];
  const logger = {
    info: (message: string) => logs.push(message),
    error: (message: string) => logs.push(message),
  };
  const service = new IntakeService(
    store,
    github.reader,
    loaded.snapshot,
    loaded.secrets,
    logger,
  );
  const services = [service],
    stores = [store];
  const app = createApp(service, "webhook-fixture-secret");
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    await app.close();
    for (const intake of services) await intake.stop();
    for (const database of stores) if (database.db.open) database.close();
    await github.close();
    await rm(root, { recursive: true });
  });
  if (enroll) await service.reconcile();
  async function send(
    payload: unknown,
    event = "issues",
    id = randomUUID(),
    headers: Record<string, string> = {},
  ) {
    const body =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    const signature =
      "sha256=" +
      createHmac("sha256", "webhook-fixture-secret").update(body).digest("hex");
    return fetch(address + "/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-delivery": id,
        "x-github-event": event,
        ...headers,
      },
    });
  }
  return {
    root,
    path,
    github,
    loaded,
    store,
    service,
    services,
    stores,
    logger,
    logs,
    app,
    address,
    send,
  };
}
const issueEvent = (number = 1) => ({
  repository: { id: 42 },
  issue: { id: 1000 + number, number },
  action: "opened",
});

describe("durable GitHub intake", () => {
  it("verifies signed raw HTTP requests and rejects invalid or excessive input safely", async () => {
    const { send, store, address } = await setup();
    expect((await send(issueEvent())).status).toBe(202);
    expect(
      (
        await send(issueEvent(), "issues", randomUUID(), {
          "x-hub-signature-256": "sha256=" + "0".repeat(64),
        })
      ).status,
    ).toBe(401);
    expect(
      (await send({ ...issueEvent(), repository: { id: 99 } })).status,
    ).toBe(403);
    expect((await send("{broken json")).status).toBe(400);
    expect((await send({ repository: { id: 42 } })).status).toBe(400);
    expect(
      (
        await send(issueEvent(), "issues", randomUUID(), {
          "x-github-event": "secret-invalid-input",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(address + "/webhooks/github", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const oversized = await send({
      repository: { id: 42 },
      body: "x".repeat(1024 * 1024),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).not.toContain("xxxx");
    expect(store.db.prepare("SELECT count(*) AS n FROM inbox").get()).toEqual({
      n: 1,
    });
  });
  it("acknowledges only durable commits and makes delivery replay idempotent", async () => {
    const { send, store } = await setup();
    const id = randomUUID();
    expect((await send(issueEvent(), "issues", id)).status).toBe(202);
    expect((await send(issueEvent(), "issues", id)).status).toBe(202);
    expect(
      (await send({ ...issueEvent(), action: "closed" }, "issues", id)).status,
    ).toBe(409);
    store.db.exec(
      "CREATE TRIGGER fail_inbox BEFORE INSERT ON dirty BEGIN SELECT RAISE(ABORT,'fixture-only-secret-error'); END",
    );
    const failed = await send(issueEvent());
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("fixture-only-secret-error");
    expect(store.db.prepare("SELECT count(*) AS n FROM inbox").get()).toEqual({
      n: 1,
    });
  });
  it("uses authoritative issue state for out-of-order events, closure and reopening", async () => {
    const { send, service, store, github } = await setup();
    const initial = store.job(1)!;
    github.state.issues[1].state = "closed";
    await send(issueEvent());
    await service.reconcile();
    const closed = store.job(1)!;
    expect(closed.status).toBe("closed");
    await send(issueEvent());
    await service.reconcile();
    expect(store.job(1)!.revision).toBe(closed.revision);
    github.state.issues[1].state = "open";
    await send({ ...issueEvent(), action: "reopened" });
    await service.reconcile();
    expect(store.jobs()).toHaveLength(1);
    expect(store.job(1)).toMatchObject({
      id: initial.id,
      status: "pending",
      phase: "investigation",
      revision: closed.revision + 1,
    });
    expect(store.counts().inbox).toBe(0);
  });
  it("ignores recorded comments while preserving genuine comments by the same PAT owner", async () => {
    const { send, service, store, github } = await setup();
    const job = store.job(1)!;
    store.recordPublication({
      operation_key: "comment",
      job_id: job.id,
      revision: job.revision,
      kind: "issue_comment",
      object_id: "9001",
      number: null,
      head_sha: null,
      receipt_json: "{}",
    });
    github.state.comments[1] = [
      {
        id: 9001,
        body: "Instance-generated comment",
        updated_at: "2026-10-15T01:00:00Z",
        user: { id: 7, login: "pat-owner" },
      },
    ];
    github.state.issues[1].updated_at = "2026-10-15T01:00:00Z";
    await send({ ...issueEvent(), comment: { id: 9001 } }, "issue_comment");
    expect(store.counts().inbox).toBe(0);
    await service.reconcile();
    expect(store.job(1)!.revision).toBe(job.revision);
    github.state.comments[1].push({
      id: 9002,
      body: "Human response from the PAT owner",
      updated_at: "2026-10-15T01:01:00Z",
      user: { id: 7, login: "pat-owner" },
    });
    await send({ ...issueEvent(), comment: { id: 9002 } }, "issue_comment");
    await service.reconcile();
    expect(JSON.parse(store.job(1)!.input_json).comments).toEqual([
      github.state.comments[1][1],
    ]);
    expect(store.job(1)!.input_json).not.toContain(github.state.token);
  });
  it("processes only recorded owned PRs and their matching current-head check events", async () => {
    const { send, service, store, github } = await setup();
    const job = store.job(1)!;
    github.state.pulls[5] = {
      id: 5005,
      number: 5,
      state: "open",
      updated_at: "2026-10-15T01:00:00Z",
      head: { sha: "c".repeat(40) },
    };
    store.recordPublication({
      operation_key: "pull",
      job_id: job.id,
      revision: job.revision,
      kind: "pull_request",
      object_id: "5005",
      number: 5,
      head_sha: "c".repeat(40),
      receipt_json: "{}",
    });
    await send(
      { repository: { id: 42 }, pull_request: { id: 5006, number: 6 } },
      "pull_request",
    );
    expect(store.counts().inbox).toBe(0);
    await send(
      {
        repository: { id: 42 },
        check_run: {
          head_sha: "c".repeat(40),
          pull_requests: [
            { id: 5005, number: 5 },
            { id: 5006, number: 6 },
          ],
        },
      },
      "check_run",
    );
    await service.reconcile();
    expect(store.ownedPull(5)?.context_json).toContain("cccc");
    const revision = store.job(1)!.revision;
    store.recordPublication({
      operation_key: "pull-comment",
      job_id: job.id,
      revision,
      kind: "issue_comment",
      object_id: "9003",
      number: null,
      head_sha: null,
      receipt_json: "{}",
    });
    github.state.pulls[5].updated_at = "2026-10-15T02:00:00Z";
    github.state.comments[5] = [
      {
        id: 9003,
        body: "Owned PR comment",
        updated_at: "2026-10-15T02:00:00Z",
        user: { id: 7, login: "pat-owner" },
      },
    ];
    await send(
      {
        repository: { id: 42 },
        issue: { id: 9905, number: 5, pull_request: {} },
        comment: { id: 9003 },
      },
      "issue_comment",
    );
    await service.reconcile();
    expect(store.job(1)!.revision).toBe(revision);
    github.state.comments[5].push({
      id: 9004,
      body: "Human PR comment",
      updated_at: "2026-10-15T02:01:00Z",
      user: { id: 7, login: "pat-owner" },
    });
    await send(
      {
        repository: { id: 42 },
        issue: { id: 9905, number: 5, pull_request: {} },
        comment: { id: 9004 },
      },
      "issue_comment",
    );
    await service.reconcile();
    expect(store.job(1)!.revision).toBe(revision + 1);
    expect(store.ownedPull(5)!.context_json).toContain("Human PR comment");
    github.state.pulls[5].head.sha = "d".repeat(40);
    await send(
      { repository: { id: 42 }, pull_request: { id: 5005, number: 5 } },
      "pull_request",
    );
    await service.reconcile();
    expect(store.ownedPull(5)!.head_sha).toBe("d".repeat(40));
    await send({ repository: { id: 42 }, sha: "c".repeat(40) }, "status");
    expect(store.counts().inbox).toBe(0);
    expect(github.requests.every((request) => request.method === "GET")).toBe(
      true,
    );
  });
  it("resumes interrupted paginated backfill from durable state and preserves old job snapshots", async () => {
    const fixture = await setup(false);
    const { github, store, service, path, stores, services, loaded, logger } =
      fixture;
    for (let number = 2; number <= 101; number++)
      github.state.issues[number] = {
        ...makeIssue(number),
        ...(number <= 100 ? { pull_request: { url: "ignored" } } : {}),
      };
    github.beforeRequest(async (url) => {
      if (
        new URL(url, "http://fixture").searchParams.get("page") === "2" &&
        url.includes("/issues?")
      )
        github.state.failures[url] = { status: 500 };
    });
    await service.reconcile();
    expect(service.status().state).toBe("degraded");
    expect(store.cursor().page).toBe(2);
    expect(store.jobs()).toHaveLength(1);
    await service.stop();
    store.close();
    github.beforeRequest(undefined);
    github.state.failures = {};
    const reopened = new Store(path);
    stores.push(reopened);
    const changed = await fixtureSnapshot("new-model");
    const resumed = new IntakeService(
      reopened,
      github.reader,
      changed.snapshot,
      loaded.secrets,
      logger,
    );
    services.push(resumed);
    await resumed.reconcile();
    expect(reopened.cursor().page).toBe(1);
    expect(reopened.jobs().map((job) => job.issue_number)).toEqual([1, 101]);
    expect(reopened.job(1)!.snapshot_digest).toBe(loaded.snapshot.digest);
    expect(reopened.job(101)!.snapshot_digest).toBe(changed.snapshot.digest);
    expect(
      reopened.snapshot(loaded.snapshot.digest).roles.investigation.profile
        .model,
    ).toBe("fixture-model");
  });
  it("recovers missed events and leaves secret-bearing input pending without blocking other issues", async () => {
    const { service, store, github, loaded } = await setup();
    github.state.issues[1].state = "closed";
    github.state.issues[2] = makeIssue(2);
    github.state.issues[2].body = loaded.secrets.get("github.token");
    github.state.issues[3] = makeIssue(3);
    await service.reconcile();
    expect(store.job(1)!.status).toBe("closed");
    expect(store.job(2)).toBeUndefined();
    expect(store.job(3)!.status).toBe("pending");
    expect(service.status()).toMatchObject({
      state: "degraded",
      reason: "secret_in_input",
      failed: 1,
    });
  });
  it("keeps intake unavailable until enrollment succeeds and stops on repository replacement", async () => {
    const fixture = await setup(false);
    const { send, github, service, store, services, loaded, logger } = fixture;
    expect((await send(issueEvent())).status).toBe(503);
    github.state.failures["/repos/owner/repo"] = { status: 401 };
    await service.reconcile();
    expect(service.status()).toMatchObject({
      state: "degraded",
      reason: "github_authentication",
    });
    github.state.failures = {};
    const fresh = new IntakeService(
      store,
      github.reader,
      loaded.snapshot,
      loaded.secrets,
      logger,
    );
    services.push(fresh);
    await fresh.reconcile();
    github.state.repository.id = 99;
    await fresh.reconcile();
    expect(fresh.status()).toMatchObject({
      state: "degraded",
      reason: "repository_changed",
    });
    expect(store.repository()!.id).toBe(42);
    expect(store.jobs()).toHaveLength(1);
  });
  it("reports intake status while keeping automation readiness unavailable", async () => {
    const { address, store } = await setup();
    const response = await fetch(address + "/readyz");
    expect(response.status).toBe(503);
    const status = await response.json();
    expect(status).toMatchObject({
      reason: "automation_not_implemented",
      intake: { state: "ready", pending: 1 },
    });
    expect(JSON.stringify(status)).not.toMatch(
      /owner\/repo|github-fixture-token|maintenance problem/,
    );
    expect(store.job(1)!.status).toBe("pending");
  });
});
