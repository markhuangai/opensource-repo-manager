import {
  createKnownSecretChecker,
  createSafeLogger,
  type SafeLogger,
} from "../logging/redact.ts";
import { createApp } from "./app.ts";
import type { IntakeService } from "../services/intake.ts";

export async function startHttpService(
  logger: SafeLogger = createSafeLogger(createKnownSecretChecker([])),
  dependencies?: {
    intake: IntakeService;
    webhookSecret: string;
    close: () => void;
  },
) {
  const app = createApp(dependencies?.intake, dependencies?.webhookSecret);
  app.addHook("onClose", async () => {
    try {
      await dependencies?.intake.stop();
    } finally {
      dependencies?.close();
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
  } catch {
    logger.error("HTTP startup failed.");
    process.exitCode = 1;
    await app.close();
  }
  return app;
}
