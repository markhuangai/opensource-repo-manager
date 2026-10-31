import { z } from "zod";
import { isContainedReference } from "../../config/files.ts";
import type { SourceMetadata } from "../../domain/jobs.ts";
import type { ModelProfile } from "../../config/schema.ts";
import type { PhaseContinuation } from "../clarification-contracts.ts";
import {
  commandSchema,
  type CommandReceipt,
  type ToolEnvironment,
} from "../bootstrap/contracts.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const implementationPlanSchema = z.strictObject({
  acceptance: z.array(z.string().trim().min(1).max(4096)).min(1).max(32),
  paths: z
    .array(z.string().min(1).max(4096).refine(isContainedReference))
    .min(1)
    .max(64),
  regression: commandSchema,
  checks: z.array(commandSchema).max(32),
});
export const implementationResultSchema = z.strictObject({
  summary: z.string().trim().min(1).max(12000),
  title: z.string().trim().min(1).max(256),
  commit_message: z.string().trim().min(1).max(4096),
});
export const implementationAuditSchema = z.strictObject({
  approved: z.boolean(),
  scope_digest: hash,
  artifact_digest: hash,
  findings: z.array(z.string().min(1).max(4096)).max(64),
});
export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;
export type ImplementationResult = z.infer<typeof implementationResultSchema>;
export type FrozenScope = {
  job_id: number;
  revision: number;
  investigation_id: string;
  source: SourceMetadata;
  snapshot_digest: string;
  objective: string;
  plan: ImplementationPlan;
  checks: ImplementationPlan["checks"];
  remote_checks: unknown[];
};
export type AuditReceipt = {
  id: string;
  run_id: string;
  profile: ModelProfile;
  result: z.infer<typeof implementationAuditSchema>;
  evidence_id: string | null;
};
export type VerificationReceipt = {
  id: string;
  job_id: number;
  revision: number;
  scope_digest: string;
  artifact_digest: string;
  source: SourceMetadata;
  audit_id: string;
  bootstrap_receipt: string;
  run_id: string;
  environment: ToolEnvironment;
  environment_digest: string;
  commands: CommandReceipt[];
  state: "running" | "passed" | "failed" | "interrupted";
  started_at: number;
  finished_at: number | null;
  evidence_id: string | null;
};
export type Implementation = {
  continuation?: PhaseContinuation;
  id: string;
  job_id: number;
  revision: number;
  investigation_id: string;
  source: SourceMetadata;
  snapshot_digest: string;
  stage:
    | "queued"
    | "planning"
    | "implementing"
    | "auditing"
    | "testing"
    | "publishing"
    | "remote_review"
    | "blocked"
    | "cancelled";
  scope: FrozenScope | null;
  scope_digest: string | null;
  baseline_digest: string | null;
  artifact_digest: string | null;
  result: ImplementationResult | null;
  bootstrap_receipt: string | null;
  candidate_bootstrap: string | null;
  milestone_done: boolean;
  audit_id: string | null;
  test_id: string | null;
  audits: AuditReceipt[];
  tests: VerificationReceipt[];
  agent_pending: { task: string; prior_runs: string[] } | null;
  recovery_attempts: string[];
  publication_id: string | null;
  status_operation: string | null;
  status_generation: number;
  feedback: string[];
  failure: string | null;
  retry_at: number;
  retry_stage: Implementation["stage"] | null;
  started_at: number;
};

export const implementationStageText: Record<Implementation["stage"], string> =
  {
    queued: "Confirmed maintenance is queued for implementation.",
    planning: "Freezing the maintenance scope and repository checks.",
    implementing:
      "Implementing the frozen maintenance objective. No passing tests are claimed.",
    auditing:
      "Independently auditing the frozen candidate before verification.",
    testing:
      "Executing repository checks under the unprivileged verification user.",
    publishing:
      "Reviewing the audited and tested candidate for first PR publication.",
    remote_review:
      "A pull request is open and awaiting remote validation. Automation readiness has not been established; human merge remains required.",
    blocked:
      "Maintenance implementation is blocked. No completion is claimed; operator attention is required.",
    cancelled: "This implementation revision is no longer active.",
  };
