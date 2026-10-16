import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunSnapshot } from "../config/load.ts";
import type { ModelProfile, Role } from "../config/schema.ts";
import { isContainedReference } from "../config/files.ts";
import type { SourceMetadata } from "./jobs.ts";

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) {
    super(`Worker unavailable (${code}).`, options);
    this.code = code;
    this.name = "RuntimeError";
  }
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function workerLimits(snapshot: RunSnapshot) {
  return {
    processes: snapshot.settings.limits.worker_processes ?? 128,
    output: snapshot.settings.limits.worker_output_bytes ?? 16 * 1024 * 1024,
    storage: snapshot.settings.limits.worker_storage_bytes ?? 4 * 1024 ** 3,
  };
}

export type McpConnection = Readonly<{
  alias: string;
  url: string;
  authorization: string;
  tools: readonly string[];
  deadline: number;
}>;
export interface McpSessionProvider {
  open(request: {
    run_id: string;
    job_id: number;
    revision: number;
    role: Role;
    grants: RunSnapshot["roles"][Role]["mcp"];
    deadline: number;
    signal: AbortSignal;
  }): Promise<{
    connections: readonly McpConnection[];
    policy_identity: string;
    catalog_identity: string;
    close(): Promise<void>;
  }>;
}

export type SessionIdentity = Readonly<{ id: string; binding: string }>;
export type AgentRunRequest = Readonly<{
  job_id: number;
  revision: number;
  role: Role;
  workspace: { source: SourceMetadata; artifact?: string };
  snapshot_digest: string;
  profile: ModelProfile;
  input?: unknown;
  resume?: SessionIdentity;
}>;
export type WorkerRequest = Omit<AgentRunRequest, "workspace"> & {
  run_id: string;
  workspace: string;
  home: string;
  temporary: string;
  prompts: { system: string; user: string; skills: string };
  relay: { url: string; authorization: string };
  mcp: readonly McpConnection[];
  binding: string;
};

const text = z.string().max(65536);
export const agentEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("progress"), message: text }),
  z.strictObject({
    type: z.literal("usage"),
    input_tokens: z.number().int().nonnegative().safe(),
    output_tokens: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({
    type: z.literal("artifact"),
    path: z.string().max(4096).refine(isContainedReference),
  }),
  z.strictObject({
    type: z.literal("session"),
    id: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_.:-]+$/),
  }),
  z.strictObject({
    type: z.literal("terminal"),
    outcome: z.enum(["completed", "failed", "cancelled", "limited", "stale"]),
    result: z.unknown().optional(),
    artifact: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
export const workerEnvelopeSchema = z.strictObject({
  run_id: z.uuid(),
  job_id: z.number().int().positive().safe(),
  revision: z.number().int().positive().safe(),
  event: agentEventSchema,
});
export interface AgentRunner {
  run(request: AgentRunRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export const roleUsers = {
  bootstrap: { name: "coding", uid: 10001, gid: 10001 },
  investigation: { name: "coding", uid: 10001, gid: 10001 },
  implementation: { name: "coding", uid: 10001, gid: 10001 },
  audit: { name: "audit", uid: 10002, gid: 10002 },
  output_review: { name: "output-review", uid: 10003, gid: 10003 },
} as const;

export type AgentRunRecord = {
  id: string;
  job_id: number;
  revision: number;
  role: Role;
  uid: number;
  parent_id: string | null;
  lease_token: string;
  binding_json: string;
  status: string;
  session_id: string | null;
  artifact_digest: string | null;
  started_at: number;
  finished_at: number | null;
};

export type ArtifactFile = { path: string; mode: number } & (
  { kind: "file"; digest: string } | { kind: "link"; target: string }
);
export type ArtifactManifest = {
  run_id: string;
  job_id: number;
  revision: number;
  source: SourceMetadata;
  files: ArtifactFile[];
};
