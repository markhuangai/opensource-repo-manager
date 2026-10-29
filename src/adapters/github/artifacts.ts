import { Octokit } from "@octokit/rest";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ActionsContext } from "../../actions/context.ts";
import {
  fileDigest,
  type ArtifactReference,
  type BundleIdentity,
} from "../../actions/bundle.ts";
import { StateError } from "../../actions/state.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import { cleanEnvironment, trustedExecutable } from "../../runtime/process.ts";
import { treeBytes } from "../../services/workspaces/files.ts";

const positive = z.number().int().positive().safe();
const runSchema = z.object({
  id: positive,
  run_attempt: positive,
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  repository: z.object({ id: positive, full_name: z.string() }),
  head_repository: z.object({ id: positive }),
});
const artifactSchema = z.object({
  id: positive,
  name: z.string(),
  size_in_bytes: positive,
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expired: z.boolean(),
  expires_at: z.iso.datetime(),
  workflow_run: z.object({
    id: positive,
    repository_id: positive,
    head_repository_id: positive,
    head_sha: z.string(),
  }),
});
type Artifact = z.infer<typeof artifactSchema>;

export interface ArtifactTransport {
  verify(directory: string, signal: AbortSignal): Promise<void>;
  upload(
    path: string,
    identity: BundleIdentity,
    limit: number,
    signal: AbortSignal,
  ): Promise<ArtifactReference>;
  download(
    reference: ArtifactReference,
    directory: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}

export class GitHubArtifacts implements ArtifactTransport {
  private readonly client: Octokit;
  private readonly coordinates: { owner: string; repo: string };
  constructor(
    private readonly context: ActionsContext,
    private readonly secrets: SecretAccessor,
    client?: Octokit,
  ) {
    const silent = () => {};
    this.client =
      client ??
      new Octokit({
        auth: secrets.get("github.token"),
        log: { debug: silent, info: silent, warn: silent, error: silent },
      });
    const [owner, repo] = context.repository.split("/");
    this.coordinates = { owner, repo };
  }

  private async read(
    route: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    try {
      return (
        await this.client.request(route, {
          ...this.coordinates,
          ...parameters,
          request: {
            signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
            redirect: "error",
          },
        })
      ).data;
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new StateError("session_transport_unavailable");
    }
  }

  private async run(id: number, attempt: number, signal: AbortSignal) {
    const run = runSchema.safeParse(
      await this.read(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}",
        { run_id: id, attempt_number: attempt },
        signal,
      ),
    );
    if (
      !run.success ||
      run.data.id !== id ||
      run.data.run_attempt !== attempt ||
      run.data.repository.id !== this.context.repository_id ||
      run.data.head_repository.id !== this.context.repository_id ||
      run.data.repository.full_name.toLowerCase() !==
        this.context.repository.toLowerCase()
    )
      throw new StateError("session_provenance_invalid");
    return run.data;
  }

  async verify(directory: string, signal: AbortSignal) {
    const run = await this.run(
      this.context.run_id,
      this.context.run_attempt,
      signal,
    );
    if (run.head_sha !== this.context.head_sha)
      throw new StateError("session_provenance_invalid");
    await this.helper({ operation: "list", directory }, 1024 * 1024, signal);
  }

  private async artifacts(run: number, name: string, signal: AbortSignal) {
    const rows: Artifact[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = z
        .object({
          total_count: z.number().int().nonnegative(),
          artifacts: z.array(artifactSchema),
        })
        .safeParse(
          await this.read(
            "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
            { run_id: run, name, per_page: 100, page },
            signal,
          ),
        );
      if (!result.success) throw new StateError("session_provenance_invalid");
      rows.push(...result.data.artifacts);
      if (rows.length === result.data.total_count) return rows;
      if (
        !result.data.artifacts.length ||
        rows.length > result.data.total_count
      )
        break;
    }
    throw new StateError("session_transport_unavailable");
  }

  private provenance(artifact: Artifact, run: z.infer<typeof runSchema>) {
    if (
      artifact.workflow_run.id !== run.id ||
      artifact.workflow_run.repository_id !== this.context.repository_id ||
      artifact.workflow_run.head_repository_id !== this.context.repository_id ||
      artifact.workflow_run.head_sha !== run.head_sha
    )
      throw new StateError("session_provenance_invalid");
  }

  async upload(
    path: string,
    identity: BundleIdentity,
    limit: number,
    signal: AbortSignal,
  ) {
    if (
      identity.run_id !== this.context.run_id ||
      identity.run_attempt !== this.context.run_attempt ||
      identity.repository_id !== this.context.repository_id
    )
      throw new StateError("session_provenance_invalid");
    const expected = await fileDigest(path, limit, signal);
    const run = await this.run(identity.run_id, identity.run_attempt, signal);
    const name = basename(path);
    let rows = (await this.artifacts(run.id, name, signal)).filter(
      (artifact) => artifact.name === name,
    );
    if (!rows.length) {
      try {
        await this.helper(
          { operation: "upload", name, path, directory: dirname(path) },
          limit,
          signal,
        );
      } catch {
        signal.throwIfAborted();
      }
      rows = (await this.artifacts(run.id, name, signal)).filter(
        (artifact) => artifact.name === name,
      );
    }
    if (rows.length !== 1) throw new StateError("session_upload_uncertain");
    const artifact = rows[0];
    this.provenance(artifact, run);
    const expires = Date.parse(artifact.expires_at);
    if (
      artifact.digest !== `sha256:${expected.digest}` ||
      artifact.size_in_bytes !== expected.size ||
      artifact.expired ||
      expires <= Date.now() ||
      expires > Date.now() + 14 * 86400000 + 60000
    )
      throw new StateError("session_provenance_invalid");
    return {
      ...identity,
      artifact_id: artifact.id,
      ...expected,
      expires_at: expires,
    };
  }

  async download(
    reference: ArtifactReference,
    directory: string,
    limit: number,
    signal: AbortSignal,
  ) {
    if (
      reference.repository_id !== this.context.repository_id ||
      reference.size > limit
    )
      throw new StateError("session_provenance_invalid");
    const run = await this.run(reference.run_id, reference.run_attempt, signal);
    const rows = await this.artifacts(
      run.id,
      `orm-session-${reference.checkpoint_id}.orm`,
      signal,
    );
    const matches = rows.filter(
      (artifact) => artifact.id === reference.artifact_id,
    );
    if (!matches.length) return undefined;
    if (matches.length !== 1)
      throw new StateError("session_provenance_invalid");
    const artifact = matches[0];
    this.provenance(artifact, run);
    if (
      artifact.digest !== `sha256:${reference.digest}` ||
      artifact.size_in_bytes !== reference.size ||
      artifact.name !== `orm-session-${reference.checkpoint_id}.orm` ||
      Date.parse(artifact.expires_at) !== reference.expires_at
    )
      throw new StateError("session_provenance_invalid");
    if (artifact.expired || reference.expires_at <= Date.now())
      return undefined;
    const result = (await this.helper(
      {
        operation: "download",
        id: reference.artifact_id,
        digest: reference.digest,
        run: reference.run_id,
        directory,
      },
      limit,
      signal,
    )) as { digestMismatch?: boolean };
    const files = await readdir(directory);
    if (result.digestMismatch || files.length !== 1)
      throw new StateError("session_corrupt");
    const path = join(directory, files[0]);
    const actual = await fileDigest(path, limit, signal);
    if (actual.digest !== reference.digest || actual.size !== reference.size)
      throw new StateError("session_corrupt");
    return path;
  }

  private async helper(
    request: Record<string, unknown> & { directory: string },
    limit: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const executable = fileURLToPath(
      new URL("./artifacts-process.js", import.meta.url),
    );
    await trustedExecutable(executable);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
    combined.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn("/opt/orm-runtime/bin/node", [executable], {
        cwd: request.directory,
        env: {
          ...cleanEnvironment(request.directory, request.directory, "root"),
          ACTIONS_RUNTIME_TOKEN: this.secrets.get("actions.runtime_token"),
          ACTIONS_RESULTS_URL: this.context.results_url,
          ORM_ARTIFACT_TOKEN: this.secrets.get("github.token"),
          GITHUB_REPOSITORY: this.context.repository,
          GITHUB_RUN_ID: String(this.context.run_id),
          GITHUB_WORKSPACE: request.directory,
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_API_URL: "https://api.github.com",
          NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
          GITHUB_RETENTION_DAYS: "14",
          ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY: "1",
        },
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      let output = "",
        bytes = 0,
        fault: unknown;
      let watching: Promise<void> | undefined;
      const stop = (error: unknown) => {
        fault ??= error;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              fault = error;
          }
        }
      };
      const abort = () => stop(combined.reason);
      combined.addEventListener("abort", abort, { once: true });
      const timer = setInterval(() => {
        watching ??= treeBytes(request.directory, limit + 16 * 1024 * 1024)
          .then(() => {}, stop)
          .finally(() => {
            watching = undefined;
          });
      }, 100);
      for (const stream of [child.stdout, child.stderr, child.stdio[3]])
        stream?.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) stop(new StateError("session_size_limit"));
          else if (stream === child.stdio[3]) output += chunk.toString();
        });
      child.on("error", () =>
        stop(new StateError("session_transport_unavailable")),
      );
      child.once("close", async (code) => {
        clearInterval(timer);
        combined.removeEventListener("abort", abort);
        await watching;
        if (fault || code !== 0)
          return reject(
            fault ?? new StateError("session_transport_unavailable"),
          );
        try {
          const parsed = JSON.parse(output) as {
            result?: unknown;
            error?: string;
          };
          if (parsed.error || !("result" in parsed))
            throw new StateError("session_transport_unavailable");
          resolve(parsed.result);
        } catch {
          reject(new StateError("session_transport_unavailable"));
        }
      });
      child.stdin.on("error", () =>
        stop(new StateError("session_transport_unavailable")),
      );
      child.stdin.end(JSON.stringify(request));
      if (combined.aborted) abort();
    });
  }
}
