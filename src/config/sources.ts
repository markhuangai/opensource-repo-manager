import { ConfigurationError, type ConfigurationDiagnostic } from "./errors.ts";

export type ConfigurationSources = Readonly<{
  variables: Readonly<Record<string, string>>;
  secrets: Readonly<Record<string, string>>;
}>;
export type ConfigurationPath = readonly (string | number)[];
export type SourceRecord = ConfigurationDiagnostic & {
  source: "variable" | "secret";
  name: string;
  path: ConfigurationPath;
};
export const configurationBytes = 1024 * 1024;
export const sourceContextBytes = 64 * 1024;
const sourceName = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

export function parseConfigurationSources(
  variables = "{}",
  secrets = "{}",
): ConfigurationSources {
  function map(source: string): Readonly<Record<string, string>> {
    try {
      if (Buffer.byteLength(source) > sourceContextBytes) throw new Error();
      const value: unknown = JSON.parse(source);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      const entries = Object.entries(value);
      if (
        entries.some(
          ([key, item]) => !sourceName.test(key) || typeof item !== "string",
        ) ||
        new Set(entries.map(([key]) => key.toUpperCase())).size !==
          entries.length
      )
        throw new Error();
      return Object.freeze(
        Object.fromEntries(
          entries.map(([key, item]) => [key.toUpperCase(), item as string]),
        ),
      );
    } catch {
      throw new ConfigurationError("source_context_invalid");
    }
  }
  return Object.freeze({ variables: map(variables), secrets: map(secrets) });
}

export function configurationValueType(value: unknown): string {
  return value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value;
}

export function sourceForPath(
  records: readonly SourceRecord[],
  path: ConfigurationPath,
) {
  return records.find(
    (record) =>
      record.path.length <= path.length &&
      record.path.every((part, index) => part === path[index]),
  );
}

export function resolveConfigurationSources(
  input: unknown,
  sources: ConfigurationSources,
  rejectSource: (
    code:
      "source_reference_invalid" | "source_missing" | "source_value_invalid",
    path: ConfigurationPath,
    diagnostic: ConfigurationDiagnostic,
  ) => never,
) {
  const records: SourceRecord[] = [];
  function reject(
    code: Parameters<typeof rejectSource>[0],
    path: ConfigurationPath,
    diagnostic: ConfigurationDiagnostic,
  ): never {
    const record = sourceForPath(records, path);
    return rejectSource(code, path, {
      ...(record && { source: record.source, name: record.name }),
      ...diagnostic,
    });
  }
  const redactions = new Set<string>();
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  function account(size: number, path: ConfigurationPath) {
    bytes += size;
    if (bytes > configurationBytes)
      reject("source_value_invalid", path, {
        expected: "bounded_value",
        observed: "oversized",
      });
  }
  function bounded(value: unknown, path: ConfigurationPath, depth: number) {
    if (++nodes > 65536 || depth > 32)
      reject("source_value_invalid", path, {
        expected: "bounded_value",
        observed: configurationValueType(value),
      });
  }
  function privateValue(
    value: unknown,
    path: ConfigurationPath,
    depth: number,
  ) {
    bounded(value, path, depth);
    if (typeof value === "string" && value) redactions.add(value);
    else if (value !== null && typeof value === "object")
      for (const item of Object.values(value))
        privateValue(item, path, depth + 1);
  }
  function visit(
    value: unknown,
    path: ConfigurationPath,
    depth: number,
    resolveReferences = true,
  ): unknown {
    bounded(value, path, depth);
    if (value === null || typeof value !== "object") {
      account(Buffer.byteLength(JSON.stringify(value)), path);
      return value;
    }
    if (ancestors.has(value))
      reject("source_value_invalid", path, {
        expected: "acyclic_value",
        observed: "cycle",
      });
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        account(2 + Math.max(0, value.length - 1), path);
        return value.map((item, index) =>
          visit(item, [...path, index], depth + 1, resolveReferences),
        );
      }
      const object = value as Record<string, unknown>;
      const keys = Object.keys(object);
      const selectors = ["from_variable", "from_secret"].filter((key) =>
        Object.hasOwn(object, key),
      );
      if (
        resolveReferences &&
        selectors.some((key) => typeof object[key] === "string")
      ) {
        const key = selectors[0],
          name = object[key];
        if (
          selectors.length !== 1 ||
          typeof name !== "string" ||
          !sourceName.test(name) ||
          keys.some(
            (key) => !["from_variable", "from_secret", "format"].includes(key),
          ) ||
          (Object.hasOwn(object, "format") && object.format !== "json")
        )
          reject("source_reference_invalid", path, {
            expected: "single_source_reference",
            observed: "object",
          });
        const source = key === "from_variable" ? "variable" : "secret";
        const record: SourceRecord = { source, name, path };
        const values =
          source === "variable" ? sources.variables : sources.secrets;
        if (!Object.hasOwn(values, name.toUpperCase()))
          reject("source_missing", path, {
            source,
            name,
            expected: "present_source",
            observed: "missing",
          });
        const text = values[name.toUpperCase()];
        let resolved: unknown = text;
        if (object.format === "json") {
          try {
            resolved = JSON.parse(text);
          } catch {
            reject("source_value_invalid", path, {
              source,
              name,
              expected: "json",
              observed: "text",
            });
          }
        }
        record.observed = configurationValueType(resolved);
        records.push(record);
        if (source === "secret") {
          if (text) redactions.add(text);
          privateValue(resolved, path, depth);
        }
        return visit(resolved, path, depth, false);
      }
      account(2 + Math.max(0, keys.length - 1), path);
      return Object.fromEntries(
        Object.entries(object).map(([key, item]) => {
          account(Buffer.byteLength(JSON.stringify(key)) + 1, path);
          return [
            key,
            visit(item, [...path, key], depth + 1, resolveReferences),
          ];
        }),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  const value = visit(input, [], 0);
  return { value, records, redactions: [...redactions] };
}
