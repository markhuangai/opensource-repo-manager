import { createGitHubReader } from "./adapters/github/reader.ts";
import { ConfigurationError } from "./config/errors.ts";
import { loadProtectedConfiguration } from "./config/load.ts";
import { startHttpService } from "./http/server.ts";
import { IntakeError } from "./domain/jobs.ts";
import { Store } from "./repositories/store.ts";
import { IntakeService } from "./services/intake.ts";
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
  try {
    const reader = createGitHubReader(
      loaded.snapshot.settings.github.repository,
      loaded.secrets.get("github.token"),
    );
    const intake = new IntakeService(
      store,
      reader,
      loaded.snapshot,
      loaded.secrets,
      logger,
    );
    await startHttpService(logger, {
      intake,
      webhookSecret: loaded.secrets.get("github.webhook_secret"),
      close: () => store.close(),
    });
  } catch (error) {
    if (store.db.open) store.close();
    throw error;
  }
} catch (error) {
  logger.error(
    error instanceof ConfigurationError || error instanceof IntakeError
      ? error.message
      : "Service startup failed.",
  );
  process.exitCode = 1;
}
