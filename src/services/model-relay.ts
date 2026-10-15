import { randomBytes, createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { setInterval, clearInterval } from "node:timers";
import type { ModelProfile } from "../config/schema.ts";
import type { SecretAccessor } from "../config/secrets.ts";
import { RuntimeError } from "../domain/agents.ts";
import type { Store } from "../repositories/store.ts";

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
};

export class ModelRelay {
  private readonly grants = new Map<string, Grant>();
  private readonly server = createServer((req, res) => {
    void this.handle(req, res);
  });
  private url = "";
  private readonly watcher: ReturnType<typeof setInterval>;
  private readonly store: Store;
  private readonly endpoint: string;
  private readonly secrets: SecretAccessor;
  constructor(store: Store, endpoint: string, secrets: SecretAccessor) {
    this.store = store;
    this.endpoint = endpoint;
    this.secrets = secrets;
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
      key = this.key(authorization),
      controller = new AbortController();
    this.grants.set(key, { ...options, controller });
    const revoke = () => this.revoke(key);
    options.signal.addEventListener("abort", revoke, { once: true });
    controller.signal.addEventListener(
      "abort",
      () => options.signal.removeEventListener("abort", revoke),
      { once: true },
    );
    return { url: this.url, authorization, revoke };
  }

  private key(token: string) {
    return createHash("sha256").update(token).digest("hex");
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
      const grant = this.grants.get(this.key(token));
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
        this.fail(res, 429);
        return;
      }
      const destination = new URL(this.endpoint);
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
      const upstream = await fetch(destination, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
        redirect: "manual",
        signal,
      });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
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
            this.checkFrame(frame);
            if (!res.write(frame + "\n\n"))
              await once(res, "drain", { signal });
          }
          if (Buffer.byteLength(pending) > 1024 * 1024)
            throw new RuntimeError("relay_frame_limit");
        }
      }
      pending += decoder.decode();
      if (streaming) {
        if (pending.trim()) {
          this.checkFrame(pending);
          res.write(pending + "\n\n");
        }
      } else {
        const value = JSON.parse(pending) as { error?: unknown };
        if (value?.error || this.secrets.containsCredentials(value))
          throw new RuntimeError("relay_response_invalid");
        res.write(pending);
      }
      res.end();
    } catch {
      this.fail(res, 502);
    } finally {
      controller.abort();
    }
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
