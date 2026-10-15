import { createHmac, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { FastifyInstance } from "fastify";
import { IntakeError } from "../domain/jobs.ts";
import type { IntakeService } from "../services/intake.ts";

export async function registerWebhooks(
  app: FastifyInstance,
  intake: IntakeService,
  secret: string,
) {
  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      ["application/json", "application/vnd.github+json"],
      { parseAs: "buffer", bodyLimit: 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    scope.post("/webhooks/github", async (request, reply) => {
      const signature = request.headers["x-hub-signature-256"];
      const bytes = request.body;
      if (
        typeof signature !== "string" ||
        !/^sha256=[a-f0-9]{64}$/.test(signature) ||
        !Buffer.isBuffer(bytes)
      )
        return reply
          .code(401)
          .send({ status: "rejected", reason: "signature_invalid" });
      const expected = createHmac("sha256", secret).update(bytes).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
        return reply
          .code(401)
          .send({ status: "rejected", reason: "signature_invalid" });
      const delivery = request.headers["x-github-delivery"];
      const event = request.headers["x-github-event"];
      if (
        typeof delivery !== "string" ||
        !/^[A-Za-z0-9-]{1,128}$/.test(delivery) ||
        typeof event !== "string" ||
        !/^[a-z_]{1,64}$/.test(event)
      )
        return reply
          .code(400)
          .send({ status: "rejected", reason: "event_invalid" });
      let payload: unknown;
      try {
        if (!isUtf8(bytes)) throw new Error();
        payload = JSON.parse(bytes.toString("utf8"));
      } catch {
        return reply
          .code(400)
          .send({ status: "rejected", reason: "event_invalid" });
      }
      try {
        intake.accept(delivery, event, payload, bytes);
      } catch (error) {
        const reason =
          error instanceof IntakeError ? error.code : "storage_unavailable";
        const status =
          reason === "repository_mismatch"
            ? 403
            : reason === "event_invalid"
              ? 400
              : reason === "delivery_conflict"
                ? 409
                : 503;
        return reply.code(status).send({ status: "rejected", reason });
      }
      return reply.code(202).send({ status: "accepted" });
    });
  });
}
