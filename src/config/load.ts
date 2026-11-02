import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  immutable,
  loadWorkflowBundles,
  type WorkflowBundles,
} from "./bundles.ts";
import { ConfigurationError } from "./errors.ts";
import { readRegularFile } from "./files.ts";
import { captureActionsContext } from "../actions/context.ts";
import { parseActionsConfiguration, roleNames, type Role } from "./schema.ts";
import {
  separateSecrets,
  type SecretAccessor,
  type SupervisorSettings,
} from "./secrets.ts";

export function createRunSnapshot(
  settings: SupervisorSettings,
  bundles: WorkflowBundles,
  secrets: SecretAccessor,
) {
  const roles = Object.fromEntries(
    roleNames.map((role) => [
      role,
      {
        profile: settings.profiles[settings.roles[role].profile],
        bundle: bundles[role],
      },
    ]),
  ) as Record<
    Role,
    {
      profile: SupervisorSettings["profiles"][string];
      bundle: WorkflowBundles[Role];
    }
  >;
  const snapshot = structuredClone({ version: 1 as const, settings, roles });
  if (secrets.contains(snapshot))
    throw new ConfigurationError("secret_in_snapshot");
  const digest = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  return immutable({ ...snapshot, digest });
}

export type RunSnapshot = ReturnType<typeof createRunSnapshot>;

export async function loadProtectedConfiguration(
  path = "/config/actions.yml",
  sessionKey?: string,
  runtimeToken?: string,
) {
  const bytes = await readRegularFile(path, true);
  let source: string;
  try {
    source = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigurationError("yaml_invalid");
  }
  const { settings, secrets } = separateSecrets(
    parseActionsConfiguration(source),
    sessionKey,
    runtimeToken,
  );
  const bundles = await loadWorkflowBundles(settings, secrets);
  return Object.freeze({
    snapshot: createRunSnapshot(settings, bundles, secrets),
    secrets,
  });
}

export function loadProtectedActionsConfiguration(
  path = "/config/actions.yml",
) {
  const key = process.env.ORM_SESSION_KEY;
  if (
    !key ||
    !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
    Buffer.from(key, "base64").length !== 32 ||
    Buffer.from(key, "base64").toString("base64") !== key
  )
    throw new ConfigurationError("session_key_invalid");
  delete process.env.ORM_SESSION_KEY;
  const { context, token } = captureActionsContext();
  return loadProtectedConfiguration(path, key, token).then((loaded) => {
    if (
      loaded.snapshot.settings.github.repository.toLowerCase() !==
      context.repository.toLowerCase()
    )
      throw new ConfigurationError("actions_context_invalid");
    return { ...loaded, actions: context };
  });
}
