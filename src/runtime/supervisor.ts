import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { setInterval, clearInterval } from "node:timers";
import type { RunSnapshot } from "../config/load.ts";
import type { SecretAccessor } from "../config/secrets.ts";
import { roleNames, type Role } from "../config/schema.ts";
import { immutable } from "../config/bundles.ts";
import {
  digest,
  RuntimeError,
  roleUsers,
  workerLimits,
  type AgentEvent,
  type AgentRunner,
  type AgentRunRequest,
} from "../domain/agents.ts";
import type { SourceMetadata } from "../domain/jobs.ts";
import type { Store } from "../repositories/store.ts";
import { BootstrapService } from "../services/bootstrap/index.ts";
import { commandDirectory } from "../services/bootstrap/environment.ts";
import type {
  BootstrapCommand,
  CommandReceipt,
} from "../services/bootstrap/contracts.ts";
import { PublicationService } from "../services/publication/index.ts";
import type { GitHubWriter } from "../adapters/github/writer.ts";
import { runCommand } from "../adapters/toolchains/process.ts";
import type { CandidateCommit } from "../domain/remote-turns.ts";
import {
  WorkspaceService,
  type PreparedWorkspace,
} from "../services/workspaces/index.ts";
import type { RemoteAgents } from "./remote-agents.ts";
import { cleanTemporary, treeBytes } from "../services/workspaces/files.ts";
import {
  assertRuntimeIdentity,
  cleanUser,
  deletedFileBytes,
  userProcesses,
} from "./process.ts";

export type BootstrapLease = Readonly<{
  lease: string;
  deadline: number;
  signal: AbortSignal;
  request: AgentRunRequest;
  abort: (reason: RuntimeError) => void;
}>;
export type SupervisorOptions = {
  root?: string;
  agents?: RemoteAgents;
  sourceUrl?: (repository: string) => string;
  publicationWriter?: (ready: () => void) => GitHubWriter;
};

export class Supervisor implements AgentRunner {
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private runtimeFailure: string | null = null;
  readonly workspaces: WorkspaceService;
  readonly bootstrap: BootstrapService;
  readonly publication: PublicationService;
  private readonly bootstrapLeases = new Set<BootstrapLease>();
  private readonly bootstrapOutput = new Map<string, number>();
  private readonly store: Store;
  private readonly snapshot: RunSnapshot;
  private readonly secrets: SecretAccessor;
  private readonly options: SupervisorOptions;
  private constructor(
    store: Store,
    snapshot: RunSnapshot,
    secrets: SecretAccessor,
    options: SupervisorOptions,
  ) {
    this.store = store;
    this.snapshot = snapshot;
    this.secrets = secrets;
    this.options = options;
    this.workspaces = new WorkspaceService(
      options.root ?? "/data/runtime",
      secrets,
      options.sourceUrl,
    );
    this.bootstrap = new BootstrapService(this, store, secrets);
    this.publication = new PublicationService(this, store, secrets, {
      writer: options.publicationWriter,
      sourceUrl: options.sourceUrl,
    });
  }

  static async create(
    store: Store,
    snapshot: RunSnapshot,
    secrets: SecretAccessor,
    options: SupervisorOptions = {},
  ) {
    const supervisor = new Supervisor(store, snapshot, secrets, options);
    await assertRuntimeIdentity();
    await supervisor.workspaces.initialize();
    for (const uid of [10001, 10002, 10003]) {
      await cleanUser(uid);
      await cleanTemporary(uid);
    }
    store.interruptBootstrap();
    await supervisor.bootstrap.initialize();
    for (const lease of store.leases()) store.accountActive(lease.token);
    for (const run of store.runs().filter((run) => run.finished_at === null)) {
      await supervisor.workspaces.remove(run.id);
      store.finishRun(run.id, "interrupted", null, null);
    }
    for (const lease of store.leases()) store.releaseLease(lease.token);
    return supervisor;
  }

  status() {
    return {
      state: this.runtimeFailure
        ? "unavailable"
        : this.controller.signal.aborted
          ? "stopped"
          : "ready",
      reason: this.runtimeFailure,
    };
  }

  request(
    jobId: number,
    role: Role,
    input?: unknown,
    artifact?: string,
  ): AgentRunRequest {
    const job = this.store.jobById(jobId);
    if (!job || !roleNames.includes(role))
      throw new RuntimeError("request_invalid");
    const snapshot = this.store.snapshot(job.snapshot_digest);
    const source = (JSON.parse(job.input_json) as { source: SourceMetadata })
      .source;
    return immutable({
      job_id: job.id,
      revision: job.revision,
      role,
      workspace: { source, ...(artifact ? { artifact } : {}) },
      snapshot_digest: job.snapshot_digest,
      profile: snapshot.roles[role].profile,
      ...(input === undefined ? {} : { input }),
    });
  }

  repositoryName() {
    return this.snapshot.settings.github.repository;
  }

  outputReviewAvailable() {
    return Boolean(this.options.agents);
  }

  run(
    request: AgentRunRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    return this.execute(request, signal);
  }

  async withBootstrapLease<T>(
    request: AgentRunRequest,
    signal: AbortSignal,
    operation: (session: BootstrapLease) => Promise<T>,
  ): Promise<T> {
    return this.withJobLease(request, signal, operation);
  }

  async withPublicationNotice<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const current = AbortSignal.any([
      signal,
      this.controller.signal,
      AbortSignal.timeout(30000),
    ]);
    current.throwIfAborted();
    const task = operation(current);
    const tracked = task.then(
      () => {},
      () => {},
    );
    this.tasks.add(tracked);
    try {
      return await task;
    } finally {
      this.tasks.delete(tracked);
    }
  }

  async withJobLease<T>(
    request: AgentRunRequest,
    signal: AbortSignal,
    operation: (session: BootstrapLease) => Promise<T>,
  ): Promise<T> {
    return this.withLease(request, signal, operation);
  }

  private async withLease<T>(
    request: AgentRunRequest,
    signal: AbortSignal,
    operation: (session: BootstrapLease) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.validate(request),
      lease = this.store.acquireLease(request.job_id, request.revision);
    if (!lease) throw new RuntimeError("lease_busy");
    const controller = new AbortController();
    let session: BootstrapLease | undefined;
    const timer = setInterval(() => {
      try {
        this.store.accountActive(lease);
        if (session && Date.now() >= session.deadline)
          controller.abort(new RuntimeError("active_budget_exhausted"));
        else if (!this.store.runtimeCurrent(lease))
          controller.abort(new RuntimeError("revision_stale"));
      } catch {
        controller.abort(new RuntimeError("monitor_failed"));
      }
    }, 100);
    const operationTask = (async () => {
      let result: T | undefined, failure: { error: unknown } | undefined;
      try {
        const deadline = this.store.startRuntimeLease(
          lease,
          snapshot.settings.limits.active_minutes * 60_000,
        );
        await this.store.checkpoint(
          AbortSignal.any([signal, controller.signal, this.controller.signal]),
        );
        session = {
          lease,
          deadline,
          request,
          signal: AbortSignal.any([
            signal,
            controller.signal,
            this.controller.signal,
          ]),
          abort: (reason) => controller.abort(reason),
        };
        this.bootstrapLeases.add(session);
        this.validate(request);
        session.signal.throwIfAborted();
        result = await operation(session);
      } catch (error) {
        failure = { error };
      } finally {
        clearInterval(timer);
        if (session) this.bootstrapLeases.delete(session);
        this.store.accountActive(lease);
        if (!this.store.releaseLease(lease))
          failure = {
            error: new RuntimeError("cleanup_failed", {
              cause:
                failure?.error instanceof RuntimeError
                  ? failure.error
                  : undefined,
            }),
          };
      }
      if (failure) {
        if (
          failure.error instanceof RuntimeError &&
          failure.error.code === "cleanup_failed"
        )
          this.runtimeFailure = "cleanup_failed";
        throw failure.error;
      }
      await this.store.checkpoint(signal);
      return result!;
    })();
    const tracked = operationTask.then(
      () => {},
      () => {},
    );
    this.tasks.add(tracked);
    try {
      return await operationTask;
    } finally {
      this.tasks.delete(tracked);
    }
  }

  runBootstrapAgent(session: BootstrapLease, request: AgentRunRequest) {
    return this.runJobAgent(session, request);
  }

  runJobAgent(session: BootstrapLease, request: AgentRunRequest) {
    this.validateBootstrapLease(session, request);
    return this.execute(request, session.signal);
  }

  private validateBootstrapLease(
    session: BootstrapLease,
    request: AgentRunRequest,
  ) {
    if (
      !this.bootstrapLeases.has(session) ||
      !this.store.runtimeCurrent(session.lease) ||
      request.job_id !== session.request.job_id ||
      request.revision !== session.request.revision
    )
      throw new RuntimeError("revision_stale");
    session.signal.throwIfAborted();
  }

  async bootstrapWorkspace<T>(
    session: BootstrapLease,
    request: AgentRunRequest,
    operation: (workspace: PreparedWorkspace, runId: string) => Promise<T>,
    publishedHead?: string,
    requiredAncestor?: string,
  ): Promise<T> {
    this.validateBootstrapLease(session, request);
    const candidate =
      request.workspace.artifact &&
      this.store.candidate(request.workspace.artifact);
    if (
      publishedHead &&
      (request.role !== "audit" ||
        (!requiredAncestor &&
          publishedHead !== this.store.durability?.publishedHead()))
    )
      throw new RuntimeError("publication_head_changed");
    const snapshot = this.store.snapshot(request.snapshot_digest),
      id = randomUUID(),
      user = roleUsers[request.role],
      limits = workerLimits(snapshot);
    let prepared: PreparedWorkspace | undefined,
      completed = false,
      cleanupFailure: RuntimeError | undefined,
      cleanupStep = "processes",
      registered = false;
    let watching: Promise<void> | undefined;
    let result: T | undefined, failure: { error: unknown } | undefined;
    const signal = session.signal;
    const watch = setInterval(() => {
      if (prepared && !watching)
        watching = (async () => {
          let used = await treeBytes(prepared!.root, limits.storage);
          for (const path of ["/tmp", "/var/tmp", "/dev/shm", "/run/lock"]) {
            try {
              if (!(await lstat(path)).isSymbolicLink())
                used += await treeBytes(path, limits.storage - used, user.uid);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
          used += await deletedFileBytes(user.uid, limits.storage - used);
          if (used > limits.storage) throw new RuntimeError("storage_limit");
        })()
          .catch((error) =>
            session.abort(
              error instanceof RuntimeError
                ? error
                : new RuntimeError("monitor_failed"),
            ),
          )
          .finally(() => {
            watching = undefined;
          });
    }, 100);
    try {
      if ((await userProcesses(user.uid)).length)
        throw new RuntimeError("worker_user_busy");
      this.store.startRun({
        id,
        job_id: request.job_id,
        revision: request.revision,
        role: request.role,
        uid: user.uid,
        parent_id: null,
        lease_token: session.lease,
        binding_json: "{}",
      });
      registered = true;
      this.bootstrapOutput.set(id, 0);
      prepared = await this.workspaces.prepare(
        id,
        request.role,
        snapshot.roles[request.role].bundle,
        request.workspace.source,
        snapshot.settings.github.repository,
        limits,
        signal,
        publishedHead ?? (candidate ? candidate.sha : undefined),
        requiredAncestor,
      );
      if (request.workspace.artifact && !candidate) {
        const artifact = this.store.artifact(
          request.workspace.artifact,
          request.job_id,
          request.revision,
        );
        if (digest(artifact.source) !== digest(request.workspace.source))
          throw new RuntimeError("artifact_source_mismatch");
        await this.workspaces.restore(
          artifact,
          prepared.workspace,
          request.role,
          limits.storage,
          signal,
        );
      }
      result = await operation(prepared, id);
      signal.throwIfAborted();
      this.validateBootstrapLease(session, request);
      completed = true;
    } catch (error) {
      failure = { error };
    } finally {
      clearInterval(watch);
      this.bootstrapOutput.delete(id);
      await watching;
      try {
        if (registered) {
          await cleanUser(user.uid);
          cleanupStep = "temporary";
          await cleanTemporary(user.uid);
          cleanupStep = "workspace";
          await this.workspaces.remove(id);
        }
      } catch (error) {
        const code =
          error instanceof RuntimeError
            ? error.code
            : (error as NodeJS.ErrnoException)?.code;
        const cause =
          typeof code === "string" &&
          /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) &&
          !this.secrets.containsCredentials(code)
            ? new RuntimeError(code)
            : undefined;
        cleanupFailure = new RuntimeError(`cleanup_${cleanupStep}_failed`, {
          cause,
        });
      }
      if (cleanupFailure) {
        this.runtimeFailure = "cleanup_failed";
        failure = {
          error: new RuntimeError("cleanup_failed", { cause: cleanupFailure }),
        };
      }
      if (!cleanupFailure && this.store.run(id))
        this.store.finishRun(
          id,
          completed ? "completed" : "failed",
          null,
          null,
        );
    }
    if (failure) throw failure.error;
    return result!;
  }

  async bootstrapCommand(
    session: BootstrapLease,
    request: AgentRunRequest,
    prepared: PreparedWorkspace,
    attempt: string,
    runId: string,
    argv: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    operation: string,
    captureNonzero = false,
  ) {
    this.validateBootstrapLease(session, request);
    const limits = workerLimits(this.store.snapshot(request.snapshot_digest));
    try {
      return await runCommand(argv[0], argv.slice(1), {
        cwd,
        env: environment,
        role: request.role,
        processes: limits.processes,
        signal: session.signal,
        limit: limits.output - (this.bootstrapOutput.get(runId) ?? 0),
        operation,
        capture_nonzero: captureNonzero,
        secrets: this.secrets,
        record: (receipt) => {
          this.store.recordBootstrapCommand(attempt, runId, receipt);
          if (receipt.finished_at !== null)
            this.bootstrapOutput.set(
              runId,
              (this.bootstrapOutput.get(runId) ?? 0) + receipt.output_bytes,
            );
        },
      });
    } finally {
      await cleanUser(roleUsers[request.role].uid);
      await cleanTemporary(roleUsers[request.role].uid);
      await treeBytes(prepared.root, limits.storage);
    }
  }

  async reproduce(
    request: AgentRunRequest,
    command: BootstrapCommand,
    signal: AbortSignal,
  ) {
    if (
      request.role !== "investigation" ||
      !request.bootstrap_receipt ||
      request.workspace.artifact
    )
      throw new RuntimeError("investigation_command_invalid");
    const bootstrap = this.bootstrap.receipt(request);
    return this.withJobLease(request, signal, (lease) =>
      this.bootstrapWorkspace(lease, request, async (workspace, runId) => {
        const setup = await this.bootstrap.materialize(
          request,
          workspace,
          runId,
          lease.signal,
          (argv, cwd, env, operation) =>
            this.bootstrapCommand(
              lease,
              request,
              workspace,
              bootstrap.id,
              runId,
              argv,
              cwd,
              env,
              operation,
            ),
        );
        const cwd = await commandDirectory(workspace.workspace, command.cwd);
        const output = await this.bootstrapCommand(
          lease,
          request,
          workspace,
          bootstrap.id,
          runId,
          command.argv,
          cwd,
          setup.environment,
          "investigation-reproduction",
          true,
        );
        const receipt = this.store
          .bootstrapCommands(bootstrap.id)
          .filter((entry) => entry.operation === "investigation-reproduction")
          .at(-1) as CommandReceipt | undefined;
        if (
          !receipt ||
          receipt.finished_at === null ||
          receipt.exit_code !== output.exit_code
        )
          throw new RuntimeError("investigation_command_receipt_missing");
        return {
          run_id: runId,
          bootstrap_receipt: bootstrap.id,
          environment: bootstrap.environment,
          command: { ...receipt, cwd: command.cwd },
          output,
        };
      }),
    );
  }

  private validate(request: AgentRunRequest) {
    const job = this.store.jobById(request.job_id);
    if (
      !job ||
      job.revision !== request.revision ||
      job.status !== "pending" ||
      job.snapshot_digest !== request.snapshot_digest ||
      !roleNames.includes(request.role)
    )
      throw new RuntimeError("revision_stale");
    const snapshot = this.store.snapshot(job.snapshot_digest),
      saved = JSON.parse(job.input_json) as { source: SourceMetadata };
    if (
      digest(saved.source) !== digest(request.workspace.source) ||
      digest(snapshot.roles[request.role].profile) !==
        digest(request.profile) ||
      snapshot.settings.github.repository !==
        this.snapshot.settings.github.repository
    )
      throw new RuntimeError("snapshot_mismatch");
    if (this.secrets.containsCredentials(request))
      throw new RuntimeError("secret_in_request");
    return snapshot;
  }

  private async *execute(
    request: AgentRunRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.validate(request);
    const agents = this.options.agents;
    if (!agents) throw new RuntimeError("backend_unavailable");
    const current = AbortSignal.any([signal, this.controller.signal]);
    const accepted = await agents.execute(request, current);
    current.throwIfAborted();
    this.validate(request);
    let artifact = request.workspace.artifact;
    if (accepted.candidate) {
      const inspection = {
        ...request,
        role: "audit" as const,
        profile: this.store.snapshot(request.snapshot_digest).roles.audit
          .profile,
        workspace: { source: request.workspace.source },
      };
      artifact = await this.captureCandidate(
        inspection,
        accepted.candidate,
        accepted.starting_sha,
        current,
      );
    }
    this.store.registerRemoteRun(
      accepted.id,
      request.job_id,
      request.revision,
      request.role,
      accepted,
    );
    yield {
      type: "terminal",
      outcome: "completed",
      result: accepted.result,
      artifact,
      run_id: accepted.id,
    };
  }

  async captureCandidate(
    request: AgentRunRequest,
    candidate: CandidateCommit,
    ancestor: string,
    signal: AbortSignal,
  ) {
    const artifact = await this.withJobLease(request, signal, (lease) =>
      this.bootstrapWorkspace(
        lease,
        request,
        async (prepared, id) => {
          const manifest = await this.workspaces.freeze(
            {
              run_id: id,
              job_id: request.job_id,
              revision: request.revision,
              source: request.workspace.source,
            },
            prepared.workspace,
            workerLimits(this.store.snapshot(request.snapshot_digest)).storage,
            lease.signal,
          );
          return this.store.recordArtifact(manifest);
        },
        candidate.sha,
        ancestor,
      ),
    );
    this.store.recordCandidate(artifact, candidate);
    return artifact;
  }

  async close() {
    this.controller.abort(new RuntimeError("cancelled"));
    await Promise.all(this.tasks);
    if (this.store.runs().some((run) => run.finished_at === null))
      throw new RuntimeError("cleanup_failed");
  }
}
