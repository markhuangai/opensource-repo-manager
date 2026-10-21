import { z } from "zod";
import { githubId, sha, type SourceMetadata } from "../../domain/jobs.ts";
import { investigationStage } from "../investigation/contracts.ts";

export const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(65536);
const job = { job_id: githubId, revision: githubId };
export const proposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...job,
    kind: z.literal("investigation"),
    investigation_id: z.uuid(),
  }),
  z.strictObject({
    ...job,
    kind: z.literal("investigation_stage"),
    stage: z.union([investigationStage, z.literal("completed")]),
    previous_operation: hash.nullable(),
  }),
  z.strictObject({ ...job, kind: z.literal("status"), body: text.min(1) }),
  z.strictObject({
    ...job,
    kind: z.literal("notice"),
    reason: z.enum([
      "model_unavailable",
      "budget_exhausted",
      "publication_blocked",
    ]),
  }),
  z.strictObject({
    ...job,
    kind: z.literal("change"),
    artifact_digest: hash,
    expected_head: sha.nullable(),
    evidence_ids: z.array(hash).min(2).max(64),
    title: text.min(1).max(256),
    body: text.min(1),
    commit_message: text.min(1),
  }),
]);
export type PublicationProposal = z.infer<typeof proposalSchema>;
export const evidenceSchema = z.strictObject({
  ...job,
  kind: z.enum(["audit", "test"]),
  source_sha: sha,
  artifact_digest: hash,
  outcome: z.literal("passed"),
  details: z.json(),
});
export type PublicationEvidence = z.infer<typeof evidenceSchema>;
export type ReviewRequest = {
  job_id: number;
  revision: number;
  destination: Readonly<Record<string, unknown>>;
  payload: unknown;
  evidence: unknown;
  artifact_digest?: string;
  parent_run_id?: string;
};
export type ReviewReceipt = {
  id: string;
  job_id: number;
  revision: number;
  binding: string;
  policy_identity: string;
  approved: boolean;
  run_id: string | null;
  created_at: number;
};
export const reviewResultSchema = z.strictObject({
  approved: z.boolean(),
  binding: hash,
  findings: z.array(z.string().max(4096)).max(64),
});
export type OwnedComment = {
  id: number;
  body: string;
  author_id: number | null;
};
export type OwnedPull = {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  author_id: number | null;
};
export type PublicationTarget = {
  job_id: number;
  branch: string;
  head: string | null;
  comment: OwnedComment | null;
  pull: OwnedPull | null;
};
export type MutationStep = {
  kind: "comment" | "branch" | "pull";
  before: unknown;
  after: unknown;
  state: "prepared" | "dispatching" | "confirmed" | "uncertain";
};
export type PublicationReceipt = {
  id: string;
  job_id: number;
  revision: number;
  status:
    | "prepared"
    | "reviewed"
    | "dispatching"
    | "uncertain"
    | "confirmed"
    | "blocked";
  failure: string | null;
  retry_at: number;
  retry_pending: boolean;
  proposal: PublicationProposal;
  source: SourceMetadata;
  target: PublicationTarget;
  actor: { id: number; login: string } | null;
  timestamp: string;
  review_id: string | null;
  payload: unknown;
  commit: string | null;
  steps: MutationStep[];
};
