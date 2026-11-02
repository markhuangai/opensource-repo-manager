import { LineCounter, parseDocument, stringify } from "yaml";
import { z } from "zod";
import { ConfigurationError, configurationSections } from "./errors.ts";
import { isContainedReference } from "./files.ts";

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

function parseSchema<T>(source: string, schema: z.ZodType<T>): T {
  if (Buffer.byteLength(source) > 1024 * 1024)
    throw new ConfigurationError("yaml_invalid");
  const lineCounter = new LineCounter();
  let input: unknown;
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
    input = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("yaml_invalid");
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.path[0];
    const section = configurationSections.find((section) => section === first);
    throw new ConfigurationError("schema_invalid", undefined, section);
  }
  return parsed.data;
}

function validateReferences(config: ActionsConfiguration) {
  if (
    new Set(config.pr_monitor.required_checks).size !==
      config.pr_monitor.required_checks.length ||
    new Set(
      config.pr_monitor.automated_reviewers.map((item) =>
        item.login.toLowerCase(),
      ),
    ).size !== config.pr_monitor.automated_reviewers.length ||
    (config.pr_monitor.local_checks_only &&
      (config.pr_monitor.requirements_source !== "operator" ||
        config.pr_monitor.required_checks.length > 0)) ||
    config.pr_monitor.automated_reviewers.some((item) =>
      item.signal === "codex"
        ? !/^chatgpt-codex-connector(?:\[bot\])?$/.test(item.login)
        : item.signal === "coderabbit" &&
          !/^coderabbitai(?:\[bot\])?$/.test(item.login),
    )
  )
    throw new ConfigurationError("schema_invalid", undefined, "pr_monitor");
  for (const phase of roleNames) {
    const settings = config.roles[phase];
    if (!Object.hasOwn(config.profiles, settings.profile))
      throw new ConfigurationError("reference_invalid");
  }
}

export function parseActionsConfiguration(
  source: string,
): ActionsConfiguration {
  const config = parseSchema(source, actionsConfigurationSchema);
  validateReferences(config);
  return config;
}

export function parseRepositoryActionsConfiguration(
  source: string,
  credentials: { repository: string; token: string; proxyKey: string },
): ActionsConfiguration {
  const input = parseSchema(
    source,
    actionsConfigurationSchema.omit({ github: true }).extend({
      proxy: actionsConfigurationSchema.shape.proxy.omit({ key: true }),
    }),
  );
  return parseActionsConfiguration(
    stringify({
      ...input,
      github: { repository: credentials.repository, token: credentials.token },
      proxy: { ...input.proxy, key: credentials.proxyKey },
    }),
  );
}
