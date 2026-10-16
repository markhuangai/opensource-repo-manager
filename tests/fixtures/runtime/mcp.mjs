import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { Server } from "/opt/orm/app/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js";
import { StreamableHTTPServerTransport } from "/opt/orm/app/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "/opt/orm/app/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";
import { McpGateway } from "/opt/orm/app/dist/services/mcp/index.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";
import { createRunSnapshot } from "/opt/orm/app/dist/config/load.js";
import { parseConfiguration } from "/opt/orm/app/dist/config/schema.js";
import { separateSecrets } from "/opt/orm/app/dist/config/secrets.js";

export async function verifyMcp({
  store,
  worker,
  root,
  sourceUrl,
  source,
  proxy,
  bundles,
}) {
  const sessions = new Map(),
    servers = new Set(),
    calls = [],
    issued = [];
  const credentials = [0, 1].map(
    () => `mcp-upstream-container-${randomUUID()}`,
  );
  let description = "read fixture";
  const upstream = createServer(async (req, res) => {
    const credential = credentials.indexOf(req.headers.authorization?.slice(7));
    if (credential < 0) {
      res.writeHead(401);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    let session = sessions.get(req.headers["mcp-session-id"]);
    if (!session) {
      if (body?.method !== "initialize") {
        res.writeHead(404);
        res.end();
        return;
      }
      const server = new Server(
        { name: "generic-http-fixture", version: "1" },
        { capabilities: { tools: {} } },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
        keepAliveMs: 0,
      });
      servers.add(server);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ["read", "hidden"].map((name) => ({
          name,
          description,
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            additionalProperties: false,
          },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (message) => {
        calls.push({ credential, name: message.params.name });
        assert(
          !JSON.stringify(message.params).includes("mcp-upstream-container-"),
        );
        return { content: [{ type: "text", text: String(credential) }] };
      });
      await server.connect(transport);
      session = { server, transport };
    }
    await session.transport.handleRequest(req, res, body);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const config = parseConfiguration(
    await readFile("/config/config.yml", "utf8"),
  );
  config.proxy.url = proxy;
  config.mcp.credentials = Object.fromEntries(
    credentials.map((credential, index) => [
      `credential${index}`,
      { headers: { Authorization: `Bearer ${credential}` } },
    ]),
  );
  config.mcp.servers = Object.fromEntries(
    credentials.map((_, index) => [
      `alias${index}`,
      {
        transport: "streamable_http",
        allow_plain_http: true,
        url: `http://127.0.0.1:${upstream.address().port}/mcp`,
        credential_ref: `credential${index}`,
        tools: { read: { effect: "read" }, hidden: { effect: "read" } },
      },
    ]),
  );
  config.roles.investigation.mcp = {
    alias0: { tools: ["read"] },
    alias1: { tools: ["read"] },
  };
  config.roles.audit.mcp = { alias0: { tools: ["hidden"] } };
  const { settings, secrets } = separateSecrets(config),
    snapshot = createRunSnapshot(settings, bundles, secrets);
  store.saveSnapshot(snapshot);
  const gateway = new McpGateway(store, snapshot, secrets);
  let supervisor;
  try {
    supervisor = await Supervisor.create(store, snapshot, secrets, {
      root,
      workers: { claude: worker, codex: worker },
      sourceUrl: () => sourceUrl,
      mcp: {
        async open(request) {
          const session = await gateway.open(request);
          issued.push(...session.connections);
          return session;
        },
      },
    });
    await gateway.start();
    let number = Math.max(...store.jobs().map((job) => job.issue_number)) + 1;
    const seed = () => {
      number++;
      store.discover([number], 1, true);
      store.applyIssue(
        store.nextDirty(),
        {
          id: 1000 + number,
          number,
          state: "open",
          title: "MCP runtime",
          body: "fixture",
          updated_at: "2026-10-16T00:00:00Z",
          comments: [],
          source,
        },
        snapshot,
      );
      return store.job(number);
    };
    const run = async (job, role = "investigation", extra = {}) => {
      const events = [];
      for await (const event of supervisor.run(
        { ...supervisor.request(job.id, role, { mode: "mcp-real" }), ...extra },
        new globalThis.AbortController().signal,
      ))
        events.push(event);
      return events.at(-1);
    };
    const job = seed(),
      first = await run(job);
    assert.equal(first.outcome, "completed");
    assert.equal(first.result.uid, 10001);
    assert.deepEqual(first.result.values, ["0", "1"]);
    const resumed = await run(job, "investigation", {
      resume: { id: "real-mcp-session", binding: first.result.binding },
    });
    assert.equal(resumed.outcome, "completed");
    description = "changed catalog";
    assert.equal(
      (
        await run(job, "investigation", {
          resume: { id: "real-mcp-session", binding: first.result.binding },
        })
      ).outcome,
      "failed",
    );
    const audit = await run(seed(), "audit");
    assert.equal(audit.outcome, "completed");
    assert.equal(audit.result.uid, 10002);
    assert(calls.some((call) => call.credential === 0 && call.name === "read"));
    assert(calls.some((call) => call.credential === 1 && call.name === "read"));
    assert(calls.some((call) => call.name === "hidden"));
    for (const connection of issued) {
      assert.equal(
        (
          await fetch(connection.url, {
            headers: { authorization: `Bearer ${connection.authorization}` },
          })
        ).status,
        401,
      );
      assert(
        !credentials.some((credential) =>
          JSON.stringify(connection).includes(credential),
        ),
      );
    }
    const receipts = store.mcpCalls();
    assert(
      receipts.length >= 5 &&
        receipts.every((receipt) => receipt.outcome === "completed"),
    );
    assert(
      !credentials.some((credential) =>
        JSON.stringify(receipts).includes(credential),
      ),
    );
    assert.equal(store.leases().length, 0);
    assert.deepEqual(await readdir(root + "/runs"), []);
    return {
      protocol: "streamable_http",
      users: [10001, 10002],
      raw_authorization: "enforced",
      aliases: "credential_isolated",
      resume: "catalog_fenced",
      receipts: "durable_sanitized",
      cleanup: "passed",
    };
  } finally {
    try {
      await supervisor?.close();
    } finally {
      try {
        await gateway.close();
      } finally {
        await Promise.all([...servers].map((server) => server.close()));
        upstream.closeAllConnections();
        await new Promise((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }
}
