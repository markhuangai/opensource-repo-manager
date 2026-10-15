import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { relative } from "node:path";
import { TextDecoder } from "node:util";
import { ConfigurationError } from "./errors.ts";
import { checkPath, containedPath, readRegularFile } from "./files.ts";
import { roleNames, type Role } from "./schema.ts";
import type { SecretAccessor, SupervisorSettings } from "./secrets.ts";

export type BundleFile = Readonly<{
  path: string;
  content_base64: string;
  sha256: string;
}>;
export type RoleBundle = Readonly<{
  system: string;
  user: string;
  skills: readonly BundleFile[];
}>;
export type WorkflowBundles = Record<Role, RoleBundle>;

export function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}

export async function loadWorkflowBundles(
  settings: SupervisorSettings,
  secrets: SecretAccessor,
  roots = { prompts: "/prompts", skills: "/skills" },
): Promise<WorkflowBundles> {
  let totalBytes = 0;
  async function content(path: string) {
    const bytes = await readRegularFile(path);
    totalBytes += bytes.length;
    if (totalBytes > 16 * 1024 * 1024)
      throw new ConfigurationError("bundle_invalid");
    if (secrets.contains(bytes.toString("utf8")))
      throw new ConfigurationError("secret_in_snapshot");
    return bytes;
  }
  async function directory(path: string): Promise<BundleFile[]> {
    await checkPath(path, "bundle_invalid");
    const stat = await lstat(path);
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0)
      throw new ConfigurationError("bundle_invalid");
    const result: BundleFile[] = [];
    const children = await readdir(path, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const childPath = containedPath(path, child.name);
      if (child.isDirectory()) result.push(...(await directory(childPath)));
      else {
        const bytes = await content(childPath);
        result.push({
          path: relative(roots.skills, childPath),
          content_base64: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
    return result;
  }
  try {
    const bundles = {} as WorkflowBundles;
    for (const role of roleNames) {
      const config = settings.roles[role];
      const decoder = new TextDecoder("utf8", { fatal: true });
      const system = decoder.decode(
        await content(containedPath(roots.prompts, config.prompts.system)),
      );
      const user = decoder.decode(
        await content(containedPath(roots.prompts, config.prompts.user)),
      );
      const files = new Map<string, BundleFile>();
      for (const reference of config.skills) {
        const selected = await directory(
          containedPath(roots.skills, reference),
        );
        if (!selected.some((file) => file.path === `${reference}/SKILL.md`))
          throw new ConfigurationError("bundle_invalid");
        for (const file of selected) files.set(file.path, file);
      }
      const skills = [...files.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      if (!skills.some((file) => file.path.endsWith("/SKILL.md")))
        throw new ConfigurationError("bundle_invalid");
      bundles[role] = { system, user, skills };
    }
    if (secrets.contains(bundles))
      throw new ConfigurationError("secret_in_snapshot");
    return immutable(bundles);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("bundle_invalid");
  }
}
