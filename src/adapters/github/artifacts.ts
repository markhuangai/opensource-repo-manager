import { Octokit } from "@octokit/rest";
import { StringDecoder } from "node:string_decoder";
import { setTimeout } from "node:timers/promises";
import { createGitHubClient } from "./client.ts";
import {
  createApiDiagnostics,
  apiFailureId,
  carryApiFailure,
  tagApiFailure,
  type ApiDiagnostics,
} from "../../logging/api.ts";
import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { openPromise as openZip } from "yauzl";
import type { ActionsContext } from "../../actions/context.ts";
import {
  fileDigest,
  type ArtifactReference,
  type PreparedArtifact,
} from "../../actions/bundle.ts";
import { StateError } from "../../actions/state.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import { cleanEnvironment, trustedExecutable } from "../../runtime/process.ts";
import { treeBytes } from "../../services/workspaces/files.ts";
import type { RemoteRun } from "../../domain/remote-turns.ts";

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

export async function listRunArtifacts(
  read: (page: number) => Promise<unknown>,
) {
  const rows: Artifact[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = z
      .object({
        total_count: z.number().int().nonnegative(),
        artifacts: z.array(artifactSchema),
      })
      .safeParse(await read(page));
    if (!result.success) throw new StateError("session_provenance_invalid");
    rows.push(...result.data.artifacts);
    if (rows.length === result.data.total_count) return rows;
    if (!result.data.artifacts.length || rows.length > result.data.total_count)
      break;
  }
  throw new StateError("session_transport_unavailable");
}

export function nativeCheckpointArtifact(run: RemoteRun, rows: Artifact[]) {
  const prefix = `remote-dev-session-r${run.id}-a${run.run_attempt}-`;
  const matches = rows
    .flatMap((artifact) => {
      const sequence = Number(artifact.name.slice(prefix.length));
      return artifact.name === `${prefix}${sequence}` &&
        Number.isSafeInteger(sequence) &&
        sequence > 0
        ? [{ artifact, sequence }]
        : [];
    })
    .sort((left, right) => right.sequence - left.sequence);
  const [latest, next] = matches;
  if (latest && next?.sequence === latest.sequence)
    throw new StateError("agent_artifact_conflict");
  if (
    latest &&
    !latest.artifact.expired &&
    Date.parse(latest.artifact.expires_at) > Date.now()
  )
    return latest;
}

export interface ArtifactTransport {
  verify(directory: string, signal: AbortSignal): Promise<void>;
  upload(
    path: string,
    prepared: PreparedArtifact,
    limit: number,
    signal: AbortSignal,
  ): Promise<ArtifactReference>;
  locate(
    prepared: PreparedArtifact,
    signal: AbortSignal,
  ): Promise<ArtifactReference | undefined>;
  download(
    reference: ArtifactReference,
    directory: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}

export class GitHubArtifacts implements ArtifactTransport {
  private readonly diagnostics: ApiDiagnostics;
  private readonly client: Octokit;
  private readonly coordinates: { owner: string; repo: string };
  constructor(
    private readonly context: ActionsContext,
    private readonly secrets: SecretAccessor,
    client?: Octokit,
    diagnostics?: ApiDiagnostics,
  ) {
    this.diagnostics =
      diagnostics ??
      createApiDiagnostics(secrets, { repository: context.repository });
    this.client =
      client ??
      createGitHubClient(
        context.repository,
        secrets.get("github.token"),
        this.diagnostics,
      );
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
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw carryApiFailure(
        new StateError("session_transport_unavailable"),
        error,
      );
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

  private async artifacts(
    run: number,
    name: string | undefined,
    signal: AbortSignal,
  ) {
    return listRunArtifacts((page) =>
      this.read(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
        { run_id: run, name, per_page: 100, page },
        signal,
      ),
    );
  }

  async uploadAgentInput(path: string, limit: number, signal: AbortSignal) {
    const expected = await fileDigest(path, limit, signal);
    const run = await this.run(
      this.context.run_id,
      this.context.run_attempt,
      signal,
    );
    const name = basename(path);
    await this.helper(
      { operation: "upload", name, path, directory: dirname(path) },
      limit,
      signal,
    );
    const rows = await this.artifacts(run.id, name, signal);
    if (rows.length !== 1 || rows[0].name !== name)
      throw new StateError("session_upload_uncertain");
    const artifact = rows[0];
    this.provenance(artifact, run);
    if (
      artifact.digest !== `sha256:${expected.digest}` ||
      artifact.size_in_bytes !== expected.size ||
      artifact.expired
    )
      throw new StateError("session_provenance_invalid");
    return { run: run.id, name, id: artifact.id, digest: expected.digest };
  }

  async agentResult(run: RemoteRun, directory: string, signal: AbortSignal) {
    const rows = await this.artifacts(run.id, undefined, signal);
    const resultName = `remote-dev-result-r${run.id}-a${run.run_attempt}`;
    const result = rows.filter((artifact) => artifact.name === resultName);
    if (result.length > 1) throw new StateError("agent_artifact_conflict");
    const checkpoint = nativeCheckpointArtifact(run, rows);
    if (!result.length) throw new StateError("agent_artifact_unavailable");
    return {
      result: await this.agentRecord(
        run,
        result[0],
        directory,
        "record.json",
        2 * 1024 * 1024,
        signal,
      ),
      session: checkpoint
        ? await this.readNativeCheckpoint(run, checkpoint, directory, signal)
        : undefined,
      result_id: result[0].id,
    };
  }

  async agentCheckpoint(
    run: RemoteRun,
    directory: string,
    signal: AbortSignal,
  ) {
    const latest = nativeCheckpointArtifact(
      run,
      await this.artifacts(run.id, undefined, signal),
    );
    if (latest)
      return this.readNativeCheckpoint(run, latest, directory, signal);
  }

  private async readNativeCheckpoint(
    run: RemoteRun,
    {
      artifact,
      sequence,
    }: NonNullable<ReturnType<typeof nativeCheckpointArtifact>>,
    directory: string,
    signal: AbortSignal,
  ) {
    return {
      checkpoint: await this.agentRecord(
        run,
        artifact,
        directory,
        "manifest.json",
        256 * 1024 * 1024,
        signal,
      ),
      checkpoint_id: artifact.id,
      checkpoint_digest: artifact.digest.slice("sha256:".length),
      sequence,
    };
  }

  private async agentRecord(
    run: RemoteRun,
    artifact: Artifact,
    directory: string,
    entryName: "record.json" | "manifest.json",
    limit: number,
    signal: AbortSignal,
  ) {
    this.provenance(artifact, run);
    if (
      artifact.expired ||
      Date.parse(artifact.expires_at) <= Date.now() ||
      artifact.size_in_bytes > limit
    )
      throw new StateError("agent_artifact_unavailable");
    const folder = join(directory, String(artifact.id));
    await mkdir(folder, { mode: 0o700 });
    const digest = artifact.digest.slice("sha256:".length);
    const downloaded = (await this.helper(
      {
        operation: "download",
        id: artifact.id,
        digest,
        run: run.id,
        directory: folder,
      },
      limit,
      signal,
    )) as { digestMismatch?: boolean };
    const files = await readdir(folder);
    if (downloaded.digestMismatch || files.length !== 1)
      throw new StateError("session_corrupt");
    const path = join(folder, files[0]);
    const actual = await fileDigest(path, limit, signal);
    if (actual.digest !== digest || actual.size !== artifact.size_in_bytes)
      throw new StateError("session_corrupt");
    const zip = await openZip(path, {
      autoClose: false,
      strictFileNames: true,
    });
    // The pinned runner allows a 10,000-file inventory with paths up to 512 characters.
    const entryLimit = entryName === "manifest.json" ? 32 * 1024 * 1024 : limit;
    try {
      if (
        zip.entryCount < 1 ||
        zip.entryCount > 10001 ||
        (entryName === "record.json" && zip.entryCount !== 1)
      )
        throw new StateError("session_corrupt");
      let value: unknown;
      let found = false;
      for await (const entry of zip.eachEntry()) {
        signal.throwIfAborted();
        if (entry.fileName !== entryName) continue;
        if (found || entry.isEncrypted() || entry.uncompressedSize > entryLimit)
          throw new StateError("session_corrupt");
        found = true;
        const stream = await zip.openReadStreamPromise(entry);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          signal.throwIfAborted();
          chunks.push(chunk);
        }
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      }
      if (!found) throw new StateError("session_corrupt");
      return value;
    } finally {
      zip.close();
    }
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
    prepared: PreparedArtifact,
    limit: number,
    signal: AbortSignal,
  ) {
    if (
      prepared.run_id !== this.context.run_id ||
      prepared.run_attempt !== this.context.run_attempt ||
      prepared.repository_id !== this.context.repository_id
    )
      throw new StateError("session_provenance_invalid");
    if (prepared.size > limit) throw new StateError("session_size_limit");
    const run = await this.run(prepared.run_id, prepared.run_attempt, signal);
    const name = basename(path);
    if (name !== `orm-session-${prepared.checkpoint_id}.orm`)
      throw new StateError("session_provenance_invalid");
    const existing = await this.checkpointReference(prepared, run, signal);
    if (existing) return existing;
    const started = performance.now();
    let uploaded: { id: number; size: number; digest: string } | undefined;
    let uploadFailure: string | undefined;
    try {
      uploaded = z
        .object({
          id: positive,
          size: positive,
          digest: z.string(),
        })
        .parse(
          await this.helper(
            { operation: "upload", name, path, directory: dirname(path) },
            limit,
            signal,
          ),
        );
    } catch (error) {
      signal.throwIfAborted();
      uploadFailure = apiFailureId(error);
    }
    const log = {
      operation_id: prepared.checkpoint_id,
      producer_run_id: run.id,
      producer_attempt: run.run_attempt,
      generation: prepared.generation,
      expected_digest: prepared.digest,
      expected_size: prepared.size,
      request_id: uploadFailure,
    };
    for (let attempt = 1; attempt <= 5; attempt++) {
      const reference = await this.checkpointReference(prepared, run, signal);
      if (reference) {
        if (
          uploaded &&
          (uploaded.id !== reference.artifact_id ||
            uploaded.size !== reference.size ||
            uploaded.digest !== reference.digest)
        )
          throw new StateError("session_provenance_invalid");
        this.diagnostics.event("checkpoint.acknowledged", {
          ...log,
          level: "info",
          artifact_id: reference.artifact_id,
          attempt,
          elapsed_ms: Math.round(performance.now() - started),
          outcome: "completed",
        });
        return reference;
      }
      this.diagnostics.event("checkpoint.visibility", {
        ...log,
        level: "warn",
        artifact_id: uploaded?.id,
        attempt,
        elapsed_ms: Math.round(performance.now() - started),
        cause: uploadFailure
          ? "upload_receipt_unavailable"
          : "artifact_not_visible",
        outcome: attempt < 5 ? "retrying" : "reconcile",
      });
      if (attempt < 5) await setTimeout(350, undefined, { signal });
    }
    throw new StateError("session_upload_uncertain");
  }

  async locate(prepared: PreparedArtifact, signal: AbortSignal) {
    if (prepared.repository_id !== this.context.repository_id)
      throw new StateError("session_provenance_invalid");
    const run = await this.run(prepared.run_id, prepared.run_attempt, signal);
    return this.checkpointReference(prepared, run, signal);
  }

  private async checkpointReference(
    prepared: PreparedArtifact,
    run: z.infer<typeof runSchema>,
    signal: AbortSignal,
  ) {
    const name = `orm-session-${prepared.checkpoint_id}.orm`;
    const rows = await this.artifacts(run.id, name, signal);
    if (!rows.length) return undefined;
    if (rows.length !== 1 || rows[0].name !== name)
      throw new StateError("session_provenance_invalid");
    const artifact = rows[0];
    this.provenance(artifact, run);
    const expires = Date.parse(artifact.expires_at);
    if (
      artifact.digest !== `sha256:${prepared.digest}` ||
      artifact.size_in_bytes !== prepared.size ||
      expires > Date.now() + 14 * 86400000 + 60000
    )
      throw new StateError("session_provenance_invalid");
    if (artifact.expired || expires <= Date.now()) return undefined;
    return {
      ...prepared,
      artifact_id: artifact.id,
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
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      });
      let output = "",
        bytes = 0,
        fault: unknown;
      let watching: Promise<void> | undefined;
      const decoder = new StringDecoder("utf8");
      let diagnosticPending = "";
      child.stdio[4]?.on("data", (chunk: Buffer) => {
        diagnosticPending += decoder.write(chunk);
        let end: number;
        while ((end = diagnosticPending.indexOf("\n")) !== -1) {
          const line = diagnosticPending.slice(0, end);
          diagnosticPending = diagnosticPending.slice(end + 1);
          try {
            if (Buffer.byteLength(line) > 2048)
              throw new Error("API diagnostic record exceeds limit.");
            this.diagnostics.forward(JSON.parse(line));
          } catch (error) {
            stop(error);
          }
        }
        if (Buffer.byteLength(diagnosticPending) > 2048)
          stop(new StateError("session_size_limit"));
      });
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
      const abort = () => {
        this.diagnostics.interrupt(combined.reason);
        stop(combined.reason);
      };
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
        if (fault || code !== 0)
          this.diagnostics.interrupt(
            fault ?? new StateError("session_transport_unavailable"),
          );
        this.diagnostics.flush();
        if (diagnosticPending)
          this.diagnostics.event("api.capture.incomplete", {
            provider: "artifact",
            operation: String(request.operation),
            capture_state: "interrupted",
            omitted_bytes: -1,
          });
        clearInterval(timer);
        combined.removeEventListener("abort", abort);
        await watching;
        if (fault || code !== 0) {
          const failure =
            fault ?? new StateError("session_transport_unavailable");
          if (!fault) {
            try {
              const parsed = JSON.parse(output) as { request_id?: unknown };
              if (
                typeof parsed.request_id === "string" &&
                /^[a-f0-9-]{36}$/.test(parsed.request_id)
              )
                tagApiFailure(failure, parsed.request_id);
            } catch {
              /* A killed helper may not complete its result frame. */
            }
          }
          return reject(failure);
        }
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
