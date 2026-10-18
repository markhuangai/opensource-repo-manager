import { join, relative, resolve } from "node:path";
import {
  digest,
  RuntimeError,
  roleUsers,
  type AgentRunRequest,
} from "../../domain/agents.ts";
import { cleanEnvironment } from "../../runtime/process.ts";
import type { PreparedWorkspace } from "../workspaces/index.ts";
import type { BootstrapReceipt } from "./contracts.ts";
import { inspectWorkspace } from "./inspect.ts";

type Execute = (
  argv: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  operation: string,
) => Promise<{ stdout: string; stderr: string }>;

export async function materialize(
  receipt: BootstrapReceipt,
  request: AgentRunRequest,
  workspace: PreparedWorkspace,
  signal: AbortSignal,
  limit: number,
  execute: Execute,
  resolveManagers = false,
) {
  const plan = receipt.plan!,
    tools = receipt.environment!.tools;
  const before = await inspectWorkspace(
    workspace.workspace,
    limit,
    signal,
    plan,
  );
  if (digest(before.fingerprints) !== digest(receipt.inspection!.fingerprints))
    throw new RuntimeError("bootstrap_source_changed");
  const user = roleUsers[request.role];
  const environment: NodeJS.ProcessEnv = {
    ...cleanEnvironment(workspace.home, workspace.temporary, user.name),
    PATH: [
      ...tools.map((tool) => join(tool.path, "bin")),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
    GOTOOLCHAIN: "local",
    // Native runtimes share the worker UID's task budget with SDK and tool subprocesses.
    GOMAXPROCS: "2",
    TOKIO_WORKER_THREADS: "2",
    RAYON_NUM_THREADS: "2",
    GOENV: "off",
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
    GOPRIVATE: "",
    GONOPROXY: "",
    GONOSUMDB: "",
    GOPATH: join(workspace.home, "go"),
    GOMODCACHE: join(workspace.home, "go", "modules"),
    GOCACHE: join(workspace.home, "go", "build"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: join(workspace.home, "npmrc"),
    npm_config_globalconfig: "/dev/null",
    npm_config_cache: join(workspace.home, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_manage_package_manager_versions: "false",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    YARN_IGNORE_PATH: "1",
    YARN_ENABLE_TELEMETRY: "0",
    YARN_NPM_REGISTRY_SERVER: "https://registry.npmjs.org/",
    YARN_ENABLE_IMMUTABLE_INSTALLS: "true",
    YARN_GLOBAL_FOLDER: join(workspace.home, "yarn"),
    PIP_CONFIG_FILE: "/dev/null",
    PIP_INDEX_URL: "https://pypi.org/simple",
    PIP_NO_INPUT: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_CACHE_DIR: join(workspace.home, "pip-cache"),
    UV_PYTHON_DOWNLOADS: "never",
    UV_DEFAULT_INDEX: "https://pypi.org/simple",
    UV_CACHE_DIR: join(workspace.home, "uv-cache"),
    POETRY_CONFIG_DIR: join(workspace.home, "poetry-config"),
    POETRY_CACHE_DIR: join(workspace.home, "poetry-cache"),
    POETRY_VIRTUALENVS_PATH: join(workspace.home, "venvs"),
    POETRY_VIRTUALENVS_CREATE: "true",
    POETRY_VIRTUALENVS_OPTIONS_SYSTEM_SITE_PACKAGES: "false",
  };
  const prepareFiles = async (
    directory: string,
    files: Record<string, string> = {},
  ) =>
    execute(
      [
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        `import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [directory, files] = process.argv.slice(1);
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const [name, content] of Object.entries(JSON.parse(files)))
  await writeFile(join(directory, name), content, { mode: 0o600 });`,
        directory,
        JSON.stringify(files),
      ],
      workspace.workspace,
      environment,
      "environment-files",
    );
  await prepareFiles(workspace.home, {
    npmrc: "registry=https://registry.npmjs.org/\n",
  });
  const binaries = new Map<string, string>();
  for (const tool of tools) {
    const binary = join(
      tool.path,
      "bin",
      tool.language === "python" ? "python3" : tool.language,
    );
    const probe = await execute(
      [binary, tool.language === "go" ? "version" : "--version"],
      workspace.workspace,
      environment,
      "tool-version",
    );
    const observed = probe.stdout.trim();
    const matches =
      tool.language === "node"
        ? observed === `v${tool.version}`
        : tool.language === "python"
          ? observed === `Python ${tool.version}`
          : observed.startsWith(`go version go${tool.version} `);
    if (!matches) throw new RuntimeError("toolchain_version_mismatch");
    binaries.set(tool.language, binary);
    if (tool.language === "python") environment.UV_PYTHON = binary;
  }
  const installed = new Map<string, string>();
  const projects: { cwd: string; path: string }[] = [];
  for (const manager of plan.package_managers) {
    const key = `${manager.name}@${manager.version}`;
    let binary = installed.get(key);
    if (!binary) {
      if (!receipt.manager_locks[key] && !resolveManagers)
        throw new RuntimeError("package_manager_lock_missing");
      const directory = join(workspace.home, "managers", key);
      if (["npm", "pnpm", "yarn"].includes(manager.name)) {
        const node = tools.find((tool) => tool.language === "node")!;
        const npm = join(node.path, "bin", "npm");
        const name =
          manager.name === "yarn" && !manager.version.startsWith("1.")
            ? "@yarnpkg/cli-dist"
            : manager.name;
        const saved = receipt.manager_locks[key];
        if (saved)
          for (const file of Object.keys(saved))
            if (!["package.json", "package-lock.json"].includes(file))
              throw new RuntimeError("package_manager_lock_invalid");
        await prepareFiles(directory, saved);
        await execute(
          saved
            ? [
                npm,
                "ci",
                "--prefix",
                directory,
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
              ]
            : [
                npm,
                "install",
                "--prefix",
                directory,
                "--save-exact",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                `${name}@${manager.version}`,
              ],
          directory,
          environment,
          "package-manager-install",
        );
        if (!saved) {
          const locked = await execute(
            [
              "/opt/orm-runtime/bin/node",
              "--input-type=module",
              "-e",
              `import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const directory = process.argv[1];
console.log(JSON.stringify(Object.fromEntries(await Promise.all(
  ['package.json', 'package-lock.json'].map(async (name) =>
    [name, await readFile(join(directory, name), 'utf8')]),
))));`,
              directory,
            ],
            directory,
            environment,
            "package-manager-lock",
          );
          receipt.manager_locks[key] = JSON.parse(locked.stdout) as Record<
            string,
            string
          >;
        }
        binary = join(directory, "node_modules", ".bin", manager.name);
      } else {
        const python = binaries.get("python")!;
        await prepareFiles(directory);
        await execute(
          [python, "-m", "venv", directory],
          workspace.workspace,
          environment,
          "package-manager-venv",
        );
        const saved = receipt.manager_locks[key];
        if (saved) {
          const requirements = saved["requirements.txt"];
          if (
            !requirements ||
            !requirements
              .trim()
              .split(/\r?\n/)
              .every((line) =>
                /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+$/.test(line),
              )
          )
            throw new RuntimeError("package_manager_lock_invalid");
          await prepareFiles(directory, { "requirements.txt": requirements });
        }
        await execute(
          [
            join(directory, "bin", "python"),
            "-m",
            "pip",
            "install",
            ...(saved
              ? ["--no-deps", "-r", join(directory, "requirements.txt")]
              : [`${manager.name}==${manager.version}`]),
          ],
          directory,
          environment,
          "package-manager-install",
        );
        await execute(
          [join(directory, "bin", "python"), "-m", "pip", "check"],
          directory,
          environment,
          "package-manager-pins",
        );
        if (!saved)
          receipt.manager_locks[key] = {
            "requirements.txt": (
              await execute(
                [
                  join(directory, "bin", "python"),
                  "-m",
                  "pip",
                  "freeze",
                  "--all",
                ],
                directory,
                environment,
                "package-manager-lock",
              )
            ).stdout,
          };
        binary = join(directory, "bin", manager.name);
      }
      const probe = await execute(
        [binary, "--version"],
        directory,
        environment,
        "package-manager-version",
      );
      if (probe.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] !== manager.version)
        throw new RuntimeError("package_manager_version_mismatch");
      installed.set(key, binary);
      environment.PATH = `${dirnameOf(binary)}:${environment.PATH}`;
    }
    const cwd = await commandDirectory(workspace.workspace, manager.cwd);
    if (manager.name === "npm")
      await execute(
        [binary, "ci", "--no-audit", "--no-fund"],
        cwd,
        environment,
        "dependencies",
      );
    if (manager.name === "pnpm")
      await execute(
        [
          binary,
          "install",
          "--frozen-lockfile",
          "--store-dir",
          join(workspace.home, "pnpm-store"),
        ],
        cwd,
        environment,
        "dependencies",
      );
    if (manager.name === "yarn")
      await execute(
        [
          binary,
          "install",
          manager.version.startsWith("1.")
            ? "--frozen-lockfile"
            : "--immutable",
        ],
        cwd,
        environment,
        "dependencies",
      );
    if (["pip", "poetry", "uv"].includes(manager.name)) {
      const project = join(workspace.home, "projects", digest(manager.cwd));
      projects.push({ cwd, path: project });
      await prepareFiles(dirnameOf(project));
      await execute(
        [binaries.get("python")!, "-m", "venv", project],
        cwd,
        environment,
        "project-venv",
      );
      const projectEnvironment = {
        ...environment,
        VIRTUAL_ENV: project,
        UV_PROJECT_ENVIRONMENT: project,
        PATH: `${join(project, "bin")}:${environment.PATH}`,
      };
      if (manager.name === "pip") {
        await execute(
          [
            join(project, "bin", "python"),
            "-m",
            "pip",
            "install",
            `pip==${manager.version}`,
          ],
          cwd,
          projectEnvironment,
          "project-pip",
        );
        await execute(
          [
            join(project, "bin", "python"),
            "-m",
            "pip",
            "install",
            "--no-deps",
            "-r",
            "requirements.txt",
          ],
          cwd,
          projectEnvironment,
          "dependencies",
        );
        await execute(
          [join(project, "bin", "python"), "-m", "pip", "check"],
          cwd,
          projectEnvironment,
          "dependency-pins",
        );
      }
      if (manager.name === "poetry") {
        await execute(
          [binary, "check", "--lock"],
          cwd,
          projectEnvironment,
          "dependency-lock",
        );
        await execute(
          [binary, "sync", "--no-interaction"],
          cwd,
          projectEnvironment,
          "dependencies",
        );
      }
      if (manager.name === "uv")
        await execute(
          [binary, "sync", "--locked", "--python", binaries.get("python")!],
          cwd,
          projectEnvironment,
          "dependencies",
        );
    }
  }
  projects.sort((a, b) => b.cwd.length - a.cwd.length);
  if (projects.length === 1 && projects[0]!.cwd === workspace.workspace) {
    environment.VIRTUAL_ENV = projects[0]!.path;
    environment.UV_PROJECT_ENVIRONMENT = projects[0]!.path;
    environment.PATH = `${join(projects[0]!.path, "bin")}:${environment.PATH}`;
  } else if (projects.length) {
    const directory = join(workspace.home, "python-bin");
    const launcher = `#!/opt/orm-runtime/bin/node
const { existsSync } = require('node:fs');
const { basename, join, delimiter } = require('node:path');
const projects = ${JSON.stringify(projects)};
const basePath = ${JSON.stringify(environment.PATH)};
const cwd = process.cwd();
const project = projects.find(project => cwd === project.cwd || cwd.startsWith(project.cwd + '/'));
const name = basename(process.argv[1]);
const environment = { ...process.env, PATH: ${JSON.stringify(directory)} + ':' + basePath };
delete environment.VIRTUAL_ENV;
delete environment.UV_PROJECT_ENVIRONMENT;
if (project) {
  environment.VIRTUAL_ENV = project.path;
  environment.UV_PROJECT_ENVIRONMENT = project.path;
  environment.PATH = ${JSON.stringify(directory)} + ':' + join(project.path, 'bin') + ':' + basePath;
}
const candidates = [
  ...(project ? [join(project.path, 'bin', name)] : []),
  ...(/^python(?:[0-9]+(?:\\.[0-9]+)*)?$/.test(name) ? [join(${JSON.stringify(dirnameOf(binaries.get("python")!))}, name)] : []),
  ...basePath.split(delimiter).map(directory => join(directory, name)),
];
const binary = candidates.find(path => existsSync(path));
if (!binary) throw new Error('Python project executable unavailable: ' + name);
process.execve(binary, [binary, ...process.argv.slice(2)], environment);
`;
    await execute(
      [
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        `import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [directory, projects, managers, launcher] = process.argv.slice(1);
await mkdir(directory, { mode: 0o700 });
const names = new Set(JSON.parse(managers));
for (const project of JSON.parse(projects))
  for (const name of await readdir(join(project.path, 'bin')))
    if ((await stat(join(project.path, 'bin', name))).mode & 0o111) names.add(name);
for (const name of names)
  await writeFile(join(directory, name), launcher, { mode: 0o700 });`,
        directory,
        JSON.stringify(projects),
        JSON.stringify(
          plan.package_managers
            .filter((manager) => ["pip", "poetry", "uv"].includes(manager.name))
            .map((manager) => manager.name),
        ),
        launcher,
      ],
      workspace.workspace,
      environment,
      "environment-files",
    );
    environment.PATH = `${directory}:${environment.PATH}`;
  }
  for (const command of plan.setup_commands) {
    const cwd = await commandDirectory(workspace.workspace, command.cwd);
    const project = projects.find(
      (project) => cwd === project.cwd || cwd.startsWith(project.cwd + "/"),
    );
    await execute(
      command.argv,
      cwd,
      project
        ? {
            ...environment,
            VIRTUAL_ENV: project.path,
            UV_PROJECT_ENVIRONMENT: project.path,
          }
        : environment,
      "project-setup",
    );
  }
  const after = await inspectWorkspace(
    workspace.workspace,
    limit,
    signal,
    plan,
    before.source_files,
  );
  if (digest(before.fingerprints) !== digest(after.fingerprints))
    throw new RuntimeError("bootstrap_lock_mutated");
  return {
    environment,
    excluded: dependencyExclusions(receipt.inspection!.source_files),
  };
}

export function dependencyExclusions(sourceFiles: readonly string[]) {
  const original = new Set(sourceFiles);
  return (path: string) =>
    /(?:^|\/)node_modules(?:\/|$)|(?:^|\/)\.yarn\/(?:cache|install-state\.gz|unplugged)(?:\/|$)|(?:^|\/)\.pnp\.(?:cjs|loader\.mjs)$/.test(
      path,
    ) &&
    !original.has(path) &&
    !sourceFiles.some((source) => source.startsWith(path + "/"));
}

function dirnameOf(path: string) {
  return resolve(path, "..");
}

export async function commandDirectory(root: string, directory: string) {
  const { lstat } = await import("node:fs/promises");
  const path = directory === "." ? root : join(root, directory);
  if (relative(root, path).startsWith(".."))
    throw new RuntimeError("bootstrap_command_path_invalid");
  let current = root;
  for (const part of relative(root, path).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new RuntimeError("bootstrap_command_path_invalid");
  }
  return path;
}
