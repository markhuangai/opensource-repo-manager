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
import {
  assertTaskStore,
  executeTask,
  parseTaskRequest,
  taskExitCode,
  type TaskResult,
} from "./task.ts";

let logger = createSafeLogger(createKnownSecretChecker([]), true);
let redact = (value: string) => value;
let application: Application | undefined;
let store: Store | undefined;
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
  redact = loaded.secrets.redact;
  controller.signal.throwIfAborted();
  await assertRuntimeIdentity();
  const root = join("/data/actions", String(request.issue_number));
  await rootDirectory("/data/actions", 0o711);
  await rootDirectory(root, 0o711);
  store = new Store(join(root, "state", "manager.sqlite"));
  assertTaskStore(store, request, loaded.snapshot.settings.github.repository);
  application = await createApplication(store, loaded, logger, {
    mode: "actions",
    root: join(root, "runtime"),
  });
  controller.signal.throwIfAborted();
  result = await executeTask(application, request, controller.signal);
} catch (error) {
  fail(
    controller.signal.aborted
      ? "cancelled"
      : error instanceof ConfigurationError
        ? error.code === "arguments_invalid"
          ? "arguments_invalid"
          : "configuration_invalid"
        : error instanceof IntakeError
          ? "intake_failed"
          : error instanceof RuntimeError && error.code === "task_state_invalid"
            ? "task_state_invalid"
            : "runtime_failed",
  );
  logger.error(`Actions execution stopped (${result.reason}).`);
} finally {
  startDeadline();
  try {
    await application?.close();
  } catch {
    cleanupFailed = true;
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
  if (controller.signal.aborted) fail("cancelled");
  if (cleanupFailed) fail("cleanup_failed");
}
emitResult();
process.exitCode = taskExitCode(result);
