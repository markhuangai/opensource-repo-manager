import { LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import { ConfigurationError, configurationSections } from "./errors.ts";
import { isContainedReference } from "./files.ts";
import {
  configurationBytes,
  configurationValueType,
  resolveConfigurationSources,
  sourceContextBytes,
  sourceForPath,
  type ConfigurationPath,
  type ConfigurationSources,
} from "./sources.ts";
import type {
  ConfigurationDiagnostic,
  ConfigurationErrorCode,
} from "./errors.ts";

export const roleNames = [
  "bootstrap",
  "investigation",
  "implementation",
  "audit",
  "output_review",
] as const;
export type Role = (typeof roleNames)[number];

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const text = z.string().min(1).max(4096);
const secret = z.string().min(1).max(16384);
const relativePath = z.string().min(1).max(4096).refine(isContainedReference);
const url = text.refine((value) => {
  try {
    const parsed = new URL(value);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  } catch {
    return false;
  }
});
const endpointUrl = url.refine((value) => {
  try {
    return new URL(value).search === "";
  } catch {
    return false;
  }
});
const profile = z.discriminatedUnion("sdk", [
  z.strictObject({
    sdk: z.literal("claude"),
    model: text,
    behaves_as: text.optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  }),
  z.strictObject({
    sdk: z.literal("codex"),
    model: text,
    effort: z.enum([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "persistent",
    ]),
  }),
]);
const role = z.strictObject({
  profile: name,
  prompts: z.strictObject({ system: relativePath, user: relativePath }),
  skills: z.array(relativePath).min(1).max(64),
});
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const prMonitorPolicy = z
  .strictObject({
    enabled: z.boolean().default(true),
    requirements_source: z.enum(["github", "operator"]).default("github"),
    required_checks: z.array(text).max(256).default([]),
    automated_reviewers: z
      .array(
        z.strictObject({
          login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/),
          signal: z.enum(["github_review", "codex", "coderabbit"]),
        }),
      )
      .max(64)
      .default([]),
    local_checks_only: z.boolean().default(false),
  })
  .prefault({});
const actionsConfigurationSchema = z.strictObject({
  version: z.literal(1),
  github: z.strictObject({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/),
    token: secret,
  }),
  pr_monitor: prMonitorPolicy,
  proxy: z.strictObject({ url: endpointUrl, key: secret }),
  redaction_values: z
    .array(z.string().min(1).max(sourceContextBytes))
    .max(65536)
    .default([]),
  profiles: z.record(name, profile),
  roles: z.strictObject({
    bootstrap: role,
    investigation: role,
    implementation: role,
    audit: role,
    output_review: role,
  }),
  limits: z
    .strictObject({
      active_slots: z.literal(1).default(1),
      active_minutes: positive.default(60),
      model_requests: positive.default(200),
      repair_cycles: count.default(3),
      infrastructure_retries: count.default(2),
      wait_hours: positive.default(24),
      worker_processes: positive.default(128),
      worker_output_bytes: positive.default(16 * 1024 * 1024),
      worker_storage_bytes: positive.default(4 * 1024 * 1024 * 1024),
    })
    .prefault({}),
});

export type ActionsConfiguration = z.infer<typeof actionsConfigurationSchema>;
export type ModelProfile = ActionsConfiguration["profiles"][string];

function parseYaml(source: string) {
  if (Buffer.byteLength(source) > configurationBytes)
    throw new ConfigurationError("yaml_invalid");
  const lineCounter = new LineCounter();
  try {
    const document = parseDocument(source, {
      logLevel: "error",
      prettyErrors: false,
      uniqueKeys: true,
      strict: true,
      lineCounter,
    });
    if (document.errors.length || document.warnings.length) {
      const position = (document.errors[0] ?? document.warnings[0]).pos[0];
      const { line, col } = lineCounter.linePos(position);
      throw new ConfigurationError("yaml_invalid", { line, column: col });
    }
    return {
      input: document.toJS({ maxAliasCount: 100 }) as unknown,
      document,
      lineCounter,
    };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("yaml_invalid");
  }
}

type DiagnosticLookup = (path: ConfigurationPath) => {
  location?: { line: number; column: number };
  diagnostic?: ConfigurationDiagnostic;
};

function rejectConfiguration(
  code: ConfigurationErrorCode,
  path: ConfigurationPath,
  expected: string,
  observed: string,
  diagnostic?: DiagnosticLookup,
): never {
  const detail = diagnostic?.(path);
  throw new ConfigurationError(
    code,
    detail?.location,
    configurationSections.find((section) => section === path[0]),
    { ...detail?.diagnostic, expected, observed },
  );
}

function parseData<T>(
  input: unknown,
  schema: z.ZodType<T>,
  diagnostic?: DiagnosticLookup,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.filter(
      (part): part is string | number => typeof part !== "symbol",
    );
    let observed = input;
    for (const part of path)
      observed =
        observed !== null &&
        typeof observed === "object" &&
        Object.hasOwn(observed, part)
          ? (observed as Record<string | number, unknown>)[part]
          : undefined;
    rejectConfiguration(
      "schema_invalid",
      path,
      issue.code === "invalid_type" ? issue.expected : issue.code,
      configurationValueType(observed),
      diagnostic,
    );
  }
  return parsed.data;
}

function validateReferences(
  config: ActionsConfiguration,
  diagnostic?: DiagnosticLookup,
) {
  function invalid(
    code: ConfigurationErrorCode,
    paths: ConfigurationPath[],
    expected: string,
    observed: string,
  ): never {
    const path =
      paths.find((path) => diagnostic?.(path).diagnostic?.source) ?? paths[0];
    return rejectConfiguration(code, path, expected, observed, diagnostic);
  }
  const policy = config.pr_monitor;
  function duplicateIndices(values: readonly string[]) {
    const seen = new Map<string, number>();
    for (const [index, value] of values.entries()) {
      const previous = seen.get(value);
      if (previous !== undefined) return [index, previous];
      seen.set(value, index);
    }
    return undefined;
  }
  const checks = duplicateIndices(policy.required_checks);
  if (checks)
    invalid(
      "schema_invalid",
      checks.map((index) => ["pr_monitor", "required_checks", index]),
      "unique_check_names",
      "duplicate_check_names",
    );
  const reviewers = duplicateIndices(
    policy.automated_reviewers.map((item) => item.login.toLowerCase()),
  );
  if (reviewers)
    invalid(
      "schema_invalid",
      reviewers.map((index) => [
        "pr_monitor",
        "automated_reviewers",
        index,
        "login",
      ]),
      "unique_reviewers",
      "duplicate_reviewers",
    );
  if (
    policy.local_checks_only &&
    (policy.requirements_source !== "operator" ||
      policy.required_checks.length > 0)
  )
    invalid(
      "schema_invalid",
      [
        ["pr_monitor", "local_checks_only"],
        ["pr_monitor", "requirements_source"],
        ...policy.required_checks.map((_, index) => [
          "pr_monitor",
          "required_checks",
          index,
        ]),
      ],
      "operator_policy_without_remote_checks",
      "incompatible_policy",
    );
  for (const [index, reviewer] of policy.automated_reviewers.entries()) {
    if (
      reviewer.signal === "codex"
        ? !/^chatgpt-codex-connector(?:\[bot\])?$/.test(reviewer.login)
        : reviewer.signal === "coderabbit" &&
          !/^coderabbitai(?:\[bot\])?$/.test(reviewer.login)
    )
      invalid(
        "schema_invalid",
        [
          ["pr_monitor", "automated_reviewers", index, "login"],
          ["pr_monitor", "automated_reviewers", index, "signal"],
        ],
        "supported_reviewer_login",
        "mismatched_reviewer_signal",
      );
  }
  for (const phase of roleNames)
    if (!Object.hasOwn(config.profiles, config.roles[phase].profile))
      invalid(
        "reference_invalid",
        [["roles", phase, "profile"]],
        "existing_profile",
        "unknown_profile",
      );
}

export function parseActionsConfiguration(
  source: string,
): ActionsConfiguration {
  const config = parseData(parseYaml(source).input, actionsConfigurationSchema);
  validateReferences(config);
  return config;
}

export function parseRepositoryActionsConfiguration(
  source: string,
  repository: string,
  sources: ConfigurationSources,
) {
  const yaml = parseYaml(source);
  function location(path: ConfigurationPath) {
    for (let length = path.length; length >= 0; length--) {
      const node = yaml.document.getIn(path.slice(0, length), true) as
        { range?: number[] } | undefined;
      if (node?.range) {
        const position = yaml.lineCounter.linePos(node.range[0]);
        return { line: position.line, column: position.col };
      }
    }
    return undefined;
  }
  const resolved = resolveConfigurationSources(
    yaml.input,
    sources,
    (code, path, diagnostic) => {
      throw new ConfigurationError(
        code,
        location(path),
        configurationSections.find((section) => section === path[0]),
        diagnostic,
      );
    },
  );
  const diagnostic: DiagnosticLookup = (path) => {
    const record = sourceForPath(resolved.records, path);
    return {
      location: location(path),
      diagnostic: record && { source: record.source, name: record.name },
    };
  };
  for (const path of [["github", "token"], ["proxy", "key"], ["session_key"]])
    if (sourceForPath(resolved.records, path)?.source !== "secret")
      rejectConfiguration(
        "source_reference_invalid",
        path,
        "secret_reference",
        "non_secret_source",
        diagnostic,
      );
  const input = parseData(
    resolved.value,
    actionsConfigurationSchema
      .omit({ github: true, redaction_values: true })
      .extend({
        github: z.strictObject({ token: secret }),
        session_key: secret.refine(
          (value) =>
            /^[A-Za-z0-9+/]{43}=$/.test(value) &&
            Buffer.from(value, "base64").toString("base64") === value,
        ),
      }),
    diagnostic,
  );
  const { session_key, github, ...settings } = input;
  const configuration = parseData(
    {
      ...settings,
      github: { repository, token: github.token },
      redaction_values: resolved.redactions,
    },
    actionsConfigurationSchema,
    diagnostic,
  );
  validateReferences(configuration, diagnostic);
  return {
    configuration,
    sessionKey: session_key,
    sources: resolved.records.map((record) => ({
      ...location(record.path),
      section: configurationSections.find(
        (section) => section === record.path[0],
      ),
      source: record.source,
      name: record.name,
      observed: record.observed,
    })),
  };
}
