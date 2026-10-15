import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import type { Role } from "../config/schema.ts";
import { checkPath } from "../config/files.ts";
import { roleUsers, RuntimeError } from "../domain/agents.ts";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, resolve } from "node:path";

export async function assertRuntimeIdentity() {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new RuntimeError("supervisor_requires_root");
  if (basename(await readlink("/proc/1/exe")) !== "tini")
    throw new RuntimeError("container_init_required");
  const users = (await readFile("/etc/passwd", "utf8")).split("\n");
  for (const user of new Map(
    Object.values(roleUsers).map((u) => [u.uid, u]),
  ).values())
    if (
      !users.some((line) => {
        const fields = line.split(":");
        return (
          fields[0] === user.name &&
          Number(fields[2]) === user.uid &&
          Number(fields[3]) === user.gid
        );
      })
    )
      throw new RuntimeError("worker_identity_invalid");
}

export async function userProcesses(
  uid: number,
): Promise<Array<{ pid: number; state: string }>> {
  if (![10001, 10002, 10003].includes(uid))
    throw new RuntimeError("worker_identity_invalid");
  const result: Array<{ pid: number; state: string }> = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, "utf8");
      if (
        status
          .match(/^Uid:\s+(.+)$/m)?.[1]
          .trim()
          .split(/\s+/)
          .some((value) => Number(value) === uid)
      )
        result.push({
          pid: Number(name),
          state: status.match(/^State:\s+(\S)/m)?.[1] ?? "?",
        });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "ESRCH"
      )
        throw error;
    }
  }
  return result;
}

export async function signalUser(uid: number, signal: NodeJS.Signals) {
  for (const { pid } of await userProcesses(uid)) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export async function cleanUser(uid: number) {
  await signalUser(uid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while ((await userProcesses(uid)).length) {
    await signalUser(uid, "SIGKILL");
    if (Date.now() >= deadline) throw new RuntimeError("cleanup_failed");
    await delay(25);
  }
}

export async function sourceProcesses(
  id: string,
  stage: string,
): Promise<number[]> {
  const result: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, "utf8");
      if (!/^Uid:\s+0\s+0\s+0\s+0$/m.test(status)) continue;
      const cwd = await readlink(`/proc/${name}/cwd`),
        environment = await readFile(`/proc/${name}/environ`, "utf8");
      if (
        cwd === stage ||
        cwd.startsWith(stage + "/") ||
        environment.split("\0").includes(`ORM_SOURCE_RUN=${id}`)
      )
        result.push(Number(name));
    } catch (error) {
      if (
        !["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  return result;
}

export async function cleanSource(id: string, stage: string) {
  const deadline = Date.now() + 3000;
  let quiet = 0;
  while (quiet < 3) {
    const processes = await sourceProcesses(id, stage);
    quiet = processes.length ? 0 : quiet + 1;
    for (const pid of processes) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (Date.now() >= deadline) throw new RuntimeError("cleanup_failed");
    await delay(25);
  }
}

export async function suspendUser(uid: number) {
  const deadline = Date.now() + 2000;
  for (;;) {
    await signalUser(uid, "SIGSTOP");
    const processes = await userProcesses(uid);
    if (processes.every((p) => ["T", "t", "Z"].includes(p.state))) return;
    if (Date.now() >= deadline) throw new RuntimeError("suspend_failed");
    await delay(10);
  }
}

export function cleanEnvironment(
  home: string,
  temporary: string,
  user: string,
): NodeJS.ProcessEnv {
  return {
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_CACHE_HOME: `${home}/.cache`,
    USER: user,
    LOGNAME: user,
    SHELL: "/bin/sh",
    LANG: "C.UTF-8",
    PATH: "/opt/orm-runtime/bin:/usr/local/bin:/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function spawnAsRole(
  role: Role,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    processes: number;
    protocol?: boolean;
  },
): ChildProcess {
  const user = roleUsers[role];
  return spawn(
    "/usr/bin/setpriv",
    [
      `--reuid=${user.uid}`,
      `--regid=${user.gid}`,
      "--clear-groups",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "/usr/bin/prlimit",
      `--nproc=${options.processes}:${options.processes}`,
      "--core=0:0",
      command,
      ...args,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: options.protocol
        ? ["pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
    },
  );
}

export async function trustedExecutable(path: string) {
  await checkPath(path, "bundle_invalid");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
    throw new RuntimeError("worker_registration_invalid");
  let parent = dirname(resolve(path));
  for (;;) {
    const directory = await lstat(parent);
    if (directory.uid !== 0 || directory.mode & 0o022)
      throw new RuntimeError("worker_registration_invalid");
    if (parent === "/") break;
    parent = dirname(parent);
  }
}
