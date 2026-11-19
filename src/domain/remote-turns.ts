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
} as const;

export const harness = z.enum(["codex", "claude"]);
export const phaseKey = z.string().regex(/^[a-f0-9]{64}$/);
const nativeProfileName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
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
  work_branch: z
    .string()
    .regex(/^orm-work\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/)
    .nullable(),
  plan_digest: phaseKey,
  caller_sha: sha,
  workflow_id: githubId,
  timeout_minutes: z.number().int().min(1).max(360),
  created_at: z.number().int().positive().safe(),
  run_id: githubId.nullable(),
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
  native_outcome: z.literal("completed"),
  session_id: z.uuid(),
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
  omitted_work: z.literal(false),
  provider_sha: z.literal(remoteDev.sha),
  outcome: z.literal("completed"),
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
  constructor() {
    super("An authorized agent run is pending.");
  }
}

export const remoteRetryReasons = [
  "agent_run_failed",
  "agent_artifact_unavailable",
  "agent_result_invalid",
  "agent_push_missing",
  "agent_checkout_mismatch",
  "session_transport_unavailable",
];
