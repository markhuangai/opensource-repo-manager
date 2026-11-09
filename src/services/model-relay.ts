import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { setInterval, clearInterval } from "node:timers";
import type { ModelProfile } from "../config/schema.ts";
import type { SecretAccessor } from "../config/secrets.ts";
import { RuntimeError, sdkVersions } from "../domain/agents.ts";
import { createSafeLogger } from "../logging/redact.ts";
import {
  captureApiBody,
  createApiDiagnostics,
  decodeDiagnosticString,
} from "../logging/api.ts";
import type { Store } from "../repositories/store.ts";

const modelTextFields = new Map([
  ["text", "content"],
  ["delta", "content"],
  ["thinking", "content"],
  ["partial_json", "content"],
  ["arguments", "content"],
  ["signature", "signature"],
  ["refusal", "refusal"],
  ["message", "message"],
  ["content", "content"],
  ["output_text", "output_text"],
  ["input_text", "input_text"],
]);

type Grant = {
  lease: string;
  profile: ModelProfile;
  deadline: number;
  requests: number;
  bytes: number;
  signal: AbortSignal;
  current: () => boolean;
  controller: AbortController;
  available?: () => boolean;
  context?: { run_id: string; job_id: number; revision: number; role: string };
};

export class ModelRelay {
  private readonly grants = new Map<string, Grant>();
  private readonly server = createServer((req, res) => {
    void this.handle(req, res);
  });
  private url = "";
  private readonly watcher: ReturnType<typeof setInterval>;
  private readonly store: Pick<Store, "reserveModelRequest" | "checkpoint">;
  private readonly endpoint: string;
  private readonly secrets: SecretAccessor;
  private readonly logger: ReturnType<typeof createSafeLogger>;
  constructor(
    store: Pick<Store, "reserveModelRequest" | "checkpoint">,
    endpoint: string,
    secrets: SecretAccessor,
  ) {
    this.store = store;
    this.endpoint = endpoint;
    this.secrets = secrets;
    this.logger = createSafeLogger(secrets, true);
    this.server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    });
    this.watcher = setInterval(() => {
      for (const [token, grant] of this.grants) {
        try {
          if (
            Date.now() >= grant.deadline ||
            grant.signal.aborted ||
            !grant.current()
          )
            this.revoke(token);
        } catch {
          this.revoke(token);
        }
      }
    }, 250);
    this.watcher.unref();
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new RuntimeError("relay_unavailable");
    this.url = `http://127.0.0.1:${address.port}/v1`;
  }

  authorize(options: Omit<Grant, "controller">) {
    if (!this.url) throw new RuntimeError("relay_unavailable");
    const authorization = randomBytes(32).toString("base64url"),
      controller = new AbortController();
    this.grants.set(authorization, { ...options, controller });
    const revoke = () => this.revoke(authorization);
    options.signal.addEventListener("abort", revoke, { once: true });
    controller.signal.addEventListener(
      "abort",
      () => options.signal.removeEventListener("abort", revoke),
      { once: true },
    );
    return { url: this.url, authorization, revoke };
  }

  private revoke(key: string) {
    const grant = this.grants.get(key);
    if (grant) {
      this.grants.delete(key);
      grant.controller.abort(new RuntimeError("relay_revoked"));
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const controller = new AbortController();
    const started = Date.now();
    const requestId = randomUUID();
    let context: Record<string, unknown> | undefined;
    let cause = "request_invalid";
    let providerStatus: number | undefined;
    let upstreamSignal: AbortSignal | undefined;
    let succeeded = false;
    const diagnostics = createApiDiagnostics(this.secrets);
    let exchange: ReturnType<typeof diagnostics.start> | undefined;
    let failure: unknown;
    let failureBody: string | undefined;
    let failureReadError: unknown;
    let failureCapture:
      Record<string, string | number | boolean | undefined> | undefined;
    let providerHeaders: Headers | undefined;
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const authorization =
        req.headers.authorization ??
        (typeof req.headers["x-api-key"] === "string"
          ? `Bearer ${req.headers["x-api-key"]}`
          : "");
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      const grant = this.grants.get(token);
      if (
        !grant ||
        grant.signal.aborted ||
        grant.controller.signal.aborted ||
        Date.now() >= grant.deadline ||
        !grant.current()
      ) {
        this.fail(res, 401);
        return;
      }
      if (grant.available && !grant.available()) {
        this.fail(res, 409);
        return;
      }
      context = {
        ...grant.context,
        request_id: requestId,
        sdk: grant.profile.sdk,
        sdk_version: sdkVersions[grant.profile.sdk],
        deadline: grant.deadline,
      };
      if (
        req.method !== "POST" ||
        !req.url?.startsWith("/") ||
        req.url.startsWith("//")
      ) {
        this.fail(res, 403);
        return;
      }
      const route = new URL(req.url, "http://127.0.0.1");
      const permitted =
        grant.profile.sdk === "claude"
          ? ["/v1/messages", "/v1/messages/count_tokens"]
          : ["/v1/responses", "/v1/responses/compact"];
      if (
        !permitted.includes(route.pathname) ||
        [...route.searchParams].some(
          ([key, value]) =>
            grant.profile.sdk !== "claude" ||
            key !== "beta" ||
            value !== "true",
        )
      ) {
        this.fail(res, 403);
        return;
      }
      let body = Buffer.alloc(0);
      for await (const chunk of req) {
        if (body.length + chunk.length > grant.bytes) {
          this.fail(res, 413);
          req.resume();
          return;
        }
        body = Buffer.concat([body, chunk]);
      }
      const data = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        data.model !== grant.profile.model ||
        ["base_url", "api_key", "endpoint", "provider", "headers"].some((key) =>
          Object.hasOwn(data, key),
        )
      ) {
        cause = "model_or_request_mismatch";
        this.fail(res, 403);
        return;
      }
      const setting =
          grant.profile.sdk === "codex" ? "reasoning" : "output_config",
        effort = data[setting] as { effort?: unknown } | undefined;
      if (
        (effort !== undefined &&
          (!effort || typeof effort !== "object" || Array.isArray(effort))) ||
        (effort?.effort !== undefined && effort.effort !== grant.profile.effort)
      ) {
        cause = "effort_mismatch";
        this.fail(res, 403);
        return;
      }
      if (
        route.pathname === "/v1/responses" ||
        route.pathname === "/v1/messages"
      )
        data[setting] = { ...effort, effort: grant.profile.effort };
      if (
        !grant.current() ||
        Date.now() >= grant.deadline ||
        !this.store.reserveModelRequest(grant.lease, grant.requests)
      ) {
        cause = "request_budget_exhausted";
        this.fail(res, 429);
        return;
      }
      const destination = new URL(this.endpoint);
      context.route = route.pathname;
      await this.store.checkpoint(
        AbortSignal.any([
          controller.signal,
          grant.signal,
          grant.controller.signal,
        ]),
      );
      if (!grant.current() || Date.now() >= grant.deadline) {
        this.fail(res, 429);
        return;
      }
      destination.pathname = destination.pathname.replace(/\/+$/, "");
      if (!destination.pathname.endsWith("/v1")) destination.pathname += "/v1";
      destination.pathname += route.pathname.slice(3);
      destination.search = route.search;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${this.secrets.get("proxy.key")}`,
      };
      for (const name of ["anthropic-version", "anthropic-beta", "openai-beta"])
        if (
          typeof req.headers[name] === "string" &&
          req.headers[name].length <= 4096
        )
          headers[name] = req.headers[name];
      const signal = AbortSignal.any([
        controller.signal,
        grant.signal,
        grant.controller.signal,
        AbortSignal.timeout(
          Math.max(1, Math.min(2_147_483_647, grant.deadline - Date.now())),
        ),
      ]);
      upstreamSignal = signal;
      cause = "upstream_transport_failed";
      this.logger.diagnostic("info", {
        event: "model.request.started",
        level: "info",
        ...context,
      });
      exchange = diagnostics.start("model", route.pathname, {
        ...grant.context,
        sdk: grant.profile.sdk,
        sdk_version: sdkVersions[grant.profile.sdk],
        method: "POST",
        route: route.pathname,
        credential_source: "proxy.key",
        request_id: requestId,
      });
      const upstream = await fetch(destination, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
        redirect: "manual",
        signal,
      });
      providerStatus = upstream.status;
      providerHeaders = upstream.headers;
      exchange.response(upstream.status, upstream.headers);
      if (!upstream.ok || !upstream.body) {
        cause = "upstream_rejected";
        const captured = await captureApiBody(upstream, signal, grant.bytes);
        failureBody = captured.body;
        failureCapture = captured.capture;
        failureReadError = captured.readError;
        if (controller.signal.aborted) cause = "request_cancelled";
        else if (signal.aborted)
          cause =
            signal.reason instanceof DOMException &&
            signal.reason.name === "TimeoutError"
              ? "deadline_exceeded"
              : "request_cancelled";
        this.fail(res, 502);
        return;
      }
      const streaming = upstream.headers
        .get("content-type")
        ?.startsWith("text/event-stream");
      res.setHeader(
        "content-type",
        streaming ? "text/event-stream" : "application/json",
      );
      res.setHeader("cache-control", "no-store");
      let bytes = 0,
        pending = "";
      const matchers = new Map<
          string,
          ReturnType<SecretAccessor["createCredentialStream"]>
        >(),
        held: string[] = [];
      let matcherBytes = 0,
        heldBytes = 0;
      const flush = async () => {
        for (const frame of held) {
          signal.throwIfAborted();
          if (!res.write(frame + "\n\n")) await once(res, "drain", { signal });
        }
        held.length = 0;
        heldBytes = 0;
      };
      const forwardFrame = async (frame: string) => {
        const length = Buffer.byteLength(frame);
        if (length > 1024 * 1024) throw new RuntimeError("relay_frame_limit");
        failureBody = frame;
        const prefixes = new Set(
          [...matchers.values()]
            .filter((matcher) => matcher.pending)
            .map((matcher) => matcher.prefixMatcher()),
        );
        try {
          const value = this.checkFrame(frame),
            fields =
              value && typeof value === "object" && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {},
            channel = [
              fields.type,
              fields.index,
              fields.output_index,
              fields.content_index,
              fields.summary_index,
              fields.item_id,
            ];
          const inspect = (item: unknown, path: string[]) => {
            if (typeof item === "string") {
              const field = modelTextFields.get(path.at(-1) ?? "");
              if (!field) return;
              for (const key of [
                JSON.stringify([channel, path]),
                JSON.stringify(["channel", channel.slice(1), field]),
                JSON.stringify(["field", field]),
              ]) {
                let matcher = matchers.get(key);
                if (!matcher) {
                  matcherBytes += Buffer.byteLength(key) + 64;
                  if (matcherBytes > grant.bytes)
                    throw new RuntimeError("relay_frame_limit");
                  matcher = this.secrets.createCredentialStream();
                  matchers.set(key, matcher);
                }
                if (matcher.pending) prefixes.add(matcher.prefixMatcher());
                if (matcher.push(item))
                  throw new RuntimeError("relay_response_invalid");
              }
            } else if (item !== null && typeof item === "object") {
              for (const [key, child] of Object.entries(item))
                inspect(child, [...path, key]);
            }
          };
          inspect(value, []);
          heldBytes += length;
          if (heldBytes > grant.bytes)
            throw new RuntimeError("relay_frame_limit");
          held.push(frame);
          failureBody = undefined;
          if (![...matchers.values()].some((matcher) => matcher.pending))
            await flush();
        } catch (error) {
          if (failureBody !== undefined)
            failureBody = this.protectFrameFragments(failureBody, prefixes);
          if (error instanceof SyntaxError) {
            error.message = this.protectFrameFragments(error.message, prefixes);
            if (error.stack)
              error.stack = this.protectFrameFragments(error.stack, prefixes);
          }
          throw error;
        }
      };
      const decoder = new TextDecoder("utf8", { fatal: true });
      for await (const chunk of upstream.body) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > grant.bytes) throw new RuntimeError("relay_output_limit");
        pending += decoder.decode(chunk, { stream: true });
        if (streaming) {
          let match;
          while ((match = /\r?\n\r?\n/.exec(pending))) {
            const frame = pending.slice(0, match.index),
              end = match.index + match[0].length;
            pending = pending.slice(end);
            await forwardFrame(frame);
          }
          if (Buffer.byteLength(pending) > 1024 * 1024)
            throw new RuntimeError("relay_frame_limit");
        }
      }
      pending += decoder.decode();
      if (streaming) {
        if (pending.trim()) await forwardFrame(pending);
        await flush();
      } else {
        failureBody = pending;
        const value = JSON.parse(pending) as { error?: unknown };
        if (value?.error || this.secrets.containsCredentials(value))
          throw new RuntimeError("relay_response_invalid");
        res.write(pending);
        failureBody = undefined;
      }
      res.end();
      succeeded = true;
    } catch (error) {
      failure = error;
      if (error instanceof RuntimeError) cause = error.code;
      else if (error instanceof SyntaxError && providerStatus !== undefined)
        cause = "relay_response_invalid";
      else if (controller.signal.aborted) cause = "request_cancelled";
      else if (
        upstreamSignal?.aborted &&
        upstreamSignal.reason instanceof DOMException &&
        upstreamSignal.reason.name === "TimeoutError"
      )
        cause = "deadline_exceeded";
      this.fail(res, 502);
    } finally {
      if (succeeded) exchange?.finish(providerStatus, providerHeaders);
      else
        exchange?.fail(failure ?? new RuntimeError(cause), {
          status: providerStatus,
          headers: providerHeaders,
          body: failureBody,
          capture: failureCapture,
          readError: failureReadError,
        });
      if (context) {
        const details = {
          ...context,
          provider_status: providerStatus,
          elapsed_ms: Date.now() - started,
          outcome: succeeded ? "completed" : "failed",
        };
        if (succeeded)
          this.logger.diagnostic("info", {
            event: "model.request.finished",
            level: "info",
            ...details,
          });
        else
          this.logger.diagnostic("error", {
            event: "model.request.failed",
            level: "error",
            ...details,
            cause,
            recovery:
              "Verify the selected profile and proxy settings, or restore provider connectivity, before retrying.",
          });
      }
      controller.abort();
    }
  }

  private protectFrameFragments(
    frame: string,
    prefixes: Set<(text: string, incomplete?: boolean) => number>,
  ) {
    const quoted = /"(?:\\[\s\S]?|[^"\\])*(?:"|$)/g;
    const streams = new Map<
      string,
      {
        current: ReturnType<SecretAccessor["createCredentialStream"]>;
        previous?: number;
      }
    >();
    const contributing = new Set<number>();
    let field: string | undefined;
    for (const match of frame.matchAll(quoted)) {
      if (/^\s*:/.test(frame.slice(match.index + match[0].length))) {
        field = modelTextFields.get(decodeDiagnosticString(match[0]));
        continue;
      }
      const parts: string[] = [];
      const value = decodeDiagnosticString(match[0], (part) => {
        parts.push(part);
        return part;
      });
      parts.push(value);
      for (const key of field ? ["all", field] : ["all"]) {
        let stream = streams.get(key);
        if (!stream) {
          stream = { current: this.secrets.createCredentialStream() };
          streams.set(key, stream);
        }
        if (stream.current.pending) {
          const prefix = stream.current.prefixMatcher();
          prefixes.add(prefix);
          if (
            stream.previous !== undefined &&
            parts.some((part) => prefix(part, true) > 0)
          )
            contributing.add(stream.previous);
        }
        stream.current.push(value);
        if (value) stream.previous = match.index;
      }
    }
    if (!prefixes.size) return frame;
    const protect = (text: string) => {
      let end = 0;
      for (const match of prefixes) end = Math.max(end, match(text, true));
      const safe = end
        ? "[credential fragment excluded]" + text.slice(end)
        : text;
      return safe;
    };
    const safe = frame.replace(quoted, (value, offset: number) => {
      if (/^\s*:/.test(frame.slice(offset + value.length))) return value;
      let protectedPrefix = false;
      const decoded = decodeDiagnosticString(value, (text) => {
        const safe = this.secrets.redactIncompleteTail(protect(text));
        protectedPrefix ||= safe !== text;
        return safe;
      });
      const protectedValue = protect(decoded);
      const content = contributing.has(offset)
        ? this.secrets.redactIncompleteTail(protectedValue)
        : protectedValue;
      const closed = value.length > 1 && value.endsWith('"');
      if (content === decoded && !protectedPrefix) return value;
      const encoded = JSON.stringify(content);
      return closed ? encoded : encoded.slice(0, -1);
    });
    return safe
      .split(/\r?\n/)
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        const payload = line.slice(5),
          content = payload.trimStart();
        return (
          "data:" +
          payload.slice(0, payload.length - content.length) +
          protect(content)
        );
      })
      .join("\n");
  }

  private checkFrame(frame: string) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (
      this.secrets.containsCredentials(frame) ||
      /^event:\s*error\s*$/m.test(frame)
    )
      throw new RuntimeError("relay_response_invalid");
    if (data && data !== "[DONE]") {
      const value = JSON.parse(data) as { type?: string; error?: unknown };
      if (
        value?.error ||
        ["error", "response.failed"].includes(value?.type ?? "") ||
        this.secrets.containsCredentials(value)
      )
        throw new RuntimeError("relay_response_invalid");
      return value;
    }
  }

  private fail(res: ServerResponse, status: number) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.end(
        'event: error\ndata: {"type":"error","error":{"type":"relay_error","message":"Model request unavailable."}}\n\n',
      );
    } else {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        '{"error":{"type":"relay_error","message":"Model request unavailable."}}',
      );
    }
  }

  async close() {
    clearInterval(this.watcher);
    for (const key of this.grants.keys()) this.revoke(key);
    this.server.closeAllConnections();
    if (this.server.listening)
      await new Promise<void>((resolve, reject) =>
        this.server.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
