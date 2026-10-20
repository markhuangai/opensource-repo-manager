import { z } from "zod";
import { githubId, sha } from "../../domain/jobs.ts";
import type { ReviewRequest } from "../publication/contracts.ts";

export const channelNames = ["discord", "smtp", "webhook"] as const;
export type ChannelName = (typeof channelNames)[number];
export const reasons = {
  automation_clean: "Automation checks completed; human review is required.",
  model_unavailable: "The configured model is unavailable.",
  budget_exhausted: "The workflow exhausted its configured budget.",
  publication_blocked: "Publication needs operator attention.",
  workflow_blocked: "The workflow needs operator attention.",
  review_timeout: "The workflow timed out waiting for review.",
  checks_failed: "Required checks failed.",
  infrastructure_failed: "Workflow infrastructure needs attention.",
} as const;
export const eventSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    job_id: githubId,
    revision: githubId,
    repository_id: githubId,
    issue_number: githubId,
    pull_number: githubId.optional(),
    head_sha: sha.optional(),
    occurred_at: z.number().int().positive().max(8_640_000_000_000_000),
    outcome: z.enum(["ready_for_review", "needs_attention"]),
    reason: z.enum(
      Object.keys(reasons) as [
        keyof typeof reasons,
        ...Array<keyof typeof reasons>,
      ],
    ),
    narrative: z
      .string()
      .min(1)
      .max(1000)
      .refine(
        (value) =>
          [...value].every((character) => {
            const code = character.charCodeAt(0);
            return (code >= 32 && code !== 127) || [9, 10, 13].includes(code);
          }) && !value.includes("```"),
      )
      .optional(),
  })
  .superRefine((event, ctx) => {
    if (
      (event.outcome === "ready_for_review") !==
        (event.reason === "automation_clean") ||
      (event.outcome === "ready_for_review" &&
        (!event.pull_number || !event.head_sha))
    )
      ctx.addIssue({ code: "custom", message: "notification_event_invalid" });
  });
export type NotificationEvent = z.infer<typeof eventSchema>;
export type ChannelPayload = {
  binding: string;
  payload: Readonly<Record<string, unknown>>;
  recipients: number;
};
export type PreparedNotification = {
  event: NotificationEvent;
  channels: Partial<Record<ChannelName, ChannelPayload>>;
  review: ReviewRequest;
};
export type DeliveryCode =
  | "accepted"
  | "network_failure"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_rejected"
  | "redirect_denied"
  | "response_invalid"
  | "smtp_rejected"
  | "smtp_tls_failed"
  | "interrupted";
export type DeliveryResult = {
  outcome: "confirmed" | "transient" | "permanent" | "uncertain";
  code: DeliveryCode;
  retry_at?: number;
  accepted?: number[];
  rejected?: number[];
};
export interface NotificationChannel {
  readonly binding: string;
  readonly recipients: number;
  deliver(
    event: {
      id: string;
      payload: Readonly<Record<string, unknown>>;
      recipients: number[];
    },
    signal: AbortSignal,
  ): Promise<DeliveryResult>;
}
export type DeliveryReceipt = {
  event_id: string;
  channel: ChannelName;
  state:
    "pending" | "dispatching" | "confirmed" | "failed" | "uncertain" | "held";
  reason: string | null;
  retry_at: number;
  accepted: number[];
  rejected: number[];
  attempts: Array<{
    started_at: number;
    finished_at: number | null;
    result: DeliveryResult | null;
  }>;
};

export class NotificationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Notification unavailable (${code}).`);
    this.name = "NotificationError";
    this.code = code;
  }
}
