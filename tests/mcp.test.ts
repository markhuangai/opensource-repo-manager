import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { McpGateway } from "../src/services/mcp/index.ts";
import { Store } from "../src/repositories/store.ts";
import { fixtureConfiguration, fixtureSnapshot } from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";
import { roleUsers, type McpConnection } from "../src/domain/agents.ts";
import type { Configuration, Role } from "../src/config/schema.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      "MCP fixture cleanup failed",
    );
});

const tool = (name: string, description = name): Tool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    additionalProperties: false,
  },
});

async function setup(configure?: (config: Configuration) => void) {
  const transports = new Map<
    string,
    { server: Server; transport: StreamableHTTPServerTransport }
  >();
  const servers = new Set<Server>();
  const state = {
    catalog: [tool("read"), tool("hidden"), tool("write")],
    catalogs: new Map<string, Tool[]>(),
    pageSize: 1,
    pageDelay: 0,
    hang: "",
    stateless: false,
    redirect: new Set<string>(),
    requests: [] as Array<{
      method: string;
      path: string;
      authorization?: string;
      session?: string;
      body?: {
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
    }>,
    calls: [] as Array<{
      name: string;
      args: Record<string, unknown>;
      authorization?: string;
    }>,
    execute: async (
      args: Record<string, unknown>,
      _progress: (message: string) => Promise<void>,
      _signal: AbortSignal,
      authorization?: string,
    ): Promise<CallToolResult> => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            args,
            authorization:
              authorization === "Bearer mcp-upstream-canary"
                ? "first"
                : "second",
          }),
        },
      ],
    }),
  };
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    state.requests.push({
      method: req.method!,
      path: req.url!,
      authorization: req.headers.authorization,
      session: req.headers["mcp-session-id"] as string | undefined,
      body,
    });
    if (state.redirect.has(req.method!)) {
      res.writeHead(307, { location: endpoint + "/redirected" });
      res.end();
      return;
    }
    if (state.hang === body?.method) return;
    let session = transports.get(req.headers["mcp-session-id"] as string);
    if (!session) {
      if (!state.stateless && body?.method !== "initialize") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (state.stateless && req.method === "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      const server = new Server(
        { name: "fixture", version: "1" },
        { capabilities: { tools: { listChanged: true } } },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: state.stateless ? undefined : randomUUID,
        onsessioninitialized: (id) => {
          transports.set(id, { server, transport });
        },
        keepAliveMs: 0,
      });
      servers.add(server);
      server.setRequestHandler(ListToolsRequestSchema, async (message) => {
        if (state.pageDelay) await delay(state.pageDelay);
        const index = Number(message.params?.cursor ?? 0);
        const catalog =
          state.catalogs.get(req.headers.authorization ?? "") ?? state.catalog;
        return {
          tools: catalog.slice(index, index + state.pageSize),
          ...(index + state.pageSize < catalog.length
            ? { nextCursor: String(index + state.pageSize) }
            : {}),
        };
      });
      const authorization = req.headers.authorization;
      server.setRequestHandler(
        CallToolRequestSchema,
        async (message, extra) => {
          const args = message.params.arguments ?? {};
          state.calls.push({ name: message.params.name, args, authorization });
          return state.execute(
            args,
            async (text) => {
              if (extra._meta?.progressToken !== undefined)
                await extra.sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken: extra._meta.progressToken,
                    progress: 1,
                    message: text,
                  },
                });
            },
            extra.signal,
            authorization,
          );
        },
      );
      await server.connect(transport);
      session = { server, transport };
    }
    await session.transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp`;
  const config = fixtureConfiguration();
  config.mcp.credentials.first = {
    headers: { Authorization: "Bearer mcp-upstream-canary" },
  };
  config.mcp.credentials.second = {
    headers: { Authorization: "Bearer other-upstream-canary" },
  };
  config.mcp.servers.context = {
    transport: "streamable_http",
    url: endpoint,
    allow_plain_http: true,
    credential_ref: "first",
    tools: {
      read: { effect: "read" },
      hidden: { effect: "read" },
      write: { effect: "reviewed_write" },
    },
  };
  config.roles.investigation.mcp = { context: { tools: ["read"] } };
  config.roles.audit.mcp = { context: { tools: ["hidden"] } };
  configure?.(config);
  const loaded = await fixtureSnapshot("model", config);
  const root = await mkdtemp(join(tmpdir(), "orm-mcp-")),
    path = join(root, "state", "db.sqlite"),
    store = new Store(path);
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
  const deadline = store.startRuntimeLease(lease, 30_000),
    gateway = new McpGateway(store, loaded.snapshot, loaded.secrets);
  await gateway.start();
  const runs = new Map<Role, string>(),
    controller = new AbortController();
  let available = true,
    expectedCleanupFailure = false;
  const clients: Client[] = [];
  const request = (role: Role = "investigation", until = deadline) => {
    if (!runs.has(role)) {
      const id = randomUUID();
      store.startRun({
        id,
        job_id: job.id,
        revision: job.revision,
        role,
        uid: roleUsers[role].uid,
        parent_id: null,
        lease_token: lease,
        binding_json: "{}",
      });
      runs.set(role, id);
    }
    return {
      run_id: runs.get(role)!,
      job_id: job.id,
      revision: job.revision,
      role,
      grants: loaded.snapshot.roles[role].mcp,
      deadline: until,
      signal: controller.signal,
      available: () => available,
    };
  };
  const open = (role: Role = "investigation", until = deadline) =>
    gateway.open(request(role, until));
  const connect = async (connection: McpConnection) => {
    const client = new Client(
      { name: "worker", version: "1" },
      { capabilities: {} },
    );
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(connection.url),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${connection.authorization}` },
        },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 100,
          maxReconnectionDelay: 100,
          reconnectionDelayGrowFactor: 1,
        },
      },
    );
    await client.connect(transport, { timeout: 3000 });
    return { client, transport };
  };
  const raw = (
    connection: McpConnection,
    method = "POST",
    body?: unknown,
    authorization = connection.authorization,
    session?: string,
  ) =>
    fetch(connection.url, {
      method,
      headers: {
        authorization: `Bearer ${authorization}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      ...(method === "POST"
        ? {
            body: JSON.stringify(
              body ?? {
                jsonrpc: "2.0",
                id: 7,
                method: "tools/call",
                params: { name: "read", arguments: {} },
              },
            ),
          }
        : {}),
      signal: AbortSignal.timeout(3000),
    });
  cleanups.push(async () => {
    try {
      if (expectedCleanupFailure)
        await expect(gateway.close()).rejects.toThrow("mcp_cleanup_failed");
      else await gateway.close();
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await Promise.all([...servers].map((server) => server.close()));
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
      await rm(root, { recursive: true });
    }
  });
  return {
    state,
    config,
    loaded,
    store,
    root,
    path,
    job,
    lease,
    deadline,
    gateway,
    request,
    open,
    connect,
    raw,
    controller,
    context,
    available: (value: boolean) => {
      available = value;
    },
    expectCleanupFailure: () => {
      expectedCleanupFailure = true;
    },
    changed: () =>
      Promise.all(
        [...servers].map((server) =>
          server.notification({ method: "notifications/tools/list_changed" }),
        ),
      ),
  };
}

describe("scoped HTTP MCP gateway", () => {
  it("initializes a complete paginated catalog and exposes only granted reads with durable digests", async () => {
    const f = await setup(),
      session = await f.open();
    const { client } = await f.connect(session.connections[0]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "read",
    ]);
    const result = await client.callTool({
      name: "read",
      arguments: { text: "hello" },
    });
    expect(result.isError).not.toBe(true);
    expect(
      f.state.requests.filter(
        (request) => request.body?.method === "tools/list",
      ),
    ).toHaveLength(3);
    expect(f.state.calls).toEqual([
      {
        name: "read",
        args: { text: "hello" },
        authorization: "Bearer mcp-upstream-canary",
      },
    ]);
    expect(f.store.mcpCalls()).toMatchObject([
      {
        outcome: "completed",
        role: "investigation",
        alias: "context",
        tool: "read",
      },
    ]);
    expect(f.store.mcpCalls()[0].request_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.store.mcpCalls()[0].result_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(f.store.mcpCalls())).not.toMatch(
      /hello|canary|Bearer/,
    );
    expect(JSON.stringify(session)).not.toContain("upstream-canary");
    await session.close();
    expect((await f.raw(session.connections[0])).status).toBe(401);
  });

  it("supports a real stateless Streamable HTTP server", async () => {
    const f = await setup();
    f.state.stateless = true;
    const session = await f.open(),
      { client } = await f.connect(session.connections[0]);
    expect((await client.callTool({ name: "read" })).isError).not.toBe(true);
  });

  it("allows empty grants without contacting any server and blocks every assigned write", async () => {
    const f = await setup((config) => {
      config.roles.investigation.mcp = {};
    });
    expect((await f.open()).connections).toEqual([]);
    expect(f.state.requests).toEqual([]);
    const write = await setup((config) => {
      config.roles.investigation.mcp.context.tools.push("write");
    });
    await expect(write.open()).rejects.toThrow(
      "mcp_reviewed_write_unavailable",
    );
    expect(write.state.requests).toEqual([]);
  });

  it("denies forged raw requests, cross-role session IDs, ungranted tools and unsupported capabilities", async () => {
    const f = await setup(),
      session = await f.open(),
      audit = await f.open("audit");
    const { client, transport } = await f.connect(session.connections[0]);
    const other = await f.connect(audit.connections[0]);
    expect(
      (await other.client.listTools()).tools.map((tool) => tool.name),
    ).toEqual(["hidden"]);
    expect(
      (
        await f.raw(
          session.connections[0],
          "POST",
          undefined,
          "wrong",
          transport.sessionId,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.raw(
          session.connections[0],
          "POST",
          undefined,
          audit.connections[0].authorization,
          transport.sessionId,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.raw(
          session.connections[0],
          "POST",
          undefined,
          session.connections[0].authorization,
          other.transport.sessionId,
        )
      ).status,
    ).toBe(404);
    expect((await f.raw(session.connections[0], "PUT")).status).toBe(405);
    await expect(client.callTool({ name: "hidden" })).rejects.toThrow(
      "mcp_tool_denied",
    );
    await expect(
      client.request({ method: "resources/list" }, ListToolsResultSchema),
    ).rejects.toThrow("Method not found");
    await expect(
      client.request(
        { method: "tools/call", params: { name: "read", task: {} } },
        CallToolResultSchema,
      ),
    ).rejects.toThrow("Server does not support task creation");
    expect(f.state.calls).toEqual([]);
  });

  it("isolates aliases sharing one URL and distinct credentials", async () => {
    const f = await setup((config) => {
      config.mcp.servers.second = {
        ...config.mcp.servers.context,
        credential_ref: "second",
      };
      config.roles.investigation.mcp.second = { tools: ["read"] };
    });
    const session = await f.open();
    expect(session.connections).toHaveLength(2);
    expect(
      new Set(session.connections.map((connection) => connection.authorization))
        .size,
    ).toBe(2);
    const first = await f.connect(session.connections[0]),
      second = await f.connect(session.connections[1]);
    await first.client.callTool({ name: "read" });
    await second.client.callTool({ name: "read" });
    expect(f.state.calls.map((call) => call.authorization)).toEqual([
      "Bearer mcp-upstream-canary",
      "Bearer other-upstream-canary",
    ]);
    const initializations = f.state.requests.filter(
      (request) => request.body?.method === "initialize",
    );
    expect(initializations).toHaveLength(2);
    expect(
      new Set(f.store.mcpCalls().map((call) => call.credential_binding)).size,
    ).toBe(2);
    expect(
      (
        await f.raw(
          session.connections[0],
          "POST",
          undefined,
          session.connections[1].authorization,
          first.transport.sessionId,
        )
      ).status,
    ).toBe(401);
  });

  it("validates real schemas without coercion, mutation, external loading or shared schema IDs", async () => {
    const f = await setup();
    f.state.catalog[0].inputSchema = {
      type: "object",
      $defs: { value: { type: "integer" } },
      properties: { value: { $ref: "#/$defs/value" } },
      required: ["value"],
      additionalProperties: false,
    };
    const session = await f.open(),
      { client } = await f.connect(session.connections[0]);
    await expect(
      client.callTool({ name: "read", arguments: { value: "3" } }),
    ).rejects.toThrow("mcp_arguments_invalid");
    await client.callTool({ name: "read", arguments: { value: 3 } });
    expect(f.state.calls.map((call) => call.args)).toEqual([{ value: 3 }]);
    const external = await setup();
    external.state.catalog[0].inputSchema = {
      type: "object",
      properties: {
        value: { $ref: external.config.mcp.servers.context.url + "/schema" },
      },
    };
    await expect(external.open()).rejects.toThrow("mcp_schema_invalid");
    expect(
      external.state.requests.some((request) =>
        request.path.includes("schema"),
      ),
    ).toBe(false);
  });

  it.each([
    ["input", "pattern"],
    ["output", "pattern"],
    ["input", "patternProperties"],
    ["output", "patternProperties"],
  ])("bounds untrusted %s schema %s evaluation", async (kind, keyword) => {
    const f = await setup();
    const schema = {
      type: "object" as const,
      additionalProperties: false,
      ...(keyword === "pattern"
        ? {
            properties: { text: { type: "string", pattern: "^(a+)+$" } },
            required: ["text"],
          }
        : { patternProperties: { "^(a+)+$": { type: "string" } } }),
    };
    if (kind === "input") f.state.catalog[0].inputSchema = schema;
    else f.state.catalog[0].outputSchema = schema;
    const invalid =
      keyword === "pattern"
        ? { text: "a".repeat(20_000) + "!" }
        : { ["a".repeat(20_000) + "!"]: "value" };
    const valid = keyword === "pattern" ? { text: "aaaa" } : { aaaa: "value" };
    let output: Record<string, unknown> = invalid;
    f.state.execute = async () => ({ content: [], structuredContent: output });
    const session = await f.open(),
      { client } = await f.connect(session.connections[0]);
    await expect(
      client.callTool({
        name: "read",
        arguments: kind === "input" ? invalid : {},
      }),
    ).rejects.toThrow(
      kind === "input" ? "mcp_arguments_invalid" : "mcp_result_invalid",
    );
    if (kind === "input") expect(f.state.calls).toEqual([]);
    else expect(f.store.mcpCalls().at(-1)?.outcome).toBe("failed");
    output = valid;
    await client.callTool({
      name: "read",
      arguments: kind === "input" ? valid : {},
    });
    expect(f.store.mcpCalls().at(-1)?.outcome).toBe("completed");
  });

  it.each(["input", "output"])(
    "rejects unsupported %s regex syntax explicitly",
    async (kind) => {
      const f = await setup();
      const schema = {
        type: "object" as const,
        properties: { text: { type: "string", pattern: "(?=a)a" } },
      };
      if (kind === "input") f.state.catalog[0].inputSchema = schema;
      else f.state.catalog[0].outputSchema = schema;
      await expect(f.open()).rejects.toThrow("mcp_schema_invalid");
      expect(f.state.calls).toEqual([]);
    },
  );

  it("keeps identically named schema IDs isolated across credential-bound catalogs", async () => {
    const f = await setup((config) => {
      config.mcp.servers.second = {
        ...config.mcp.servers.context,
        credential_ref: "second",
      };
      config.roles.investigation.mcp.second = { tools: ["read"] };
    });
    const schema = (type: string): Tool => ({
      name: "read",
      inputSchema: {
        type: "object",
        $id: "urn:fixture:same-id",
        properties: { value: { type } },
        required: ["value"],
      },
    });
    f.state.catalogs.set("Bearer mcp-upstream-canary", [schema("integer")]);
    f.state.catalogs.set("Bearer other-upstream-canary", [schema("string")]);
    const session = await f.open(),
      first = await f.connect(session.connections[0]),
      second = await f.connect(session.connections[1]);
    await first.client.callTool({ name: "read", arguments: { value: 1 } });
    await second.client.callTool({ name: "read", arguments: { value: "one" } });
    await expect(
      first.client.callTool({ name: "read", arguments: { value: "one" } }),
    ).rejects.toThrow("mcp_arguments_invalid");
    await expect(
      second.client.callTool({ name: "read", arguments: { value: 1 } }),
    ).rejects.toThrow("mcp_arguments_invalid");
  });

  it.each([
    "missing",
    "duplicate",
    "invalid-schema",
    "ungranted-invalid-schema",
  ])("rejects an invalid complete catalog: %s", async (mode) => {
    const f = await setup();
    if (mode === "missing") f.state.catalog = [tool("hidden")];
    if (mode === "duplicate") f.state.catalog.push(tool("read"));
    if (mode === "invalid-schema")
      f.state.catalog[0].inputSchema = {
        type: "object",
        properties: { invalid: { type: "invented" } },
      };
    if (mode === "ungranted-invalid-schema")
      f.state.catalog[1].inputSchema = {
        type: "object",
        properties: { invalid: { type: "invented" } },
      };
    await expect(f.open()).rejects.toThrow(
      mode === "missing"
        ? "mcp_tool_unavailable"
        : mode === "duplicate"
          ? "mcp_catalog_invalid"
          : "mcp_schema_invalid",
    );
    expect(f.state.calls).toEqual([]);
  });

  it.each(["input", "output"])(
    "rejects asynchronous %s schemas before they can bypass validation",
    async (kind) => {
      const f = await setup();
      const schema = {
        type: "object" as const,
        $async: true,
        properties: { value: { type: "integer" } },
        required: ["value"],
      };
      if (kind === "input") f.state.catalog[0].inputSchema = schema;
      else f.state.catalog[0].outputSchema = schema;
      f.state.execute = async () => ({
        content: [],
        structuredContent: { value: "invalid" },
      });
      await expect(f.open()).rejects.toThrow("mcp_schema_invalid");
      expect(f.state.calls).toEqual([]);
    },
  );

  it("rejects assigned task-required reads and closes aliases already initialized", async () => {
    const f = await setup((config) => {
      config.mcp.servers.second = {
        ...config.mcp.servers.context,
        credential_ref: "second",
      };
      config.roles.investigation.mcp.second = { tools: ["read"] };
    });
    f.state.catalogs.set("Bearer other-upstream-canary", [
      { ...tool("read"), execution: { taskSupport: "required" } },
    ]);
    await expect(f.open()).rejects.toThrow("mcp_tool_unavailable");
    expect(f.state.calls).toEqual([]);
    expect(
      f.state.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(2);
  });

  it.each([
    "description",
    "schema",
    "result",
    "error",
    "progress",
    "arguments",
    "authorization",
  ])("blocks secret canaries in %s", async (mode) => {
    const f = await setup();
    if (mode === "description")
      f.state.catalog[0].description = "mcp-upstream-canary";
    if (mode === "schema")
      f.state.catalog[0].inputSchema.description = "mcp-upstream-canary";
    if (mode === "description" || mode === "schema") {
      await expect(f.open()).rejects.toThrow("mcp_secret_in_response");
      return;
    }
    const session = await f.open(),
      connection = session.connections[0],
      { client } = await f.connect(connection);
    f.state.execute = async (_args, progress) => {
      if (mode === "error") throw new McpError(-32004, "mcp-upstream-canary");
      if (mode === "progress") {
        await progress("mcp-upstream-canary");
        await delay(30);
      }
      return { content: [{ type: "text", text: "mcp-upstream-canary" }] };
    };
    let failure: unknown;
    try {
      await client.callTool(
        {
          name: "read",
          arguments: {
            text:
              mode === "authorization"
                ? connection.authorization
                : mode === "arguments"
                  ? "mcp-upstream-canary"
                  : "safe",
          },
        },
        undefined,
        {
          timeout: 2000,
          onprogress: () => {
            throw new Error("secret progress escaped");
          },
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain("mcp-upstream-canary");
    expect(String(failure)).not.toContain(connection.authorization);
    if (mode === "arguments" || mode === "authorization")
      expect(f.state.calls).toEqual([]);
    expect(JSON.stringify(f.store.mcpCalls())).not.toContain("canary");
  });

  it.each(["POST", "GET", "DELETE"])(
    "rejects upstream redirects on %s without following them",
    async (method) => {
      const f = await setup();
      if (method !== "DELETE") {
        f.state.redirect.add(method);
        await expect(f.open()).rejects.toThrow();
      } else {
        const session = await f.open();
        f.state.redirect.add(method);
        f.expectCleanupFailure();
        await expect(session.close()).rejects.toThrow("mcp_cleanup_failed");
      }
      expect(
        f.state.requests.some((request) => request.path.includes("redirected")),
      ).toBe(false);
    },
  );

  it("bounds requests, streamed responses and the aggregate paginated catalog", async () => {
    const f = await setup((config) => {
      config.mcp.max_request_bytes = 1024;
      config.mcp.max_response_bytes = 4096;
    });
    const session = await f.open(),
      { client, transport } = await f.connect(session.connections[0]);
    expect(
      (
        await f.raw(
          session.connections[0],
          "POST",
          { padding: "x".repeat(2000) },
          session.connections[0].authorization,
          transport.sessionId,
        )
      ).status,
    ).toBe(413);
    expect(f.state.calls).toEqual([]);
    f.state.execute = async () => ({
      content: [{ type: "text", text: "x".repeat(8192) }],
    });
    await expect(
      client.callTool({ name: "read" }, undefined, { timeout: 2000 }),
    ).rejects.toThrow();
    const catalog = await setup((config) => {
      config.mcp.max_catalog_bytes = 500;
    });
    catalog.state.catalog = [
      tool("read", "x".repeat(150)),
      tool("hidden", "x".repeat(150)),
      tool("write", "x".repeat(150)),
    ];
    await expect(catalog.open()).rejects.toThrow("mcp_catalog_limit");
  });

  it("records oversized outgoing result envelopes as failures before sending", async () => {
    const f = await setup((config) => {
      config.mcp.max_response_bytes = 1000;
    });
    f.state.execute = async () => ({
      content: [{ type: "text", text: "x".repeat(850) }],
    });
    const session = await f.open(),
      { transport } = await f.connect(session.connections[0]);
    const response = await f.raw(
      session.connections[0],
      "POST",
      {
        jsonrpc: "2.0",
        id: "r".repeat(200),
        method: "tools/call",
        params: { name: "read" },
      },
      session.connections[0].authorization,
      transport.sessionId,
    );
    expect(await response.text()).toContain("mcp_response_limit");
    expect(f.state.calls).toHaveLength(1);
    expect(f.store.mcpCalls()).toMatchObject([
      { outcome: "failed", result_digest: null },
    ]);
  });

  it("paginates the downstream snapshot within its response bound", async () => {
    const f = await setup((config) => {
      config.mcp.max_response_bytes = 1000;
      config.mcp.servers.context.tools.extra = { effect: "read" };
      config.roles.investigation.mcp.context.tools.push("extra");
    });
    f.state.catalog.push(tool("extra", "x".repeat(500)));
    f.state.catalog[0].description = "x".repeat(500);
    const session = await f.open(),
      { client } = await f.connect(session.connections[0]);
    const first = await client.listTools();
    expect(first.tools).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    for (let i = 0; i < 8; i++)
      expect((await client.listTools()).nextCursor).toBe(first.nextCursor);
    const second = await client.listTools({ cursor: first.nextCursor });
    expect(second.tools).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    await expect(client.listTools({ cursor: "forged" })).rejects.toThrow(
      "mcp_cursor_invalid",
    );
    const other = await f.open(),
      connected = await f.connect(other.connections[0]);
    await expect(
      connected.client.listTools({ cursor: first.nextCursor }),
    ).rejects.toThrow("mcp_cursor_invalid");
  });

  it("forwards safe progress, preserves tool errors and validates structured results", async () => {
    const f = await setup();
    f.state.catalog[0].outputSchema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };
    f.state.execute = async (_args, progress) => {
      await progress("working");
      return { content: [], structuredContent: { ok: true } };
    };
    const session = await f.open(),
      { client } = await f.connect(session.connections[0]);
    const messages: string[] = [];
    expect(
      (
        await client.callTool({ name: "read" }, undefined, {
          onprogress: (progress) => {
            if (progress.message) messages.push(progress.message);
          },
        })
      ).structuredContent,
    ).toEqual({ ok: true });
    expect(messages).toEqual(["working"]);
    f.state.execute = async () => ({
      isError: true,
      content: [{ type: "text", text: "provider rejected" }],
    });
    expect((await client.callTool({ name: "read" })).isError).toBe(true);
    expect(f.store.mcpCalls().at(-1)?.outcome).toBe("tool_error");
    f.state.execute = async () => ({
      content: [],
      structuredContent: { ok: "wrong" },
    });
    await expect(client.callTool({ name: "read" })).rejects.toThrow(
      "mcp_result_invalid",
    );
    f.state.execute = async () => {
      throw new McpError(-32004, "provider failure", { kind: "safe" });
    };
    await expect(client.callTool({ name: "read" })).rejects.toMatchObject({
      code: -32004,
      data: { kind: "safe" },
    });
  });

  it("applies one initialization deadline across pages and independent call deadlines after idle time", async () => {
    const slow = await setup((config) => {
      config.mcp.initialization_timeout_seconds = 1;
    });
    slow.state.pageDelay = 400;
    await expect(slow.open()).rejects.toThrow();
    const f = await setup((config) => {
      config.mcp.call_timeout_seconds = 1;
    });
    const session = await f.open(),
      { client } = await f.connect(session.connections[0]);
    await delay(1100);
    await client.callTool({ name: "read" });
    f.state.execute = async (_args, progress, signal) => {
      for (let index = 0; index < 20; index++) {
        await progress("still working");
        await delay(100, undefined, { signal });
      }
      return { content: [] };
    };
    await expect(
      client.callTool({ name: "read" }, undefined, {
        timeout: 5000,
        onprogress: () => {},
      }),
    ).rejects.toThrow();
    const deadline = Date.now() + 2000;
    while (
      f.store.mcpCalls().at(-1)?.finished_at === null &&
      Date.now() < deadline
    )
      await delay(20);
    const receipt = f.store.mcpCalls().at(-1)!;
    expect(receipt.outcome).toBe("cancelled");
    expect(receipt.finished_at! - receipt.started_at).toBeLessThan(2000);
  }, 10_000);

  it("cancels a real in-flight call and respects the remaining parent budget", async () => {
    const f = await setup();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.state.execute = async (_args, _progress, signal) => {
      started();
      await delay(10_000, undefined, { signal });
      return { content: [] };
    };
    const session = await f.open(),
      { client } = await f.connect(session.connections[0]);
    const controller = new AbortController(),
      call = client.callTool({ name: "read" }, undefined, {
        signal: controller.signal,
      });
    await running;
    controller.abort();
    await expect(call).rejects.toThrow();
    await delay(100);
    expect(f.store.mcpCalls().at(-1)?.outcome).toBe("cancelled");
    const bounded = await setup(),
      parent = await bounded.open("investigation", Date.now() + 600),
      connection = await bounded.connect(parent.connections[0]);
    bounded.state.execute = async (_args, _progress, signal) => {
      await delay(10_000, undefined, { signal });
      return { content: [] };
    };
    await expect(
      connection.client.callTool({ name: "read" }, undefined, {
        timeout: 2500,
      }),
    ).rejects.toThrow();
    expect((await bounded.raw(parent.connections[0])).status).toBe(401);
  });

  it.each(["abort", "revision", "phase", "finished", "catalog", "delete"])(
    "revokes on %s and never expands a running catalog",
    async (mode) => {
      const f = await setup(),
        session = await f.open(),
        connection = session.connections[0],
        { client, transport } = await f.connect(connection);
      if (mode === "abort") f.controller.abort();
      if (mode === "revision")
        f.store.db
          .prepare("UPDATE jobs SET revision=revision+1 WHERE id=?")
          .run(f.job.id);
      if (mode === "phase")
        f.store.db
          .prepare("UPDATE jobs SET phase='implementation' WHERE id=?")
          .run(f.job.id);
      if (mode === "finished")
        f.store.finishRun(f.request().run_id, "completed", null, null);
      if (mode === "catalog") {
        f.state.catalog.push(tool("new"));
        await f.changed();
        await delay(100);
      }
      if (mode === "delete") await transport.terminateSession();
      expect(
        (
          await f.raw(
            connection,
            "POST",
            undefined,
            connection.authorization,
            transport.sessionId,
          )
        ).status,
      ).toBe(401);
      await expect(
        client.callTool({ name: "read" }, undefined, { timeout: 1000 }),
      ).rejects.toThrow();
      expect(f.state.calls).toEqual([]);
    },
  );

  it("blocks suspended turns without revoking them and freezes grants against caller mutation", async () => {
    const f = await setup(),
      request = f.request();
    const mutable = { ...request, grants: structuredClone(request.grants) },
      session = await f.gateway.open(mutable);
    const { client } = await f.connect(session.connections[0]);
    mutable.grants.context.tools.hidden = { effect: "read" };
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "read",
    ]);
    f.available(false);
    expect((await f.raw(session.connections[0])).status).toBe(409);
    f.available(true);
    await client.callTool({ name: "read" });
  });

  it("changes identities after fresh catalog or credential binding changes and rejects mismatched policies", async () => {
    const f = await setup(),
      first = await f.open();
    await first.close();
    f.state.catalog[0].description = "new description";
    const second = await f.open();
    expect(second.catalog_identity).not.toBe(first.catalog_identity);
    expect(second.policy_identity).toBe(first.policy_identity);
    await second.close();
    const rotatedConfig = structuredClone(f.config);
    rotatedConfig.mcp.credentials.first.headers.Authorization =
      "Bearer rotated-upstream-canary";
    const rotated = await fixtureSnapshot("model", rotatedConfig),
      replacement = new McpGateway(f.store, rotated.snapshot, rotated.secrets);
    await replacement.start();
    try {
      const changed = await replacement.open(f.request());
      expect(changed.policy_identity).not.toBe(second.policy_identity);
      expect(changed.catalog_identity).toBe(second.catalog_identity);
      await changed.close();
    } finally {
      await replacement.close();
    }
    const altered = structuredClone(f.loaded.snapshot);
    altered.settings.mcp.servers.context.credential_ref = "second";
    const different = new McpGateway(f.store, altered, f.loaded.secrets);
    await different.start();
    try {
      await expect(different.open(f.request())).rejects.toThrow(
        "mcp_policy_mismatch",
      );
    } finally {
      await different.close();
    }
  });

  it("cleans up already initialized aliases when a later catalog is unavailable", async () => {
    const f = await setup((config) => {
      config.mcp.servers.second = {
        ...config.mcp.servers.context,
        credential_ref: "second",
        tools: { absent: { effect: "read" } },
      };
      config.roles.investigation.mcp.second = { tools: ["absent"] };
    });
    await expect(f.open()).rejects.toThrow("mcp_tool_unavailable");
    expect(
      f.state.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(2);
    expect(f.state.calls).toEqual([]);
  });
});
