import type { Store } from "./store.ts";
import { digest } from "../domain/agents.ts";
import {
  channelNames,
  NotificationError,
  type ChannelName,
  type DeliveryReceipt,
  type PreparedNotification,
} from "../services/notifications/contracts.ts";

export class NotificationRepository {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  event(
    id: string,
  ): { prepared: PreparedNotification; review_id: string | null } | undefined {
    const row = this.store.db
      .prepare("SELECT content,review_id FROM notification_events WHERE id=?")
      .get(id) as { content: string; review_id: string | null } | undefined;
    return row
      ? {
          prepared: JSON.parse(row.content) as PreparedNotification,
          review_id: row.review_id,
        }
      : undefined;
  }

  enqueue(prepared: PreparedNotification, review_id: string | null) {
    this.store.db
      .transaction(() => {
        const previous = this.event(prepared.event.id);
        if (previous) {
          if (digest(previous.prepared) !== digest(prepared))
            throw new NotificationError("event_id_conflict");
          return;
        }
        this.store.db
          .prepare("INSERT INTO notification_events VALUES(?,?,?)")
          .run(prepared.event.id, JSON.stringify(prepared), review_id);
        for (const channel of channelNames) {
          if (!prepared.channels[channel]) continue;
          this.insert({
            event_id: prepared.event.id,
            channel,
            state: "pending",
            reason: null,
            retry_at: 0,
            accepted: [],
            rejected: [],
            attempts: [],
          });
        }
      })
      .immediate();
  }

  receipts(id?: string): DeliveryReceipt[] {
    const rows = (
      id === undefined
        ? this.store.db
            .prepare(
              "SELECT content FROM notification_deliveries ORDER BY rowid",
            )
            .all()
        : this.store.db
            .prepare(
              "SELECT content FROM notification_deliveries WHERE event_id=? ORDER BY channel",
            )
            .all(id)
    ) as { content: string }[];
    return rows.map((row) => JSON.parse(row.content) as DeliveryReceipt);
  }

  save(receipt: DeliveryReceipt) {
    this.store.db
      .prepare(
        "UPDATE notification_deliveries SET state=?,retry_at=?,content=? WHERE event_id=? AND channel=?",
      )
      .run(
        receipt.state,
        receipt.retry_at,
        JSON.stringify(receipt),
        receipt.event_id,
        receipt.channel,
      );
  }

  backoff(channel: ChannelName, binding: string, deadline?: number) {
    if (deadline !== undefined)
      this.store.db
        .prepare(
          "INSERT INTO notification_backoff VALUES(?,?,?) ON CONFLICT(channel,binding) DO UPDATE SET retry_at=max(retry_at,excluded.retry_at)",
        )
        .run(channel, binding, deadline);
    const row = this.store.db
      .prepare(
        "SELECT retry_at FROM notification_backoff WHERE channel=? AND binding=?",
      )
      .get(channel, binding) as { retry_at: number } | undefined;
    return row?.retry_at ?? 0;
  }

  private insert(receipt: DeliveryReceipt) {
    this.store.db
      .prepare("INSERT INTO notification_deliveries VALUES(?,?,?,?,?)")
      .run(
        receipt.event_id,
        receipt.channel,
        receipt.state,
        receipt.retry_at,
        JSON.stringify(receipt),
      );
  }
}
