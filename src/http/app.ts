import Fastify from "fastify";
import type { IntakeService } from "../services/intake.ts";
import { registerWebhooks } from "./webhooks.ts";
import type { NotificationService } from "../services/notifications/index.ts";
import type { McpWriteService } from "../services/mcp-writes/index.ts";
import type { InvestigationService } from "../services/investigation/index.ts";

export function createApp(
  intake?: IntakeService,
  webhookSecret?: string,
  notifications?: NotificationService,
  mcpWrites?: McpWriteService,
  investigation?: InvestigationService,
) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const status =
      typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
        ? statusCode
        : 503;
    return reply
      .code(status)
      .send({ status: "rejected", reason: "request_rejected" });
  });

  app.get("/healthz", () => ({ status: "ok" }));
  app.get("/readyz", (_request, reply) => {
    const monitor = investigation?.implementation?.monitor;
    const operational =
      intake?.status().state === "ready" &&
      investigation?.status().state === "running" &&
      investigation.implementation?.status().runtime.state === "ready" &&
      notifications?.status().state === "running" &&
      monitor?.status().state === "running";
    return reply.code(operational ? 200 : 503).send({
      status: operational ? "ready" : "not_ready",
      reason: operational
        ? null
        : !monitor
          ? "automation_not_implemented"
          : monitor.status().state === "disabled"
            ? "pr_monitor_disabled"
            : "service_unavailable",
      ...(intake ? { intake: intake.status() } : {}),
      ...(notifications ? { notifications: notifications.status() } : {}),
      ...(mcpWrites ? { mcp_writes: mcpWrites.status() } : {}),
      ...(investigation ? { investigation: investigation.status() } : {}),
      ...(investigation?.implementation
        ? { implementation: investigation.implementation.status() }
        : {}),
      ...(monitor ? { pr_monitor: monitor.status() } : {}),
    });
  });

  if (intake && webhookSecret)
    app.register(async (scope) =>
      registerWebhooks(scope, intake, webhookSecret),
    );

  return app;
}
