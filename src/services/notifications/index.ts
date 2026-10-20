import type { RunSnapshot } from "../../config/load.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import { immutable } from "../../config/bundles.ts";
import { digest, RuntimeError } from "../../domain/agents.ts";
import type { Store } from "../../repositories/store.ts";
import { NotificationRepository } from "../../repositories/notifications.ts";
import type { ExternalOutputReview } from "../publication/review.ts";
import { HttpNotificationChannel } from "../../adapters/notifications/http.ts";
import { SmtpNotificationChannel } from "../../adapters/notifications/smtp.ts";
import {
  channelNames,
  eventSchema,
  NotificationError,
  reasons,
  type ChannelName,
  type DeliveryReceipt,
  type DeliveryResult,
  type NotificationChannel,
  type NotificationEvent,
  type PreparedNotification,
} from "./contracts.ts";

export class NotificationService {
  readonly repository: NotificationRepository;
  private readonly channels: Partial<Record<ChannelName, NotificationChannel>> =
    {};
  private readonly controller = new AbortController();
  private readonly active = new Map<ChannelName, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private failure: string | null = null;
  private readonly store: Store;
  private readonly snapshot: RunSnapshot;
  private readonly secrets: SecretAccessor;
  private readonly outputReview: Pick<ExternalOutputReview, "verify">;

  constructor(
    store: Store,
    snapshot: RunSnapshot,
    secrets: SecretAccessor,
    outputReview: Pick<ExternalOutputReview, "verify">,
  ) {
    this.store = store;
    this.snapshot = snapshot;
    this.secrets = secrets;
    this.outputReview = outputReview;
    this.repository = new NotificationRepository(store);
    for (const name of channelNames) {
      const config = secrets.notification(name);
      if (!config.enabled) continue;
      if (name === "discord" && "webhook_url" in config)
        this.channels.discord = new HttpNotificationChannel(
          "discord",
          config.webhook_url,
        );
      if (name === "webhook" && "url" in config)
        this.channels.webhook = new HttpNotificationChannel(
          "webhook",
          config.url,
          config.headers,
        );
      if (name === "smtp" && "host" in config)
        this.channels.smtp = new SmtpNotificationChannel(config);
    }
  }

  prepare(input: NotificationEvent): PreparedNotification {
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) throw new NotificationError("event_invalid");
    const event = parsed.data;
    this.current(event);
    if (this.secrets.containsCredentials(event))
      throw new NotificationError("content_rejected");
    const repository = this.store.repository()!.full_name;
    const issue = `https://github.com/${repository}/issues/${event.issue_number}`;
    const pull = event.pull_number
      ? `https://github.com/${repository}/pull/${event.pull_number}`
      : undefined;
    const subject = `Repository maintenance: ${event.outcome === "ready_for_review" ? "ready for human review" : "attention required"}`;
    const text = [
      subject,
      reasons[event.reason],
      issue,
      ...(pull ? [pull] : []),
      ...(event.narrative ? [event.narrative] : []),
      `Event: ${event.id}`,
    ].join("\n");
    if (text.length > 2000) throw new NotificationError("content_limit");
    const channels: PreparedNotification["channels"] = {};
    for (const name of channelNames) {
      const adapter = this.channels[name];
      if (!adapter) continue;
      const payload =
        name === "discord"
          ? {
              content: text,
              allowed_mentions: {
                parse: [],
                users: [],
                roles: [],
                replied_user: false,
              },
            }
          : name === "smtp"
            ? { subject, text, occurred_at: event.occurred_at }
            : {
                version: 1,
                event_id: event.id,
                repository_id: event.repository_id,
                repository,
                issue: { number: event.issue_number, url: issue },
                ...(pull
                  ? {
                      pull: {
                        number: event.pull_number,
                        url: pull,
                        head_sha: event.head_sha,
                      },
                    }
                  : {}),
                outcome: event.outcome,
                reason: event.reason,
                occurred_at: event.occurred_at,
                ...(event.narrative ? { summary: event.narrative } : {}),
              };
      channels[name] = {
        binding: adapter.binding,
        recipients: adapter.recipients,
        payload,
      };
    }
    const review = {
      job_id: event.job_id,
      revision: event.revision,
      destination: {
        type: "notification",
        channels: Object.fromEntries(
          Object.entries(channels).map(([name, value]) => [
            name,
            value.binding,
          ]),
        ),
      },
      payload: Object.fromEntries(
        Object.entries(channels).map(([name, value]) => [name, value.payload]),
      ),
      evidence: {
        event_id: event.id,
        repository_id: event.repository_id,
        issue_number: event.issue_number,
        outcome: event.outcome,
        reason: event.reason,
        head_sha: event.head_sha ?? null,
        policy:
          "Only bounded operator summaries are permitted; reject source code, raw logs, transcripts, credentials, and unsupported claims. Readiness is asserted by the supervisor caller, not discovered by notification delivery.",
      },
    };
    return immutable({ event, channels, review });
  }

  async enqueue(
    prepared: PreparedNotification,
    options: { review_id?: string },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.controller.signal.aborted)
      throw new NotificationError("service_stopped");
    const canonical = this.prepare(prepared.event);
    if (digest(canonical) !== digest(prepared))
      throw new NotificationError("prepared_mismatch");
    if (prepared.event.narrative) {
      if (!options.review_id) throw new NotificationError("review_missing");
      this.outputReview.verify(options.review_id, prepared.review);
    }
    this.repository.enqueue(canonical, options.review_id ?? null);
    this.wake();
    return this.receipt(prepared.event.id);
  }

  receipt(id: string) {
    return immutable(this.repository.receipts(id));
  }

  status() {
    const counts = {
      pending: 0,
      dispatching: 0,
      confirmed: 0,
      failed: 0,
      uncertain: 0,
      held: 0,
    };
    const channels = Object.fromEntries(
      channelNames.map((name) => [
        name,
        { ...counts, reason: null as string | null },
      ]),
    );
    for (const receipt of this.repository.receipts()) {
      counts[receipt.state]++;
      channels[receipt.channel][receipt.state]++;
      if (receipt.reason) channels[receipt.channel].reason = receipt.reason;
    }
    return {
      state: this.failure ? "degraded" : this.started ? "running" : "stopped",
      reason: this.failure,
      ...counts,
      channels,
    };
  }

  start() {
    if (this.started || this.controller.signal.aborted) return;
    for (const receipt of this.repository.receipts()) {
      if (receipt.state === "dispatching") {
        this.finish(receipt, { outcome: "uncertain", code: "interrupted" });
      }
      if (receipt.state === "pending") this.eligible(receipt);
    }
    this.started = true;
    this.wake();
  }

  private current(event: NotificationEvent) {
    const repository = this.store.repository();
    const job = this.store.jobById(event.job_id);
    if (
      !repository ||
      repository.id !== event.repository_id ||
      repository.full_name !== this.snapshot.settings.github.repository ||
      !job ||
      job.revision !== event.revision ||
      job.issue_number !== event.issue_number ||
      job.status !== "pending"
    )
      throw new NotificationError("event_stale");
    if (event.pull_number) {
      const pull = this.store.ownedPull(event.pull_number);
      if (
        !pull ||
        pull.job_id !== job.id ||
        (event.head_sha && pull.head_sha !== event.head_sha)
      )
        throw new NotificationError("event_stale");
    }
  }

  private eligible(receipt: DeliveryReceipt) {
    const stored = this.repository.event(receipt.event_id)!;
    const expected = stored.prepared.channels[receipt.channel]!;
    try {
      this.current(stored.prepared.event);
      if (this.channels[receipt.channel]?.binding !== expected.binding)
        throw new NotificationError("destination_changed");
      if (this.secrets.containsCredentials(stored.prepared))
        throw new NotificationError("content_rejected");
      if (stored.prepared.event.narrative) {
        if (!stored.review_id) throw new NotificationError("review_missing");
        this.outputReview.verify(stored.review_id, stored.prepared.review);
      }
      return true;
    } catch (error) {
      if (
        !(error instanceof NotificationError) &&
        !(error instanceof RuntimeError)
      )
        throw error;
      receipt.state = "held";
      receipt.reason =
        error instanceof NotificationError ? error.code : "review_invalid";
      this.repository.save(receipt);
      return false;
    }
  }

  private wake() {
    if (!this.started || this.controller.signal.aborted || this.failure) return;
    clearTimeout(this.timer);
    try {
      const receipts = this.repository
        .receipts()
        .filter((receipt) => receipt.state === "pending");
      let next = Infinity;
      for (const name of channelNames) {
        if (this.active.has(name)) continue;
        const adapter = this.channels[name];
        for (const receipt of receipts.filter(
          (value) => value.channel === name,
        )) {
          if (!this.eligible(receipt)) continue;
          const due = Math.max(
            receipt.retry_at,
            this.repository.backoff(name, adapter!.binding),
          );
          if (due > Date.now()) {
            next = Math.min(next, due);
            continue;
          }
          const task = this.deliver(receipt)
            .catch(() => {
              this.failure = "storage_unavailable";
            })
            .finally(() => {
              this.active.delete(name);
              this.wake();
            });
          this.active.set(name, task);
          break;
        }
      }
      if (Number.isFinite(next))
        this.timer = setTimeout(
          () => this.wake(),
          Math.min(2_147_483_647, Math.max(1, next - Date.now())),
        );
    } catch {
      this.failure = "storage_unavailable";
    }
  }

  private async deliver(receipt: DeliveryReceipt) {
    const stored = this.repository.event(receipt.event_id)!;
    const channel = stored.prepared.channels[receipt.channel]!;
    receipt.state = "dispatching";
    receipt.attempts.push({
      started_at: Date.now(),
      finished_at: null,
      result: null,
    });
    this.repository.save(receipt);
    const recipients = Array.from(
      { length: channel.recipients },
      (_, index) => index,
    ).filter(
      (index) =>
        !receipt.accepted.includes(index) && !receipt.rejected.includes(index),
    );
    let result: DeliveryResult;
    try {
      result = await this.channels[receipt.channel]!.deliver(
        { id: receipt.event_id, payload: channel.payload, recipients },
        AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]),
      );
    } catch {
      result = { outcome: "uncertain", code: "interrupted" };
    }
    this.finish(receipt, result);
  }

  private finish(receipt: DeliveryReceipt, result: DeliveryResult) {
    const last = receipt.attempts.at(-1)!;
    last.finished_at = Date.now();
    last.result = result;
    receipt.accepted = [
      ...new Set([...receipt.accepted, ...(result.accepted ?? [])]),
    ];
    receipt.rejected = [
      ...new Set([...receipt.rejected, ...(result.rejected ?? [])]),
    ];
    const recipients = this.repository.event(receipt.event_id)!.prepared
      .channels[receipt.channel]!.recipients;
    const complete = recipients
      ? receipt.accepted.length === recipients
      : result.outcome === "confirmed";
    const uncertain = receipt.attempts.some(
      (attempt) => attempt.result?.outcome === "uncertain",
    );
    const terminal =
      result.outcome === "permanent" ||
      receipt.attempts.length >= 3 ||
      (recipients > 0 &&
        receipt.accepted.length + receipt.rejected.length === recipients);
    receipt.state = complete
      ? "confirmed"
      : terminal
        ? uncertain
          ? "uncertain"
          : "failed"
        : "pending";
    receipt.reason = receipt.rejected.length ? "smtp_rejected" : result.code;
    receipt.retry_at = Math.max(
      Date.now() + (receipt.attempts.length === 1 ? 5000 : 30000),
      result.retry_at ?? 0,
    );
    if (result.retry_at)
      this.repository.backoff(
        receipt.channel,
        this.repository.event(receipt.event_id)!.prepared.channels[
          receipt.channel
        ]!.binding,
        result.retry_at,
      );
    this.repository.save(receipt);
  }

  async stop() {
    this.started = false;
    clearTimeout(this.timer);
    this.controller.abort();
    await Promise.all(this.active.values());
    if (this.failure) throw new NotificationError(this.failure);
  }
}
