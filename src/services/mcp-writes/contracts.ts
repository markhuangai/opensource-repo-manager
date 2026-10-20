import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Role } from "../../config/schema.ts";
import type { SourceMetadata } from "../../domain/jobs.ts";
import { isContainedReference } from "../../config/files.ts";

export const reviewedWriteInput = z.strictObject({
  arguments: z.record(z.string(), z.unknown()),
  purpose: z.string().trim().min(1).max(65536),
  evidence: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("job") }),
        z.strictObject({
          kind: z.literal("source"),
          path: z.string().min(1).max(4096).refine(isContainedReference),
          start_line: z.number().int().positive().safe(),
          end_line: z.number().int().positive().safe(),
        }),
        z.strictObject({
          kind: z.literal("publication_evidence"),
          id: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      ]),
    )
    .min(1)
    .max(64),
});
export type ReviewedWriteInput = z.infer<typeof reviewedWriteInput>;
export type WriteBinding = {
  repository_id: number;
  repository: string;
  job_id: number;
  revision: number;
  phase: string;
  run_id: string;
  role: Role;
  snapshot_digest: string;
  source: SourceMetadata;
  artifact_digest: string | null;
  alias: string;
  endpoint: string;
  tool: string;
  credential_binding: string;
  policy_identity: string;
  scanner_policy: string;
  catalog_identity: string;
  review_required: boolean;
  idempotency_argument: string | null;
};
export interface McpWriteChannel {
  readonly binding: WriteBinding;
  readonly tool: Tool;
  assertCurrent(): void;
  validate(arguments_: Record<string, unknown>): boolean;
  transmit(
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}
export interface McpWriteTransport {
  openRecovery(
    binding: WriteBinding,
    deadline: number,
    signal: AbortSignal,
    current: () => void,
  ): Promise<McpWriteChannel>;
}
export type WriteResponse =
  | { kind: "result"; value: CallToolResult }
  | { kind: "error"; value: { code: number; message: string; data?: unknown } };
export type WriteState =
  "proposed" | "rejected" | "dispatching" | "response_recorded" | "uncertain";
export type McpWriteOperation = {
  id: string;
  job_id: number;
  revision: number;
  state: WriteState;
  binding: WriteBinding;
  request_digest: string;
  arguments: Record<string, unknown> | null;
  purpose: string | null;
  evidence: unknown;
  idempotency_key: string | null;
  review_id: string | null;
  review: "required" | "not_required";
  deadline: number;
  created_at: number;
  updated_at: number;
  failure: string | null;
  response: WriteResponse | null;
  notification: "pending" | "enqueued" | "failed" | null;
};
export type McpWriteAttempt = {
  operation_id: string;
  number: number;
  started_at: number;
  finished_at: number | null;
  state: "dispatching" | "response_recorded" | "uncertain";
  request_digest: string;
};

export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    ) as T;
  return value;
}
