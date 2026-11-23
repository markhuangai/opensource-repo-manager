import { join } from "node:path";
import { ConfigurationError } from "../config/errors.ts";
import { loadProtectedActionsConfiguration } from "../config/load.ts";
import { RuntimeError } from "../domain/agents.ts";
import { IntakeError } from "../domain/jobs.ts";
import {
  createKnownSecretChecker,
  createSafeLogger,
} from "../logging/redact.ts";
import { Store } from "../repositories/store.ts";
import { createApplication, type Application } from "../runtime/application.ts";
import { assertRuntimeIdentity } from "../runtime/process.ts";
import { rootDirectory } from "../services/workspaces/files.ts";
import { ActionsState } from "./persistence.ts";
import { createApiDiagnostics, apiFailureId } from "../logging/api.ts";
import { ActionsArtifacts } from "./artifacts.ts";
import { GitHubArtifacts } from "../adapters/github/artifacts.ts";
import { GitHubActionsSource } from "../adapters/github/actions-source.ts";
import { createGitHubClient } from "../adapters/github/client.ts";
import { RemoteDevActions } from "../adapters/github/remote-dev.ts";
import { RemoteAgents } from "../runtime/remote-agents.ts";
import { RemoteTurnPending } from "../domain/remote-turns.ts";
import { StateError } from "./state.ts";
import {
  assertTaskStore,
  executeTask,
  parseTaskRequest,
  taskExitCode,
  type TaskResult,
} from "./task.ts";

let logger = createSafeLogger(createKnownSecretChecker([]), true);
let diagnostics = createApiDiagnostics(createKnownSecretChecker([]));
let redact = (value: string) => value;
let application: Application | undefined;
let store: Store | undefined;
let state: ActionsState | undefined;
let result: TaskResult = {
  version: 1,
  outcome: "failed",
  reason: "runtime_failed",
};
let cleanupFailed = false;
let deadline: ReturnType<typeof setTimeout> | undefined;
const controller = new AbortController();
const fail = (reason: TaskResult["reason"]) => {
  result = { ...result, outcome: "failed", reason };
};
function emitResult() {
  console.log(
    JSON.stringify(result, (_key, value: unknown) =>
      typeof value === "string" ? redact(value) : value,
    ),
  );
}
function startDeadline() {
  deadline ??= setTimeout(() => {
    logger.error("Shutdown exceeded its 10-second deadline.");
    fail("cleanup_failed");
    emitResult();
    process.exit(1);
  }, 10_000);
  deadline.unref();
}
function cancel() {
  controller.abort(new RuntimeError("cancelled"));
  startDeadline();
  void application?.stop().catch(() => {
    cleanupFailed = true;
  });
}
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const request = parseTaskRequest(process.argv.slice(2));
  const loaded = await loadProtectedActionsConfiguration();
  logger = createSafeLogger(loaded.secrets, true);
  diagnostics = createApiDiagnostics(loaded.secrets, {
    repository: loaded.actions.repository,
    issue_number: request.issue_number,
  });
  redact = loaded.secrets.redact;
  controller.signal.throwIfAborted();
  await assertRuntimeIdentity();
  const root = join("/data/actions", String(request.issue_number));
  await rootDirectory("/data/actions", 0o711);
  await rootDirectory(root, 0o711);
  store = new Store(join(root, "state", "manager.sqlite"));
  assertTaskStore(store, request, loaded.snapshot.settings.github.repository);
  const transport = new GitHubArtifacts(
    loaded.actions,
    loaded.secrets,
    undefined,
    diagnostics,
  );
  const artifacts = new ActionsArtifacts(
    loaded.actions,
    loaded.snapshot,
    loaded.secrets,
    join(root, "runtime"),
    transport,
  );
  await artifacts.initialize(controller.signal);
  state = await ActionsState.open(
    store,
    loaded.snapshot,
    loaded.secrets,
    request.issue_number,
    controller.signal,
    { artifacts },
  );
  const repository = loaded.actions.repository;
  const client = createGitHubClient(
    repository,
    loaded.secrets.get("github.token"),
    diagnostics,
  );
  const agents = new RemoteAgents(
    store,
    state,
    new RemoteDevActions(repository, client),
    new GitHubActionsSource(repository, client),
    transport,
    loaded.secrets,
    join(root, "runtime"),
    diagnostics,
  );
  const restored = state.result();
  if (restored) {
    result = restored;
    if (
      restored.outcome === "closed" ||
      ["state_incompatible", "state_conflict"].includes(restored.reason)
    ) {
      try {
        await agents.cancelSuperseded(controller.signal, true);
      } catch (error) {
        if (!(error instanceof RemoteTurnPending)) throw error;
        result = { ...restored, outcome: "waiting", reason: "agent_run" };
      }
    }
  } else {
    application = await createApplication(store, loaded, logger, {
      root: join(root, "runtime"),
      publicationWriter: () => state!.writer,
      agents,
    });
    controller.signal.throwIfAborted();
    result = await executeTask(application, request, controller.signal);
  }
} catch (error) {
  fail(
    controller.signal.aborted
      ? "cancelled"
      : error instanceof ConfigurationError
        ? error.code === "arguments_invalid"
          ? "arguments_invalid"
          : "configuration_invalid"
        : error instanceof IntakeError
          ? error.code === "schema_unsupported"
            ? "state_incompatible"
            : "intake_failed"
          : error instanceof RuntimeError && error.code === "task_state_invalid"
            ? "task_state_invalid"
            : error instanceof StateError
              ? (error.code as TaskResult["reason"])
              : "runtime_failed",
  );
  if (error instanceof StateError) result = { ...result, outcome: "blocked" };
  logger.error(`Actions execution stopped (${result.reason}).`);
  diagnostics.event("actions.failed", {
    reason: result.reason,
    request_id: apiFailureId(error),
    ...([
      "state_incompatible",
      "state_legacy_unbound",
      "session_schema_unsupported",
    ].includes(result.reason)
      ? {
          recovery:
            "Use the matching pinned ORM release for existing data. Install the version 2 examples for new tasks.",
        }
      : {}),
    cause: controller.signal.aborted
      ? "cancelled"
      : error instanceof IntakeError ||
          error instanceof StateError ||
          error instanceof RuntimeError ||
          error instanceof ConfigurationError
        ? error.code
        : "runtime_failed",
  });
} finally {
  startDeadline();
  try {
    await application?.close();
    if (!application && state && store?.db.open)
      await store.checkpoint(AbortSignal.timeout(9000), true);
  } catch (error) {
    if (
      error instanceof StateError ||
      (error instanceof DOMException && error.name === "TimeoutError")
    ) {
      const cause =
        error instanceof StateError ? error.code : "checkpoint_interrupted";
      diagnostics.event("checkpoint.final_failed", {
        cause,
        task_outcome: result.outcome,
        task_reason: result.reason,
        request_id: apiFailureId(error),
        recovery:
          "Check the prepared upload and last acknowledged checkpoint on the next maintenance event.",
      });
      result = { ...result, checkpoint_failed: true, checkpoint_error: cause };
    } else cleanupFailed = true;
  } finally {
    try {
      if (store?.db.open) store.close();
    } catch {
      cleanupFailed = true;
    }
    clearTimeout(deadline);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  if (state?.failure() && state.failure()!.code !== result.checkpoint_error)
    result = {
      ...result,
      outcome: "blocked",
      reason: state.failure()!.code as TaskResult["reason"],
    };
  if (controller.signal.aborted) fail("cancelled");
  if (cleanupFailed) fail("cleanup_failed");
  if (state) result = { ...result, ...state.identifiers() };
}
emitResult();
process.exitCode = taskExitCode(result);
