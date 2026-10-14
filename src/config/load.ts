import { createHash } from "node:crypto";
import {
  immutable,
  loadWorkflowBundles,
  type WorkflowBundles,
} from "./bundles.ts";
import { ConfigurationError } from "./errors.ts";
import { readRegularFile } from "./files.ts";
import { parseConfiguration, roleNames, type Role } from "./schema.ts";
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

export async function loadProtectedConfiguration(path = "/config/config.yml") {
  const source = (await readRegularFile(path, true)).toString("utf8");
  const { settings, secrets } = separateSecrets(parseConfiguration(source));
  const bundles = await loadWorkflowBundles(settings, secrets);
  return Object.freeze({
    snapshot: createRunSnapshot(settings, bundles, secrets),
    secrets,
  });
}
