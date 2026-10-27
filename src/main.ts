import { createApplication } from "./runtime/application.ts";
import { ConfigurationError } from "./config/errors.ts";
import { loadProtectedConfiguration } from "./config/load.ts";
import { startHttpService } from "./http/server.ts";
import { IntakeError } from "./domain/jobs.ts";
import { Store } from "./repositories/store.ts";
import { RuntimeError } from "./domain/agents.ts";
import {
  createKnownSecretChecker,
  createSafeLogger,
} from "./logging/redact.ts";

let logger = createSafeLogger(createKnownSecretChecker([]));
try {
  if (process.argv.length !== 2)
    throw new ConfigurationError("arguments_invalid");
  const loaded = await loadProtectedConfiguration();
  logger = createSafeLogger(loaded.secrets);
  if (process.getuid?.() !== 0)
    throw new IntakeError("supervisor_requires_root");
  const store = new Store("/data/state/manager.sqlite");
  const application = await createApplication(store, loaded, logger, {
    mode: "service",
  });
  try {
    await startHttpService(logger, {
      intake: application.intake,
      investigation: application.investigation,
      notifications: application.supervisor.notifications,
      mcpWrites: application.supervisor.mcpWrites,
      webhookSecret: loaded.secrets.get("github.webhook_secret"),
      close: application.close,
    });
  } catch (error) {
    await application.close();
    throw error;
  }
} catch (error) {
  logger.error(
    error instanceof ConfigurationError ||
      error instanceof IntakeError ||
      error instanceof RuntimeError
      ? error.message
      : "Service startup failed.",
  );
  process.exitCode = 1;
}
