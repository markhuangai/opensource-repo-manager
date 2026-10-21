import {
  createKnownSecretChecker,
  createSafeLogger,
  type SafeLogger,
} from "../logging/redact.ts";
import { createApp } from "./app.ts";
import type { IntakeService } from "../services/intake.ts";
import type { NotificationService } from "../services/notifications/index.ts";
import type { McpWriteService } from "../services/mcp-writes/index.ts";
import type { InvestigationService } from "../services/investigation/index.ts";

export async function startHttpService(
  logger: SafeLogger = createSafeLogger(createKnownSecretChecker([])),
  dependencies?: {
    intake: IntakeService;
    webhookSecret: string;
    notifications?: NotificationService;
    mcpWrites?: McpWriteService;
    investigation?: InvestigationService;
    close: () => void | Promise<void>;
  },
) {
  const app = createApp(
    dependencies?.intake,
    dependencies?.webhookSecret,
    dependencies?.notifications,
    dependencies?.mcpWrites,
    dependencies?.investigation,
  );
  app.addHook("onClose", async () => {
    try {
      await dependencies?.investigation?.stop();
      await dependencies?.intake.stop();
    } finally {
      await dependencies?.close();
    }
  });
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      logger.error("Shutdown exceeded its 10-second deadline.");
      process.exit(1);
    }, 10_000);
    deadline.unref();
    try {
      await app.close();
    } catch {
      logger.error("HTTP shutdown failed.");
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  }
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  try {
    await app.listen({ host: "0.0.0.0", port: 8080 });
    logger.info(
      "HTTP listening on port 8080; maintenance automation is unavailable.",
    );
    dependencies?.intake.start();
    dependencies?.notifications?.start();
    dependencies?.investigation?.start();
  } catch {
    logger.error("HTTP startup failed.");
    process.exitCode = 1;
    await app.close();
  }
  return app;
}
