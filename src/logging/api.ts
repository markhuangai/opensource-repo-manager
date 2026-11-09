import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createKnownSecretChecker, createSafeLogger } from "./redact.ts";

export const apiCaptureLimit = 1024 * 1024;
let lastFailureId: string | undefined;
const failureReferences = new WeakMap<object, string>();
export function tagApiFailure(error: unknown, id: string) {
  const seen = new Set<object>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    failureReferences.set(error, id);
    error = "cause" in error ? error.cause : undefined;
  }
}
export function apiFailureId(error: unknown): string | undefined {
  return error && typeof error === "object"
    ? failureReferences.get(error)
    : undefined;
}
export function carryApiFailure<T extends object>(
  error: T,
  original: unknown,
): T {
  const id = apiFailureId(original);
  if (id) tagApiFailure(error, id);
  return error;
}
type Fields = Record<string, string | number | boolean | undefined>;
type Protection = {
  redact(text: string): string;
  redactCredentials?(text: string): string;
  redactIncompleteTail?(text: string): string;
};
const credentialField =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|token|access_token|refresh_token|(?:x[-_]?)?api[-_]?key|password|secret|signed(?:upload|download)?url|signature|sig)$/i;
const responseHeaders = [
  "content-type",
  "x-github-request-id",
  "x-request-id",
  "request-id",
  "x-ms-request-id",
  "x-accepted-github-permissions",
  "x-accepted-oauth-scopes",
  "x-oauth-scopes",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after",
];

export function actionsApiContext(): Fields {
  const context: Fields = {};
  for (const [key, name, pattern] of [
    ["repository", "GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/],
    ["workflow_run_id", "GITHUB_RUN_ID", /^[1-9][0-9]*$/],
    ["run_attempt", "GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/],
    ["source_sha", "GITHUB_SHA", /^[a-f0-9]{40}$/],
  ] as const) {
    const value = process.env[name];
    if (value && pattern.test(value)) context[key] = value;
  }
  return context;
}

export function apiError(error: unknown, seen = new Set<unknown>()): unknown {
  if (!error || typeof error !== "object") return { message: String(error) };
  if (seen.has(error)) return { message: "Circular error cause" };
  seen.add(error);
  const value = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
    stack?: unknown;
    errors?: unknown;
  };
  return {
    name: typeof value.name === "string" ? value.name : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
    code:
      typeof value.code === "string" || typeof value.code === "number"
        ? value.code
        : undefined,
    stack: typeof value.stack === "string" ? value.stack : undefined,
    ...(Array.isArray(value.errors) && {
      errors: value.errors.map((error) => apiError(error, seen)),
    }),
    ...(value.cause !== undefined && { cause: apiError(value.cause, seen) }),
  };
}

export function createApiDiagnostics(
  protection: Protection,
  context: Fields = {},
  sink?: (line: string) => void,
) {
  const logger = createSafeLogger(createKnownSecretChecker([]), true, sink);
  const active = new Map<string, Fields>();
  const redact =
    protection.redactCredentials?.bind(protection) ??
    protection.redact.bind(protection);
  function protect(text: string): string {
    const scrub = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(scrub).join(",")}]`;
      if (value && typeof value === "object")
        return `{${Object.entries(value)
          .map(
            ([key, item]) =>
              `${JSON.stringify(scrubText(key))}:${credentialField.test(key) ? JSON.stringify("[credential excluded]") : scrub(item)}`,
          )
          .join(",")}}`;
      return JSON.stringify(
        typeof value === "string" ? scrubText(value) : value,
      );
    };
    function protectUrls(value: string) {
      return value.replace(/\bhttps?:(?:\/|\\\/){2}[^\s"'<>]+/gi, (url) => {
        try {
          const parsed = new URL(
            url.replaceAll("\\/", "/").replaceAll("&amp;", "&"),
          );
          if (
            parsed.username ||
            parsed.password ||
            [...parsed.searchParams.keys()].some(
              (key) =>
                credentialField.test(key) ||
                /^(?:client_secret|x-amz-|x-goog-)/i.test(key),
            )
          )
            return "[signed URL excluded]";
        } catch {
          return url;
        }
        return url;
      });
    }
    function excludeFields(value: string) {
      const keys = /("(?:\\.|[^"\\])*")\s*:\s*/g;
      let output = "",
        previous = 0,
        match: RegExpExecArray | null;
      while ((match = keys.exec(value))) {
        try {
          if (!credentialField.test(JSON.parse(match[1]))) continue;
        } catch {
          continue;
        }
        let depth = 0,
          quoted = false,
          escaped = false,
          end = keys.lastIndex;
        for (; end < value.length; end++) {
          const character = value[end];
          if (quoted) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') {
              quoted = false;
              if (!depth) {
                end++;
                break;
              }
            }
          } else if (character === '"') quoted = true;
          else if (character === "[" || character === "{") depth++;
          else if (character === "]" || character === "}") {
            if (!depth) break;
            if (!--depth) {
              end++;
              break;
            }
          } else if (!depth && (character === "," || /\s/.test(character)))
            break;
        }
        output +=
          value.slice(previous, keys.lastIndex) + '"[credential excluded]"';
        previous = end;
        keys.lastIndex = end;
      }
      return output + value.slice(previous);
    }
    function scrubText(value: string): string {
      const fieldsExcluded = excludeFields(value).replace(
        /^([ \t]*([a-z0-9_-]+)[ \t]*[:=][ \t]*)[^\r\n]*/gim,
        (line, prefix: string, key: string) =>
          credentialField.test(key) ? prefix + "[credential excluded]" : line,
      );
      const text = fieldsExcluded.replace(
        /"(?:\\.|[^"\\])*(?:"|$)/g,
        (quoted) => {
          const closed = quoted.length > 1 && quoted.endsWith('"');
          try {
            const decoded = JSON.parse(
              closed ? quoted : quoted + '"',
            ) as string;
            const safe = scrubText(decoded);
            if (safe === decoded) return quoted;
            const encoded = JSON.stringify(safe);
            return closed ? encoded : encoded.slice(0, -1);
          } catch {
            return quoted;
          }
        },
      );
      return redact(protectUrls(text));
    }
    try {
      return scrub(JSON.parse(text));
    } catch {
      return text
        .split(/(\r?\n\r?\n)/)
        .map((frame) => {
          const lines = frame.split(/\r?\n/),
            data = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart());
          if (!data.length) return scrubText(frame);
          const payload = data.join("\n");
          let safe: string;
          try {
            safe = scrub(JSON.parse(payload));
          } catch {
            safe = scrubText(payload);
          }
          let first = true;
          return lines
            .flatMap((line) => {
              if (!line.startsWith("data:")) return [scrubText(line)];
              if (!first) return [];
              first = false;
              return ["data: " + safe];
            })
            .join("\n");
        })
        .join("");
    }
  }
  function emit(level: "info" | "error", record: Fields) {
    if (record.event === "api.request.started")
      active.set(String(record.request_id), record);
    if (record.event === "api.response.started") {
      const before = active.get(String(record.request_id));
      if (before)
        active.set(String(record.request_id), {
          ...before,
          status: record.status,
        });
    }
    if (
      record.event === "api.request.finished" ||
      record.event === "api.request.failed"
    )
      active.delete(String(record.request_id));
    if (record.event === "api.request.failed")
      lastFailureId = String(record.request_id);
    logger.diagnostic(level, { ...actionsApiContext(), ...context, ...record });
  }
  function detail(
    base: Fields,
    kind: string,
    value: unknown,
    capture: Fields = {},
  ) {
    const raw =
      typeof value === "string"
        ? value
        : value instanceof ArrayBuffer
          ? Buffer.from(value).toString("utf8")
          : ArrayBuffer.isView(value)
            ? Buffer.from(
                value.buffer,
                value.byteOffset,
                value.byteLength,
              ).toString("utf8")
            : JSON.stringify(value);
    if (raw === undefined) return;
    const protectedText = protect(raw);
    const incomplete =
      capture.capture_state !== undefined &&
      capture.capture_state !== "complete" &&
      capture.capture_state !== "empty";
    const bytes = Buffer.from(
        incomplete
          ? (protection.redactIncompleteTail?.(protectedText) ?? protectedText)
          : protectedText,
      ),
      decoder = new StringDecoder("utf8");
    const captured = decoder.write(bytes.subarray(0, apiCaptureLimit));
    const text = captured;
    const common = {
      ...actionsApiContext(),
      ...context,
      ...base,
      event: "api.response.detail",
      level: "error",
      detail_kind: kind,
      body_bytes: bytes.length,
      captured_bytes: Buffer.byteLength(captured),
      omitted_bytes: bytes.length - Buffer.byteLength(captured),
      capture_state: bytes.length > apiCaptureLimit ? "byte_limit" : "complete",
      ...capture,
    };
    let offset = 0,
      part = 0;
    do {
      let end = Math.min(text.length, offset + 1024);
      while (
        end > offset &&
        Buffer.byteLength(
          JSON.stringify({
            ...common,
            part: part + 1,
            content: text.slice(offset, end),
            last: end === text.length,
          }),
        ) > 2048
      )
        end = offset + Math.floor((end - offset) / 2);
      if (end > offset && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      if (end === offset && offset < text.length)
        throw new RangeError("API diagnostic metadata exceeds log limit.");
      const next = text.slice(offset, end);
      emit("error", {
        ...common,
        part: ++part,
        content: next,
        last: end === text.length,
      });
      offset = end;
    } while (offset < text.length);
  }
  const pending = new Map<
    string,
    { fields: Fields; content: string; next: number }
  >();
  return {
    interrupt(error: unknown) {
      for (const record of active.values()) {
        lastFailureId = String(record.request_id);
        tagApiFailure(error, lastFailureId);
        emit("error", {
          ...record,
          event: "api.capture.incomplete",
          level: "error",
          capture_state: "interrupted",
          omitted_bytes: -1,
        });
        detail(record, "interruption_cause", apiError(error), {
          capture_state: "interrupted",
          omitted_bytes: -1,
        });
      }
      active.clear();
    },
    flush() {
      for (const value of pending.values()) {
        const {
          content: _content,
          part: _part,
          last: _last,
          ...fields
        } = value.fields;
        void _content;
        void _part;
        void _last;
        detail(fields, String(fields.detail_kind), value.content, {
          capture_state: "interrupted",
          omitted_bytes: -1,
        });
      }
      pending.clear();
    },
    forward(record: Fields) {
      if (typeof record.provider_request_id === "string")
        record = {
          ...record,
          provider_request_id: protect(record.provider_request_id),
        };
      if (record.event !== "api.response.detail") {
        emit(record.level === "error" ? "error" : "info", record);
        return;
      }
      const key = `${record.request_id}:${record.detail_kind}`;
      const value = pending.get(key) ?? {
        fields: record,
        content: "",
        next: 1,
      };
      if (record.part !== value.next || typeof record.content !== "string")
        throw new Error("Invalid API diagnostic sequence.");
      value.next++;
      value.content += record.content;
      if (Buffer.byteLength(value.content) > apiCaptureLimit * 8)
        throw new Error("API diagnostic capture exceeds limit.");
      if (record.last) {
        pending.delete(key);
        const {
          content: _content,
          part: _part,
          last: _last,
          ...fields
        } = value.fields;
        void _content;
        void _part;
        void _last;
        detail(fields, String(record.detail_kind), value.content, {
          capture_state: record.capture_state,
          omitted_bytes: record.omitted_bytes,
        });
      } else pending.set(key, value);
    },
    event(event: string, fields: Fields) {
      emit("error", {
        event,
        level: "error",
        request_id: lastFailureId,
        ...fields,
      });
    },
    start(provider: string, operation: string, fields: Fields = {}) {
      const started = performance.now();
      const base: Fields = {
        provider,
        operation,
        request_id: randomUUID(),
        ...fields,
      };
      let omittedMetadata = 0;
      for (const key of ["operation", "route"]) {
        const value = base[key];
        if (typeof value === "string" && Buffer.byteLength(value) > 256) {
          const decoder = new StringDecoder("utf8");
          const bounded = decoder.write(Buffer.from(value).subarray(0, 256));
          omittedMetadata +=
            Buffer.byteLength(value) - Buffer.byteLength(bounded);
          base[key] = bounded;
        }
      }
      if (omittedMetadata) base.metadata_omitted_bytes = omittedMetadata;
      emit("info", { ...base, event: "api.request.started", level: "info" });
      let finished = false;
      return {
        id: String(base.request_id),
        response(status?: number, headers?: Headers | Record<string, unknown>) {
          const requestId =
            headers instanceof Headers
              ? (headers.get("x-github-request-id") ??
                headers.get("x-request-id") ??
                headers.get("x-ms-request-id"))
              : (headers?.["x-github-request-id"] ??
                headers?.["x-request-id"] ??
                headers?.["x-ms-request-id"]);
          emit("info", {
            ...base,
            event: "api.response.started",
            level: "info",
            status,
            provider_request_id:
              typeof requestId === "string"
                ? protect(requestId).slice(0, 128)
                : undefined,
            elapsed_ms: Math.round(performance.now() - started),
          });
        },
        finish(status?: number, headers?: Headers | Record<string, unknown>) {
          if (finished) return;
          finished = true;
          emit("info", {
            ...base,
            event: "api.request.finished",
            level: "info",
            status,
            outcome: status === 304 ? "not_modified" : "completed",
            elapsed_ms: Math.round(performance.now() - started),
          });
          void headers;
        },
        fail(
          error: unknown,
          response: {
            status?: number;
            headers?: Headers | Record<string, unknown>;
            body?: unknown;
            capture?: Fields;
            readError?: unknown;
          } = {},
        ) {
          tagApiFailure(error, String(base.request_id));
          tagApiFailure(response.readError, String(base.request_id));
          if (finished) return;
          finished = true;
          const safeHeaders = Object.fromEntries(
            responseHeaders.flatMap((name) => {
              const value =
                response.headers instanceof Headers
                  ? response.headers.get(name)
                  : response.headers?.[name];
              return typeof value === "string" ? [[name, value]] : [];
            }),
          );
          emit("error", {
            ...base,
            event: "api.request.failed",
            level: "error",
            status: response.status,
            response_received: response.status !== undefined,
            outcome: "failed",
            elapsed_ms: Math.round(performance.now() - started),
          });
          detail(base, "cause", apiError(error));
          if (response.readError !== undefined)
            detail(base, "read_cause", apiError(response.readError));
          if (Object.keys(safeHeaders).length)
            detail(base, "headers", safeHeaders);
          if (response.body !== undefined)
            detail(base, "body", response.body, response.capture);
        },
      };
    },
  };
}

export type ApiDiagnostics = ReturnType<typeof createApiDiagnostics>;

export function observeApiFetch(
  original: typeof fetch,
  exchange: ReturnType<ApiDiagnostics["start"]>,
  finishOnBodyEnd = false,
): typeof fetch {
  return async (input, init) => {
    const response = await original(input, init);
    exchange.response(response.status, response.headers);
    const replay = (body: BodyInit | null) => {
      const result = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      for (const key of ["url", "redirected", "type"] as const)
        Object.defineProperty(result, key, { value: response[key] });
      return result;
    };
    if (response.status >= 400) {
      const captured = await captureApiBody(
        response,
        init?.signal ?? undefined,
      );
      exchange.fail(new Error(response.statusText), {
        status: response.status,
        headers: response.headers,
        ...captured,
      });
      return replay(captured.body);
    }
    if (!response.body || response.status === 304) {
      if (finishOnBodyEnd) exchange.finish(response.status, response.headers);
      return response;
    }
    const reader = response.body.getReader();
    const prefix: Uint8Array[] = [];
    let captured = 0,
      received = 0;
    const failed = (error: unknown, state: string) =>
      exchange.fail(error, {
        status: response.status,
        headers: response.headers,
        body: new StringDecoder("utf8").write(Buffer.concat(prefix)),
        capture: {
          capture_state: state,
          received_bytes: received,
          omitted_bytes: -1,
        },
      });
    return replay(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const value = await reader.read();
            if (value.done) {
              controller.close();
              if (finishOnBodyEnd)
                exchange.finish(response.status, response.headers);
            } else {
              received += value.value.length;
              const next = value.value.subarray(
                0,
                Math.max(0, apiCaptureLimit - captured),
              );
              if (next.length) prefix.push(next);
              captured += next.length;
              controller.enqueue(value.value);
            }
          } catch (error) {
            failed(error, "read_failed");
            controller.error(error);
          }
        },
        cancel(reason) {
          failed(reason ?? new Error("Response body cancelled."), "cancelled");
          return reader.cancel(reason);
        },
      }),
    );
  };
}

export async function captureApiBody(
  response: Response,
  signal?: AbortSignal,
  limit = apiCaptureLimit,
) {
  const reader = response.body?.getReader();
  if (!reader)
    return {
      body: "",
      capture: { capture_state: "empty" },
      readError: undefined as unknown,
    };
  const chunks: Uint8Array[] = [];
  let bytes = 0,
    state = "complete";
  let readError: unknown;
  const timeout = AbortSignal.timeout(5000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const stop = () => {
    void reader.cancel().catch(() => {});
  };
  combined.addEventListener("abort", stop, { once: true });
  try {
    while (!combined.aborted) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = Math.min(limit, apiCaptureLimit) - bytes;
      chunks.push(next.value.subarray(0, Math.max(0, remaining)));
      bytes += Math.min(remaining, next.value.length);
      if (next.value.length > remaining) {
        state = "byte_limit";
        break;
      }
    }
    if (combined.aborted) {
      state = timeout.aborted ? "read_timeout" : "cancelled";
      readError = combined.reason;
    }
  } catch (error) {
    state = "read_failed";
    readError = error;
  } finally {
    combined.removeEventListener("abort", stop);
    void reader.cancel().catch(() => {});
  }
  const decoder = new StringDecoder("utf8");
  return {
    body: decoder.write(Buffer.concat(chunks)),
    readError,
    capture: {
      capture_state: state,
      ...(state !== "complete" && { omitted_bytes: -1 }),
    },
  };
}
