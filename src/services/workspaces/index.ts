import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  chmod,
  chown,
  lchown,
  mkdir,
  open,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { setInterval, clearInterval } from "node:timers";
import type { RunSnapshot } from "../../config/load.ts";
import { isContainedReference } from "../../config/files.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import type { Role } from "../../config/schema.ts";
import {
  RuntimeError,
  roleUsers,
  type ArtifactFile,
  type ArtifactManifest,
} from "../../domain/agents.ts";
import type { SourceMetadata } from "../../domain/jobs.ts";
import {
  cleanEnvironment,
  cleanSource,
  spawnAsRole,
} from "../../runtime/process.ts";
import { ownedDirectory, rootDirectory, treeBytes, walkTree } from "./files.ts";

export type PreparedWorkspace = {
  root: string;
  workspace: string;
  home: string;
  temporary: string;
  prompts: { system: string; user: string; skills: string };
};

function validateArtifactLinks(files: readonly ArtifactFile[]) {
  const entries = new Map<string, ArtifactFile>();
  for (const file of files) {
    if (
      !isContainedReference(file.path) ||
      file.path.split("/").includes(".git") ||
      entries.has(file.path)
    )
      throw new RuntimeError("artifact_path_invalid");
    entries.set(file.path, file);
  }
  for (const file of files) {
    const parents = file.path.split("/");
    parents.pop();
    while (parents.length) {
      if (entries.has(parents.join("/")))
        throw new RuntimeError("artifact_path_invalid");
      parents.pop();
    }
    if (file.kind !== "link") continue;
    if (isAbsolute(file.target))
      throw new RuntimeError("artifact_path_invalid");
    const resolved = file.path.split("/");
    resolved.pop();
    const pending = file.target.split("/");
    let links = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!resolved.length) throw new RuntimeError("artifact_path_invalid");
        resolved.pop();
        continue;
      }
      if (part === ".git") throw new RuntimeError("artifact_path_invalid");
      resolved.push(part);
      const entry = entries.get(resolved.join("/"));
      if (entry?.kind === "link") {
        if (++links > 40 || isAbsolute(entry.target))
          throw new RuntimeError("artifact_path_invalid");
        resolved.pop();
        pending.unshift(...entry.target.split("/"));
      }
    }
  }
}

export function gitCommand(
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    role?: Role;
    processes?: number;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = options.role
      ? spawnAsRole(options.role, "/usr/bin/git", args, {
          ...options,
          processes: options.processes ?? 128,
        })
      : spawn("/usr/bin/git", args, {
          cwd: options.cwd,
          env: options.env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
    let bytes = 0,
      output = "",
      failure: RuntimeError | undefined;
    function stop(code: string) {
      failure ??= new RuntimeError(code);
      if (child.pid) {
        try {
          process.kill(options.role ? child.pid : -child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
        }
      }
    }
    const abort = () =>
      stop(
        options.signal.reason instanceof RuntimeError
          ? options.signal.reason.code
          : "source_cancelled",
      );
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) stop("source_output_limit");
      else output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) stop("source_output_limit");
    });
    child.on("error", () => {
      failure = new RuntimeError("source_failed");
    });
    child.on("close", (code) => {
      options.signal.removeEventListener("abort", abort);
      if (failure || code !== 0)
        reject(failure ?? new RuntimeError("source_failed"));
      else resolve(output.trim());
    });
    if (options.signal.aborted) abort();
  });
}

export class WorkspaceService {
  readonly privateRoot: string;
  readonly runsRoot: string;
  readonly root: string;
  private readonly secrets: SecretAccessor;
  private readonly sourceUrl: (repository: string) => string;
  constructor(
    root: string,
    secrets: SecretAccessor,
    sourceUrl = (repository: string) => `https://github.com/${repository}.git`,
  ) {
    this.root = root;
    this.secrets = secrets;
    this.sourceUrl = sourceUrl;
    this.privateRoot = join(root, "private");
    this.runsRoot = join(root, "runs");
  }

  async initialize() {
    await rootDirectory(this.root, 0o711);
    await rootDirectory(this.privateRoot);
    await rootDirectory(this.runsRoot, 0o711);
    for (const part of ["sources", "blobs", "manifests"])
      await rootDirectory(join(this.privateRoot, part));
  }

  async prepare(
    id: string,
    role: Role,
    bundle: RunSnapshot["roles"][Role]["bundle"],
    source: SourceMetadata,
    repository: string,
    limits: { processes: number; storage: number },
    signal: AbortSignal,
  ): Promise<PreparedWorkspace> {
    const user = roleUsers[role],
      root = join(this.runsRoot, id),
      stage = join(this.privateRoot, "sources", id);
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      !/^[a-f0-9]{40}$/.test(source.sha) ||
      !/^[a-f0-9]{40}$/.test(source.tree_sha)
    )
      throw new RuntimeError("source_invalid");
    await mkdir(root, { mode: 0o711 });
    await mkdir(stage, { mode: 0o700 });
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal]);
    let watching: Promise<void> | undefined,
      moving = false;
    const timer = setInterval(() => {
      if (!watching && !moving)
        watching = (async () => {
          const staged = await treeBytes(stage, limits.storage);
          await treeBytes(root, limits.storage - staged);
        })()
          .then(
            () => {},
            (error) =>
              controller.abort(
                error instanceof RuntimeError
                  ? error
                  : new RuntimeError("monitor_failed"),
              ),
          )
          .finally(() => {
            watching = undefined;
          });
    }, 1000);
    try {
      const endpoint = new URL(this.sourceUrl(repository));
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new RuntimeError("source_invalid");
      const env: NodeJS.ProcessEnv = {
        ...cleanEnvironment(stage, stage, "root"),
        ORM_SOURCE_RUN: id,
        GIT_ALLOW_PROTOCOL: "https:http",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "http.followRedirects",
        GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: `http.${endpoint.origin}/.extraHeader`,
        GIT_CONFIG_VALUE_2: `Authorization: Basic ${Buffer.from(`x-access-token:${this.secrets.get("github.token")}`).toString("base64")}`,
      };
      const sourceGit = join(stage, "source.git");
      await gitCommand(["init", "--bare", sourceGit], {
        cwd: stage,
        env,
        signal: combined,
      });
      await gitCommand(
        [
          "--git-dir",
          sourceGit,
          "fetch",
          "--no-tags",
          endpoint.href,
          source.sha,
        ],
        { cwd: stage, env, signal: combined },
      );
      const fetched = await gitCommand(
        [
          "--git-dir",
          sourceGit,
          "rev-parse",
          "FETCH_HEAD",
          "FETCH_HEAD^{tree}",
        ],
        { cwd: stage, env, signal: combined },
      );
      if (fetched !== `${source.sha}\n${source.tree_sha}`)
        throw new RuntimeError("source_identity_changed");
      await treeBytes(stage, limits.storage);
      const workspace = join(root, "workspace"),
        home = join(root, "home"),
        temporary = join(root, "tmp"),
        trusted = join(root, "bundle");
      await mkdir(workspace, { mode: 0o700 });
      const publicEnv = {
        ...cleanEnvironment(home, temporary, user.name),
        ORM_SOURCE_RUN: id,
      };
      await gitCommand(["init", "--initial-branch=work", workspace], {
        cwd: root,
        env: publicEnv,
        signal: combined,
      });
      moving = true;
      try {
        await watching;
        combined.throwIfAborted();
        await rm(join(workspace, ".git", "objects"), { recursive: true });
        await rename(
          join(sourceGit, "objects"),
          join(workspace, ".git", "objects"),
        );
      } finally {
        moving = false;
      }
      combined.throwIfAborted();
      await writeFile(
        join(workspace, ".git", "config"),
        "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\nhooksPath = /dev/null\nautocrlf = false\n[credential]\nhelper =\n",
        { mode: 0o600 },
      );
      await walkTree(workspace, async (path) => {
        await chown(path, user.uid, user.gid);
      });
      await chown(workspace, user.uid, user.gid);
      await ownedDirectory(home, user.uid, user.gid);
      await ownedDirectory(temporary, user.uid, user.gid);
      await gitCommand(["checkout", "--detach", source.sha], {
        cwd: workspace,
        env: publicEnv,
        signal: combined,
        role,
        processes: limits.processes,
      });
      await mkdir(trusted, { mode: 0o750 });
      await chown(trusted, 0, user.gid);
      for (const [name, content] of [
        ["system.md", bundle.system],
        ["user.md", bundle.user],
      ] as const) {
        await writeFile(join(trusted, name), content, {
          mode: 0o440,
          flag: "wx",
        });
        await chown(join(trusted, name), 0, user.gid);
      }
      await mkdir(join(trusted, "skills"), { mode: 0o750 });
      await chown(join(trusted, "skills"), 0, user.gid);
      for (const file of bundle.skills) {
        if (!isContainedReference(file.path))
          throw new RuntimeError("bundle_invalid");
        const bytes = Buffer.from(file.content_base64, "base64");
        if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
          throw new RuntimeError("bundle_invalid");
        const target = join(trusted, "skills", file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o750 });
        await writeFile(target, bytes, { mode: 0o440, flag: "wx" });
      }
      await walkTree(trusted, async (path, _ref, stat) => {
        await chown(path, 0, user.gid);
        await chmod(path, stat.isDirectory() ? 0o550 : 0o440);
      });
      await chmod(trusted, 0o550);
      await treeBytes(root, limits.storage);
      return {
        root,
        workspace,
        home,
        temporary,
        prompts: {
          system: join(trusted, "system.md"),
          user: join(trusted, "user.md"),
          skills: join(trusted, "skills"),
        },
      };
    } finally {
      clearInterval(timer);
      await watching;
      await cleanSource(id, stage);
      await rm(stage, { recursive: true, force: true });
    }
  }

  async freeze(
    request: {
      run_id: string;
      job_id: number;
      revision: number;
      source: SourceMetadata;
    },
    workspace: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<ArtifactManifest> {
    const manifest: ArtifactManifest = { ...request, files: [] };
    let total = 0;
    await walkTree(workspace, async (path, reference, stat) => {
      signal.throwIfAborted();
      if (reference.split("/").includes(".git")) return false;
      if (!isContainedReference(reference))
        throw new RuntimeError("artifact_path_invalid");
      total += stat.size;
      if (total > limit || manifest.files.length >= 100000)
        throw new RuntimeError("storage_limit");
      if (stat.isDirectory()) return;
      if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        manifest.files.push({
          path: reference,
          kind: "link",
          target,
          mode: 0o777,
        });
        return;
      }
      if (!stat.isFile() || stat.nlink !== 1)
        throw new RuntimeError("artifact_type_invalid");
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const temporary = join(
        this.privateRoot,
        "blobs",
        `pending-${randomUUID()}`,
      );
      try {
        const actual = await handle.stat();
        if (
          !actual.isFile() ||
          actual.nlink !== 1 ||
          actual.ino !== stat.ino ||
          actual.dev !== stat.dev
        )
          throw new RuntimeError("artifact_type_invalid");
        const hash = createHash("sha256");
        let bytes = 0;
        await pipeline(
          handle.createReadStream({ autoClose: false }),
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              bytes += chunk.length;
              if (bytes > stat.size) done(new RuntimeError("artifact_changed"));
              else {
                hash.update(chunk);
                done(null, chunk);
              }
            },
          }),
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
          { signal },
        );
        if (bytes !== stat.size) throw new RuntimeError("artifact_changed");
        const blob = hash.digest("hex");
        await chmod(temporary, 0o400);
        await rename(temporary, join(this.privateRoot, "blobs", blob));
        manifest.files.push({
          path: reference,
          kind: "file",
          digest: blob,
          mode: stat.mode & 0o111 ? 0o755 : 0o644,
        });
      } finally {
        await handle.close();
        await rm(temporary, { force: true });
      }
    });
    validateArtifactLinks(manifest.files);
    if (Buffer.byteLength(JSON.stringify(manifest)) > 16 * 1024 * 1024)
      throw new RuntimeError("artifact_metadata_limit");
    return manifest;
  }

  async restore(
    manifest: ArtifactManifest,
    target: string,
    role: Role,
    limit: number,
    signal: AbortSignal,
  ) {
    validateArtifactLinks(manifest.files);
    const user = roleUsers[role];
    let bytes = 0;
    for (const name of await readdir(target))
      if (name !== ".git") await rm(join(target, name), { recursive: true });
    for (const file of manifest.files) {
      signal.throwIfAborted();
      if (
        !isContainedReference(file.path) ||
        file.path.split("/").includes(".git")
      )
        throw new RuntimeError("artifact_path_invalid");
      const path = join(target, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (file.kind === "link") {
        await symlink(file.target, path);
        await lchown(path, user.uid, user.gid);
      } else {
        if (!/^[a-f0-9]{64}$/.test(file.digest))
          throw new RuntimeError("artifact_corrupt");
        const blob = join(this.privateRoot, "blobs", file.digest);
        const handle = await open(
          blob,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await handle.stat(),
            hash = createHash("sha256");
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.uid !== process.getuid!() ||
            stat.mode & 0o077
          )
            throw new RuntimeError("artifact_corrupt");
          await pipeline(
            handle.createReadStream({ autoClose: false }),
            new Transform({
              transform(chunk: Buffer, _encoding, done) {
                bytes += chunk.length;
                if (bytes > limit) done(new RuntimeError("storage_limit"));
                else {
                  hash.update(chunk);
                  done(null, chunk);
                }
              },
            }),
            createWriteStream(path, { flags: "wx", mode: file.mode }),
            { signal },
          );
          if (hash.digest("hex") !== file.digest)
            throw new RuntimeError("artifact_corrupt");
          await chown(path, user.uid, user.gid);
        } finally {
          await handle.close();
        }
      }
    }
    await walkTree(target, async (path, ref, stat) => {
      if (ref.split("/").includes(".git")) return false;
      if (!stat.isSymbolicLink()) await chown(path, user.uid, user.gid);
    });
  }

  async remove(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new RuntimeError("run_identity_invalid");
    const stage = join(this.privateRoot, "sources", id);
    await cleanSource(id, stage);
    await rm(stage, { recursive: true, force: true });
    await rm(join(this.runsRoot, id), { recursive: true, force: true });
  }
}
