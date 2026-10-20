import { createGitHubReader } from "./adapters/github/reader.ts";
import { ConfigurationError } from "./config/errors.ts";
import { loadProtectedConfiguration } from "./config/load.ts";
import { startHttpService } from "./http/server.ts";
import { IntakeError } from "./domain/jobs.ts";
import { Store } from "./repositories/store.ts";
import { IntakeService } from "./services/intake.ts";
import { RuntimeError } from "./domain/agents.ts";
import { Supervisor } from "./runtime/supervisor.ts";
import { McpGateway } from "./services/mcp/index.ts";
import { fileURLToPath } from "node:url";
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
  const mcp = new McpGateway(store, loaded.snapshot, loaded.secrets);
  let supervisor: Supervisor | undefined;
  try {
    supervisor = await Supervisor.create(
      store,
      loaded.snapshot,
      loaded.secrets,
      {
        mcp,
        workers: {
          claude: fileURLToPath(
            new URL("./adapters/agents/claude.js", import.meta.url),
          ),
          codex: fileURLToPath(
            new URL("./adapters/agents/codex.js", import.meta.url),
          ),
        },
      },
    );
    mcp.setWriteDispatcher(supervisor.mcpWrites);
    await mcp.start();
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
      notifications: supervisor.notifications,
      mcpWrites: supervisor.mcpWrites,
      webhookSecret: loaded.secrets.get("github.webhook_secret"),
      close: async () => {
        try {
          await supervisor!.close();
        } finally {
          try {
            await mcp.close();
          } finally {
            store.close();
          }
        }
      },
    });
  } catch (error) {
    try {
      await supervisor?.close();
    } finally {
      try {
        await mcp.close();
      } finally {
        if (store.db.open) store.close();
      }
    }
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
