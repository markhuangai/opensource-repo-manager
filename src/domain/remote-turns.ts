import { z } from "zod";
import { githubId, sha } from "./jobs.ts";
import { roleNames } from "../config/schema.ts";

export const remoteDev = {
  repository: "markhuangai/agent-remote-dev",
  path: ".github/workflows/remote-dev.yml",
  tag: "v1.0.0",
  sha: "b25da0394133b6bf31c8d68cfa06766ddfffe092",
  dispatcher: "orm-agent.yml",
  planBytes: 65535,
  registrationMs: 10 * 60_000,
  runnerVersions: { codex: "0.169.0", claude: "0.3.326" },
} as const;

export const harness = z.enum(["codex", "claude"]);
export const phaseKey = z.string().regex(/^[a-f0-9]{64}$/);
const nativeProfileName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const remoteBlockingReasons = [
  "agent_progress_conflict",
  "agent_resume_conflict",
  "agent_artifact_conflict",
  "session_provenance_invalid",
] as const;
export const collectionRetryCauses = [
  "agent_run_not_visible",
  "github_read_failed",
  "github_rate_limited",
  "github_publication_failed",
  "session_transport_unavailable",
] as const;
const workRef = z.string().regex(/^orm-work\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/);
const nativeSessionSchema = z.strictObject({
  key: phaseKey,
  turn_id: z.uuid(),
  run_id: githubId,
  artifact_id: githubId,
  artifact_digest: phaseKey,
  sequence: githubId,
  root_run_id: githubId,
  session_id: z.uuid(),
  checkpoint_sha: sha,
  branch: workRef.nullable(),
});
export type NativeSession = z.infer<typeof nativeSessionSchema>;

const workProgressSchema = z.strictObject({
  key: phaseKey,
  branch: workRef,
  base_sha: sha,
  parent_sha: sha,
  head: sha.nullable(),
});
const pushedCandidateSchema = z.strictObject({
  branch: workRef,
  sha,
  writer_run_id: githubId,
});
export const agentRecoverySchema = z.strictObject({
  revision: githubId,
  last_run_id: githubId.optional(),
  blocked: z.enum(remoteBlockingReasons).optional(),
  investigation: nativeSessionSchema.optional(),
  coding: workProgressSchema
    .extend({
      session: nativeSessionSchema.optional(),
      candidate: pushedCandidateSchema.optional(),
      // This is the terminal writer whose verified ref supplied head.
      writer_run_id: githubId.optional(),
    })
    .optional(),
});
export type AgentRecovery = z.infer<typeof agentRecoverySchema>;
export type WorkProgress = z.infer<typeof workProgressSchema>;

export const turnSchema = z.strictObject({
  id: z.uuid(),
  job_id: githubId,
  revision: githubId,
  phase: z.enum(["investigation", "implementation", "remote_review"]),
  request_digest: phaseKey,
  role: z.enum(roleNames),
  profile: nativeProfileName,
  runner: harness,
  starting_sha: sha,
  work_branch: workRef.nullable(),
  progress: workProgressSchema.optional(),
  previous_writer_run_id: githubId.optional(),
  assessment: pushedCandidateSchema.optional(),
  recovery_key: phaseKey.optional(),
  resume: nativeSessionSchema.optional(),
  collection_retries: z.number().int().nonnegative().safe().optional(),
  collection_retry: z
    .strictObject({
      cause: z.enum(collectionRetryCauses),
      retry_at: z.number().int().positive().max(8.64e15),
    })
    .optional(),
  plan_digest: phaseKey,
  caller_sha: sha,
  workflow_id: githubId,
  timeout_minutes: z.number().int().min(1).max(360),
  created_at: z.number().int().positive().safe(),
  run_id: githubId.nullable(),
  receipt_run_id: githubId.optional(),
  elapsed_ms: z.number().int().nonnegative().safe().nullable(),
});
export type RemoteTurn = z.infer<typeof turnSchema>;

export type CandidateCommit = Readonly<{ branch: string; sha: string }>;

export const remoteRunSchema = z.object({
  id: githubId,
  run_attempt: githubId,
  workflow_id: githubId,
  path: z.string(),
  event: z.string(),
  display_title: z.string(),
  head_branch: z.string(),
  head_sha: sha,
  repository: z.object({ id: githubId, full_name: z.string() }),
  head_repository: z.object({ id: githubId }),
  actor: z.object({ id: githubId, login: z.string() }),
  triggering_actor: z.object({ id: githubId }),
  status: z.string(),
  conclusion: z.string().nullable(),
  created_at: z.iso.datetime(),
  referenced_workflows: z
    .array(z.object({ path: z.string(), ref: z.string().optional(), sha }))
    .optional(),
});
export type RemoteRun = z.infer<typeof remoteRunSchema>;

export const resultRecordSchema = z.strictObject({
  runner: harness,
  runner_version: z.string().min(1).max(64),
  response: z.string(),
  native_outcome: z.enum(["running", "completed", "failed", "cancelled"]),
  session_id: z.union([z.uuid(), z.literal("")]),
});

export const checkpointRecordSchema = z.object({
  schema_version: z.literal(5),
  repository: z.string(),
  runner: harness,
  runner_version: z.string().min(1).max(64),
  session_id: z.uuid(),
  branch: z.string().nullable(),
  root_run_id: z.string(),
  activation_run_id: z.string(),
  operator: z.string(),
  checkpoint_sha: sha,
  omitted_work: z.boolean(),
  provider_sha: z.literal(remoteDev.sha),
  outcome: z.enum(["running", "completed", "failed", "cancelled"]),
  auto_count: z.literal(0),
  sequence: githubId,
  lineage: z.object({
    run_id: z.string(),
    run_attempt: z.string(),
    workflow_id: githubId,
    workflow_path: z.string(),
    workflow_sha: sha,
    branch: z.string(),
  }),
});

export function turnTitle(issueNumber: number, turn: string) {
  return `ORM agent #${issueNumber} ${turn}`;
}

export class RemoteTurnPending extends Error {
  readonly retryAt?: number;

  constructor(retryAt?: number) {
    super("An authorized agent run is pending.");
    this.retryAt = retryAt;
  }
}

export const remoteRetryReasons = [
  "agent_run_failed",
  "agent_artifact_unavailable",
  "agent_result_invalid",
  "agent_push_missing",
  "agent_checkout_mismatch",
  "agent_candidate_incomplete",
  "session_transport_unavailable",
];
