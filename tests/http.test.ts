import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("scaffold HTTP endpoints", () => {
  it("reports liveness without reflecting headers or environment", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      url: "/healthz",
      headers: { authorization: "Bearer secret-canary" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.body).not.toContain("secret-canary");
  });

  it("does not declare maintenance automation ready", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject("/readyz");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      reason: "automation_not_implemented",
    });
  });

  it("does not expose a webhook integration that is not implemented", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
    });
    expect(response.statusCode).toBe(404);
  });
});
