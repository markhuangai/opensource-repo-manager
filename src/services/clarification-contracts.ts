import { z } from "zod";
import { githubId } from "../domain/jobs.ts";
import type { AgentRunRequest, Conversation } from "../domain/agents.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const questionAudience = z.enum([
  "reporter_or_maintainer",
  "maintainer",
]);
export const clarificationRequestSchema = z.strictObject({
  outcome: z.literal("needs_information"),
  summary: z.string().trim().min(1).max(4096),
  questions: z.array(z.string().trim().min(1).max(1024)).min(1).max(8),
  audience: questionAudience,
});
export const questionSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  phase: z.enum([
    "investigation_triage",
    "investigation_plan",
    "investigation_result",
    "implementation_plan",
    "implementation_change",
    "implementation_review_feedback",
  ]),
  summary: z.string().min(1).max(4096),
  questions: z.array(z.string().min(1).max(1024)).min(1).max(8),
  audience: questionAudience,
  input_digest: hash,
  conversation_id: z.uuid(),
  publication_id: hash,
  comment_id: githubId.nullable(),
  answers: z.array(z.strictObject({ id: githubId, digest: hash })).max(128),
});
export type Question = z.infer<typeof questionSchema>;
export function renderQuestion(
  question: Pick<Question, "summary" | "audience" | "questions">,
  marker: string,
) {
  return [
    question.summary,
    question.audience === "maintainer"
      ? "A repository maintainer must clarify the intended existing behavior or scope."
      : "The issue reporter or a repository maintainer may supply these facts.",
    ...question.questions.map((item) => `- ${item}`),
    "Reply in a new issue comment. Answers cannot authorize features or expand the frozen bug objective.",
    marker,
  ].join("\n\n");
}
export type PhaseContinuation = {
  id: string;
  request: AgentRunRequest;
  messages: Conversation["messages"];
  question: Question | null;
};
export type Discussion = {
  reporter: { id: number; login: string } | null;
  comments: Array<{
    id: number;
    body: string | null;
    user: { id: number; login: string; type: string } | null;
  }>;
};
