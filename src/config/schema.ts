import { LineCounter, parseDocument } from "yaml";
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
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
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
    return ![...new URL(value).searchParams.keys()].some((key) =>
      /^(access[_-]?token|(?:x[_-]?)?api[_-]?key|authorization|auth|bearer|password|secret|token|key|(?:x[_-]?amz[_-]?)?signature)$/i.test(
        key,
      ),
    );
  } catch {
    return false;
  }
});
const headers = z.record(
  z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  secret.refine(
    (value) =>
      !value.includes("\r") && !value.includes("\n") && !value.includes("\0"),
  ),
);
const profile = z.discriminatedUnion("sdk", [
  z.strictObject({
    sdk: z.literal("claude"),
    model: text,
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
  mcp: z
    .record(name, z.strictObject({ tools: z.array(toolName).max(1024) }))
    .default({}),
});
const tool = z.discriminatedUnion("effect", [
  z.strictObject({ effect: z.literal("read") }),
  z.strictObject({
    effect: z.literal("reviewed_write"),
    idempotency_argument: text.optional(),
  }),
]);
const server = z.strictObject({
  transport: z.literal("streamable_http"),
  url: endpointUrl,
  allow_plain_http: z.boolean().default(false),
  credential_ref: name.optional(),
  tools: z.record(toolName, tool),
});
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const size = z
  .number()
  .int()
  .positive()
  .max(1024 * 1024);
const disabled = z.strictObject({ enabled: z.literal(false) });
const configurationSchema = z.strictObject({
  version: z.literal(1),
  github: z.strictObject({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/),
    token: secret,
    webhook_secret: secret,
  }),
  proxy: z.strictObject({ url: endpointUrl, key: secret }),
  profiles: z.record(name, profile),
  roles: z.strictObject({
    bootstrap: role,
    investigation: role,
    implementation: role,
    audit: role,
    output_review: role,
  }),
  notifications: z.strictObject({
    discord: z
      .discriminatedUnion("enabled", [
        disabled,
        z.strictObject({ enabled: z.literal(true), webhook_url: url }),
      ])
      .default({ enabled: false }),
    smtp: z
      .discriminatedUnion("enabled", [
        disabled,
        z.strictObject({
          enabled: z.literal(true),
          host: text,
          port: z.number().int().min(1).max(65535),
          secure: z.boolean(),
          username: secret,
          password: secret,
          from: z.email(),
          to: z.array(z.email()).min(1).max(64),
        }),
      ])
      .default({ enabled: false }),
    webhook: z
      .discriminatedUnion("enabled", [
        disabled,
        z.strictObject({
          enabled: z.literal(true),
          url,
          headers: headers.default({}),
        }),
      ])
      .default({ enabled: false }),
  }),
  limits: z
    .strictObject({
      active_slots: z.literal(1).default(1),
      active_minutes: positive.default(60),
      model_requests: positive.default(200),
      repair_cycles: count.default(3),
      infrastructure_retries: count.default(2),
      wait_hours: positive.default(24),
      reconciliation_minutes: positive.default(5),
    })
    .prefault({}),
  mcp: z
    .strictObject({
      credentials: z.record(name, z.strictObject({ headers })).default({}),
      servers: z.record(name, server).default({}),
      initialization_timeout_seconds: positive.default(30),
      call_timeout_seconds: positive.default(300),
      max_request_bytes: size.default(1024 * 1024),
      max_response_bytes: size.default(1024 * 1024),
      max_catalog_bytes: size.default(1024 * 1024),
    })
    .prefault({}),
});

export type Configuration = z.infer<typeof configurationSchema>;
export type ModelProfile = Configuration["profiles"][string];

export function parseConfiguration(source: string): Configuration {
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
  const parsed = configurationSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.path[0];
    const section = configurationSections.find((section) => section === first);
    throw new ConfigurationError("schema_invalid", undefined, section);
  }
  const config = parsed.data;
  if (!Object.values(config.notifications).some((channel) => channel.enabled))
    throw new ConfigurationError("schema_invalid");
  for (const entry of Object.values(config.mcp.servers)) {
    if (new URL(entry.url).protocol === "http:" && !entry.allow_plain_http)
      throw new ConfigurationError("schema_invalid");
    if (
      entry.credential_ref &&
      !Object.hasOwn(config.mcp.credentials, entry.credential_ref)
    )
      throw new ConfigurationError("reference_invalid");
  }
  for (const phase of roleNames) {
    const settings = config.roles[phase];
    if (!Object.hasOwn(config.profiles, settings.profile))
      throw new ConfigurationError("reference_invalid");
    for (const [alias, grant] of Object.entries(settings.mcp)) {
      if (!Object.hasOwn(config.mcp.servers, alias))
        throw new ConfigurationError("reference_invalid");
      if (phase === "output_review" && grant.tools.length)
        throw new ConfigurationError("schema_invalid");
      if (new Set(grant.tools).size !== grant.tools.length)
        throw new ConfigurationError("schema_invalid");
      for (const name of grant.tools)
        if (!Object.hasOwn(config.mcp.servers[alias].tools, name))
          throw new ConfigurationError("reference_invalid");
    }
  }
  return config;
}
