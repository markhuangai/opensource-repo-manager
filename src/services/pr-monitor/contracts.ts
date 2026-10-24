import { z } from "zod";
import { githubId, sha } from "../../domain/jobs.ts";
import type { Configuration } from "../../config/schema.ts";

export type PrMonitorPolicy = Configuration["pr_monitor"];
const actor = z.object({ id: githubId, login: z.string() });
export const prReview = z.object({
  id: githubId,
  node_id: z.string(),
  user: actor.nullable(),
  commit_id: sha.nullable(),
  state: z.string(),
  body: z.string().nullable(),
  submitted_at: z.string().nullable(),
});
export const prComment = z.object({
  id: githubId,
  node_id: z.string(),
  body: z.string().nullable(),
  user: actor.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const prCheck = z.object({
  id: githubId,
  name: z.string(),
  head_sha: sha,
  app: z.object({ id: githubId, slug: z.string().optional() }),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  details_url: z.string().nullable(),
  output: z.object({
    title: z.string().nullable(),
    summary: z.string().nullable(),
    text: z.string().nullable(),
  }),
});
export const prStatus = z.object({
  id: githubId,
  context: z.string(),
  state: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  creator: actor.nullable(),
  description: z.string().nullable(),
  target_url: z.string().nullable(),
});
export const prReaction = z.object({
  id: githubId,
  content: z.string(),
  user: actor.nullable(),
  created_at: z.string(),
});
export const threadComment = z.object({
  id: z.string(),
  databaseId: githubId,
  body: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  originalLine: z.number().int().nullable(),
  commit: z.object({ oid: sha }).nullable(),
  originalCommit: z.object({ oid: sha }).nullable(),
  pullRequestReview: z
    .object({ databaseId: githubId, commit: z.object({ oid: sha }) })
    .nullable(),
});
export const prThread = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.array(threadComment).min(1),
});
export type PrThread = z.infer<typeof prThread>;
export type RequiredCheck = { name: string; app_id: number | null };
export type PrRequirements = {
  checks: RequiredCheck[];
  unknown: string[];
  human_approvals: number;
};
export type PrSnapshot = {
  id: number;
  node_id: string;
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  author_id: number | null;
  repository_id: number;
  base_repository_id: number;
  branch: string;
  base: string;
  base_sha: string;
  head_sha: string;
  updated_at: string;
  comments: z.infer<typeof prComment>[];
  reviews: z.infer<typeof prReview>[];
  threads: PrThread[];
  reactions: z.infer<typeof prReaction>[];
  checks: z.infer<typeof prCheck>[];
  statuses: z.infer<typeof prStatus>[];
  requirements: PrRequirements;
};
export type ReviewSurface = {
  id: string;
  digest: string;
  kind: "thread" | "review" | "comment" | "check";
  author: string | null;
  reviewed_sha: string | null;
  thread_id: string | null;
  body: string;
};
export const feedbackAssessment = z.strictObject({
  dispositions: z
    .array(
      z.strictObject({
        surface_id: z.string().min(1),
        disposition: z.enum([
          "fix",
          "fixed",
          "non_actionable",
          "informational",
          "blocked",
        ]),
        explanation: z.string().min(1).max(4096),
        citations: z
          .array(
            z.strictObject({
              path: z.string().min(1),
              start_line: z.number().int().positive(),
              end_line: z.number().int().positive(),
            }),
          )
          .max(32),
      }),
    )
    .max(256),
});
export type FeedbackAssessment = z.infer<typeof feedbackAssessment>;
export type FindingDisposition = FeedbackAssessment["dispositions"][number] & {
  surface: ReviewSurface;
  run_id: string;
  assessed_head: string;
  fixed_head: string | null;
  publication_id: string | null;
  evidence: unknown[];
};
export type PrMonitor = {
  id: string;
  job_id: number;
  implementation_id: string;
  revision: number;
  pull_number: number;
  expected_head: string;
  observed_head: string | null;
  publication_id: string;
  stage:
    | "waiting"
    | "queued"
    | "assessing"
    | "repairing"
    | "ready"
    | "blocked"
    | "closed";
  policy_digest: string;
  policy_generation: number;
  generation: number;
  snapshot_digest: string | null;
  assessment_digest: string | null;
  findings: FindingDisposition[];
  pending_agent: {
    task: "assessment" | "readiness";
    prior_runs: string[];
  } | null;
  recovery_attempts: string[];
  mcp_done_for: string | null;
  readiness_id: string | null;
  status_operation: string | null;
  status_text: string | null;
  notification_id: string | null;
  started_at: number;
  head_published_at: number | null;
  wait_accounted_at: number | null;
  retry_at: number;
  failure: string | null;
};
export type PrReadiness = {
  job_id: number;
  revision: number;
  monitor_id: string;
  head_sha: string;
  policy_digest: string;
  observation_digest: string;
  snapshot: PrSnapshot;
  checks: RequiredCheck[];
  reviewers: { login: string; signal: string; receipt: string }[];
  findings_digest: string;
};
