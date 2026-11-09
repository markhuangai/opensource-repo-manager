import { createKnownSecretChecker } from "../logging/redact.ts";
import { ConfigurationError } from "./errors.ts";
import type { ActionsConfiguration } from "./schema.ts";

export function separateSecrets(
  config: ActionsConfiguration,
  sessionKey?: string,
  actionsRuntimeToken?: string,
) {
  const credentials = new Map<string, string>();
  const sensitive: string[] = [config.github.token, config.proxy.key];
  const put = (name: string, value: string) => credentials.set(name, value);
  put("github.token", config.github.token);
  put("proxy.key", config.proxy.key);
  if (actionsRuntimeToken !== undefined) {
    put("actions.runtime_token", actionsRuntimeToken);
    sensitive.push(actionsRuntimeToken);
  }
  if (sessionKey !== undefined) {
    put("actions.session_key", sessionKey);
    sensitive.push(
      sessionKey,
      Buffer.from(sessionKey, "base64").toString("hex"),
      Buffer.from(sessionKey, "base64").toString("base64url"),
    );
  }
  const checker = createKnownSecretChecker(sensitive);
  const diagnosticCredentials = createKnownSecretChecker(
    sensitive.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
  );
  const redactor = createKnownSecretChecker([
    ...sensitive,
    config.proxy.url,
    ...config.redaction_values,
  ]);
  const secrets = Object.freeze({
    ...checker,
    redact: redactor.redact,
    redactCredentials: diagnosticCredentials.redact,
    containsCredentials: checker.contains,
    createCredentialStream: checker.createStream,
    get(name: string) {
      const value = credentials.get(name);
      if (value === undefined)
        throw new ConfigurationError("reference_invalid");
      return value;
    },
  });
  const settings = {
    version: config.version,
    github: { repository: config.github.repository },
    pr_monitor: config.pr_monitor,
    proxy: { url: config.proxy.url },
    profiles: config.profiles,
    roles: config.roles,
    limits: config.limits,
  };
  if (checker.contains(settings))
    throw new ConfigurationError("secret_in_snapshot");
  return { settings, secrets };
}

export type SupervisorSettings = ReturnType<typeof separateSecrets>["settings"];
export type SecretAccessor = ReturnType<typeof separateSecrets>["secrets"];
