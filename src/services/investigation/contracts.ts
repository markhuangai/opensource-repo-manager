import { z } from "zod";
import { isContainedReference } from "../../config/files.ts";
import { commandSchema } from "../bootstrap/contracts.ts";
import type { SourceMetadata } from "../../domain/jobs.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceReference = z.strictObject({
  kind: z.literal("source"),
  path: z.string().min(1).max(4096).refine(isContainedReference),
  start_line: z.number().int().positive().safe(),
  end_line: z.number().int().positive().safe(),
});
export const investigationPlanSchema = z.strictObject({
  hypothesis: z.string().min(1).max(8192),
  citations: z.array(sourceReference).max(32),
  commands: z.array(commandSchema).max(8),
});
export const investigationResultSchema = z.strictObject({
  outcome: z.enum([
    "maintenance_candidate",
    "needs_information",
    "no_fix",
    "manual_feature",
    "blocked",
  ]),
  summary: z.string().min(1).max(12000),
  objective: z.string().max(4096),
  proof: z.enum(["reproduced", "source", "none"]),
  evidence_ids: z.array(hash).max(64),
  questions: z.array(z.string().min(1).max(1024)).max(8),
});
export const investigationStage = z.enum([
  "queued",
  "inspecting",
  "bootstrap",
  "reproducing",
  "summarizing",
  "publishing",
  "blocked",
]);
export type InvestigationStage = z.infer<typeof investigationStage>;
export type InvestigationPlan = z.infer<typeof investigationPlanSchema>;
export type InvestigationResult = z.infer<typeof investigationResultSchema>;
export type InvestigationEvidence = {
  job_id: number;
  revision: number;
  source: SourceMetadata;
  kind: "context" | "source" | "command" | "mcp";
  details: unknown;
};
export type Investigation = {
  id: string;
  job_id: number;
  revision: number;
  source: SourceMetadata;
  snapshot_digest: string;
  stage: InvestigationStage | "completed" | "cancelled";
  plan: InvestigationPlan | null;
  agent_pending: boolean;
  recovery_attempts: string[];
  result: InvestigationResult | null;
  evidence_ids: string[];
  bootstrap_receipt: string | null;
  publication_id: string | null;
  status_operation: string | null;
  previous_operation: string | null;
  failure: string | null;
  retry_at: number;
  retry_stage: InvestigationStage | null;
  started_at: number;
};

export const stageText: Record<InvestigationStage, string> = {
  queued: "This issue is queued for investigation.",
  inspecting: "Investigation is in progress. No diagnosis is confirmed yet.",
  bootstrap: "Preparing the source environment for reproduction.",
  reproducing: "Running reproduction commands. Findings are not yet confirmed.",
  summarizing: "Checking the investigation evidence.",
  publishing: "Reviewing the investigation findings before publication.",
  blocked:
    "Investigation is blocked. No completion is claimed; operator attention is required.",
};

export function renderFindings(
  record: Investigation,
  evidence: InvestigationEvidence[] = [],
  repository?: string,
) {
  const result = record.result!;
  const labels: Record<InvestigationResult["outcome"], string> = {
    maintenance_candidate:
      "Confirmed maintenance candidate; queued for audited implementation and real verification.",
    needs_information:
      "More information is needed before investigation can continue.",
    no_fix: "Investigation completed; no maintenance fix is proposed.",
    manual_feature:
      "Feature request investigated; implementation requires a manual maintainer handoff.",
    blocked: "Investigation is blocked; no completion is claimed.",
  };
  const references = evidence.flatMap((item) => {
    if (item.kind === "source" && repository) {
      const source = item.details as {
        path: string;
        start_line: number;
        end_line: number;
      };
      return [
        `[Source lines ${source.start_line}–${source.end_line}](https://github.com/${repository}/blob/${record.source.sha}/${source.path.split("/").map(encodeURIComponent).join("/")}#L${source.start_line}-L${source.end_line})`,
      ];
    }
    if (item.kind === "command") {
      const value = item.details as {
        command: { argv: string[]; cwd: string; exit_code: number };
      };
      return [
        `Reproduction argv: ${JSON.stringify(value.command.argv)}; cwd: ${JSON.stringify(value.command.cwd)}; exit: ${value.command.exit_code}.`,
      ];
    }
    return [];
  });
  return [
    labels[result.outcome],
    `Inspected source: ${record.source.sha}`,
    result.proof === "source"
      ? "Evidence: verified source analysis; not reproduced."
      : result.proof === "reproduced"
        ? "Evidence: supervisor-recorded reproduction."
        : "No reproduction is claimed.",
    result.summary,
    ...references,
    ...(result.objective ? [`Maintenance objective: ${result.objective}`] : []),
    ...result.questions.map((question) => `- ${question}`),
  ].join("\n\n");
}
