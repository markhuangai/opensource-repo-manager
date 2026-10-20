import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { notificationFixture } from "./fixtures/notifications.ts";
import { fixtureConfiguration, fixtureSnapshot } from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";
import { Store } from "../src/repositories/store.ts";
import { NotificationService } from "../src/services/notifications/index.ts";
import { SmtpNotificationChannel } from "../src/adapters/notifications/smtp.ts";
import { HttpNotificationChannel } from "../src/adapters/notifications/http.ts";
import { createApp } from "../src/http/app.ts";
import type { NotificationEvent } from "../src/services/notifications/contracts.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Notification fixture timed out");
    await delay(10);
  }
}
async function setup(options: Parameters<typeof notificationFixture>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "orm-notifications-"));
  cleanup.push(() => rm(root, { recursive: true }));
  const fixture = await notificationFixture(root, options);
  cleanup.push(fixture.close);
  const config = fixtureConfiguration();
  config.notifications.webhook = {
    enabled: true,
    url: fixture.url + "/webhook",
    headers: { Authorization: "Bearer fixture-notification-secret" },
  };
  config.notifications.discord = {
    enabled: true,
    webhook_url: fixture.url + "/discord",
  };
  const loaded = await fixtureSnapshot("fixture-model", config);
  const path = join(root, "state", "manager.sqlite");
  let store = new Store(path);
  store.saveSnapshot(loaded.snapshot);
  store.enroll({
    id: 42,
    full_name: "owner/repo",
    default_branch: "main",
    private: true,
  });
  store.discover([1], 1, true);
  store.applyIssue(
    store.nextDirty()!,
    {
      ...makeIssue(1),
      state: "open",
      comments: [],
      source: {
        default_branch: "main",
        sha: "a".repeat(40),
        tree_sha: "b".repeat(40),
      },
    },
    loaded.snapshot,
  );
  const job = store.job(1)!;
  const event: NotificationEvent = {
    id: "stable-event",
    job_id: job.id,
    revision: job.revision,
    repository_id: 42,
    issue_number: 1,
    occurred_at: 1792451961000,
    outcome: "needs_attention",
    reason: "workflow_blocked",
  };
  const review = {
    verify() {
      throw new Error(
        "Actual SDK review is exercised by the production-container harness",
      );
    },
  };
  let service = new NotificationService(
    store,
    loaded.snapshot,
    loaded.secrets,
    review,
  );
  cleanup.push(async () => {
    await service.stop();
    if (store.db.open) store.close();
  });
  const restart = async (changed = config) => {
    await service.stop();
    store.close();
    store = new Store(path);
    const next = await fixtureSnapshot("fixture-model", changed);
    service = new NotificationService(
      store,
      next.snapshot,
      next.secrets,
      review,
    );
    return service;
  };
  const enqueue = (input = event) =>
    service.enqueue(service.prepare(input), {}, new AbortController().signal);
  const expedite = () => {
    for (const receipt of service.repository.receipts()) {
      receipt.retry_at = 0;
      service.repository.save(receipt);
    }
  };
  return {
    root,
    fixture,
    config,
    loaded,
    event,
    job,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    restart,
    enqueue,
    expedite,
  };
}

describe("durable notifications", () => {
  it("delivers canonical payloads with isolated authentication, disabled mentions, and concurrent event deduplication", async () => {
    const f = await setup();
    await Promise.all([f.enqueue(), f.enqueue()]);
    f.service.start();
    await until(() =>
      f.service.receipt(f.event.id).every((row) => row.state === "confirmed"),
    );
    expect(f.fixture.requests).toHaveLength(2);
    const webhook = f.fixture.requests.find((row) => row.path === "/webhook")!;
    expect(webhook.headers.authorization).toBe(
      "Bearer fixture-notification-secret",
    );
    expect(webhook.headers["idempotency-key"]).toBe(f.event.id);
    expect(webhook.body).toMatchObject({
      version: 1,
      event_id: f.event.id,
      issue: { url: "https://github.com/owner/repo/issues/1" },
    });
    const discord = f.fixture.requests.find((row) => row.path === "/discord")!;
    expect(discord.headers.authorization).toBeUndefined();
    expect(discord.body.allowed_mentions).toEqual({
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    });
    expect(JSON.stringify(f.service.receipt(f.event.id))).not.toContain(
      "fixture-notification-secret",
    );
    await f.restart();
    f.service.start();
    await f.enqueue();
    await delay(40);
    expect(f.fixture.requests).toHaveLength(2);
  });

  it("delivers ready-for-review notifications for the exact owned PR head", async () => {
    const f = await setup();
    const head = "b".repeat(40);
    const event: NotificationEvent = {
      ...f.event,
      outcome: "ready_for_review",
      reason: "automation_clean",
      pull_number: 77,
      head_sha: head,
    };
    expect(() => f.service.prepare(event)).toThrow("event_stale");
    f.store.recordPublication({
      operation_key: "ready-pull",
      job_id: f.job.id,
      revision: f.job.revision,
      kind: "pull_request",
      object_id: "77",
      number: 77,
      head_sha: head,
      receipt_json: "{}",
    });
    expect(() =>
      f.service.prepare({ ...event, head_sha: "c".repeat(40) }),
    ).toThrow("event_stale");
    await f.enqueue(event);
    f.service.start();
    await until(() =>
      f.service.receipt(event.id).every((row) => row.state === "confirmed"),
    );
    expect(f.fixture.requests).toHaveLength(2);
    const webhook = f.fixture.requests.find((row) => row.path === "/webhook")!;
    expect(webhook.body).toMatchObject({
      outcome: "ready_for_review",
      reason: "automation_clean",
      pull: {
        number: 77,
        url: "https://github.com/owner/repo/pull/77",
        head_sha: head,
      },
    });
    const discord = f.fixture.requests.find((row) => row.path === "/discord")!;
    const lines = String(discord.body.content).split("\n");
    expect(lines).toContain("Repository maintenance: ready for human review");
    expect(lines).toContain("https://github.com/owner/repo/pull/77");
  });

  it("retries lost responses twice across restart without resending the confirmed channel", async () => {
    const f = await setup();
    f.fixture.modes["/webhook"] = { lose: true };
    await f.enqueue();
    f.service.start();
    await until(
      () =>
        f.service.receipt(f.event.id).find((r) => r.channel === "webhook")
          ?.state === "pending",
    );
    await until(
      () =>
        f.service.receipt(f.event.id).find((r) => r.channel === "webhook")
          ?.attempts.length === 1 &&
        f.service.receipt(f.event.id).find((r) => r.channel === "discord")
          ?.state === "confirmed",
    );
    const first = f.service
      .receipt(f.event.id)
      .find((r) => r.channel === "webhook")!;
    expect(
      first.retry_at - first.attempts[0].finished_at!,
    ).toBeGreaterThanOrEqual(5000);
    for (let attempt = 2; attempt <= 3; attempt++) {
      await f.restart();
      f.expedite();
      f.service.start();
      await until(
        () =>
          f.service.receipt(f.event.id).find((r) => r.channel === "webhook")
            ?.attempts.length === attempt &&
          f.service.receipt(f.event.id).find((r) => r.channel === "webhook")
            ?.state !== "dispatching",
      );
    }
    const failed = f.service
      .receipt(f.event.id)
      .find((r) => r.channel === "webhook")!;
    expect(failed.state).toBe("uncertain");
    expect(
      failed.attempts.every((row) => row.result?.outcome === "uncertain"),
    ).toBe(true);
    expect(
      f.fixture.requests.filter((row) => row.path === "/discord"),
    ).toHaveLength(1);
    expect(
      f.fixture.requests.filter((row) => row.path === "/webhook"),
    ).toHaveLength(3);
    expect(
      new Set(f.fixture.requests.map((row) => row.headers["idempotency-key"])),
    ).toEqual(new Set([f.event.id]));
  });

  it("retains uncertainty after a later confirmation and recovers dispatch intent", async () => {
    const f = await setup();
    await f.enqueue();
    const receipt = f.service.repository
      .receipts(f.event.id)
      .find((row) => row.channel === "webhook")!;
    receipt.state = "dispatching";
    receipt.attempts.push({
      started_at: Date.now(),
      finished_at: null,
      result: null,
    });
    f.service.repository.save(receipt);
    await f.restart();
    f.service.start();
    expect(
      f.service.receipt(f.event.id).find((row) => row.channel === "webhook")!
        .attempts[0].result?.outcome,
    ).toBe("uncertain");
    await f.restart();
    f.expedite();
    f.service.start();
    await until(() =>
      f.service.receipt(f.event.id).every((row) => row.state === "confirmed"),
    );
    expect(
      f.service
        .receipt(f.event.id)
        .find((row) => row.channel === "webhook")!
        .attempts.map((a) => a.result?.outcome),
    ).toEqual(["uncertain", "confirmed"]);
  });

  it("persists rate limits and exposes partial failure through safe read-only diagnostics", async () => {
    const f = await setup();
    f.fixture.modes["/webhook"] = {
      status: 429,
      headers: { "Retry-After": "60" },
    };
    f.fixture.modes["/discord"] = {
      status: 403,
      body: "provider-secret-canary",
    };
    await f.enqueue();
    f.service.start();
    await until(() =>
      f.service.receipt(f.event.id).every((r) => r.attempts[0]?.finished_at),
    );
    const blocked = f.service
      .receipt(f.event.id)
      .find((r) => r.channel === "webhook")!;
    expect(blocked.retry_at).toBeGreaterThan(Date.now() + 55000);
    await f.restart();
    f.service.start();
    await f.enqueue({ ...f.event, id: "new-event" });
    await delay(30);
    expect(
      f.fixture.requests.filter((r) => r.path === "/webhook"),
    ).toHaveLength(1);
    const app = createApp(undefined, undefined, f.service);
    cleanup.push(() => app.close());
    const status = await app.inject("/readyz");
    expect(status.statusCode).toBe(503);
    expect(status.json()).toMatchObject({
      reason: "automation_not_implemented",
      notifications: {
        pending: 2,
        failed: 2,
        channels: {
          webhook: { reason: "rate_limited" },
          discord: { reason: "provider_rejected" },
        },
      },
    });
    expect(status.body).not.toMatch(
      /fixture-notification-secret|provider-secret-canary|owner\/repo|127\.0\.0\.1/,
    );
    expect(
      (await app.inject({ method: "POST", url: "/notifications/test" }))
        .statusCode,
    ).toBe(404);
  });

  it.each(["disabled", "destination", "revision"])(
    "holds %s delivery and never releases it automatically",
    async (change) => {
      const f = await setup();
      await f.enqueue();
      if (change === "disabled")
        f.config.notifications.webhook = { enabled: false };
      if (change === "destination")
        f.config.notifications.webhook = {
          enabled: true,
          url: f.fixture.url + "/different",
          headers: {},
        };
      if (change === "revision")
        f.store.db.prepare("UPDATE jobs SET revision=revision+1").run();
      await f.restart();
      f.service.start();
      expect(
        f.service.receipt(f.event.id).find((r) => r.channel === "webhook")
          ?.state,
      ).toBe("held");
      f.config.notifications.webhook = {
        enabled: true,
        url: f.fixture.url + "/webhook",
        headers: { Authorization: "Bearer fixture-notification-secret" },
      };
      await f.restart();
      f.service.start();
      await delay(40);
      expect(
        f.fixture.requests.filter((r) => r.path === "/webhook"),
      ).toHaveLength(0);
    },
  );

  it("rejects changed IDs, forged prepared payloads, secrets, raw source fields, and unreviewed summaries", async () => {
    const f = await setup();
    await f.enqueue();
    await expect(
      f.enqueue({ ...f.event, reason: "budget_exhausted" }),
    ).rejects.toThrow("event_id_conflict");
    const changed = structuredClone(
      f.service.prepare({ ...f.event, id: "tampered" }),
    );
    changed.channels.discord!.payload = {
      content: "@everyone",
      allowed_mentions: { parse: ["everyone"] },
    };
    await expect(
      f.service.enqueue(changed, {}, new AbortController().signal),
    ).rejects.toThrow("prepared_mismatch");
    expect(() =>
      f.service.prepare({
        ...f.event,
        narrative: "fixture-notification-secret",
      }),
    ).toThrow("content_rejected");
    expect(() =>
      f.service.prepare({
        ...f.event,
        source: "private source",
      } as NotificationEvent),
    ).toThrow("event_invalid");
    expect(() =>
      f.service.prepare({ ...f.event, narrative: "x".repeat(1001) }),
    ).toThrow("event_invalid");
    await expect(
      f.enqueue({ ...f.event, narrative: "A bounded summary." }),
    ).rejects.toThrow("review_missing");
    expect(f.fixture.requests).toHaveLength(0);
  });

  it("rejects redirects without forwarding credentials and parses Discord rate-limit JSON", async () => {
    const f = await setup();
    f.fixture.modes["/redirect"] = {
      status: 307,
      headers: { Location: f.fixture.url + "/leak" },
    };
    const adapter = new HttpNotificationChannel(
      "webhook",
      f.fixture.url + "/redirect",
      { Authorization: "Bearer fixture-secret" },
    );
    expect(
      await adapter.deliver(
        { id: "redirect", payload: {}, recipients: [] },
        new AbortController().signal,
      ),
    ).toMatchObject({ outcome: "permanent", code: "redirect_denied" });
    expect(f.fixture.requests.map((r) => r.path)).toEqual(["/redirect"]);
    f.fixture.modes["/discord-rate"] = {
      status: 429,
      body: '{"retry_after":1.5}',
    };
    const discord = new HttpNotificationChannel(
      "discord",
      f.fixture.url + "/discord-rate",
    );
    expect(
      (
        await discord.deliver(
          { id: "rate", payload: {}, recipients: [] },
          new AbortController().signal,
        )
      ).retry_at,
    ).toBeGreaterThan(Date.now() + 1000);
  });

  it("cancels a hanging network transmission and preserves its intent for restart", async () => {
    const f = await setup();
    f.fixture.modes["/webhook"] = { hold: true };
    await f.enqueue();
    f.service.start();
    await until(() => f.fixture.requests.length === 2);
    await f.service.stop();
    const receipt = f.service
      .receipt(f.event.id)
      .find((r) => r.channel === "webhook")!;
    expect(receipt.state).toBe("pending");
    expect(receipt.attempts[0].result).toEqual({
      outcome: "uncertain",
      code: "interrupted",
    });
  });
});

describe("real SMTP and TLS", () => {
  it("maps normalized SMTP recipients to every original index while preserving local-part case", async () => {
    const f = await setup();
    const adapter = new SmtpNotificationChannel(
      {
        ...f.fixture.smtp,
        to: [
          "Case@EXAMPLE.invalid",
          "case@Example.INVALID",
          "Case@example.invalid",
        ],
      },
      { ca: f.fixture.cert },
    );
    const event = {
      id: "normalized-recipients",
      payload: {
        subject: "Safe",
        text: "Safe",
        occurred_at: f.event.occurred_at,
      },
      recipients: [0, 1, 2],
    };
    f.fixture.rejected.set("case@example.invalid", 550);
    expect(
      await adapter.deliver(event, AbortSignal.timeout(5000)),
    ).toMatchObject({ outcome: "permanent", accepted: [0, 2], rejected: [1] });
    expect(f.fixture.messages[0].to).toEqual(["Case@example.invalid"]);
    f.fixture.rejected.set("Case@example.invalid", 450);
    expect(
      await adapter.deliver(event, AbortSignal.timeout(5000)),
    ).toMatchObject({ outcome: "transient", rejected: [1] });
    expect(f.fixture.messages).toHaveLength(1);
    f.fixture.rejected.clear();
    expect(
      await adapter.deliver(
        { ...event, recipients: [0, 2] },
        AbortSignal.timeout(5000),
      ),
    ).toMatchObject({ outcome: "confirmed", accepted: [0, 2], rejected: [] });
    expect(f.fixture.messages[1].to).toEqual(["Case@example.invalid"]);
    expect(
      await adapter.deliver(
        { ...event, recipients: [1] },
        AbortSignal.timeout(5000),
      ),
    ).toMatchObject({ outcome: "confirmed", accepted: [1], rejected: [] });
    expect(f.fixture.messages[2].to).toEqual(["case@example.invalid"]);
  });

  it("classifies temporary AUTH replies and preserves permanent indices when every recipient refuses", async () => {
    const f = await setup();
    const adapter = new SmtpNotificationChannel(f.fixture.smtp, {
      ca: f.fixture.cert,
    });
    const event = {
      id: "smtp-failures",
      payload: {
        subject: "Safe",
        text: "Safe",
        occurred_at: f.event.occurred_at,
      },
      recipients: [0, 1],
    };
    f.fixture.state.auth_code = 454;
    expect(
      await adapter.deliver(event, AbortSignal.timeout(5000)),
    ).toMatchObject({ outcome: "transient", code: "smtp_rejected" });
    f.fixture.state.auth_code = 0;
    f.fixture.rejected.set(f.fixture.smtp.to[0], 450);
    f.fixture.rejected.set(f.fixture.smtp.to[1], 550);
    expect(
      await adapter.deliver(event, AbortSignal.timeout(5000)),
    ).toMatchObject({ outcome: "transient", rejected: [1] });
    expect(f.fixture.messages).toHaveLength(0);
  });
  for (const secure of [true, false])
    it(`delivers MIME and authenticates only over TLS (implicit=${secure})`, async () => {
      const f = await setup({ secure });
      const adapter = new SmtpNotificationChannel(f.fixture.smtp, {
        ca: f.fixture.cert,
      });
      const event = {
        id: "smtp-stable",
        payload: {
          subject: "Maintenance status",
          text: "A safe message.",
          occurred_at: f.event.occurred_at,
        },
        recipients: [0, 1],
      };
      expect(
        await adapter.deliver(event, AbortSignal.timeout(5000)),
      ).toMatchObject({ outcome: "confirmed", accepted: [0, 1] });
      expect(f.fixture.auth).toEqual([
        {
          username: f.fixture.smtp.username,
          password: f.fixture.smtp.password,
          secure: true,
        },
      ]);
      const message = f.fixture.messages[0].raw;
      expect(message).toContain("Subject: Maintenance status");
      expect(message).toContain("Content-Type: text/plain; charset=utf-8");
      expect(message).toContain("A safe message.");
      expect(message).not.toContain(f.fixture.smtp.password);
      await adapter.deliver(event, AbortSignal.timeout(5000));
      expect(f.fixture.messages[0].raw.match(/^Message-ID: (.*)$/im)?.[1]).toBe(
        f.fixture.messages[1].raw.match(/^Message-ID: (.*)$/im)?.[1],
      );
    });

  it("rejects an untrusted certificate and refuses plaintext when STARTTLS is absent", async () => {
    const f = await setup();
    expect(
      await new SmtpNotificationChannel(f.fixture.smtp).deliver(
        {
          id: "untrusted",
          payload: {
            subject: "Safe",
            text: "Safe",
            occurred_at: f.event.occurred_at,
          },
          recipients: [0],
        },
        AbortSignal.timeout(5000),
      ),
    ).toMatchObject({ outcome: "permanent", code: "smtp_tls_failed" });
    expect(f.fixture.auth).toHaveLength(0);
    const plain = await setup({ secure: false, noStartTls: true });
    expect(
      (
        await new SmtpNotificationChannel(plain.fixture.smtp, {
          ca: plain.fixture.cert,
        }).deliver(
          {
            id: "no-starttls",
            payload: {
              subject: "Safe",
              text: "Safe",
              occurred_at: f.event.occurred_at,
            },
            recipients: [0],
          },
          AbortSignal.timeout(5000),
        )
      ).outcome,
    ).toBe("permanent");
    expect(plain.fixture.auth).toHaveLength(0);
  });

  it("reports partial recipient acceptance and aborts while waiting for the DATA acknowledgement", async () => {
    const f = await setup();
    const adapter = new SmtpNotificationChannel(f.fixture.smtp, {
      ca: f.fixture.cert,
    });
    const event = {
      id: "partial",
      payload: {
        subject: "Safe",
        text: "Safe",
        occurred_at: f.event.occurred_at,
      },
      recipients: [0, 1],
    };
    f.fixture.rejected.set(f.fixture.smtp.to[1], 450);
    expect(
      await adapter.deliver(event, AbortSignal.timeout(5000)),
    ).toMatchObject({ outcome: "transient", accepted: [0], rejected: [] });
    f.fixture.rejected.clear();
    f.fixture.state.hold = true;
    const controller = new AbortController();
    const waiting = adapter.deliver(
      { ...event, recipients: [1] },
      controller.signal,
    );
    await until(() => f.fixture.messages.length === 2);
    controller.abort();
    expect(await waiting).toMatchObject({
      outcome: "uncertain",
      code: "interrupted",
    });
    expect(f.fixture.messages[1].to).toEqual([f.fixture.smtp.to[1]]);
  });
});
