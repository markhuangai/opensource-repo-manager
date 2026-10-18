import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { parse as toml } from "smol-toml";
import { parseAllDocuments } from "yaml";
import { RuntimeError } from "../../domain/agents.ts";
import { isContainedReference } from "../../config/files.ts";
import { walkTree } from "../workspaces/files.ts";
import type { BootstrapPlan, Inspection } from "./contracts.ts";

const relevant =
  /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.npmrc|\.yarnrc(?:\.yml)?|go\.(?:mod|sum|work)|vendor\/modules\.txt|pyproject\.toml|poetry\.(?:lock|toml)|uv\.(?:lock|toml)|pip\.conf|requirements[^/]*\.txt|\.python-version|\.node-version|\.nvmrc|\.tool-versions|mise(?:\.[^/]+)?\.toml|AGENTS\.md|CLAUDE\.md)$/;
const registries = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
]);

function publicUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeError("dependency_source_invalid");
  }
  if (url.username || url.password)
    throw new RuntimeError("private_dependency_required");
  if (url.protocol !== "https:" || !registries.has(url.hostname) || url.port)
    throw new RuntimeError("dependency_source_unsupported");
}

function inspectSettings(value: unknown, key = "", credentials = false) {
  if (Array.isArray(value)) {
    for (const item of value) inspectSettings(item, key, credentials);
    return;
  }
  if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value))
      inspectSettings(item, name, credentials);
    return;
  }
  if (typeof value !== "string") return;
  if (
    credentials &&
    /^(?:npmAuthToken|npmAuthIdent|_authToken|_auth|password|username|credentials?)$/i.test(
      key,
    ) &&
    value
  )
    throw new RuntimeError("private_dependency_required");
  if (
    /^(?:resolved|tarball|registry|npmRegistryServer|npmPublishRegistry|index-url|extra-index-url|url|server)$/i.test(
      key,
    ) &&
    /^https?:/.test(value)
  )
    publicUrl(value);
  if (
    /^(?:useNodeVersion|use-node-version|nodeVersion|node-version)$/i.test(key)
  )
    throw new RuntimeError("toolchain_override_unsupported");
  if (
    /^(?:git\+|git:|ssh:|git@)|https?:\/\/[^/]*@|\s@\s*(?:https?:|git\+)|\$\{/.test(
      value,
    ) ||
    key === "git"
  )
    throw new RuntimeError("dependency_source_unsupported");
}

function contents(path: string, text: string, requirements = false) {
  if (requirements) return contents("requirements.txt", text);
  if (path.startsWith(".github/workflows/")) return text;
  const name = basename(path);
  try {
    if (name.endsWith(".json")) {
      const value = JSON.parse(text);
      if (name === "package.json") {
        for (const field of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "overrides",
          "resolutions",
        ]) {
          inspectSettings(value[field]);
          for (const request of Object.values(value[field] ?? {})) {
            if (typeof request !== "string") continue;
            if (/^https?:/.test(request)) publicUrl(request);
            if (
              /^(?:file:|link:)/.test(request) &&
              !isContainedReference(request.replace(/^(?:file:|link:)/, ""))
            )
              throw new RuntimeError("dependency_source_unsupported");
          }
        }
      } else inspectSettings(value);
      return value;
    }
    if (name.endsWith(".toml") || ["uv.lock", "poetry.lock"].includes(name)) {
      const value = toml(text);
      if (!name.startsWith("mise"))
        inspectSettings(value, "", name === "poetry.toml");
      return value;
    }
    if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      const parsed = parseAllDocuments(text, { uniqueKeys: true });
      if (
        parsed.some((document) => document.errors.length) ||
        (name !== "pnpm-lock.yaml" && parsed.length !== 1)
      )
        throw new Error("yaml_invalid");
      const values = parsed.map((document) =>
        document.toJS({ maxAliasCount: 100 }),
      );
      for (const value of values)
        inspectSettings(value, "", name !== "pnpm-lock.yaml");
      return values;
    }
    if (/npmrc|yarnrc|pip\.conf/.test(name)) {
      if (/(?:_auth|password|username|token|credential)\s*[:=]/i.test(text))
        throw new RuntimeError("private_dependency_required");
      for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/g))
        publicUrl(match[0]);
      if (/use-node-version\s*[:=]/i.test(text))
        throw new RuntimeError("toolchain_override_unsupported");
    }
    if (name === "yarn.lock") {
      for (const match of text.matchAll(/https?:\/\/[^\s"']+/g))
        publicUrl(match[0]);
      if (/(?:git\+|git@|ssh:)/.test(text))
        throw new RuntimeError("dependency_source_unsupported");
    }
    if (requirements || /^requirements.*\.txt$/.test(name)) {
      for (const line of text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))) {
        if (line === "\\" || line.startsWith("--hash=")) continue;
        if (
          /^-r\s+\S+$/.test(line) &&
          isContainedReference(line.replace(/^-r\s+/, ""))
        )
          continue;
        if (
          !/^[a-zA-Z0-9_.-]+(?:\[[a-zA-Z0-9_,.-]+\])?==[a-zA-Z0-9_.+!-]+(?:\s|;|$)/.test(
            line,
          )
        )
          throw new RuntimeError("dependency_pins_required");
        if (/https?:|git\+|\$\{/.test(line))
          throw new RuntimeError("dependency_source_unsupported");
      }
    }
    return text;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError("dependency_manifest_invalid");
  }
}

export async function inspectWorkspace(
  workspace: string,
  limit: number,
  signal: AbortSignal,
  plan?: BootstrapPlan,
  original?: readonly string[],
): Promise<Inspection> {
  const fingerprints: Record<string, string> = {},
    source_files: string[] = [];
  const files = new Map<string, unknown>();
  let bytes = 0;
  const input = async (
    path: string,
    ref: string,
    stat: Stats,
    pins = false,
  ) => {
    if (!stat.isFile() || stat.nlink !== 1)
      throw new RuntimeError("dependency_manifest_invalid");
    bytes += stat.size;
    if (bytes > Math.min(limit, 64 * 1024 * 1024))
      throw new RuntimeError("storage_limit");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const actual = await handle.stat();
      if (
        !actual.isFile() ||
        actual.ino !== stat.ino ||
        actual.dev !== stat.dev ||
        actual.nlink !== 1
      )
        throw new RuntimeError("dependency_manifest_invalid");
      const data = await handle.readFile();
      fingerprints[ref] = createHash("sha256").update(data).digest("hex");
      files.set(
        ref,
        contents(
          ref,
          new TextDecoder("utf8", { fatal: true }).decode(data),
          pins,
        ),
      );
    } finally {
      await handle.close();
    }
  };
  await walkTree(workspace, async (path, ref, stat) => {
    signal.throwIfAborted();
    if (ref.split("/").includes(".git")) return false;
    if (!isContainedReference(ref))
      throw new RuntimeError("dependency_manifest_invalid");
    if (stat.isDirectory()) return;
    source_files.push(ref);
    if (
      original &&
      !original.includes(ref) &&
      (ref.split("/").includes("node_modules") || ref.includes(".yarn/cache/"))
    )
      return;
    if (relevant.test(basename(ref)) || ref.startsWith(".github/workflows/"))
      await input(path, ref, stat);
  });
  const visited = new Set<string>();
  const requirements = async (ref: string, parents: Set<string>) => {
    signal.throwIfAborted();
    if (
      !isContainedReference(ref) ||
      ref.split("/").includes(".git") ||
      parents.has(ref)
    )
      throw new RuntimeError("dependency_manifest_invalid");
    if (visited.has(ref)) return;
    if (visited.size >= 256)
      throw new RuntimeError("dependency_manifest_invalid");
    visited.add(ref);
    let directory = await open(
      workspace,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const parts = ref.split("/");
      for (const part of parts.slice(0, -1)) {
        const child = await open(
          `/proc/self/fd/${directory.fd}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        await directory.close();
        directory = child;
      }
      const path = `/proc/self/fd/${directory.fd}/${parts.at(-1)}`;
      const { lstat } = await import("node:fs/promises");
      await input(path, ref, await lstat(path), true);
    } finally {
      await directory.close();
    }
    const next = new Set([...parents, ref]);
    for (const line of String(files.get(ref)).split(/\r?\n/)) {
      const include = /^\s*-r\s+(\S+)\s*$/.exec(line)?.[1];
      if (include) {
        const child =
          dirname(ref) === "." ? include : `${dirname(ref)}/${include}`;
        await requirements(child, next);
      }
    }
  };
  for (const path of [...files.keys()])
    if (/^requirements.*\.txt$/.test(basename(path)))
      await requirements(path, new Set());
  for (const [path, value] of files) {
    const prefix = dirname(path) === "." ? "" : dirname(path) + "/";
    if (
      basename(path) === "go.mod" &&
      /(?:^|\n)\s*require\s/.test(String(value)) &&
      !files.has(prefix + "go.sum")
    )
      throw new RuntimeError("dependency_lock_required");
    if (basename(path) === "pyproject.toml") {
      const pyproject = value as {
        project?: { dependencies?: unknown[] };
        tool?: { poetry?: { dependencies?: Record<string, unknown> } };
      };
      const hasDependencies = Boolean(
        pyproject.project?.dependencies?.length ||
        Object.keys(pyproject.tool?.poetry?.dependencies ?? {}).some(
          (name) => name !== "python",
        ),
      );
      if (
        hasDependencies &&
        !["poetry.lock", "uv.lock", "requirements.txt"].some((lock) =>
          files.has(prefix + lock),
        )
      )
        throw new RuntimeError("dependency_lock_required");
      if (
        plan &&
        hasDependencies &&
        !plan.package_managers.some(
          (manager) =>
            manager.cwd === (prefix ? prefix.slice(0, -1) : ".") &&
            ["pip", "poetry", "uv"].includes(manager.name),
        )
      )
        throw new RuntimeError("dependency_manager_required");
    }
    if (basename(path) !== "package.json") continue;
    const pkg = value as Record<string, unknown>;
    const hasDependencies = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ].some((field) => Object.keys((pkg[field] ?? {}) as object).length);
    if (
      hasDependencies &&
      ![
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
      ].some((lock) => files.has(prefix + lock))
    )
      throw new RuntimeError("dependency_lock_required");
    if (
      plan &&
      hasDependencies &&
      !plan.package_managers.some(
        (manager) =>
          manager.cwd === (prefix ? prefix.slice(0, -1) : ".") &&
          ["npm", "pnpm", "yarn"].includes(manager.name),
      )
    )
      throw new RuntimeError("dependency_manager_required");
  }
  if (plan) {
    for (const manager of plan.package_managers) {
      const prefix = manager.cwd === "." ? "" : manager.cwd + "/";
      const required = {
        npm: ["package-lock.json", "npm-shrinkwrap.json"],
        pnpm: ["pnpm-lock.yaml"],
        yarn: ["yarn.lock"],
        pip: ["requirements.txt"],
        poetry: ["poetry.lock"],
        uv: ["uv.lock"],
      }[manager.name];
      if (!required.some((file) => files.has(prefix + file)))
        throw new RuntimeError("dependency_lock_required");
      const pkg = files.get(prefix + "package.json") as
        Record<string, unknown> | undefined;
      if (
        pkg?.packageManager &&
        pkg.packageManager !== `${manager.name}@${manager.version}`
      )
        throw new RuntimeError("dependency_manager_mismatch");
    }
  }
  return { fingerprints, source_files };
}
