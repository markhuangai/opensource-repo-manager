import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { setInterval, clearInterval } from "node:timers";
import type { RunSnapshot } from "../config/load.ts";
import type { SecretAccessor } from "../config/secrets.ts";
import { roleNames, type Role } from "../config/schema.ts";
import { immutable } from "../config/bundles.ts";
import { createKnownSecretChecker } from "../logging/redact.ts";
import {
  digest,
  RuntimeError,
  roleUsers,
  workerEnvelopeSchema,
  workerLimits,
  type AgentEvent,
  type AgentRunner,
  type AgentRunRequest,
  type McpSessionProvider,
  type WorkerRequest,
} from "../domain/agents.ts";
import type { SourceMetadata } from "../domain/jobs.ts";
import type { Store } from "../repositories/store.ts";
import { ModelRelay } from "../services/model-relay.ts";
import {
  WorkspaceService,
  type PreparedWorkspace,
} from "../services/workspaces/index.ts";
import { cleanTemporary, treeBytes } from "../services/workspaces/files.ts";
import {
  assertRuntimeIdentity,
  cleanEnvironment,
  cleanUser,
  deletedFileBytes,
  signalUser,
  spawnAsRole,
  suspendUser,
  trustedExecutable,
  userProcesses,
} from "./process.ts";

class EventQueue {
  private values: AgentEvent[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  private failure: unknown;
  push(event: AgentEvent) {
    this.values.push(event);
    this.waiter?.();
  }
  end(error?: unknown) {
    this.ended = true;
    this.failure = error;
    this.waiter?.();
  }
  async *events() {
    for (;;) {
      const event = this.values.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = undefined;
    }
  }
}

type ActiveRun = {
  id: string;
  lease: string;
  request: AgentRunRequest;
  snapshot: RunSnapshot;
  deadline: number;
  controller: AbortController;
  signal: AbortSignal;
  suspended: boolean;
  reviewing: boolean;
  reviewTask?: Promise<void>;
  reviewCleanupFailed?: boolean;
};
export type SupervisorOptions = {
  root?: string;
  workers?: Partial<Record<"claude" | "codex", string>>;
  mcp?: McpSessionProvider;
  sourceUrl?: (repository: string) => string;
};

export class Supervisor implements AgentRunner {
  private readonly controller = new AbortController();
  private readonly active = new Map<string, ActiveRun>();
  private readonly tasks = new Set<Promise<void>>();
  readonly workspaces: WorkspaceService;
  private readonly relay: ModelRelay;
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
    this.relay = new ModelRelay(store, snapshot.settings.proxy.url, secrets);
  }

  static async create(
    store: Store,
    snapshot: RunSnapshot,
    secrets: SecretAccessor,
    options: SupervisorOptions = {},
  ) {
    const supervisor = new Supervisor(store, snapshot, secrets, options);
    try {
      await assertRuntimeIdentity();
      await supervisor.workspaces.initialize();
      for (const uid of [10001, 10002, 10003]) {
        await cleanUser(uid);
        await cleanTemporary(uid);
      }
      for (const lease of store.leases()) store.accountActive(lease.token);
      for (const run of store
        .runs()
        .filter((run) => run.finished_at === null)) {
        await supervisor.workspaces.remove(run.id);
        store.finishRun(run.id, "interrupted", null, null);
      }
      for (const lease of store.leases()) store.releaseLease(lease.token);
      await supervisor.relay.start();
      return supervisor;
    } catch (error) {
      await supervisor.relay.close();
      throw error;
    }
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

  run(
    request: AgentRunRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    return this.execute(request, signal);
  }

  async *runReview(
    parentId: string,
    request: AgentRunRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const parent = this.active.get(parentId);
    if (
      !parent ||
      !this.store.runtimeCurrent(parent.lease) ||
      parent.reviewing ||
      parent.suspended ||
      roleUsers[parent.request.role].uid !== 10001 ||
      !["audit", "output_review"].includes(request.role) ||
      request.job_id !== parent.request.job_id ||
      request.revision !== parent.request.revision
    )
      throw new RuntimeError("review_parent_invalid");
    parent.reviewing = true;
    parent.suspended = true;
    const queue = new EventQueue(),
      controller = new AbortController();
    const task = (async () => {
      let failure: unknown;
      try {
        await suspendUser(10001);
        for await (const event of this.execute(
          request,
          AbortSignal.any([signal, parent.signal, controller.signal]),
          parent,
        ))
          queue.push(event);
      } catch (error) {
        failure = error;
        if (error instanceof RuntimeError && error.code === "cleanup_failed") {
          parent.reviewCleanupFailed = true;
          parent.controller.abort(error);
        }
      } finally {
        parent.reviewing = false;
        parent.suspended = false;
        try {
          if (!parent.signal.aborted && !parent.reviewCleanupFailed)
            await signalUser(10001, "SIGCONT");
        } catch (error) {
          failure = error;
          parent.reviewCleanupFailed = true;
          parent.controller.abort(new RuntimeError("cleanup_failed"));
        }
        parent.reviewTask = undefined;
        queue.end(failure);
      }
    })();
    parent.reviewTask = task;
    try {
      yield* queue.events();
    } finally {
      controller.abort(new RuntimeError("consumer_cancelled"));
      await task;
    }
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
        this.snapshot.settings.github.repository ||
      snapshot.settings.proxy.url !== this.snapshot.settings.proxy.url
    )
      throw new RuntimeError("snapshot_mismatch");
    if (this.secrets.containsCredentials(request))
      throw new RuntimeError("secret_in_request");
    return snapshot;
  }

  private async *execute(
    request: AgentRunRequest,
    signal: AbortSignal,
    parent?: ActiveRun,
  ): AsyncIterable<AgentEvent> {
    const snapshot = this.validate(request),
      worker = this.options.workers?.[request.profile.sdk];
    if (!worker) throw new RuntimeError("backend_unavailable");
    await trustedExecutable(worker);
    const bootstrap = fileURLToPath(new URL("./worker.js", import.meta.url));
    await trustedExecutable(bootstrap);
    const grant = snapshot.roles[request.role].mcp;
    const hasGrants = Object.values(grant).some(
      (value) => Object.keys(value.tools).length > 0,
    );
    if (hasGrants && !this.options.mcp)
      throw new RuntimeError("mcp_unavailable");
    const controller = new AbortController(),
      combined = AbortSignal.any([
        signal,
        this.controller.signal,
        controller.signal,
        ...(parent ? [parent.signal] : []),
      ]);
    combined.throwIfAborted();
    const lease =
      parent?.lease ??
      this.store.acquireLease(request.job_id, request.revision);
    if (!lease) throw new RuntimeError("lease_busy");
    let deadline: number;
    try {
      deadline =
        parent?.deadline ??
        this.store.startRuntimeLease(
          lease,
          snapshot.settings.limits.active_minutes * 60_000,
        );
    } catch (error) {
      if (!parent) this.store.releaseLease(lease);
      throw error;
    }
    const context: ActiveRun = {
      id: randomUUID(),
      lease,
      request,
      snapshot,
      deadline,
      controller,
      signal: combined,
      suspended: false,
      reviewing: false,
    };
    this.active.set(context.id, context);
    const queue = new EventQueue();
    const task = this.work(context, worker, bootstrap, queue, parent).catch(
      (error) => queue.end(error),
    );
    this.tasks.add(task);
    try {
      yield* queue.events();
    } finally {
      controller.abort(new RuntimeError("consumer_cancelled"));
      await task;
      this.tasks.delete(task);
      this.active.delete(context.id);
    }
  }

  private async work(
    context: ActiveRun,
    worker: string,
    bootstrap: string,
    queue: EventQueue,
    parent?: ActiveRun,
  ) {
    const { request, snapshot, signal, lease, id } = context,
      identity = roleUsers[request.role],
      limits = workerLimits(snapshot);
    let prepared: PreparedWorkspace | undefined,
      mcp: Awaited<ReturnType<McpSessionProvider["open"]>> | undefined;
    let relay: ReturnType<ModelRelay["authorize"]> | undefined,
      registered = false,
      cleaned = false;
    let session: string | null = null,
      terminal: Extract<AgentEvent, { type: "terminal" }> | undefined;
    let closeProvider: Promise<void> | undefined,
      termination: Promise<void> | undefined,
      watching: Promise<void> | undefined;
    let cleanupFailure: unknown,
      cleanupStep = "connections";
    const revoke = () => {
      relay?.revoke();
      if (mcp && !closeProvider) closeProvider = mcp.close();
      if (closeProvider)
        void closeProvider.catch((error) => {
          cleanupFailure = error;
        });
    };
    const abort = () => {
      revoke();
      if (registered && !termination) termination = cleanUser(identity.uid);
      if (termination)
        void termination.catch((error) => {
          cleanupFailure = error;
        });
    };
    signal.addEventListener("abort", abort, { once: true });
    const expiry =
      context.deadline - Date.now() <= 2_147_483_647
        ? setTimeout(
            () =>
              context.controller.abort(
                new RuntimeError("active_budget_exhausted"),
              ),
            Math.max(1, context.deadline - Date.now()),
          )
        : undefined;
    const timer = setInterval(() => {
      if (watching) return;
      watching = (async () => {
        if (Date.now() >= context.deadline)
          throw new RuntimeError("active_budget_exhausted");
        if (!this.store.runtimeCurrent(lease))
          throw new RuntimeError("revision_stale");
        if (!parent) this.store.accountActive(lease);
        if (prepared) {
          let used = await treeBytes(prepared.root, limits.storage);
          for (const path of ["/tmp", "/var/tmp", "/dev/shm", "/run/lock"]) {
            try {
              const stat = await lstat(path);
              if (!stat.isSymbolicLink())
                used += await treeBytes(
                  path,
                  limits.storage - used,
                  identity.uid,
                );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
          used += await deletedFileBytes(identity.uid, limits.storage - used);
          if (used > limits.storage) throw new RuntimeError("storage_limit");
        }
      })()
        .catch((error) =>
          context.controller.abort(
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
      if ((await userProcesses(identity.uid)).length)
        throw new RuntimeError("worker_user_busy");
      this.store.startRun({
        id,
        job_id: request.job_id,
        revision: request.revision,
        role: request.role,
        uid: identity.uid,
        parent_id: parent?.id ?? null,
        lease_token: lease,
        binding_json: "{}",
      });
      registered = true;
      prepared = await this.workspaces.prepare(
        id,
        request.role,
        snapshot.roles[request.role].bundle,
        request.workspace.source,
        snapshot.settings.github.repository,
        limits,
        signal,
      );
      signal.throwIfAborted();
      if (request.workspace.artifact) {
        const manifest = this.store.artifact(
          request.workspace.artifact,
          request.job_id,
          request.revision,
        );
        if (digest(manifest.source) !== digest(request.workspace.source))
          throw new RuntimeError("artifact_source_mismatch");
        await this.workspaces.restore(
          manifest,
          prepared.workspace,
          request.role,
          limits.storage,
          signal,
        );
      }
      if (hasTools(grantFor(snapshot, request.role))) {
        mcp = await this.options.mcp!.open({
          run_id: id,
          job_id: request.job_id,
          revision: request.revision,
          role: request.role,
          grants: grantFor(snapshot, request.role),
          deadline: context.deadline,
          signal,
          available: () => !context.suspended,
        });
        this.validateMcp(mcp, context);
      }
      signal.throwIfAborted();
      const binding = digest({
        job_id: request.job_id,
        revision: request.revision,
        role: request.role,
        source: request.workspace.source,
        input: request.input,
        artifact: request.workspace.artifact,
        snapshot: request.snapshot_digest,
        profile: request.profile,
        policy: mcp?.policy_identity ?? digest({}),
        catalog: mcp?.catalog_identity ?? digest({}),
      });
      if (
        request.resume &&
        (["audit", "output_review"].includes(request.role) ||
          !this.store
            .runs()
            .some(
              (run) =>
                run.finished_at !== null &&
                run.job_id === request.job_id &&
                run.revision === request.revision &&
                run.role === request.role &&
                run.session_id === request.resume!.id &&
                run.binding_json === JSON.stringify({ binding }) &&
                request.resume!.binding === binding,
            ))
      )
        throw new RuntimeError("resume_mismatch");
      this.store.bindRun(id, binding);
      relay = this.relay.authorize({
        lease,
        profile: request.profile,
        deadline: context.deadline,
        requests: snapshot.settings.limits.model_requests,
        bytes: limits.output,
        signal,
        current: () => this.store.runtimeCurrent(lease),
        available: () => !context.suspended,
      });
      const workerRequest: WorkerRequest = {
        ...request,
        run_id: id,
        workspace: prepared.workspace,
        home: prepared.home,
        temporary: prepared.temporary,
        prompts: prepared.prompts,
        relay: { url: relay.url, authorization: relay.authorization },
        mcp:
          mcp?.connections.map((connection) => ({
            alias: connection.alias,
            url: connection.url,
            authorization: connection.authorization,
            tools: [...connection.tools],
            deadline: connection.deadline,
          })) ?? [],
        binding,
      };
      const outputCredentials = createKnownSecretChecker([
          workerRequest.relay.authorization,
          ...workerRequest.mcp.map((connection) => connection.authorization),
        ]),
        credentialStream = outputCredentials.createStream(),
        input = JSON.stringify(workerRequest);
      if (Buffer.byteLength(input) > 32 * 1024 * 1024)
        throw new RuntimeError("request_limit");
      const child = spawnAsRole(
        request.role,
        "/opt/orm-runtime/bin/node",
        [bootstrap, worker],
        {
          cwd: prepared.workspace,
          env: cleanEnvironment(
            prepared.home,
            prepared.temporary,
            identity.name,
          ),
          processes: limits.processes,
          protocol: true,
        },
      );
      let output = 0,
        pending = Buffer.alloc(0),
        protocolFailure: RuntimeError | undefined;
      const fail = (code: string) => {
        protocolFailure ??= new RuntimeError(code);
        context.controller.abort(protocolFailure);
      };
      const count = (chunk: Buffer) => {
        output += chunk.length;
        if (output > limits.output) fail("output_limit");
      };
      child.stdout!.on("data", count);
      child.stderr!.on("data", count);
      (child.stdio[3] as Readable).on("data", (chunk: Buffer) => {
        count(chunk);
        if (signal.aborted) return;
        pending = Buffer.concat([pending, chunk]);
        try {
          let newline;
          while ((newline = pending.indexOf(10)) >= 0) {
            const line = pending.subarray(0, newline);
            pending = pending.subarray(newline + 1);
            if (!line.length) continue;
            if (line.length > 1024 * 1024)
              throw new RuntimeError("protocol_limit");
            const wire = workerEnvelopeSchema.parse(
              JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(line)),
            );
            if (
              wire.run_id !== id ||
              wire.job_id !== request.job_id ||
              wire.revision !== request.revision ||
              !this.store.runtimeCurrent(lease) ||
              terminal
            )
              throw new RuntimeError("protocol_invalid");
            if (
              this.secrets.containsCredentials(wire.event) ||
              outputCredentials.contains(wire.event) ||
              (wire.event.type === "progress" &&
                credentialStream.push(wire.event.message))
            )
              throw new RuntimeError("secret_in_output");
            if (wire.event.type === "terminal") terminal = wire.event;
            else if (wire.event.type === "session") {
              if (session && session !== wire.event.id)
                throw new RuntimeError("protocol_invalid");
              session = wire.event.id;
              queue.push(wire.event);
            } else queue.push(wire.event);
          }
          if (pending.length > 1024 * 1024) fail("protocol_limit");
        } catch (error) {
          fail(error instanceof RuntimeError ? error.code : "protocol_invalid");
        }
      });
      child.stdin!.on("error", () => fail("worker_input_failed"));
      const code = await new Promise<number | null>((resolve) => {
        child.once("error", () => {
          fail("worker_start_failed");
        });
        child.once("close", resolve);
        child.stdin!.end(input);
        if (signal.aborted) abort();
      });
      if (protocolFailure) throw protocolFailure;
      if (pending.length || !terminal || code !== 0)
        throw new RuntimeError("worker_failed");
      signal.throwIfAborted();
      if (terminal.outcome !== "completed")
        throw new RuntimeError(terminal.outcome);
      revoke();
      await closeProvider;
      termination ??= cleanUser(identity.uid);
      await termination;
      if (cleanupFailure) throw new RuntimeError("cleanup_failed");
      if (!this.store.runtimeCurrent(lease))
        throw new RuntimeError("revision_stale");
      const manifest = await this.workspaces.freeze(
        {
          run_id: id,
          job_id: request.job_id,
          revision: request.revision,
          source: request.workspace.source,
        },
        prepared.workspace,
        limits.storage,
        signal,
      );
      const artifact = this.store.recordArtifact(manifest);
      await writeFile(
        join(this.workspaces.privateRoot, "manifests", artifact),
        JSON.stringify(manifest),
        { mode: 0o400, flag: "wx" },
      );
      terminal = { ...terminal, artifact };
    } catch (error) {
      const code = signal.aborted
        ? signal.reason instanceof RuntimeError
          ? signal.reason.code
          : "cancelled"
        : error instanceof RuntimeError
          ? error.code
          : "worker_failed";
      terminal = {
        type: "terminal",
        outcome:
          code === "revision_stale" || code === "stale"
            ? "stale"
            : code === "cancelled" || code === "consumer_cancelled"
              ? "cancelled"
              : [
                    "limited",
                    "output_limit",
                    "storage_limit",
                    "active_budget_exhausted",
                  ].includes(code)
                ? "limited"
                : "failed",
      };
      if (code === "cleanup_failed") cleanupFailure = error;
    } finally {
      clearInterval(timer);
      clearTimeout(expiry);
      if (context.reviewTask) {
        context.controller.abort(new RuntimeError("cancelled"));
        await context.reviewTask;
        if (context.reviewCleanupFailed)
          cleanupFailure = new RuntimeError("cleanup_failed");
      }
      await watching;
      revoke();
      try {
        await closeProvider;
        if (registered) {
          cleanupStep = "processes";
          termination ??= cleanUser(identity.uid);
          await termination;
          cleanupStep = "temporary";
          await cleanTemporary(identity.uid);
          cleanupStep = "workspace";
          await this.workspaces.remove(id);
        }
        cleanupStep = "receipt";
        if (!cleanupFailure) {
          if (
            terminal?.outcome === "completed" &&
            !this.store.runtimeCurrent(lease)
          )
            terminal = { type: "terminal", outcome: "stale" };
          if (registered)
            this.store.finishRun(
              id,
              terminal!.outcome,
              signal.aborted ? null : session,
              terminal?.outcome === "completed"
                ? (terminal.artifact ?? null)
                : null,
            );
          cleaned = true;
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
      signal.removeEventListener("abort", abort);
      if (!parent) {
        this.store.accountActive(lease);
        if (cleaned && !this.store.releaseLease(lease))
          cleanupFailure = new RuntimeError("cleanup_failed");
      }
    }
    if (cleanupFailure)
      throw new RuntimeError("cleanup_failed", {
        cause:
          cleanupFailure instanceof RuntimeError ? cleanupFailure : undefined,
      });
    queue.push(terminal!);
    queue.end();
  }

  private validateMcp(
    session: Awaited<ReturnType<McpSessionProvider["open"]>>,
    context: ActiveRun,
  ) {
    const grants = grantFor(context.snapshot, context.request.role),
      seen = new Set<string>();
    if (!session.policy_identity || !session.catalog_identity)
      throw new RuntimeError("mcp_descriptor_invalid");
    for (const connection of session.connections) {
      const url = new URL(connection.url),
        tools = grants[connection.alias]?.tools;
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        !tools ||
        seen.has(connection.alias) ||
        !connection.authorization ||
        connection.authorization.length > 16384 ||
        /[\r\n\0]/.test(connection.authorization) ||
        Object.keys(connection).some(
          (key) =>
            !["alias", "url", "authorization", "tools", "deadline"].includes(
              key,
            ),
        ) ||
        !Number.isSafeInteger(connection.deadline) ||
        connection.deadline > context.deadline ||
        connection.deadline <= Date.now() ||
        new Set(connection.tools).size !== connection.tools.length ||
        connection.tools.some((name) => !Object.hasOwn(tools, name)) ||
        this.secrets.containsCredentials(connection)
      )
        throw new RuntimeError("mcp_descriptor_invalid");
      seen.add(connection.alias);
    }
    if (
      Object.entries(grants).some(
        ([alias, grant]) => Object.keys(grant.tools).length && !seen.has(alias),
      )
    )
      throw new RuntimeError("mcp_unavailable");
  }

  async close() {
    this.controller.abort(new RuntimeError("cancelled"));
    await Promise.all(this.tasks);
    await this.relay.close();
    if (this.store.runs().some((run) => run.finished_at === null))
      throw new RuntimeError("cleanup_failed");
  }
}

function grantFor(snapshot: RunSnapshot, role: Role) {
  return snapshot.roles[role].mcp;
}
function hasTools(grants: RunSnapshot["roles"][Role]["mcp"]) {
  return Object.values(grants).some(
    (value) => Object.keys(value.tools).length > 0,
  );
}
