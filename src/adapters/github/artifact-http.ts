import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { HttpClientResponse } from "@actions/http-client";
import {
  apiCaptureLimit,
  observeApiFetch,
  type ApiDiagnostics,
} from "../../logging/api.ts";

async function capture(response: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const result = await new Promise<{ state: string; error?: Error }>(
    (resolve) => {
      const finish = (state: string, error?: Error) => {
        clearTimeout(timer);
        response.pause();
        response.removeListener("data", data);
        response.removeListener("end", end);
        response.removeListener("error", failed);
        resolve({ state, error });
      };
      const data = (chunk: Buffer) => {
        chunks.push(chunk);
        bytes += chunk.length;
        if (bytes > apiCaptureLimit) finish("byte_limit");
      };
      const end = () => finish("complete");
      const failed = (error: Error) => finish("read_failed", error);
      const timer = setTimeout(() => finish("read_timeout"), 5000);
      response.on("data", data).once("end", end).once("error", failed);
    },
  );
  const prefix = Buffer.concat(chunks);
  const replay = new PassThrough() as PassThrough & Partial<IncomingMessage>;
  for (const name of [
    "statusCode",
    "statusMessage",
    "headers",
    "rawHeaders",
    "trailers",
    "rawTrailers",
    "httpVersion",
    "httpVersionMajor",
    "httpVersionMinor",
    "socket",
    "complete",
    "aborted",
  ] as const)
    Object.defineProperty(replay, name, {
      get: () => response[name],
      configurable: true,
    });
  replay.setTimeout = response.setTimeout.bind(response);
  return {
    body: new StringDecoder("utf8").write(prefix.subarray(0, apiCaptureLimit)),
    state: result.state,
    error: result.error,
    replay,
    resume() {
      if (result.state === "complete") replay.end(prefix);
      else {
        replay.write(prefix);
        response.pipe(replay);
        response.once("error", (error) => replay.destroy(error));
        if (result.error) replay.destroy(result.error);
      }
    },
  };
}

function observeBody(
  response: IncomingMessage,
  exchange: ReturnType<ApiDiagnostics["start"]>,
  finishOnEnd = true,
) {
  const prefix: Buffer[] = [];
  let captured = 0,
    received = 0;
  const failed = (error: unknown) =>
    exchange.fail(error, {
      status: response.statusCode,
      headers: response.headers,
      body: new StringDecoder("utf8").write(Buffer.concat(prefix)),
      capture: {
        capture_state: "read_failed",
        received_bytes: received,
        omitted_bytes: -1,
      },
    });
  const emit = response.emit;
  response.once("error", failed);
  response.emit = function (name: string | symbol, ...values: unknown[]) {
    if (name === "data") {
      const chunk = values[0] as Buffer;
      received += chunk.length;
      const next = chunk.subarray(0, Math.max(0, apiCaptureLimit - captured));
      if (next.length) prefix.push(next);
      captured += next.length;
    } else if (name === "end" && finishOnEnd)
      exchange.finish(response.statusCode, response.headers);
    else if (name === "close") {
      if (!response.complete)
        failed(new Error("Response body closed before completion."));
      else if (finishOnEnd)
        exchange.finish(response.statusCode, response.headers);
    }
    return Reflect.apply(emit, this, [name, ...values]);
  };
  return failed;
}

function rpcError(text: string): Error | undefined {
  try {
    const body = JSON.parse(text) as {
      ok?: boolean;
      error?: unknown;
      errors?: unknown[];
    };
    if (body?.ok === false || body?.error || body?.errors?.length)
      return new Error("Artifact RPC response contains an application error.");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

// The artifact SDK owns its clients; observation stays inside its disposable supervisor helper.
export function observeArtifactHttp(
  diagnostics: ApiDiagnostics,
  operationId: string,
) {
  const originals = [http.request, https.request] as const;
  const originalFetch = globalThis.fetch;
  const originalReadBody = HttpClientResponse.prototype.readBody;
  const rpcOutcomes = new WeakMap<IncomingMessage, (body: string) => void>();
  HttpClientResponse.prototype.readBody = async function () {
    const body = await Reflect.apply(originalReadBody, this, []);
    rpcOutcomes.get(this.message)?.(body);
    rpcOutcomes.delete(this.message);
    return body;
  };
  const attempts = new Map<string, number>();
  const start = (method: string, path: string, identity = path) => {
    const pathname = new URL(path, "https://artifact.invalid").pathname;
    const route =
      pathname.startsWith("/twirp/") || pathname.startsWith("/repos/")
        ? pathname
        : "/artifact-blob";
    const operation = `${method} ${route}`;
    const key = `${method} ${identity}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    return diagnostics.start("artifact", operation, {
      operation_id: operationId,
      method,
      route,
      attempt,
      credential_source: route.startsWith("/twirp/")
        ? "actions.runtime_token"
        : route.startsWith("/repos/")
          ? "github.token"
          : "signed_url",
    });
  };
  for (const [index, module] of [http, https].entries()) {
    const original = originals[index]!;
    module.request = function (...args: Parameters<typeof http.request>) {
      const request = Reflect.apply(
        original,
        module,
        args,
      ) as http.ClientRequest;
      const exchange = start(
        request.method,
        request.path,
        `${request.getHeader("host")}${request.path}`,
      );
      let reportError = (error: unknown) => exchange.fail(error);
      const emit = request.emit;
      request.emit = function (name: string | symbol, ...values: unknown[]) {
        if (name === "response") {
          const response = values[0] as IncomingMessage;
          exchange.response(response.statusCode, response.headers);
          if (
            (response.statusCode ?? 0) >= 400 ||
            request.path.startsWith("/twirp/")
          ) {
            let requestError: unknown;
            reportError = (error) => {
              requestError = error;
            };
            void capture(response).then((value) => {
              const applicationError =
                request.path.startsWith("/twirp/") && value.state === "complete"
                  ? rpcError(value.body)
                  : undefined;
              if (
                (response.statusCode ?? 0) >= 400 ||
                applicationError ||
                value.error ||
                requestError
              )
                exchange.fail(
                  value.error ??
                    requestError ??
                    applicationError ??
                    new Error(
                      response.statusMessage ?? "Artifact HTTP request failed.",
                    ),
                  {
                    status: response.statusCode,
                    headers: response.headers,
                    body: value.body,
                    readError: value.error ?? requestError,
                    capture: {
                      capture_state: value.state,
                      ...(value.state !== "complete" && { omitted_bytes: -1 }),
                    },
                  },
                );
              else if (value.state === "complete")
                exchange.finish(response.statusCode, response.headers);
              else {
                reportError = observeBody(
                  value.replay as IncomingMessage,
                  exchange,
                  false,
                );
                // The SDK already reads the complete RPC body; retain only the admitted diagnostic prefix.
                rpcOutcomes.set(value.replay as IncomingMessage, (body) => {
                  const error = rpcError(body);
                  if (error)
                    exchange.fail(error, {
                      status: response.statusCode,
                      headers: response.headers,
                      body: value.body,
                      capture: {
                        capture_state: value.state,
                        omitted_bytes: -1,
                      },
                    });
                  else exchange.finish(response.statusCode, response.headers);
                });
                diagnostics.event("api.capture.incomplete", {
                  provider: "artifact",
                  operation_id: operationId,
                  request_id: exchange.id,
                  status: response.statusCode,
                  capture_state: value.state,
                  omitted_bytes: -1,
                });
              }
              Reflect.apply(emit, request, [name, value.replay]);
              value.resume();
            });
            return true;
          }
          reportError = observeBody(response, exchange);
        }
        return Reflect.apply(emit, this, [name, ...values]);
      };
      request.once("error", (error) => reportError(error));
      return request;
    } as typeof http.request;
  }
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const exchange = start(
      init?.method ?? (input instanceof Request ? input.method : "GET"),
      url,
    );
    try {
      return await observeApiFetch(originalFetch, exchange, true)(input, init);
    } catch (error) {
      exchange.fail(error);
      throw error;
    }
  };
  syncBuiltinESMExports();
  return () => {
    http.request = originals[0];
    https.request = originals[1];
    HttpClientResponse.prototype.readBody = originalReadBody;
    globalThis.fetch = originalFetch;
    syncBuiltinESMExports();
  };
}
