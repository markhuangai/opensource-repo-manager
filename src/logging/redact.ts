export function createKnownSecretChecker(values: readonly string[]) {
  const secrets = [...new Set(values.filter(Boolean))]
    .flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")])
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  function contains(value: unknown): boolean {
    if (typeof value === "string")
      return secrets.some((secret) => value.includes(secret));
    if (Array.isArray(value)) return value.some(contains);
    if (value !== null && typeof value === "object")
      return Object.entries(value).some(
        ([key, item]) => contains(key) || contains(item),
      );
    return false;
  }

  function redact(message: string) {
    for (const secret of secrets)
      message = message.replaceAll(secret, "[redacted]");
    return message;
  }

  const incompleteSecrets = [
    ...new Set(
      secrets.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ];
  function redactIncompleteTail(message: string) {
    let excluded = 0;
    for (const secret of incompleteSecrets)
      for (
        let size = Math.min(secret.length - 1, message.length);
        size > excluded;
        size--
      )
        if (message.endsWith(secret.slice(0, size))) {
          excluded = size;
          break;
        }
    return excluded
      ? message.slice(0, -excluded) + "[credential prefix excluded]"
      : message;
  }

  type Node = { next: Map<string, number>; fail: number; matched: boolean };
  type Stream = Readonly<{
    pending: boolean;
    push(text: string): boolean;
    fork(): Stream;
  }>;
  let nodes: Node[] | undefined;
  function createStream(): Stream {
    if (!nodes) {
      nodes = [{ next: new Map(), fail: 0, matched: false }];
      for (const secret of secrets) {
        let state = 0;
        for (let index = 0; index < secret.length; index++) {
          const character = secret[index];
          let next = nodes[state].next.get(character);
          if (next === undefined) {
            next = nodes.length;
            nodes[state].next.set(character, next);
            nodes.push({ next: new Map(), fail: 0, matched: false });
          }
          state = next;
        }
        nodes[state].matched = true;
      }
      const queue = [...nodes[0].next.values()];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const state = queue[cursor];
        for (const [character, child] of nodes[state].next) {
          let fallback = nodes[state].fail;
          while (fallback && !nodes[fallback].next.has(character))
            fallback = nodes[fallback].fail;
          nodes[child].fail = nodes[fallback].next.get(character) ?? 0;
          nodes[child].matched ||= nodes[nodes[child].fail].matched;
          queue.push(child);
        }
      }
    }
    const compiled = nodes;
    const stream = (state: number): Stream =>
      Object.freeze({
        get pending() {
          return state !== 0;
        },
        push(text: string) {
          let matched = false;
          for (let index = 0; index < text.length; index++) {
            const character = text[index];
            while (state && !compiled[state].next.has(character))
              state = compiled[state].fail;
            state = compiled[state].next.get(character) ?? 0;
            matched ||= compiled[state].matched;
          }
          return matched;
        },
        fork: () => stream(state),
      });
    return stream(0);
  }

  return Object.freeze({
    contains,
    redact,
    redactIncompleteTail,
    createStream,
  });
}

export type KnownSecretChecker = ReturnType<typeof createKnownSecretChecker>;

const publicLogFields = [
  "event",
  "level",
  "request_id",
  "operation",
  "repository",
  "run_id",
  "run_attempt",
  "issue_number",
  "source_sha",
  "cause",
  "outcome",
  "elapsed_ms",
  "schema_version",
  "source",
  "name",
  "line",
  "column",
  "section",
  "expected",
  "observed",
  "recovery",
] as const;
type PublicLogRecord = Partial<
  Record<(typeof publicLogFields)[number], string | number | undefined>
>;

// Public provenance bypasses value redaction; private content must use the string methods.
function publicRecord(record: PublicLogRecord) {
  const fields: PublicLogRecord = {};
  const omitted: string[] = [];
  for (const key of publicLogFields) {
    const value = record[key];
    if (value === undefined) continue;
    if (
      (typeof value !== "string" &&
        (typeof value !== "number" || !Number.isFinite(value))) ||
      JSON.stringify({
        ...fields,
        [key]: value,
        omitted_fields: publicLogFields,
      }).length > 2048
    )
      omitted.push(key);
    else fields[key] = value;
  }
  return JSON.stringify({
    ...fields,
    ...(omitted.length && { omitted_fields: omitted }),
  });
}

export function createSafeLogger(
  checker: KnownSecretChecker,
  stderr = false,
  diagnosticSink?: (line: string) => void,
) {
  return Object.freeze({
    diagnostic: (level: "info" | "error", record: Record<string, unknown>) => {
      const line = JSON.stringify(record);
      if (Buffer.byteLength(line) > 2048)
        throw new RangeError("Diagnostic record exceeds 2 KiB.");
      if (diagnosticSink) diagnosticSink(line);
      else (level === "error" || stderr ? console.error : console.log)(line);
    },
    info: (message: string) =>
      (stderr ? console.error : console.log)(
        checker.redact(message).slice(0, 2048),
      ),
    error: (message: string) =>
      console.error(checker.redact(message).slice(0, 2048)),
    infoPublic: (record: PublicLogRecord) =>
      (stderr ? console.error : console.log)(publicRecord(record)),
    errorPublic: (record: PublicLogRecord) =>
      console.error(publicRecord(record)),
  });
}

export type SafeLogger = Pick<
  ReturnType<typeof createSafeLogger>,
  "info" | "error"
>;
