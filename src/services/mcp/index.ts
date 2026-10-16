import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { RunSnapshot } from "../../config/load.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import {
  digest,
  RuntimeError,
  type McpConnection,
  type McpSessionProvider,
} from "../../domain/agents.ts";
import { createKnownSecretChecker } from "../../logging/redact.ts";
import { immutable } from "../../config/bundles.ts";
import type { Store } from "../../repositories/store.ts";
import { snapshotTool } from "./catalog.ts";
import { UpstreamHttp, budget } from "./http.ts";

type OpenRequest = Parameters<McpSessionProvider["open"]>[0];
type Session = {
  request: OpenRequest;
  phase: string;
  snapshot_digest: string;
  lease: string;
  alias: string;
  token: string;
  path: string;
  credential: string;
  policy: string;
  catalog: string;
  tools: Map<string, ReturnType<typeof snapshotTool>>;
  controller: AbortController;
  client: Client;
  http: UpstreamHttp;
  server: Server;
  transport: StreamableHTTPServerTransport;
  cursors: Map<string, number>;
  calls: Set<Promise<CallToolResult>>;
  ready: boolean;
  removeAbort: () => void;
  closing?: Promise<void>;
};

export class McpGateway implements McpSessionProvider {
  private readonly sessions = new Map<string, Session>();
  private readonly closing = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private readonly listener = createServer((req, res) => {
    void this.handle(req, res).catch(() => this.reject(res, 503));
  });
  private watcher: ReturnType<typeof setInterval> | undefined;
  private url = "";
  private stopped = false;
  private readonly store: Store;
  private readonly snapshot: RunSnapshot;
  private readonly secrets: SecretAccessor;

  constructor(store: Store, snapshot: RunSnapshot, secrets: SecretAccessor) {
    this.store = store;
    this.snapshot = snapshot;
    this.secrets = secrets;
    this.listener.on("upgrade", (_req, socket) =>
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"),
    );
  }

  async start() {
    if (this.url || this.stopped)
      throw new RuntimeError("mcp_gateway_unavailable");
    this.store.interruptMcpCalls();
    await new Promise<void>((resolve, reject) => {
      this.listener.once("error", reject);
      this.listener.listen(0, "127.0.0.1", () => {
        this.listener.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.listener.address();
    if (!address || typeof address === "string")
      throw new RuntimeError("mcp_gateway_unavailable");
    this.url = `http://127.0.0.1:${address.port}`;
    this.watcher = setInterval(() => {
      for (const session of this.sessions.values()) {
        try {
          if (!this.current(session)) this.revoke(session);
        } catch {
          this.revoke(session);
        }
      }
    }, 100);
    this.watcher.unref();
  }

  async open(request: OpenRequest) {
    request = Object.freeze({
      ...request,
      grants: immutable(structuredClone(request.grants)),
    });
    if (!this.url || this.stopped)
      throw new RuntimeError("mcp_gateway_unavailable");
    const job = this.store.jobById(request.job_id),
      run = this.store.run(request.run_id);
    if (
      !job ||
      !run ||
      run.finished_at !== null ||
      run.job_id !== request.job_id ||
      run.revision !== request.revision ||
      run.role !== request.role ||
      job.revision !== request.revision ||
      !this.store.runtimeCurrent(run.lease_token) ||
      request.signal.aborted ||
      request.deadline <= Date.now()
    )
      throw new RuntimeError("mcp_scope_stale");
    const saved = this.store.snapshot(job.snapshot_digest),
      policy = saved.roles[request.role]?.mcp;
    if (
      !policy ||
      digest(request.grants) !== digest(policy) ||
      digest(policy) !== digest(this.snapshot.roles[request.role].mcp)
    )
      throw new RuntimeError("mcp_policy_mismatch");
    const aliases = Object.entries(policy)
      .filter(([, grant]) => Object.keys(grant.tools).length)
      .sort(([a], [b]) => a.localeCompare(b));
    const limits = saved.settings.mcp;
    for (const [alias, grant] of aliases) {
      const configured = limits.servers[alias];
      if (
        !configured ||
        digest(configured) !== digest(this.snapshot.settings.mcp.servers[alias])
      )
        throw new RuntimeError("mcp_policy_mismatch");
      const endpoint = new URL(configured.url);
      if (
        !(
          endpoint.protocol === "https:" ||
          (endpoint.protocol === "http:" && configured.allow_plain_http)
        ) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new RuntimeError("mcp_endpoint_invalid");
      for (const [name, tool] of Object.entries(grant.tools)) {
        if (
          !Object.hasOwn(configured.tools, name) ||
          digest(configured.tools[name]) !== digest(tool)
        )
          throw new RuntimeError("mcp_policy_mismatch");
        if (tool.effect !== "read")
          throw new RuntimeError("mcp_reviewed_write_unavailable");
      }
    }
    for (const key of [
      "initialization_timeout_seconds",
      "call_timeout_seconds",
      "max_request_bytes",
      "max_response_bytes",
      "max_catalog_bytes",
    ] as const)
      if (limits[key] !== this.snapshot.settings.mcp[key])
        throw new RuntimeError("mcp_policy_mismatch");
    const opened: Session[] = [];
    const initialization = budget(
      Math.min(
        request.deadline,
        Date.now() + limits.initialization_timeout_seconds * 1000,
      ),
      request.signal,
    );
    try {
      for (const [alias, grant] of aliases) {
        initialization.signal.throwIfAborted();
        const configured = limits.servers[alias],
          authentication = configured.credential_ref
            ? this.secrets.mcpHeaders(configured.credential_ref)
            : {};
        const controller = new AbortController();
        const http = new UpstreamHttp(
          configured.url,
          authentication,
          controller.signal,
          limits,
          this.secrets,
          (value) => this.containsAuthorization(value),
        );
        const client = new Client(
          { name: "opensource-repo-manager", version: "0.1.0" },
          { capabilities: {} },
        );
        const server = new Server(
          { name: "opensource-repo-manager-gateway", version: "0.1.0" },
          { capabilities: { tools: {} } },
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          maxRequestBodySize: limits.max_request_bytes,
          keepAliveMs: 0,
        });
        const token = randomBytes(32).toString("base64url");
        const credential = digest({
          reference: configured.credential_ref,
          headers: [...new Headers(authentication)].sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        });
        const session: Session = {
          request,
          phase: job.phase,
          snapshot_digest: job.snapshot_digest,
          lease: run.lease_token,
          alias,
          token,
          path: `/mcp/${randomUUID()}`,
          credential,
          policy: digest({
            alias,
            configured,
            grant,
            credential,
            limits: { ...limits, servers: undefined },
          }),
          catalog: "",
          tools: new Map(),
          cursors: new Map(),
          calls: new Set(),
          controller,
          http,
          client,
          server,
          transport,
          ready: false,
          removeAbort: () => {},
        };
        opened.push(session);
        this.sessions.set(session.path, session);
        const abort = () => {
          this.revoke(session);
        };
        request.signal.addEventListener("abort", abort, { once: true });
        session.removeAbort = () =>
          request.signal.removeEventListener("abort", abort);
        if (request.signal.aborted) this.revoke(session);
        client.onerror = () => {
          this.revoke(session);
        };
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          this.revoke(session);
        });
        await http.within(initialization.signal, () =>
          client.connect(
            http.transport,
            this.options(initialization.signal, request.deadline),
          ),
        );
        if (!client.getServerCapabilities()?.tools)
          throw new RuntimeError("mcp_tools_unavailable");
        const seen = new Set<string>(),
          cursors = new Set<string>();
        let cursor: string | undefined,
          bytes = 0;
        do {
          const page = await http.within(initialization.signal, () =>
            client.request(
              {
                method: "tools/list",
                ...(cursor === undefined ? {} : { params: { cursor } }),
              },
              ListToolsResultSchema,
              this.options(initialization.signal, request.deadline),
            ),
          );
          bytes += Buffer.byteLength(JSON.stringify(page));
          if (bytes > limits.max_catalog_bytes)
            throw new RuntimeError("mcp_catalog_limit");
          for (const tool of page.tools) {
            if (seen.has(tool.name))
              throw new RuntimeError("mcp_catalog_invalid");
            seen.add(tool.name);
            const entry = snapshotTool(tool);
            if (Object.hasOwn(grant.tools, tool.name)) {
              if (tool.execution?.taskSupport === "required")
                throw new RuntimeError("mcp_tool_unavailable");
              this.checkVisible(entry.tool, limits.max_response_bytes);
              session.tools.set(tool.name, entry);
            }
          }
          cursor = page.nextCursor;
          if (cursor !== undefined) {
            if (cursors.has(cursor))
              throw new RuntimeError("mcp_catalog_invalid");
            cursors.add(cursor);
          }
        } while (cursor !== undefined);
        if (Object.keys(grant.tools).some((name) => !session.tools.has(name)))
          throw new RuntimeError("mcp_tool_unavailable");
        session.tools = new Map(
          [...session.tools].sort(([a], [b]) => a.localeCompare(b)),
        );
        session.catalog = digest(
          [...session.tools.values()].map((entry) => entry.tool),
        );
        server.setRequestHandler(
          ListToolsRequestSchema,
          async (message, extra) => {
            this.authorize(session);
            const start =
              message.params?.cursor === undefined
                ? 0
                : session.cursors.get(message.params.cursor);
            if (start === undefined)
              throw new McpError(ErrorCode.InvalidParams, "mcp_cursor_invalid");
            const entries = [...session.tools.values()],
              tools = [];
            let index = start;
            while (index < entries.length) {
              const candidate = [...tools, entries[index].tool];
              const result = {
                tools: candidate,
                ...(index + 1 < entries.length
                  ? { nextCursor: "x".repeat(24) }
                  : {}),
              };
              if (
                Buffer.byteLength(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: extra.requestId,
                    result,
                  }),
                ) > limits.max_response_bytes
              )
                break;
              tools.push(entries[index++].tool);
            }
            if (!tools.length && index < entries.length)
              throw new McpError(ErrorCode.InternalError, "mcp_response_limit");
            if (index === entries.length) return { tools };
            const nextCursor = randomBytes(18).toString("base64url");
            session.cursors.set(nextCursor, index);
            return { tools, nextCursor };
          },
        );
        server.setRequestHandler(CallToolRequestSchema, (message, extra) => {
          const operation = (async () => {
            this.authorize(session);
            const entry = session.tools.get(message.params.name);
            if (
              !entry ||
              !Object.hasOwn(
                request.grants[alias].tools,
                message.params.name,
              ) ||
              request.grants[alias].tools[message.params.name].effect !==
                "read" ||
              message.params.task
            )
              throw new McpError(ErrorCode.InvalidParams, "mcp_tool_denied");
            const args = message.params.arguments ?? {};
            if (this.secrets.contains(args) || this.containsAuthorization(args))
              throw new McpError(
                ErrorCode.InvalidParams,
                "mcp_secret_in_request",
              );
            if (!entry.input(args))
              throw new McpError(
                ErrorCode.InvalidParams,
                "mcp_arguments_invalid",
              );
            const call = budget(
              Math.min(
                request.deadline,
                Date.now() + limits.call_timeout_seconds * 1000,
              ),
              AbortSignal.any([controller.signal, extra.signal]),
            );
            const id = randomUUID();
            this.store.startMcpCall({
              id,
              run_id: request.run_id,
              job_id: request.job_id,
              revision: request.revision,
              role: request.role,
              alias,
              tool: entry.tool.name,
              credential_binding: credential,
              policy_identity: session.policy,
              catalog_identity: session.catalog,
              request_digest: digest(args),
              started_at: Date.now(),
            });
            let outcome: "completed" | "tool_error" | "cancelled" | "failed" =
                "failed",
              resultDigest: string | null = null;
            let progressFailure: unknown;
            const progressTasks: Promise<void>[] = [];
            try {
              this.authorize(session);
              const result = await http.within(call.signal, () =>
                client.request(
                  {
                    method: "tools/call",
                    params: { name: entry.tool.name, arguments: args },
                  },
                  CallToolResultSchema,
                  {
                    ...this.options(call.signal, request.deadline),
                    onprogress: (progress) => {
                      const task = (async () => {
                        this.authorize(session);
                        this.checkVisible(progress, limits.max_response_bytes);
                        if (extra._meta?.progressToken !== undefined)
                          await extra.sendNotification({
                            method: "notifications/progress",
                            params: {
                              ...progress,
                              progressToken: extra._meta.progressToken,
                            },
                          });
                      })().catch((error) => {
                        progressFailure = error;
                        this.revoke(session);
                      });
                      progressTasks.push(task);
                    },
                  },
                ),
              );
              await Promise.all(progressTasks);
              if (progressFailure) throw progressFailure;
              call.signal.throwIfAborted();
              this.authorize(session);
              this.checkVisible(result, limits.max_response_bytes);
              if (
                entry.output &&
                !result.isError &&
                (result.structuredContent === undefined ||
                  !entry.output(result.structuredContent))
              )
                throw new RuntimeError("mcp_result_invalid");
              resultDigest = digest(result);
              outcome = result.isError ? "tool_error" : "completed";
              return result;
            } catch (error) {
              if (call.signal.aborted) outcome = "cancelled";
              throw this.safeError(error, limits.max_response_bytes);
            } finally {
              await Promise.all(progressTasks);
              call.dispose();
              this.store.finishMcpCall(id, outcome, resultDigest);
            }
          })();
          session.calls.add(operation);
          void operation.then(
            () => session.calls.delete(operation),
            () => session.calls.delete(operation),
          );
          return operation;
        });
        const send = transport.send.bind(transport);
        transport.send = async (message, options) => {
          if (
            this.secrets.contains(message) ||
            this.containsAuthorization(message) ||
            Buffer.byteLength(JSON.stringify(message)) >
              limits.max_response_bytes
          ) {
            if (!("id" in message))
              throw new RuntimeError("mcp_response_invalid");
            await send(
              {
                jsonrpc: "2.0",
                id: message.id,
                error: {
                  code: ErrorCode.InternalError,
                  message: "mcp_response_invalid",
                },
              },
              options,
            );
            return;
          }
          await send(message, options);
        };
        await server.connect(transport);
        if (!this.current(session)) throw new RuntimeError("mcp_scope_stale");
      }
      initialization.signal.throwIfAborted();
      for (const session of opened) {
        if (!this.current(session)) throw new RuntimeError("mcp_scope_stale");
        session.ready = true;
      }
      return {
        connections: opened.map(
          (session) =>
            ({
              alias: session.alias,
              url: this.url + session.path,
              authorization: session.token,
              tools: [...session.tools.keys()],
              deadline: request.deadline,
            }) satisfies McpConnection,
        ),
        policy_identity: digest(
          opened.map((session) => [session.alias, session.policy]),
        ),
        catalog_identity: digest(
          opened.map((session) => [session.alias, session.catalog]),
        ),
        close: async () => {
          const results = await Promise.allSettled(
            opened.map((session) => this.revoke(session)),
          );
          if (results.some((result) => result.status === "rejected"))
            throw new RuntimeError("mcp_cleanup_failed");
        },
      };
    } catch (error) {
      const cleanup = await Promise.allSettled(
        opened.map((session) => this.revoke(session)),
      );
      if (cleanup.some((result) => result.status === "rejected"))
        throw new RuntimeError("mcp_cleanup_failed");
      throw error instanceof RuntimeError
        ? error
        : new RuntimeError("mcp_initialization_failed");
    } finally {
      initialization.dispose();
    }
  }

  private options(signal: AbortSignal, deadline: number) {
    const timeout = Math.max(1, Math.min(2_147_483_647, deadline - Date.now()));
    return {
      signal,
      timeout,
      maxTotalTimeout: timeout,
      resetTimeoutOnProgress: false,
    };
  }

  private current(session: Session) {
    if (
      session.controller.signal.aborted ||
      session.request.signal.aborted ||
      Date.now() >= session.request.deadline
    )
      return false;
    const run = this.store.run(session.request.run_id),
      job = this.store.jobById(session.request.job_id);
    return Boolean(
      run &&
      run.finished_at === null &&
      run.role === session.request.role &&
      run.job_id === session.request.job_id &&
      run.revision === session.request.revision &&
      job &&
      job.revision === session.request.revision &&
      job.phase === session.phase &&
      job.snapshot_digest === session.snapshot_digest &&
      this.store.runtimeCurrent(session.lease),
    );
  }

  private authorize(session: Session) {
    if (!this.current(session)) {
      this.revoke(session);
      throw new McpError(-32001, "mcp_session_revoked");
    }
    if (session.request.available && !session.request.available())
      throw new McpError(-32002, "mcp_suspended");
  }

  private containsAuthorization(value: unknown) {
    return createKnownSecretChecker(
      [...this.sessions.values()].map((session) => session.token),
    ).contains(value);
  }

  private checkVisible(value: unknown, maximum: number) {
    if (Buffer.byteLength(JSON.stringify(value)) > maximum)
      throw new RuntimeError("mcp_response_limit");
    if (this.secrets.contains(value) || this.containsAuthorization(value))
      throw new RuntimeError("mcp_secret_in_response");
  }

  private safeError(error: unknown, maximum: number): McpError {
    if (error instanceof RuntimeError)
      return new McpError(ErrorCode.InternalError, error.code);
    if (error instanceof McpError && Number.isSafeInteger(error.code)) {
      const exposed = {
        code: error.code,
        message: error.message,
        data: error.data,
      };
      if (
        Buffer.byteLength(JSON.stringify(exposed)) <= maximum &&
        !this.secrets.contains(exposed) &&
        !this.containsAuthorization(exposed)
      )
        return new McpError(error.code, error.message, error.data);
    }
    return new McpError(ErrorCode.InternalError, "mcp_call_failed");
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const session = req.url ? this.sessions.get(req.url) : undefined;
    if (
      !session ||
      !session.ready ||
      req.headers.authorization !== `Bearer ${session.token}` ||
      !this.current(session)
    ) {
      if (session && !this.current(session)) this.revoke(session);
      this.reject(res, 401);
      return;
    }
    if (session.request.available && !session.request.available()) {
      this.reject(res, 409);
      return;
    }
    if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
      this.reject(res, 405);
      return;
    }
    if (req.headers.origin) {
      this.reject(res, 403);
      return;
    }
    const incoming = budget(
      req.method === "GET"
        ? session.request.deadline
        : Math.min(
            session.request.deadline,
            Date.now() + this.snapshot.settings.mcp.call_timeout_seconds * 1000,
          ),
      session.controller.signal,
    );
    const abort = () => {
      req.destroy();
      res.destroy();
    };
    incoming.signal.addEventListener("abort", abort, { once: true });
    res.once("close", () => {
      incoming.signal.removeEventListener("abort", abort);
      incoming.dispose();
    });
    if (incoming.signal.aborted) {
      abort();
      return;
    }
    if (req.method === "POST") {
      const limit = this.snapshot.settings.mcp.max_request_bytes;
      let body = Buffer.alloc(0);
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        if (body.length + chunk.length > limit) {
          req.resume();
          this.reject(res, 413);
          return;
        }
        body = Buffer.concat([body, chunk]);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        this.reject(res, 400);
        return;
      }
      if (this.secrets.contains(parsed) || this.containsAuthorization(parsed)) {
        this.reject(res, 400);
        return;
      }
      this.authorize(session);
      await session.transport.handleRequest(req, res, parsed);
    } else {
      await session.transport.handleRequest(req, res);
      if (req.method === "DELETE" && res.statusCode < 400)
        await this.revoke(session);
    }
  }

  private reject(res: ServerResponse, status: number) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end('{"error":"mcp_request_unavailable"}');
  }

  private revoke(session: Session): Promise<void> {
    if (session.closing) return session.closing;
    this.sessions.delete(session.path);
    session.controller.abort(new RuntimeError("mcp_session_revoked"));
    session.removeAbort();
    const task = (async () => {
      const results = await Promise.allSettled([
        session.server.close(),
        (async () => {
          try {
            await session.http.transport.terminateSession();
          } finally {
            await session.client.close();
          }
        })(),
      ]);
      await Promise.allSettled([...session.calls]);
      if (results.some((result) => result.status === "rejected"))
        throw new RuntimeError("mcp_cleanup_failed");
    })();
    session.closing = task;
    this.closing.add(task);
    void task.then(
      () => this.closing.delete(task),
      (error) => {
        this.closing.delete(task);
        this.failures.push(error);
      },
    );
    return task;
  }

  async close() {
    this.stopped = true;
    clearInterval(this.watcher);
    for (const session of this.sessions.values()) this.revoke(session);
    await Promise.allSettled([...this.closing]);
    this.listener.closeAllConnections();
    if (this.listener.listening)
      await new Promise<void>((resolve, reject) =>
        this.listener.close((error) => (error ? reject(error) : resolve())),
      );
    if (this.failures.length) throw new RuntimeError("mcp_cleanup_failed");
  }
}
