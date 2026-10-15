import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/repositories/store.ts";
import { ModelRelay } from "../src/services/model-relay.ts";
import { fixtureConfiguration, fixtureSnapshot } from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(sdk: "claude" | "codex" = "claude", budget = 10) {
  const requests: Array<{
    url: string | undefined;
    authorization: string | undefined;
    body: unknown;
    committed: number;
  }> = [];
  let handler:
    ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const server = createServer(async (req, res) => {
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(bytes),
      committed: JSON.parse(store.job(1)!.budget_json).model_requests,
    });
    if (handler) handler(req, res);
    else {
      res.setHeader("content-type", "application/json");
      res.end('{"count":3}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port,
    config = fixtureConfiguration();
  config.proxy.url = `http://127.0.0.1:${port}/v1`;
  config.proxy.key = "relay-upstream-secret";
  const loaded = await fixtureSnapshot("model", config),
    root = await mkdtemp(join(tmpdir(), "orm-relay-"));
  const store = new Store(join(root, "state", "db.sqlite"));
  store.saveSnapshot(loaded.snapshot);
  store.discover([1], 1, true);
  const context = {
    ...makeIssue(1),
    state: "open" as const,
    comments: [],
    source: {
      sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
      default_branch: "main",
    },
  };
  store.applyIssue(store.nextDirty()!, context, loaded.snapshot);
  const job = store.job(1)!,
    lease = store.acquireLease(job.id, job.revision)!;
  const deadline = store.startRuntimeLease(lease, 60_000),
    relay = new ModelRelay(store, config.proxy.url, loaded.secrets);
  await relay.start();
  const controller = new AbortController();
  let available = true;
  const profile =
    sdk === "claude"
      ? { sdk: "claude" as const, model: "model", effort: "high" as const }
      : { sdk: "codex" as const, model: "model", effort: "high" as const };
  const grant = relay.authorize({
    lease,
    profile,
    deadline,
    requests: budget,
    bytes: 4096,
    signal: controller.signal,
    current: () => store.runtimeCurrent(lease),
    available: () => available,
  });
  cleanups.push(async () => {
    controller.abort();
    await relay.close();
    store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true });
  });
  const post = (
    path: string,
    body: unknown = { model: "model" },
    signal?: AbortSignal,
  ) =>
    fetch(grant.url + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.authorization}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  return {
    post,
    grant,
    relay,
    store,
    loaded,
    requests,
    controller,
    context,
    handler: (next: typeof handler) => {
      handler = next;
    },
    available: (next: boolean) => {
      available = next;
    },
  };
}

describe("scoped model relay", () => {
  it("rejects an actual WebSocket upgrade", async () => {
    const f = await setup("codex"),
      url = new URL(f.grant.url);
    const socket = createConnection({
      host: "127.0.0.1",
      port: Number(url.port),
    });
    const response = await new Promise<string>((resolve, reject) => {
      let output = "";
      socket.on("data", (chunk) => {
        output += chunk;
      });
      socket.on("error", reject);
      socket.on("close", () => resolve(output));
      socket.on("connect", () =>
        socket.write(
          `GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${f.grant.authorization}\r\n\r\n`,
        ),
      );
    });
    expect(response).toContain("403 Forbidden");
    expect(f.requests).toHaveLength(0);
  });
  it("streams split SSE frames using only upstream authentication", async () => {
    const f = await setup();
    f.handler((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write('event: message_start\ndata: {"type":"message_');
      setTimeout(
        () =>
          res.end(
            'start","message":{"id":"m"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
          ),
        5,
      );
    });
    const response = await f.post("/messages");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
    expect(f.requests).toMatchObject([
      {
        url: "/v1/messages",
        authorization: "Bearer relay-upstream-secret",
        body: { model: "model", output_config: { effort: "high" } },
        committed: 1,
      },
    ]);
    expect(f.grant.authorization).not.toBe("relay-upstream-secret");
    expect((await f.post("/messages/count_tokens")).status).toBe(200);
  });
  it.each(["/responses", "/responses/compact"])(
    "supports Codex HTTP route %s and rejects cross-profile requests",
    async (path) => {
      const f = await setup("codex");
      expect((await f.post(path)).status).toBe(200);
      expect((await f.post("/messages")).status).toBe(403);
      expect((await f.post(path, { model: "other" })).status).toBe(403);
      expect(
        (await f.post(path, { model: "model", reasoning: { effort: "low" } }))
          .status,
      ).toBe(403);
      expect(
        (await f.post(path, { model: "model", base_url: "http://other" }))
          .status,
      ).toBe(403);
      expect(f.requests).toHaveLength(1);
    },
  );
  it.each(["claude", "codex"] as const)(
    "enforces %s effort on generation requests before forwarding",
    async (sdk) => {
      const f = await setup(sdk),
        path = sdk === "claude" ? "/messages" : "/responses",
        setting = sdk === "claude" ? "output_config" : "reasoning";
      expect((await f.post(path)).status).toBe(200);
      expect(f.requests[0].body).toEqual({
        model: "model",
        [setting]: { effort: "high" },
      });
      expect(
        (await f.post(path, { model: "model", [setting]: { effort: "low" } }))
          .status,
      ).toBe(403);
      expect(
        (await f.post(path, { model: "model", [setting]: "high" })).status,
      ).toBe(403);
      expect(
        (await f.post(path, { model: "model", [setting]: { effort: "high" } }))
          .status,
      ).toBe(200);
      expect(f.requests).toHaveLength(2);
    },
  );
  it("commits concurrent request reservations before forwarding and never refunds failures", async () => {
    const f = await setup("claude", 2);
    f.handler((_req, res) => {
      res.writeHead(500);
      res.end("relay-upstream-secret");
    });
    const responses = await Promise.all([
      f.post("/messages"),
      f.post("/messages/count_tokens"),
      f.post("/messages"),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([429, 502, 502]);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.every((r) => r.committed >= 1)).toBe(true);
    expect(JSON.parse(f.store.job(1)!.budget_json).model_requests).toBe(2);
    for (const response of responses)
      expect(await response.text()).not.toContain("relay-upstream-secret");
  });
  it("rejects redirects, secret-bearing SSE errors, oversized input and forbidden paths", async () => {
    const f = await setup();
    f.handler((_req, res) => {
      res.writeHead(302, { location: f.grant.url + "/messages" });
      res.end();
    });
    expect((await f.post("/messages")).status).toBe(502);
    expect(f.requests).toHaveLength(1);
    f.handler((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end(
        'event: error\ndata: {"error":{"message":"relay-upstream-secret"}}\n\n',
      );
    });
    expect(await (await f.post("/messages")).text()).not.toContain(
      "relay-upstream-secret",
    );
    expect(
      (await f.post("/messages", { model: "model", input: "x".repeat(5000) }))
        .status,
    ).toBe(413);
    expect((await f.post("/models")).status).toBe(403);
    expect((await f.post("/messages?target=elsewhere")).status).toBe(403);
    expect(
      (
        await fetch(f.grant.url + "/messages", {
          headers: { authorization: `Bearer ${f.grant.authorization}` },
        })
      ).status,
    ).toBe(403);
  });
  it("keeps authorization usable after a nested-review suspension", async () => {
    const f = await setup();
    f.available(false);
    expect((await f.post("/messages")).status).toBe(409);
    await delay(300);
    f.available(true);
    expect((await f.post("/messages")).status).toBe(200);
    expect(f.requests).toHaveLength(1);
  });
  it.each(["cancellation", "revision", "disconnect"])(
    "aborts upstream streaming on %s",
    async (mode) => {
      const f = await setup();
      let closed = false;
      f.handler((_req, res) => {
        res.on("close", () => {
          closed = true;
        });
        res.setHeader("content-type", "text/event-stream");
        res.write('data: {"type":"message_start"}\n\n');
      });
      const client = new AbortController(),
        response = await f.post("/messages", { model: "model" }, client.signal);
      const reader = response.body!.getReader();
      await reader.read();
      if (mode === "cancellation") f.controller.abort();
      if (mode === "disconnect") client.abort();
      if (mode === "revision") {
        f.store.discover([1], 1, true);
        f.store.applyIssue(
          f.store.nextDirty()!,
          { ...f.context, body: "changed" },
          f.loaded.snapshot,
        );
      }
      const until = Date.now() + 2000;
      while (!closed && Date.now() < until) await delay(10);
      expect(closed).toBe(true);
      await reader.cancel().catch(() => {});
      if (mode !== "disconnect")
        expect((await f.post("/messages")).status).toBe(401);
    },
  );
  it("expires short-lived grants and rejects invalid authentication", async () => {
    const f = await setup();
    const short = f.relay.authorize({
      lease: f.store.leases()[0].token,
      profile: { sdk: "claude", model: "model", effort: "high" },
      deadline: Date.now() + 20,
      requests: 10,
      bytes: 4096,
      signal: f.controller.signal,
      current: () => true,
    });
    await delay(40);
    expect(
      (
        await fetch(short.url + "/messages", {
          method: "POST",
          headers: { authorization: `Bearer ${short.authorization}` },
          body: '{"model":"model"}',
        })
      ).status,
    ).toBe(401);
    f.grant.revoke();
    expect((await f.post("/messages")).status).toBe(401);
    expect(
      (
        await fetch(f.grant.url + "/messages", {
          method: "POST",
          headers: { authorization: "Bearer unknown" },
          body: '{"model":"model"}',
        })
      ).status,
    ).toBe(401);
  });
});
