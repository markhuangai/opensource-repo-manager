import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { SecretAccessor } from "../../config/secrets.ts";
import { RuntimeError, type ArtifactManifest } from "../../domain/agents.ts";
import { validateArtifactLinks } from "../../services/workspaces/index.ts";
import { publicationText } from "../../services/publication/scanner.ts";

export function runGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  input?: Uint8Array | string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/git", args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0,
      failed = false;
    const stop = () => {
      failed = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
        }
      }
    };
    const timer = setTimeout(stop, 30000);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) stop();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) stop();
    });
    child.on("error", () => {
      failed = true;
    });
    child.stdin.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (failed || code !== 0)
        reject(new RuntimeError("publication_git_failed"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
    if (signal.aborted) stop();
  });
}

export function protectedPath(path: string) {
  const value = path.toLowerCase();
  return (
    value.split("/").includes(".git") ||
    value === ".github/workflows" ||
    value.startsWith(".github/workflows/") ||
    value === ".github/actions" ||
    value.startsWith(".github/actions/") ||
    /(^|\/)action\.ya?ml$/.test(value) ||
    [
      "codeowners",
      ".github/codeowners",
      "docs/codeowners",
      ".github/dependabot.yml",
      ".github/dependabot.yaml",
      ".gitmodules",
    ].includes(value)
  );
}

export class PublicationGit {
  readonly environment: NodeJS.ProcessEnv;
  readonly directory: string;
  private readonly secrets: SecretAccessor;
  private endpoint: string;
  constructor(
    directory: string,
    secrets: SecretAccessor,
    repository: string,
    sourceUrl = (repository: string) => `https://github.com/${repository}.git`,
  ) {
    this.directory = directory;
    this.secrets = secrets;
    const endpoint = new URL(sourceUrl(repository));
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new RuntimeError("source_invalid");
    this.endpoint = endpoint.href;
    this.environment = {
      PATH: "/usr/bin:/bin",
      HOME: directory,
      TMPDIR: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "http:https",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "http.followRedirects",
      GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: `http.${endpoint.origin}/.extraHeader`,
      GIT_CONFIG_VALUE_3: `Authorization: Basic ${Buffer.from(`x-access-token:${secrets.get("github.token")}`).toString("base64")}`,
    };
  }
  async command(
    args: string[],
    signal: AbortSignal,
    input?: Uint8Array | string,
    env = this.environment,
  ) {
    return runGit(args, this.directory, env, signal, input);
  }
  async initialize(parent: string, signal: AbortSignal) {
    await mkdir(this.directory, { mode: 0o700 });
    await this.command(["init", "--bare", "."], signal);
    await this.command(["fetch", "--no-tags", this.endpoint, parent], signal);
    const actual = (await this.command(["rev-parse", "FETCH_HEAD"], signal))
      .toString()
      .trim();
    if (actual !== parent) throw new RuntimeError("publication_head_changed");
  }
  async build(
    manifest: ArtifactManifest,
    blobs: string,
    parent: string,
    message: string,
    actor: { id: number; login: string },
    timestamp: string,
    limit: number,
    signal: AbortSignal,
  ) {
    validateArtifactLinks(manifest.files);
    const before = new Map<string, { mode: string; sha: string }>();
    for (const line of (await this.command(["ls-tree", "-rz", parent], signal))
      .toString()
      .split("\0")
      .filter(Boolean)) {
      const [metadata, path] = line.split("\t");
      const [mode, , sha] = metadata.split(" ");
      before.set(path, { mode, sha });
    }
    const entries: Array<{ path: string; mode: string; sha: string }> = [];
    const changes: Array<{ path: string; mode: string; text: string | null }> =
      [];
    let total = 0;
    for (const file of manifest.files) {
      signal.throwIfAborted();
      let bytes: Buffer;
      if (file.kind === "link") bytes = Buffer.from(file.target);
      else {
        if (!/^[a-f0-9]{64}$/.test(file.digest))
          throw new RuntimeError("artifact_corrupt");
        const handle = await open(
          join(blobs, file.digest),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.uid !== process.getuid!() ||
            stat.mode & 0o222 ||
            stat.size > limit - total
          )
            throw new RuntimeError("artifact_corrupt");
          bytes = await handle.readFile();
          if (createHash("sha256").update(bytes).digest("hex") !== file.digest)
            throw new RuntimeError("artifact_corrupt");
        } finally {
          await handle.close();
        }
      }
      total += bytes.length;
      if (total > limit) throw new RuntimeError("storage_limit");
      const mode =
        file.kind === "link"
          ? "120000"
          : file.mode === 0o755
            ? "100755"
            : file.mode === 0o644
              ? "100644"
              : "";
      if (!mode) throw new RuntimeError("artifact_type_invalid");
      const sha = createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex"),
        previous = before.get(file.path);
      if (sha !== previous?.sha || mode !== previous.mode) {
        if (protectedPath(file.path) || previous?.mode === "160000")
          throw new RuntimeError("publication_path_protected");
        const text = publicationText(
          bytes,
          file.kind === "file" ? file.path : "",
        );
        if (
          this.secrets.containsCredentials(file.path) ||
          this.secrets.containsCredentials(text)
        )
          throw new RuntimeError("publication_secret");
        changes.push({ path: file.path, mode, text });
      }
      await this.command(
        ["hash-object", "-w", "--stdin", "--no-filters"],
        signal,
        bytes,
      );
      entries.push({ path: file.path, mode, sha });
      before.delete(file.path);
    }
    for (const [path, previous] of before) {
      if (protectedPath(path) || previous.mode === "160000")
        throw new RuntimeError("publication_path_protected");
      changes.push({ path, mode: previous.mode, text: null });
    }
    const index = join(this.directory, "candidate-index");
    const environment = { ...this.environment, GIT_INDEX_FILE: index };
    await this.command(
      ["read-tree", "--empty"],
      signal,
      undefined,
      environment,
    );
    await this.command(
      ["update-index", "-z", "--index-info"],
      signal,
      entries
        .map((entry) => `${entry.mode} ${entry.sha}\t${entry.path}\0`)
        .join(""),
      environment,
    );
    const tree = (
      await this.command(["write-tree"], signal, undefined, environment)
    )
      .toString()
      .trim();
    if (!changes.length)
      return {
        commit: parent,
        tree,
        parent,
        message,
        actor,
        timestamp,
        changes,
      };
    const identity = `${actor.id}+${actor.login}@users.noreply.github.com`;
    const commitEnv = {
      ...environment,
      GIT_AUTHOR_NAME: actor.login,
      GIT_AUTHOR_EMAIL: identity,
      GIT_COMMITTER_NAME: actor.login,
      GIT_COMMITTER_EMAIL: identity,
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    };
    const commit = (
      await this.command(
        ["commit-tree", tree, "-p", parent],
        signal,
        message,
        commitEnv,
      )
    )
      .toString()
      .trim();
    await writeFile(
      join(this.directory, "candidate.json"),
      JSON.stringify({ commit, tree, parent }),
      { mode: 0o400, flag: "wx" },
    );
    return { commit, tree, parent, message, actor, timestamp, changes };
  }
  async push(commit: string, branch: string, signal: AbortSignal) {
    if (
      !/^[a-f0-9]{40}$/.test(commit) ||
      !/^orm\/[a-f0-9-]{36}\/issue-[1-9]\d*$/.test(branch)
    )
      throw new RuntimeError("publication_target_invalid");
    await this.command(
      ["push", "--porcelain", this.endpoint, `${commit}:refs/heads/${branch}`],
      signal,
    );
  }
}
