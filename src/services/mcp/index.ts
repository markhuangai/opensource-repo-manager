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
  ProgressSchema,
  ToolListChangedNotificationSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
  type ProgressNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { RunSnapshot } from "../../config/load.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import {
  digest,
  RuntimeError,
  type McpConnection,
  type McpSessionProvider,
  type McpWriteDispatcher,
} from "../../domain/agents.ts";
import { createKnownSecretChecker } from "../../logging/redact.ts";
import { immutable } from "../../config/bundles.ts";
import type { Store } from "../../repositories/store.ts";
import { snapshotTool, writeTool } from "./catalog.ts";
import { UpstreamHttp, budget } from "./http.ts";
import type {
  McpWriteChannel,
  McpWriteTransport,
  WriteBinding,
} from "../mcp-writes/contracts.ts";
import { policyIdentity } from "../publication/scanner.ts";

const maxConcurrentCalls = 16;

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
  upstreamTools: Map<string, ReturnType<typeof snapshotTool>>;
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

export class McpGateway implements McpSessionProvider, McpWriteTransport {
  private dispatcher: McpWriteDispatcher | undefined;
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

  setWriteDispatcher(dispatcher: McpWriteDispatcher) {
    if (this.url || this.dispatcher)
      throw new RuntimeError("mcp_dispatcher_already_set");
    this.dispatcher = dispatcher;
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
        if (
          tool.effect !== "read" &&
          (tool.effect !== "write" || !this.dispatcher)
        )
          throw new RuntimeError("mcp_write_unavailable");
        if (tool.effect === "write")
          this.dispatcher!.assertAvailable(
            configured.review_required_tools.includes(name),
          );
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
        initialization.assertActive();
        const upstream = await this.connectUpstream(
          job.snapshot_digest,
          request.role,
          alias,
          initialization.signal,
          request.deadline,
        );
        const {
          http,
          client,
          controller,
          credential,
          policy: upstreamPolicy,
          catalog,
          tools: upstreamTools,
        } = upstream;
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
        const session: Session = {
          request,
          phase: job.phase,
          snapshot_digest: job.snapshot_digest,
          lease: run.lease_token,
          alias,
          token,
          path: `/mcp/${randomUUID()}`,
          credential,
          policy: upstreamPolicy,
          catalog,
          upstreamTools,
          tools: new Map(
            [...upstreamTools].map(([name, entry]) => {
              const definition = grant.tools[name];
              return [
                name,
                definition.effect === "write"
                  ? writeTool(
                      entry.tool,
                      limits.servers[alias].review_required_tools.includes(
                        name,
                      ),
                      definition.idempotency_argument,
                    )
                  : entry,
              ];
            }),
          ),
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
            const nextCursor =
              [...session.cursors].find(
                ([, offset]) => offset === index,
              )?.[0] ?? randomBytes(18).toString("base64url");
            session.cursors.set(nextCursor, index);
            return { tools, nextCursor };
          },
        );
        server.setRequestHandler(CallToolRequestSchema, (message, extra) => {
          const operation = (async () => {
            this.authorize(session);
            if (session.calls.size >= maxConcurrentCalls)
              throw new McpError(-32003, "mcp_concurrency_limit");
            const entry = session.tools.get(message.params.name);
            if (
              !entry ||
              !Object.hasOwn(
                request.grants[alias].tools,
                message.params.name,
              ) ||
              message.params.task
            )
              throw new McpError(ErrorCode.InvalidParams, "mcp_tool_denied");
            const args = message.params.arguments ?? {};
            if (
              request.grants[alias].tools[entry.tool.name].effect === "write"
            ) {
              const deadline = Math.min(
                  request.deadline,
                  Date.now() + limits.call_timeout_seconds * 1000,
                ),
                call = budget(
                  deadline,
                  AbortSignal.any([controller.signal, extra.signal]),
                );
              try {
                const channel = this.writeChannel(session, entry.tool.name);
                const result = await this.dispatcher!.dispatch(
                  {
                    binding: channel.binding,
                    arguments: args,
                    deadline,
                    signal: call.signal,
                  },
                  channel,
                );
                call.assertActive();
                this.authorize(session);
                this.checkVisible(
                  { jsonrpc: "2.0", id: extra.requestId, result },
                  limits.max_response_bytes,
                );
                return result;
              } catch (error) {
                throw this.safeError(error, limits.max_response_bytes);
              } finally {
                call.dispose();
              }
            }
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
            let progressBytes = 0;
            const progressTasks = new Set<Promise<void>>();
            const progressToken = extra._meta?.progressToken;
            const secretStream = this.secrets.createStream();
            const authorizationStream = createKnownSecretChecker(
              [...this.sessions.values()].map((session) => session.token),
            ).createStream();
            const held: ProgressNotification[] = [];
            let delivery = Promise.resolve();
            const inspectText = (
              text: string,
              streams = [secretStream, authorizationStream],
            ) => {
              if (streams.some((stream) => stream.push(text))) {
                this.revoke(session);
                throw new RuntimeError("mcp_secret_in_response");
              }
            };
            const drain = () => {
              const notifications = held.splice(0);
              delivery = delivery.then(async () => {
                for (const notification of notifications) {
                  call.assertActive();
                  this.authorize(session);
                  await extra.sendNotification({
                    ...notification,
                    params: {
                      ...ProgressSchema.parse(notification.params),
                      progressToken: notification.params.progressToken,
                    },
                  });
                }
              });
              return delivery;
            };
            try {
              call.assertActive();
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
                    onprogress:
                      progressToken === undefined
                        ? undefined
                        : (progress) => {
                            const task = (async () => {
                              this.authorize(session);
                              const notification = {
                                method: "notifications/progress" as const,
                                params: {
                                  ...progress,
                                  progressToken,
                                },
                              };
                              progressBytes += this.checkVisible(
                                { jsonrpc: "2.0", ...notification },
                                limits.max_response_bytes - progressBytes,
                              );
                              held.push(notification);
                              if (progress.message !== undefined)
                                inspectText(progress.message);
                              if (
                                !secretStream.pending &&
                                !authorizationStream.pending
                              )
                                await drain();
                            })().catch((error) => {
                              progressFailure = error;
                              this.revoke(session);
                            });
                            progressTasks.add(task);
                            void task.then(() => progressTasks.delete(task));
                          },
                  },
                ),
              );
              await Promise.all(progressTasks);
              if (progressFailure) throw progressFailure;
              call.assertActive();
              this.authorize(session);
              if (
                this.containsVisibleSecret(result, [
                  secretStream,
                  authorizationStream,
                ])
              ) {
                this.revoke(session);
                throw new RuntimeError("mcp_secret_in_response");
              }
              this.checkVisible(
                { jsonrpc: "2.0", id: extra.requestId, result },
                limits.max_response_bytes - progressBytes,
              );
              for (const content of result.content) {
                if (content.type === "text") inspectText(content.text);
                else if (
                  content.type === "resource" &&
                  "text" in content.resource
                )
                  inspectText(content.resource.text);
              }
              if (
                entry.output &&
                !result.isError &&
                (result.structuredContent === undefined ||
                  !entry.output(result.structuredContent))
              )
                throw new RuntimeError("mcp_result_invalid");
              await drain();
              const completedDigest = digest(result);
              call.assertActive();
              this.authorize(session);
              resultDigest = completedDigest;
              outcome = result.isError ? "tool_error" : "completed";
              return result;
            } catch (error) {
              if (call.signal.aborted) outcome = "cancelled";
              const remaining = limits.max_response_bytes - progressBytes;
              const failure = this.safeError(error, remaining);
              if (
                Buffer.byteLength(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: extra.requestId,
                    error: {
                      code: failure.code,
                      message: failure.message,
                      data: failure.data,
                    },
                  }),
                ) > remaining
              )
                this.revoke(session);
              throw failure;
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
            this.containsVisibleSecret(message) ||
            Buffer.byteLength(JSON.stringify(message)) >
              limits.max_response_bytes
          ) {
            if (!("id" in message))
              throw new RuntimeError("mcp_response_invalid");
            const replacement = {
              jsonrpc: "2.0" as const,
              id: message.id,
              error: {
                code: ErrorCode.InternalError,
                message: "mcp_response_invalid",
              },
            };
            if (
              Buffer.byteLength(JSON.stringify(replacement)) >
              limits.max_response_bytes
            ) {
              this.revoke(session);
              throw new RuntimeError("mcp_response_limit");
            }
            await send(replacement, options);
            return;
          }
          await send(message, options);
        };
        await server.connect(transport);
        if (!this.current(session)) throw new RuntimeError("mcp_scope_stale");
      }
      initialization.assertActive();
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

  private async connectUpstream(
    snapshotDigest: string,
    role: OpenRequest["role"],
    alias: string,
    signal: AbortSignal,
    deadline: number,
  ) {
    const saved = this.store.snapshot(snapshotDigest),
      limits = saved.settings.mcp,
      configured = limits.servers[alias],
      grant = saved.roles[role].mcp[alias];
    if (
      !configured ||
      !grant ||
      digest(configured) !==
        digest(this.snapshot.settings.mcp.servers[alias]) ||
      digest(saved.roles[role].mcp) !== digest(this.snapshot.roles[role].mcp) ||
      digest({ ...limits, servers: undefined }) !==
        digest({ ...this.snapshot.settings.mcp, servers: undefined })
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
    for (const [name, definition] of Object.entries(grant.tools))
      if (
        !Object.hasOwn(configured.tools, name) ||
        digest(definition) !== digest(configured.tools[name]) ||
        !["read", "write"].includes(definition.effect)
      )
        throw new RuntimeError("mcp_policy_mismatch");
    const authentication = configured.credential_ref
        ? this.secrets.mcpHeaders(configured.credential_ref)
        : {},
      credential = digest({
        reference: configured.credential_ref,
        headers: [...new Headers(authentication)].sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      }),
      policy = digest({
        alias,
        configured,
        grant,
        credential,
        limits: { ...limits, servers: undefined },
      }),
      controller = new AbortController(),
      http = new UpstreamHttp(
        configured.url,
        authentication,
        controller.signal,
        limits,
        this.secrets,
        (value) => this.containsAuthorization(value),
      ),
      client = new Client(
        { name: "opensource-repo-manager", version: "0.1.0" },
        { capabilities: {} },
      ),
      tools = new Map<string, ReturnType<typeof snapshotTool>>();
    const initialization = budget(
      Math.min(
        deadline,
        Date.now() + limits.initialization_timeout_seconds * 1000,
      ),
      signal,
    );
    client.onerror = () =>
      controller.abort(new RuntimeError("mcp_connection_failed"));
    client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
      controller.abort(new RuntimeError("mcp_catalog_changed")),
    );
    try {
      await http.within(initialization.signal, () =>
        client.connect(
          http.transport,
          this.options(initialization.signal, deadline),
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
            this.options(initialization.signal, deadline),
          ),
        );
        initialization.assertActive();
        if (
          (bytes += Buffer.byteLength(JSON.stringify(page))) >
          limits.max_catalog_bytes
        )
          throw new RuntimeError("mcp_catalog_limit");
        for (const tool of page.tools) {
          initialization.assertActive();
          if (seen.has(tool.name))
            throw new RuntimeError("mcp_catalog_invalid");
          seen.add(tool.name);
          const entry = snapshotTool(tool);
          if (Object.hasOwn(grant.tools, tool.name)) {
            if (tool.execution?.taskSupport === "required")
              throw new RuntimeError("mcp_tool_unavailable");
            this.checkVisible(entry.tool, limits.max_response_bytes);
            const definition = grant.tools[tool.name];
            if (definition.effect === "write")
              writeTool(
                entry.tool,
                configured.review_required_tools.includes(tool.name),
                definition.idempotency_argument,
              );
            tools.set(tool.name, entry);
          }
        }
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (cursors.has(cursor))
            throw new RuntimeError("mcp_catalog_invalid");
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      if (Object.keys(grant.tools).some((name) => !tools.has(name)))
        throw new RuntimeError("mcp_tool_unavailable");
      const ordered = new Map(
        [...tools].sort(([a], [b]) => a.localeCompare(b)),
      );
      initialization.assertActive();
      controller.signal.throwIfAborted();
      return {
        http,
        client,
        controller,
        credential,
        policy,
        tools: ordered,
        catalog: digest([...ordered.values()].map((entry) => entry.tool)),
      };
    } catch (error) {
      controller.abort();
      try {
        await http.transport.terminateSession();
      } finally {
        await client.close();
      }
      throw error;
    } finally {
      initialization.dispose();
    }
  }

  private writeChannel(session: Session, tool: string): McpWriteChannel {
    const job = this.store.jobById(session.request.job_id)!,
      repository = this.store.repository()!,
      configured = this.store.snapshot(session.snapshot_digest).settings.mcp
        .servers[session.alias],
      definition = configured.tools[tool];
    if (definition.effect !== "write")
      throw new RuntimeError("mcp_tool_denied");
    const binding: WriteBinding = {
      repository_id: repository.id,
      repository: repository.full_name,
      job_id: job.id,
      revision: job.revision,
      phase: session.phase,
      run_id: session.request.run_id,
      role: session.request.role,
      snapshot_digest: job.snapshot_digest,
      source: (JSON.parse(job.input_json) as { source: WriteBinding["source"] })
        .source,
      artifact_digest: session.request.artifact_digest ?? null,
      alias: session.alias,
      endpoint: configured.url,
      tool,
      credential_binding: session.credential,
      policy_identity: session.policy,
      catalog_identity: session.catalog,
      scanner_policy: policyIdentity,
      review_required: configured.review_required_tools.includes(tool),
      idempotency_argument: definition.idempotency_argument ?? null,
    };
    return this.channel(
      binding,
      session.upstreamTools.get(tool)!,
      session,
      () => this.authorize(session),
      async () => {},
    );
  }

  private channel(
    binding: WriteBinding,
    entry: ReturnType<typeof snapshotTool>,
    upstream: { http: UpstreamHttp; client: Client },
    assertCurrent: () => void,
    close: () => Promise<void>,
  ): McpWriteChannel {
    const limit = this.store.snapshot(binding.snapshot_digest).settings.mcp
      .max_response_bytes;
    return {
      binding: immutable(binding),
      tool: entry.tool,
      assertCurrent,
      close,
      validate: (args) => Boolean(entry.input(args)),
      transmit: async (args, signal) => {
        let result: CallToolResult;
        try {
          result = await upstream.http.within(signal, () =>
            upstream.client.request(
              {
                method: "tools/call",
                params: { name: binding.tool, arguments: args },
              },
              CallToolResultSchema,
              this.options(
                signal,
                Date.now() +
                  Math.min(
                    2_147_483_647,
                    this.store.snapshot(binding.snapshot_digest).settings.mcp
                      .call_timeout_seconds * 1000,
                  ),
              ),
            ),
          );
        } catch (error) {
          if (error instanceof McpError)
            this.checkVisible(
              { code: error.code, message: error.message, data: error.data },
              limit,
            );
          throw error;
        }
        this.checkVisible(result, limit);
        if (
          entry.output &&
          !result.isError &&
          (result.structuredContent === undefined ||
            !entry.output(result.structuredContent))
        )
          throw new RuntimeError("mcp_result_invalid");
        return result;
      },
    };
  }

  async openRecovery(
    binding: WriteBinding,
    deadline: number,
    signal: AbortSignal,
    current: () => void,
  ) {
    if (!this.url || this.stopped)
      throw new RuntimeError("mcp_gateway_unavailable");
    current();
    const upstream = await this.connectUpstream(
      binding.snapshot_digest,
      binding.role,
      binding.alias,
      signal,
      deadline,
    );
    const abort = () =>
      upstream.controller.abort(new RuntimeError("mcp_cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const close = async () => {
      signal.removeEventListener("abort", abort);
      upstream.controller.abort();
      try {
        await upstream.http.transport.terminateSession();
      } finally {
        await upstream.client.close();
      }
    };
    try {
      const configured = this.snapshot.settings.mcp.servers[binding.alias],
        definition = configured.tools[binding.tool];
      if (
        upstream.credential !== binding.credential_binding ||
        upstream.policy !== binding.policy_identity ||
        binding.scanner_policy !== policyIdentity ||
        upstream.catalog !== binding.catalog_identity ||
        configured.url !== binding.endpoint ||
        definition?.effect !== "write" ||
        configured.review_required_tools.includes(binding.tool) !==
          binding.review_required ||
        (definition.idempotency_argument ?? null) !==
          binding.idempotency_argument
      )
        throw new RuntimeError("mcp_write_binding_changed");
      return this.channel(
        binding,
        upstream.tools.get(binding.tool)!,
        upstream,
        () => {
          current();
          signal.throwIfAborted();
          upstream.controller.signal.throwIfAborted();
        },
        close,
      );
    } catch (error) {
      await close();
      throw error;
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

  private containsVisibleSecret(
    value: unknown,
    previous: ReturnType<SecretAccessor["createStream"]>[] = [],
  ) {
    const sources = [
      this.secrets.createStream(),
      createKnownSecretChecker(
        [...this.sessions.values()].map((session) => session.token),
      ).createStream(),
      ...previous,
    ];
    const forks = (streams = sources) => streams.map((stream) => stream.fork());
    const values = forks(),
      keys = forks(),
      mixed = forks();
    const inspect = (text: string, streams: typeof values) =>
      streams.some((stream) => stream.push(text));
    const visit = (value: unknown, streams?: typeof values): boolean => {
      if (typeof value === "string")
        return (
          inspect(value, forks()) ||
          inspect(value, streams ?? forks()) ||
          inspect(value, values) ||
          inspect(value, mixed)
        );
      if (Array.isArray(value))
        return value.some((item) => visit(item, streams));
      if (value !== null && typeof value === "object") {
        const objectKeys = forks(),
          objectMixed = forks();
        for (const [key, item] of Object.entries(value)) {
          if (
            inspect(key, forks()) ||
            inspect(key, keys) ||
            inspect(key, mixed) ||
            inspect(key, forks(values)) ||
            inspect(key, objectKeys) ||
            inspect(key, objectMixed) ||
            (typeof item === "string" && inspect(item, objectMixed)) ||
            visit(item, streams ?? forks())
          )
            return true;
        }
      }
      return false;
    };
    return visit(value);
  }

  private checkVisible(value: unknown, maximum: number) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > maximum) throw new RuntimeError("mcp_response_limit");
    if (this.containsVisibleSecret(value))
      throw new RuntimeError("mcp_secret_in_response");
    return bytes;
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
        !this.containsVisibleSecret(exposed)
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
      incoming.assertActive();
      this.authorize(session);
      await session.transport.handleRequest(req, res, parsed);
    } else {
      incoming.assertActive();
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
