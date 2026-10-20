import type {
  DeliveryResult,
  NotificationChannel,
} from "../../services/notifications/contracts.ts";
import { digest } from "../../domain/agents.ts";

export function retryAfter(value: string | null, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  const deadline =
    Number.isFinite(seconds) && seconds >= 0
      ? now + seconds * 1000
      : Date.parse(value);
  return Number.isFinite(deadline) &&
    deadline > now &&
    deadline <= Number.MAX_SAFE_INTEGER
    ? Math.ceil(deadline)
    : 0;
}

export class HttpNotificationChannel implements NotificationChannel {
  readonly binding: string;
  readonly recipients = 0;
  private readonly kind: "discord" | "webhook";
  private readonly url: string;
  private readonly headers: Record<string, string>;
  constructor(
    kind: "discord" | "webhook",
    url: string,
    headers: Record<string, string> = {},
  ) {
    this.kind = kind;
    this.url = url;
    this.headers = headers;
    this.binding = digest({ version: 1, kind, url, headers });
  }

  async deliver(
    event: Parameters<NotificationChannel["deliver"]>[0],
    signal: AbortSignal,
  ): Promise<DeliveryResult> {
    signal.throwIfAborted();
    try {
      const response = await fetch(this.url, {
        method: "POST",
        redirect: "manual",
        signal,
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
          "Idempotency-Key": event.id,
        },
        body: JSON.stringify(event.payload),
      });
      let retry_at = retryAfter(response.headers.get("retry-after"));
      if (this.kind === "discord" && response.status === 429) {
        let bytes = 0,
          text = "";
        const reader = response.body?.getReader();
        if (reader) {
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > 65536) break;
              text += new TextDecoder().decode(next.value);
            }
          } finally {
            await reader.cancel();
          }
        }
        try {
          const value: unknown = JSON.parse(text);
          if (
            value &&
            typeof value === "object" &&
            "retry_after" in value &&
            typeof value.retry_after === "number" &&
            value.retry_after >= 0
          )
            retry_at = Math.max(
              retry_at,
              retryAfter(String(value.retry_after)),
            );
        } catch {
          /* A malformed rate-limit body does not override the HTTP outcome. */
        }
      } else await response.body?.cancel();
      if (response.status >= 200 && response.status < 300)
        return { outcome: "confirmed", code: "accepted" };
      if (response.status >= 300 && response.status < 400)
        return { outcome: "permanent", code: "redirect_denied" };
      if (response.status === 429)
        return { outcome: "transient", code: "rate_limited", retry_at };
      if (response.status >= 500 || response.status === 408)
        return { outcome: "transient", code: "provider_unavailable", retry_at };
      return { outcome: "permanent", code: "provider_rejected" };
    } catch {
      return {
        outcome: "uncertain",
        code: signal.aborted ? "interrupted" : "network_failure",
      };
    }
  }
}
