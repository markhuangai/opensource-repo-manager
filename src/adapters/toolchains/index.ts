import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SecretAccessor } from "../../config/secrets.ts";
import { digest, RuntimeError } from "../../domain/agents.ts";
import { cleanEnvironment, trustedExecutable } from "../../runtime/process.ts";
import {
  rootDirectory,
  treeBytes,
  walkTree,
} from "../../services/workspaces/files.ts";
import type {
  BootstrapPlan,
  CommandReceipt,
  InstalledTool,
  ToolEnvironment,
} from "../../services/bootstrap/contracts.ts";
import { bootstrapPlanSchema } from "../../services/bootstrap/contracts.ts";
import { runCommand } from "./process.ts";

type Execute = (
  command: string,
  argv: string[],
  mutates?: boolean,
) => Promise<{ stdout: string; stderr: string }>;
type Limits = { output: number; storage: number };

export const miseVersion = "2026.10.9";
const executable = "/opt/orm-runtime/bin/mise";
export class Toolchains {
  readonly privateRoot: string;
  readonly installs: string;
  private readonly secrets: SecretAccessor;
  constructor(root: string, privateRoot: string, secrets: SecretAccessor) {
    this.secrets = secrets;
    this.installs = join(root, "toolchains");
    this.privateRoot = join(privateRoot, "toolchains");
  }
  async initialize() {
    await rootDirectory(this.installs, 0o755);
    await rootDirectory(this.privateRoot);
    for (const name of [
      "home",
      "config",
      "cache",
      "data",
      "state",
      "system",
      "tmp",
      "receipts",
    ])
      await rootDirectory(join(this.privateRoot, name));
    await writeFile(join(this.privateRoot, "empty"), "", { mode: 0o600 });
    await writeFile(join(this.privateRoot, "config", "config.toml"), "", {
      mode: 0o600,
    });
    await writeFile(join(this.privateRoot, "system", "config.toml"), "", {
      mode: 0o600,
    });
  }

  private environment(): NodeJS.ProcessEnv {
    const root = this.privateRoot;
    return {
      ...cleanEnvironment(join(root, "home"), join(root, "tmp"), "root"),
      PATH: "/opt/orm-runtime/bin:/usr/bin:/bin",
      DEBIAN_FRONTEND: "noninteractive",
      MISE_CONFIG_DIR: join(root, "config"),
      MISE_SYSTEM_CONFIG_DIR: join(root, "system"),
      MISE_GLOBAL_CONFIG_FILE: join(root, "config", "config.toml"),
      MISE_SYSTEM_CONFIG_FILE: join(root, "system", "config.toml"),
      MISE_CACHE_DIR: join(root, "cache"),
      MISE_DATA_DIR: join(root, "data"),
      MISE_STATE_DIR: join(root, "state"),
      MISE_INSTALLS_DIR: this.installs,
      MISE_SAFE: "1",
      MISE_LOG_LEVEL: "info",
      MISE_ALWAYS_KEEP_DOWNLOAD: "1",
      MISE_NO_HOOKS: "1",
      MISE_YES: "1",
      MISE_DISABLE_DEFAULT_REGISTRY: "1",
      MISE_ENABLE_TOOLS: "go,node,python",
      MISE_DISABLE_BACKENDS: "asdf,vfox,npm,pypi,cargo,go,github,aqua,http,ubi",
      MISE_NODE_COMPILE: "0",
      MISE_PYTHON_COMPILE: "0",
      MISE_NODE_COREPACK: "0",
      MISE_NODE_NPM_SHIM: "0",
      MISE_NODE_VERIFY: "1",
      MISE_NODE_GPG_VERIFY: "1",
      MISE_GO_SKIP_CHECKSUM: "0",
      MISE_PYTHON_GITHUB_ATTESTATIONS: "1",
      MISE_LOCKED_VERIFY_PROVENANCE: "1",
      MISE_NODE_DEFAULT_PACKAGES_FILE: join(root, "empty"),
      MISE_GO_DEFAULT_PACKAGES_FILE: join(root, "empty"),
      MISE_PYTHON_DEFAULT_PACKAGES_FILE: join(root, "empty"),
      MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS: "",
      MISE_EXPERIMENTAL: "0",
      MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: "none",
    };
  }

  private async controlled<T>(
    signal: AbortSignal,
    record: (receipt: CommandReceipt) => void,
    limits: Limits,
    system: string[],
    operation: (execute: Execute) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal]);
    let output = 0;
    const baseline = await Promise.all(
      system.map((path) => treeBytes(path, Infinity)),
    );
    const check = async () => {
      let used = 0;
      for (const path of [
        this.installs,
        this.privateRoot,
        "/var/cache/apt",
        "/var/lib/apt/lists",
      ])
        used += await treeBytes(path, limits.storage - used);
      for (const [index, path] of system.entries())
        used += Math.max(
          0,
          (await treeBytes(path, baseline[index] + limits.storage - used)) -
            baseline[index],
        );
      if (used > limits.storage) throw new RuntimeError("storage_limit");
    };
    let monitoring: Promise<void> | undefined,
      timer: ReturnType<typeof setInterval> | undefined;
    const execute: Execute = async (command, argv, mutates = false) => {
      if (mutates && !timer)
        timer = setInterval(() => {
          monitoring ??= check()
            .catch((error) =>
              controller.abort(
                error instanceof RuntimeError
                  ? error
                  : new RuntimeError("monitor_failed"),
              ),
            )
            .finally(() => {
              monitoring = undefined;
            });
        }, 1000);
      combined.throwIfAborted();
      const result = await runCommand(command, argv, {
        cwd: this.privateRoot,
        env: this.environment(),
        signal: combined,
        limit: limits.output - output,
        operation: "install",
        secrets: this.secrets,
        record: (receipt) => {
          record(receipt);
          if (receipt.finished_at !== null) output += receipt.output_bytes;
        },
      });
      if (mutates) await check();
      combined.throwIfAborted();
      return result;
    };
    try {
      await check();
      const result = await operation(execute);
      if (timer) await check();
      combined.throwIfAborted();
      return result;
    } finally {
      clearInterval(timer);
      await monitoring;
      combined.throwIfAborted();
    }
  }

  private async inventory(execute: Execute) {
    const output = await execute("/usr/bin/dpkg-query", [
      "-W",
      "-f=${binary:Package}\t${Version}\t${db:Status-Status}\n",
    ]);
    return output.stdout.split("\n").filter(Boolean).sort().join("\n");
  }

  async ensure(
    plan: BootstrapPlan,
    signal: AbortSignal,
    record: (receipt: CommandReceipt) => void,
    limits: Limits,
  ): Promise<ToolEnvironment> {
    const parsed = bootstrapPlanSchema.safeParse(plan);
    if (!parsed.success) throw new RuntimeError("bootstrap_plan_invalid");
    plan = parsed.data;
    return this.controlled(
      signal,
      record,
      limits,
      plan.system_packages.length ? ["/usr", "/etc", "/var/lib/dpkg"] : [],
      async (execute) => {
        await trustedExecutable(executable);
        const version = await execute(executable, ["--version"]);
        if (
          !version.stdout.startsWith(miseVersion + " ") &&
          version.stdout.trim() !== miseVersion
        )
          throw new RuntimeError("mise_version_mismatch");
        const audit = await execute("/usr/bin/dpkg", ["--audit"]);
        if (audit.stdout.trim() || audit.stderr.trim())
          throw new RuntimeError("system_install_incomplete");
        if (plan.system_packages.length) {
          await execute(
            "/usr/bin/apt-get",
            [
              "-o",
              "Dir::Etc=/opt/orm-runtime/apt",
              "-o",
              "DPkg::Lock::Timeout=0",
              "update",
            ],
            true,
          );
          const packages: string[] = [];
          for (const name of [...new Set(plan.system_packages)].sort()) {
            const policy = await execute(
              "/usr/bin/apt-cache",
              ["-o", "Dir::Etc=/opt/orm-runtime/apt", "policy", name],
              true,
            );
            const candidate = policy.stdout.match(
              /^\s*Candidate:\s*([0-9][A-Za-z0-9.+:~_-]*)\s*$/m,
            )?.[1];
            if (!candidate)
              throw new RuntimeError("system_package_unavailable");
            packages.push(`${name}=${candidate}`);
          }
          await execute(
            "/usr/bin/apt-get",
            [
              "-o",
              "Dir::Etc=/opt/orm-runtime/apt",
              "-o",
              "DPkg::Lock::Timeout=0",
              "install",
              "--yes",
              "--no-install-recommends",
              "--no-remove",
              "--",
              ...packages,
            ],
            true,
          );
          const after = await execute("/usr/bin/dpkg", ["--audit"]);
          if (after.stdout.trim() || after.stderr.trim())
            throw new RuntimeError("system_install_incomplete");
        }
        const tools: InstalledTool[] = [];
        for (const tool of plan.toolchains) {
          const path = join(this.installs, tool.language, tool.version),
            receiptPath = join(
              this.privateRoot,
              "receipts",
              `${tool.language}-${tool.version}.json`,
            );
          let exists = false;
          try {
            await lstat(path);
            exists = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (exists) {
            let saved: InstalledTool;
            try {
              saved = JSON.parse(
                await readFile(receiptPath, "utf8"),
              ) as InstalledTool;
            } catch {
              throw new RuntimeError("toolchain_install_incomplete");
            }
            if (
              saved.path !== path ||
              saved.version !== tool.version ||
              saved.language !== tool.language ||
              (tool.language === "node" && !saved.node_signature) ||
              (await toolIntegrity(path)) !== saved.integrity
            )
              throw new RuntimeError("toolchain_integrity_mismatch");
            tools.push(saved);
            continue;
          }
          const installation = await execute(
            executable,
            ["--no-hooks", "install", `${tool.language}@${tool.version}`],
            true,
          );
          let node_signature: string | undefined;
          if (tool.language === "node") {
            const downloads = join(
              this.privateRoot,
              "data",
              "downloads",
              "node",
              tool.version,
            );
            const checksums = await readFile(join(downloads, "SHASUMS256.txt"));
            const signature = await readFile(join(downloads, "SHASUMS256.asc"));
            // Pinned mise verifies every downloaded signature, but explicitly skips a 404.
            if (
              !signature.length ||
              !checksums.length ||
              /gpg signature not found|skipping verification/.test(
                installation.stderr + installation.stdout,
              )
            )
              throw new RuntimeError("node_signature_missing");
            node_signature = digest({
              checksums: checksums.toString("base64"),
              signature: signature.toString("base64"),
            });
          }
          const stat = await lstat(path);
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0)
            throw new RuntimeError("toolchain_install_invalid");
          await walkTree(path, async (entry, _ref, info) => {
            if (info.isSymbolicLink()) return;
            if (
              info.uid !== 0 ||
              (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
            )
              throw new RuntimeError("toolchain_install_invalid");
            await chmod(
              entry,
              info.isDirectory() || info.mode & 0o111 ? 0o555 : 0o444,
            );
          });
          await chmod(path, 0o555);
          const installed = {
            ...tool,
            path,
            integrity: await toolIntegrity(path),
            ...(node_signature ? { node_signature } : {}),
          };
          await writeFile(receiptPath, JSON.stringify(installed), {
            mode: 0o400,
            flag: "wx",
          });
          tools.push(installed);
        }
        const inventory = await this.inventory(execute);
        return {
          platform: `${process.platform}/${process.arch}`,
          mise: miseVersion,
          installer_integrity: createHash("sha256")
            .update(await readFile(executable))
            .digest("hex"),
          packages: digest(inventory),
          package_versions: inventory,
          tools,
        };
      },
    );
  }

  async verify(
    environment: ToolEnvironment,
    signal: AbortSignal,
    record: (receipt: CommandReceipt) => void,
    limits: Limits,
  ) {
    return this.controlled(signal, record, limits, [], async (execute) => {
      if (
        environment.platform !== `${process.platform}/${process.arch}` ||
        environment.mise !== miseVersion ||
        environment.installer_integrity !==
          createHash("sha256")
            .update(await readFile(executable))
            .digest("hex") ||
        environment.packages !== digest(await this.inventory(execute))
      )
        throw new RuntimeError("bootstrap_environment_changed");
      for (const tool of environment.tools) {
        if (
          tool.path !== join(this.installs, tool.language, tool.version) ||
          (tool.language === "node" && !tool.node_signature) ||
          (await toolIntegrity(tool.path)) !== tool.integrity
        )
          throw new RuntimeError("toolchain_integrity_mismatch");
      }
    });
  }
}

export async function toolIntegrity(root: string) {
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    const stat = await lstat(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      stat.mode & 0o022
    )
      throw new RuntimeError("toolchain_integrity_mismatch");
    if (parent === "/") break;
  }
  const base = await lstat(root);
  if (
    !base.isDirectory() ||
    base.isSymbolicLink() ||
    base.uid !== 0 ||
    base.mode & 0o222
  )
    throw new RuntimeError("toolchain_integrity_mismatch");
  const entries: unknown[] = [];
  await walkTree(root, async (path, ref, stat) => {
    if (stat.uid !== 0 || (!stat.isSymbolicLink() && stat.mode & 0o222))
      throw new RuntimeError("toolchain_integrity_mismatch");
    if (stat.isSymbolicLink()) {
      const target = await readlink(path),
        resolved = resolve(root, dirname(ref), target);
      if (isAbsolute(target) || relative(root, resolved).startsWith(".."))
        throw new RuntimeError("toolchain_integrity_mismatch");
      entries.push([ref, "link", target]);
    } else if (stat.isFile() && stat.nlink === 1)
      entries.push([
        ref,
        stat.mode & 0o777,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]);
    else if (stat.isDirectory()) entries.push([ref, "directory"]);
    else throw new RuntimeError("toolchain_integrity_mismatch");
  });
  return digest(entries);
}
