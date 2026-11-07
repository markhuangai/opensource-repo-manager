import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import type { ActionsConfiguration, Role } from "../config/schema.ts";
import { separateSecrets } from "../config/secrets.ts";
import {
  createKnownSecretChecker,
  createSafeLogger,
} from "../logging/redact.ts";
import {
  digest,
  roleUsers,
  RuntimeError,
  sdkVersions,
  workerEnvelopeSchema,
  type AgentEvent,
  type WorkerRequest,
} from "../domain/agents.ts";
import type { SourceMetadata } from "../domain/jobs.ts";
import {
  assertRuntimeIdentity,
  cleanEnvironment,
  cleanUser,
  deletedFileBytes,
  spawnAsRole,
  trustedExecutable,
} from "../runtime/process.ts";
import {
  cleanTemporary,
  ownedDirectory,
  rootDirectory,
  treeBytes,
} from "../services/workspaces/files.ts";
import { ModelRelay } from "../services/model-relay.ts";
import { gitCommand } from "../services/workspaces/index.ts";

export async function testAiConfiguration(
  config: ActionsConfiguration,
  role: Role,
  source: SourceMetadata,
  signal: AbortSignal,
) {
  const started = Date.now(),
    id = randomUUID(),
    user = roleUsers.output_review;
  const { settings, secrets } = separateSecrets(config);
  const logger = createSafeLogger(secrets, true);
  const profile = settings.profiles[settings.roles[role].profile];
  const context = {
    run_id: id,
    role,
    sdk: profile.sdk,
    sdk_version: sdkVersions[profile.sdk],
    source_sha: source.sha,
  };
  const controller = new AbortController();
  const abort = () => controller.abort(new RuntimeError("cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const deadline =
    started + Math.min(120_000, settings.limits.active_minutes * 60_000);
  const timer = setTimeout(
    () => controller.abort(new RuntimeError("ai_test_timeout")),
    Math.max(1, deadline - Date.now()),
  );
  const current = () => !controller.signal.aborted && Date.now() < deadline;
  let requests = 0;
  const relay = new ModelRelay(
    {
      reserveModelRequest: (_lease, limit) => {
        if (!current() || requests >= limit) return false;
        requests++;
        return true;
      },
      // This probe has no durable task state to checkpoint.
      checkpoint: async (checkpointSignal) => {
        checkpointSignal.throwIfAborted();
      },
    },
    settings.proxy.url,
    secrets,
  );
  const root = join("/data/ai-tests", id);
  let rootCreated = false,
    cleanupFailed = false;
  let reason: string;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let monitoring: Promise<void> | undefined;
  let termination: Promise<void> | undefined;
  let monitorFailure: string | undefined;
  const terminate = () => {
    termination ??= cleanUser(user.uid);
    void termination.catch(() => {
      cleanupFailed = true;
    });
  };
  try {
    await assertRuntimeIdentity();
    controller.signal.throwIfAborted();
    try {
      await cleanUser(user.uid);
      await cleanTemporary(user.uid);
    } catch (error) {
      cleanupFailed = true;
      throw error;
    }
    await rootDirectory("/data/ai-tests", 0o711);
    await rootDirectory(root, 0o711);
    rootCreated = true;
    const workspace = join(root, "workspace"),
      home = join(root, "home"),
      temporary = join(root, "temporary"),
      session = join(root, "session"),
      bundle = join(root, "bundle");
    for (const path of [workspace, home, temporary, session])
      await ownedDirectory(path, user.uid, user.gid);
    await gitCommand(["init", "--initial-branch=probe", workspace], {
      cwd: workspace,
      env: cleanEnvironment(home, temporary, user.name),
      signal: controller.signal,
      role: "output_review",
      processes: settings.limits.worker_processes,
    });
    await rootDirectory(bundle, 0o755);
    await writeFile(
      join(bundle, "system.md"),
      "Answer the short connectivity prompt. Do not use tools, read files, or execute commands.",
      { mode: 0o444 },
    );
    await writeFile(
      join(bundle, "user.md"),
      "Reply with a short confirmation that you can respond.",
      { mode: 0o444 },
    );
    const bootstrap = fileURLToPath(
      new URL("../runtime/worker.js", import.meta.url),
    );
    const adapter = fileURLToPath(
      new URL(`../adapters/agents/${profile.sdk}.js`, import.meta.url),
    );
    await trustedExecutable(bootstrap);
    await trustedExecutable(adapter);
    await relay.start();
    const grant = relay.authorize({
      lease: id,
      profile,
      deadline,
      requests: Math.min(2, settings.limits.model_requests),
      bytes: Math.min(256 * 1024, settings.limits.worker_output_bytes),
      signal: controller.signal,
      current,
      context: { run_id: id, job_id: 1, revision: 1, role },
    });
    const request: WorkerRequest = {
      job_id: 1,
      revision: 1,
      role: "output_review",
      run_id: id,
      snapshot_digest: digest(settings),
      binding: digest({ id, profile }),
      profile,
      workspace,
      home,
      temporary,
      session_directory: session,
      deadline,
      prompts: {
        system: join(bundle, "system.md"),
        user: join(bundle, "user.md"),
        skills: bundle,
        selected: [],
      },
      relay: { url: grant.url, authorization: grant.authorization },
      input: { scenario: "ai_configuration_test" },
    };
    controller.signal.throwIfAborted();
    logger.info(
      JSON.stringify({
        event: "ai.test.started",
        level: "info",
        ...context,
        deadline,
      }),
    );
    const child = spawnAsRole(
      "output_review",
      "/opt/orm-runtime/bin/node",
      [bootstrap, adapter],
      {
        cwd: workspace,
        env: cleanEnvironment(home, temporary, user.name),
        processes: settings.limits.worker_processes,
        protocol: true,
      },
    );
    controller.signal.addEventListener("abort", terminate, { once: true });
    const outputSecrets = createKnownSecretChecker([grant.authorization]);
    let bytes = 0,
      pending = Buffer.alloc(0),
      terminal: Extract<AgentEvent, { type: "terminal" }> | undefined;
    const fail = (code: string) => controller.abort(new RuntimeError(code));
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > Math.min(256 * 1024, settings.limits.worker_output_bytes))
        fail("output_limit");
    };
    child.stdout!.on("data", count);
    child.stderr!.on("data", count);
    (child.stdio[3] as Readable).on("data", (chunk: Buffer) => {
      count(chunk);
      if (controller.signal.aborted) return;
      pending = Buffer.concat([pending, chunk]);
      try {
        let end;
        while ((end = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, end);
          pending = pending.subarray(end + 1);
          const wire = workerEnvelopeSchema.parse(
            JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(line)),
          );
          if (
            wire.run_id !== id ||
            wire.job_id !== 1 ||
            wire.revision !== 1 ||
            terminal
          )
            throw new RuntimeError("protocol_invalid");
          if (
            secrets.containsCredentials(wire.event) ||
            outputSecrets.contains(wire.event)
          )
            throw new RuntimeError("secret_in_output");
          if (wire.event.type === "terminal") terminal = wire.event;
        }
      } catch (error) {
        fail(error instanceof RuntimeError ? error.code : "protocol_invalid");
      }
    });
    monitor = setInterval(() => {
      if (monitoring) return;
      monitoring = (async () => {
        const limit = settings.limits.worker_storage_bytes;
        const used = await treeBytes(root, limit, user.uid);
        if (used + (await deletedFileBytes(user.uid, limit)) > limit)
          throw new RuntimeError("storage_limit");
      })()
        .catch((error) => {
          monitorFailure =
            error instanceof RuntimeError ? error.code : "monitor_failed";
          fail(monitorFailure);
        })
        .finally(() => {
          monitoring = undefined;
        });
    }, 250);
    child.stdin!.on("error", () => fail("worker_input_failed"));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", () =>
        reject(new RuntimeError("worker_start_failed")),
      );
      child.once("close", resolve);
      child.stdin!.end(JSON.stringify(request));
      if (controller.signal.aborted) terminate();
    });
    controller.signal.throwIfAborted();
    if (
      code !== 0 ||
      pending.length ||
      terminal?.outcome !== "completed" ||
      typeof terminal.result !== "string" ||
      !terminal.result.trim()
    )
      throw new RuntimeError("ai_interaction_failed");
    reason = "ai_interaction_completed";
  } catch (error) {
    reason =
      controller.signal.aborted &&
      controller.signal.reason instanceof RuntimeError
        ? controller.signal.reason.code
        : error instanceof RuntimeError
          ? error.code
          : "ai_interaction_failed";
  } finally {
    clearTimeout(timer);
    if (monitor) clearInterval(monitor);
    controller.abort();
    signal.removeEventListener("abort", abort);
    try {
      await monitoring;
      await relay.close();
      if (rootCreated) {
        terminate();
        await termination;
        await cleanUser(user.uid);
        await cleanTemporary(user.uid);
        await rm(root, { recursive: true });
      }
    } catch {
      cleanupFailed = true;
    }
  }
  if (monitorFailure) reason = monitorFailure;
  if (cleanupFailed) reason = "cleanup_failed";
  const result = {
    version: 1,
    outcome: reason === "ai_interaction_completed" ? "completed" : "failed",
    reason,
    ...context,
    model_requests: requests,
    elapsed_ms: Date.now() - started,
    cleanup: cleanupFailed ? "failed" : "passed",
  };
  logger[result.outcome === "completed" ? "info" : "error"](
    JSON.stringify({
      event: "ai.test.finished",
      level: result.outcome === "completed" ? "info" : "error",
      ...result,
    }),
  );
  return result;
}
