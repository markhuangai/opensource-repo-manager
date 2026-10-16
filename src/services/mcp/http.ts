import { AsyncLocalStorage } from "node:async_hooks";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SecretAccessor } from "../../config/secrets.ts";
import { RuntimeError } from "../../domain/agents.ts";

export function budget(deadline: number, parent: AbortSignal) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) controller.abort(new RuntimeError("mcp_timeout"));
    else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
  };
  const abort = () => controller.abort(new RuntimeError("mcp_cancelled"));
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  expire();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

export class UpstreamHttp {
  readonly transport: StreamableHTTPClientTransport;
  private readonly operations = new AsyncLocalStorage<AbortSignal>();

  constructor(
    endpoint: string,
    authentication: Readonly<Record<string, string>>,
    lifetime: AbortSignal,
    limits: { max_request_bytes: number; max_response_bytes: number },
    secrets: SecretAccessor,
    containsAuthorization: (value: unknown) => boolean,
  ) {
    const url = new URL(endpoint);
    for (const name of Object.keys(authentication))
      if (
        /^(host|content-length|transfer-encoding|connection|accept|content-type|mcp-.*|last-event-id)$/i.test(
          name,
        )
      )
        throw new RuntimeError("mcp_authentication_invalid");
    this.transport = new StreamableHTTPClientTransport(url, {
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        const destination =
          input instanceof Request ? input.url : String(input);
        if (destination !== url.href)
          throw new RuntimeError("mcp_endpoint_changed");
        const method = init?.method ?? "GET";
        if (!["POST", "GET", "DELETE"].includes(method))
          throw new RuntimeError("mcp_method_invalid");
        if (init?.body !== undefined && init.body !== null) {
          if (
            typeof init.body !== "string" ||
            Buffer.byteLength(init.body) > limits.max_request_bytes
          )
            throw new RuntimeError("mcp_request_limit");
          const value: unknown = JSON.parse(init.body);
          if (secrets.contains(value) || containsAuthorization(value))
            throw new RuntimeError("mcp_secret_in_request");
        }
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(authentication))
          headers.set(name, value);
        // SDK GET requests have their own redirect policy, so the fetch boundary owns every method.
        const signal =
          method === "DELETE"
            ? AbortSignal.timeout(1000)
            : AbortSignal.any([
                lifetime,
                ...(init?.signal ? [init.signal] : []),
                ...(method === "POST" && this.operations.getStore()
                  ? [this.operations.getStore()!]
                  : []),
              ]);
        const response = await fetch(url, {
          ...init,
          method,
          headers,
          signal,
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new RuntimeError("mcp_redirect_denied");
        }
        if (!response.body) return response;
        const reader = response.body.getReader();
        let used = 0,
          previous = "";
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                controller.close();
                return;
              }
              if (method === "GET") {
                for (const byte of next.value) {
                  if (++used > limits.max_response_bytes)
                    throw new RuntimeError("mcp_response_limit");
                  previous = (previous + String.fromCharCode(byte)).slice(-4);
                  if (previous.endsWith("\n\n") || previous === "\r\n\r\n")
                    used = 0;
                }
              } else if (
                (used += next.value.byteLength) > limits.max_response_bytes
              )
                throw new RuntimeError("mcp_response_limit");
              controller.enqueue(next.value);
            } catch (error) {
              await reader.cancel().catch(() => {});
              controller.error(error);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
  }

  within<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    return this.operations.run(signal, operation);
  }
}
