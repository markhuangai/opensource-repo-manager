import Fastify from "fastify";

export function createApp() {
  const app = Fastify({ logger: false });

  app.get("/healthz", () => ({ status: "ok" }));
  app.get("/readyz", (_request, reply) =>
    reply.code(503).send({
      status: "not_ready",
      reason: "automation_not_implemented",
    }),
  );

  return app;
}
