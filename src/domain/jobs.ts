import { z } from "zod";

export const githubId = z.number().int().positive().safe();
export const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const repositoryIdentity = z.object({
  id: githubId,
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  default_branch: z.string().min(1).max(1024),
  private: z.boolean(),
});
export type RepositoryIdentity = z.infer<typeof repositoryIdentity>;

export const issueSummary = z.object({
  id: githubId,
  number: githubId,
  state: z.enum(["open", "closed"]),
  title: z.string(),
  body: z.string().nullable(),
  updated_at: z.string(),
});
export const issueComment = z.object({
  id: githubId,
  body: z.string().nullable(),
  updated_at: z.string(),
  user: z.object({ id: githubId, login: z.string() }).nullable(),
});
export type IssueContext = z.infer<typeof issueSummary> & {
  comments: z.infer<typeof issueComment>[];
  source: SourceMetadata;
};
export type SourceMetadata = {
  default_branch: string;
  sha: string;
  tree_sha: string;
};
export type PullContext = {
  id: number;
  number: number;
  state: "open" | "closed";
  head_sha: string;
  updated_at: string;
  comments: z.infer<typeof issueComment>[];
  reviews: unknown[];
  review_comments: unknown[];
  checks: unknown[];
  statuses: unknown[];
};
export type Target = { kind: "issue" | "pull"; number: number };
export type DirtyTarget = Target & { generation: number };
export type BudgetUsage = {
  active_ms: number;
  model_requests: number;
  repair_cycles: number;
  infrastructure_retries: number;
  wait_ms: number;
};
export const budgetUsage = z.strictObject({
  active_ms: z.number().int().nonnegative().safe(),
  model_requests: z.number().int().nonnegative().safe(),
  repair_cycles: z.number().int().nonnegative().safe(),
  infrastructure_retries: z.number().int().nonnegative().safe(),
  wait_ms: z.number().int().nonnegative().safe(),
});
export const initialBudget: BudgetUsage = {
  active_ms: 0,
  model_requests: 0,
  repair_cycles: 0,
  infrastructure_retries: 0,
  wait_ms: 0,
};
export type Job = {
  id: number;
  issue_id: number;
  issue_number: number;
  revision: number;
  phase: string;
  status: "pending" | "closed";
  input_digest: string;
  input_json: string;
  snapshot_digest: string;
  budget_json: string;
};
export type Publication = {
  operation_key: string;
  job_id: number;
  revision: number;
  kind:
    "issue_comment" | "review_comment" | "review" | "pull_request" | "commit";
  object_id: string;
  number: number | null;
  head_sha: string | null;
  receipt_json: string;
  context_json: string | null;
};

export class IntakeError extends Error {
  readonly code: string;
  readonly retryAt: number;
  constructor(code: string, retryAt = 0) {
    super(`Intake unavailable (${code}).`);
    this.name = "IntakeError";
    this.code = code;
    this.retryAt = retryAt;
  }
}
