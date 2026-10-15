import { createKnownSecretChecker } from "../logging/redact.ts";
import { ConfigurationError } from "./errors.ts";
import type { Configuration } from "./schema.ts";

export function separateSecrets(config: Configuration) {
  const credentials = new Map<string, string>();
  const identifiers: string[] = [];
  const sensitive: string[] = [
    config.github.token,
    config.github.webhook_secret,
    config.proxy.key,
  ];
  const put = (name: string, value: string) => credentials.set(name, value);
  put("github.token", config.github.token);
  put("github.webhook_secret", config.github.webhook_secret);
  put("proxy.key", config.proxy.key);
  for (const [name, channel] of Object.entries(config.notifications)) {
    if (!channel.enabled) continue;
    for (const [field, value] of Object.entries(channel)) {
      if (field !== "enabled")
        put(
          `notifications.${name}.${field}`,
          typeof value === "string" ? value : JSON.stringify(value),
        );
      if (
        ["webhook_url", "url", "password"].includes(field) &&
        typeof value === "string"
      )
        sensitive.push(value);
      if (field === "username" && typeof value === "string")
        identifiers.push(value);
    }
  }
  for (const [name, credential] of Object.entries(config.mcp.credentials))
    for (const [header, value] of Object.entries(credential.headers)) {
      put(`mcp.${name}.${header}`, value);
      sensitive.push(value);
    }
  if (config.notifications.webhook.enabled)
    for (const [header, value] of Object.entries(
      config.notifications.webhook.headers,
    )) {
      put(`notifications.webhook.headers.${header}`, value);
      sensitive.push(value);
    }
  const checker = createKnownSecretChecker([...sensitive, ...identifiers]);
  const credentialChecker = createKnownSecretChecker(sensitive);
  const boundHeaders = new Map(
    Object.entries(config.mcp.credentials).map(([name, credential]) => [
      name,
      Object.freeze({ ...credential.headers }),
    ]),
  );
  const secrets = Object.freeze({
    ...checker,
    containsCredentials: credentialChecker.contains,
    createCredentialStream: credentialChecker.createStream,
    get(name: string) {
      const value = credentials.get(name);
      if (value === undefined)
        throw new ConfigurationError("reference_invalid");
      return value;
    },
    mcpHeaders(name: string): Readonly<Record<string, string>> {
      const headers = boundHeaders.get(name);
      if (!headers) throw new ConfigurationError("reference_invalid");
      return headers;
    },
  });
  const settings = {
    version: config.version,
    github: { repository: config.github.repository },
    proxy: { url: config.proxy.url },
    profiles: config.profiles,
    roles: config.roles,
    notifications: Object.fromEntries(
      Object.entries(config.notifications).map(([name, channel]) => [
        name,
        { enabled: channel.enabled },
      ]),
    ),
    limits: config.limits,
    mcp: {
      servers: config.mcp.servers,
      initialization_timeout_seconds: config.mcp.initialization_timeout_seconds,
      call_timeout_seconds: config.mcp.call_timeout_seconds,
      max_request_bytes: config.mcp.max_request_bytes,
      max_response_bytes: config.mcp.max_response_bytes,
      max_catalog_bytes: config.mcp.max_catalog_bytes,
    },
  };
  if (checker.contains(settings))
    throw new ConfigurationError("secret_in_snapshot");
  return { settings, secrets };
}

export type SupervisorSettings = ReturnType<typeof separateSecrets>["settings"];
export type SecretAccessor = ReturnType<typeof separateSecrets>["secrets"];
