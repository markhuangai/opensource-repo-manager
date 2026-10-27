import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  immutable,
  loadWorkflowBundles,
  type WorkflowBundles,
} from "./bundles.ts";
import { ConfigurationError } from "./errors.ts";
import { readRegularFile } from "./files.ts";
import {
  parseActionsConfiguration,
  parseConfiguration,
  roleNames,
  type Role,
} from "./schema.ts";
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
        mcp: Object.fromEntries(
          Object.entries(settings.roles[role].mcp).map(([alias, grant]) => [
            alias,
            {
              tools: Object.fromEntries(
                grant.tools.map((name) => [
                  name,
                  settings.mcp.servers[alias].tools[name],
                ]),
              ),
            },
          ]),
        ),
      },
    ]),
  ) as Record<
    Role,
    {
      profile: SupervisorSettings["profiles"][string];
      bundle: WorkflowBundles[Role];
      mcp: Record<
        string,
        { tools: SupervisorSettings["mcp"]["servers"][string]["tools"] }
      >;
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

async function loadConfiguration(
  path: string,
  parse: typeof parseConfiguration | typeof parseActionsConfiguration,
) {
  const bytes = await readRegularFile(path, true);
  let source: string;
  try {
    source = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigurationError("yaml_invalid");
  }
  const { settings, secrets } = separateSecrets(parse(source));
  const bundles = await loadWorkflowBundles(settings, secrets);
  return Object.freeze({
    snapshot: createRunSnapshot(settings, bundles, secrets),
    secrets,
  });
}

export function loadProtectedConfiguration(path = "/config/config.yml") {
  return loadConfiguration(path, parseConfiguration);
}

export function loadProtectedActionsConfiguration(
  path = "/config/actions.yml",
) {
  return loadConfiguration(path, parseActionsConfiguration);
}
