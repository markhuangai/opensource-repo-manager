import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { notificationFixture } from "./fixture.mts";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";
import { parseConfiguration } from "/opt/orm/app/dist/config/schema.js";
import {
  loadProtectedConfiguration,
  createRunSnapshot,
} from "/opt/orm/app/dist/config/load.js";
import { separateSecrets } from "/opt/orm/app/dist/config/secrets.js";

async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert(Date.now() < deadline, "notification production proof timed out");
    await delay(20);
  }
}
export async function runNotificationTests() {
  const root = "/data/notification-proof";
  await mkdir(root, { mode: 0o700 });
  const fixture = await notificationFixture(root, {
    key: "/fixture-key.pem",
    cert: "/fixture-ca.pem",
  });
  const config = parseConfiguration(
    await readFile("/config/config.yml", "utf8"),
  );
  config.notifications = {
    discord: { enabled: true, webhook_url: fixture.url + "/discord" },
    webhook: {
      enabled: true,
      url: fixture.url + "/webhook",
      headers: { Authorization: "Bearer notification-production-canary" },
    },
    smtp: fixture.smtp,
  };
  const loaded = await loadProtectedConfiguration();
  const { settings, secrets } = separateSecrets(config);
  const snapshot = createRunSnapshot(
    settings,
    Object.fromEntries(
      Object.entries(loaded.snapshot.roles).map(([role, value]) => [
        role,
        value.bundle,
      ]),
    ),
    secrets,
  );
  const path = root + "/state/manager.sqlite";
  let store = new Store(path),
    supervisor;
  const create = () =>
    Supervisor.create(store, snapshot, secrets, { root: root + "/runtime" });
  const signal = () => new globalThis.AbortController().signal;
  try {
    store.saveSnapshot(snapshot);
    store.enroll({
      id: 42,
      full_name: "owner/repo",
      default_branch: "main",
      private: true,
    });
    store.discover([1], 1, true);
    store.applyIssue(
      store.nextDirty(),
      {
        id: 10001,
        number: 1,
        state: "open",
        title: "Private issue text must not be rendered",
        body: "Private source must not be rendered",
        comments: [],
        updated_at: "2026-10-19T00:00:00Z",
        source: {
          default_branch: "main",
          sha: "a".repeat(40),
          tree_sha: "b".repeat(40),
        },
      },
      snapshot,
    );
    const job = store.job(1);
    const event = {
      id: "production-notification",
      job_id: job.id,
      revision: job.revision,
      repository_id: 42,
      issue_number: 1,
      occurred_at: 1792451961000,
      outcome: "needs_attention",
      reason: "workflow_blocked",
    };
    supervisor = await create();
    await supervisor.notifications.enqueue(
      supervisor.notifications.prepare(event),
      {},
      signal(),
    );
    supervisor.notifications.start();
    await until(() =>
      supervisor.notifications
        .receipt(event.id)
        .every((r) => r.state === "confirmed"),
    );
    assert.equal(fixture.messages.length, 1);
    assert(
      fixture.messages[0].raw.includes(
        "Content-Type: text/plain; charset=utf-8",
      ),
    );
    assert(
      fixture.messages[0].raw
        .split(/\r?\n/)
        .includes("https://github.com/owner/repo/issues/1"),
    );
    assert(!fixture.messages[0].raw.includes("Private source"));
    assert(fixture.auth.every((row) => row.secure));
    assert.equal(fixture.requests.length, 2);
    assert.equal(
      fixture.requests.find((row) => row.path === "/webhook").headers
        .authorization,
      "Bearer notification-production-canary",
    );
    assert.equal(
      fixture.requests.find((row) => row.path === "/discord").headers
        .authorization,
      undefined,
    );
    assert.deepEqual(
      fixture.requests.find((row) => row.path === "/discord").body
        .allowed_mentions.parse,
      [],
    );
    assert(
      !JSON.stringify(supervisor.notifications.receipt(event.id)).includes(
        "notification-production-canary",
      ),
    );
    await supervisor.close();
    store.close();
    store = new Store(path);
    supervisor = await create();
    supervisor.notifications.start();
    await supervisor.notifications.enqueue(
      supervisor.notifications.prepare(event),
      {},
      signal(),
    );
    await delay(50);
    assert.equal(fixture.messages.length, 1);
    assert.equal(fixture.requests.length, 2);

    const partial = { ...event, id: "partial-smtp" };
    fixture.rejected.set(fixture.smtp.to[1], 450);
    await supervisor.notifications.enqueue(
      supervisor.notifications.prepare(partial),
      {},
      signal(),
    );
    await until(
      () =>
        supervisor.notifications
          .receipt(partial.id)
          .find((r) => r.channel === "smtp").state === "pending" &&
        fixture.messages.length === 2,
    );
    assert.deepEqual(
      supervisor.notifications
        .receipt(partial.id)
        .find((r) => r.channel === "smtp").accepted,
      [0],
    );
    fixture.rejected.clear();
    await until(() =>
      supervisor.notifications
        .receipt(partial.id)
        .every((r) => r.state === "confirmed"),
    );
    assert.deepEqual(fixture.messages[2].to, [fixture.smtp.to[1]]);

    const temporaryAuth = { ...event, id: "temporary-auth" };
    fixture.state.auth_code = 454;
    await supervisor.notifications.enqueue(
      supervisor.notifications.prepare(temporaryAuth),
      {},
      signal(),
    );
    await until(
      () =>
        supervisor.notifications
          .receipt(temporaryAuth.id)
          .find((r) => r.channel === "smtp").attempts[0]?.finished_at,
    );
    assert.equal(
      supervisor.notifications
        .receipt(temporaryAuth.id)
        .find((r) => r.channel === "smtp").state,
      "pending",
    );
    fixture.state.auth_code = 0;
    await until(() =>
      supervisor.notifications
        .receipt(temporaryAuth.id)
        .every((r) => r.state === "confirmed"),
    );
    assert.equal(
      supervisor.notifications
        .receipt(temporaryAuth.id)
        .find((r) => r.channel === "smtp").attempts.length,
      2,
    );

    const mixed = { ...event, id: "mixed-refusal" };
    fixture.rejected.set(fixture.smtp.to[0], 450);
    fixture.rejected.set(fixture.smtp.to[1], 550);
    await supervisor.notifications.enqueue(
      supervisor.notifications.prepare(mixed),
      {},
      signal(),
    );
    await until(
      () =>
        supervisor.notifications
          .receipt(mixed.id)
          .find((r) => r.channel === "smtp").attempts[0]?.finished_at,
    );
    const mixedFirst = supervisor.notifications
      .receipt(mixed.id)
      .find((r) => r.channel === "smtp");
    assert.equal(mixedFirst.state, "pending");
    assert.deepEqual(mixedFirst.rejected, [1]);
    await supervisor.close();
    store.close();
    store = new Store(path);
    supervisor = await create();
    fixture.rejected.clear();
    const beforeMixedRetry = fixture.messages.length;
    supervisor.notifications.start();
    await until(
      () =>
        supervisor.notifications
          .receipt(mixed.id)
          .find((r) => r.channel === "smtp").state === "failed",
    );
    const mixedFinal = supervisor.notifications
      .receipt(mixed.id)
      .find((r) => r.channel === "smtp");
    assert.deepEqual(mixedFinal.accepted, [0]);
    assert.deepEqual(mixedFinal.rejected, [1]);
    assert.equal(mixedFinal.attempts.length, 2);
    assert.equal(mixedFinal.reason, "smtp_rejected");
    assert.deepEqual(fixture.messages[beforeMixedRetry].to, [
      fixture.smtp.to[0],
    ]);

    const ambiguous = { ...event, id: "ambiguous-http" };
    fixture.modes["/webhook"] = { lose: true };
    await supervisor.notifications.enqueue(
      supervisor.notifications.prepare(ambiguous),
      {},
      signal(),
    );
    await until(
      () =>
        supervisor.notifications
          .receipt(ambiguous.id)
          .find((r) => r.channel === "webhook").state === "uncertain",
      60000,
    );
    const receipt = supervisor.notifications
      .receipt(ambiguous.id)
      .find((r) => r.channel === "webhook");
    assert.equal(receipt.attempts.length, 3);
    assert(
      receipt.attempts.every(
        (attempt) => attempt.result.outcome === "uncertain",
      ),
    );
    assert.equal(
      fixture.requests.filter(
        (row) =>
          row.headers["idempotency-key"] === ambiguous.id &&
          row.path === "/webhook",
      ).length,
      3,
    );
    return {
      notifications: "passed",
      channels: ["discord", "smtp", "webhook"],
      durable_restart: "passed",
      smtp_partial_recipients: "passed",
      smtp_temporary_auth: "passed",
      smtp_mixed_refusal_restart: "passed",
      bounded_ambiguous_retries: "passed",
      cleanup: "passed",
    };
  } finally {
    await supervisor?.close();
    if (store.db.open) store.close();
    await fixture.close();
  }
}
