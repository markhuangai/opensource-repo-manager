import { cp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import type { GitHubActionsSource } from "../adapters/github/actions-source.ts";
import { parseRepositoryActionsConfiguration } from "../config/schema.ts";
import { containedPath } from "../config/files.ts";
import { ConfigurationError } from "../config/errors.ts";
import { rootDirectory } from "../services/workspaces/files.ts";
import { StateError } from "./state.ts";
import {
  configurationBytes,
  type ConfigurationSources,
} from "../config/sources.ts";

type ConfigurationSource = Pick<
  GitHubActionsSource,
  "repository" | "files" | "blob"
>;

export async function readActionsConfiguration(
  source: ConfigurationSource,
  repositoryName: string,
  sources: ConfigurationSources,
  signal: AbortSignal,
) {
  const repository = await source.repository(signal);
  if (repository.full_name.toLowerCase() !== repositoryName.toLowerCase())
    throw new StateError("state_invalid");
  const pinned = await source.files(repository, signal);
  for (const file of pinned.files) {
    if (
      [".github/orm", ".github/orm/prompts", ".github/orm/skills"].includes(
        file.path,
      ) &&
      (file.type !== "tree" || file.mode !== "040000")
    )
      throw new ConfigurationError("bundle_invalid");
  }
  const file = pinned.files.find((file) => file.path === ".github/orm.yml");
  if (!file) throw new ConfigurationError("config_unreadable");
  try {
    const bytes = await source.blob(file, signal);
    let content: string;
    try {
      content = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    } catch {
      throw new ConfigurationError("yaml_invalid");
    }
    return {
      ...parseRepositoryActionsConfiguration(content, repositoryName, sources),
      repository,
      pinned,
    };
  } catch (error) {
    if (error instanceof ConfigurationError)
      error.diagnostic.source_sha = pinned.source.sha;
    throw error;
  }
}

export async function prepareActionsConfiguration(
  source: Pick<GitHubActionsSource, "repository" | "files" | "blob">,
  loaded: Awaited<ReturnType<typeof readActionsConfiguration>>,
  signal: AbortSignal,
  roots = {
    config: "/config",
    prompts: "/prompts",
    skills: "/skills",
    defaults: "/opt/orm/defaults",
  },
) {
  const { configuration: config, pinned } = loaded;
  for (const name of ["prompts", "skills"] as const) {
    await rootDirectory(roots[name], 0o755);
    await cp(join(roots.defaults, name), roots[name], { recursive: true });
  }
  let bytes = 0;
  for (const name of ["prompts", "skills"] as const) {
    const prefix = `.github/orm/${name}/`;
    for (const file of pinned.files.filter(
      (file) => file.path.startsWith(prefix) && file.type !== "tree",
    )) {
      signal.throwIfAborted();
      const path = containedPath(roots[name], file.path.slice(prefix.length));
      if (file.size === undefined || (bytes += file.size) > 16 * 1024 * 1024)
        throw new ConfigurationError("bundle_invalid");
      const content = await source.blob(file, signal);
      await rootDirectory(dirname(path), 0o755);
      await writeFile(path, content, { mode: 0o644 });
    }
  }
  const runtime = {
    version: config.version,
    github: config.github,
    proxy: config.proxy,
    profiles: config.profiles,
    redaction_values: config.redaction_values,
    pr_monitor: config.pr_monitor,
    limits: config.limits,
    roles: Object.fromEntries(
      Object.entries(config.roles).map(([name, role]) => [
        name,
        {
          profile: role.profile,
          prompts: role.prompts,
          skills: role.skills,
        },
      ]),
    ),
  };
  const content = stringify(runtime);
  if (Buffer.byteLength(content) > configurationBytes)
    throw new ConfigurationError("source_value_invalid", undefined, undefined, {
      expected: "bounded_value",
      observed: "oversized",
    });
  await rootDirectory(roots.config);
  await writeFile(join(roots.config, "actions.yml"), content, {
    flag: "wx",
    mode: 0o600,
  });
  return { source_sha: pinned.source.sha };
}
