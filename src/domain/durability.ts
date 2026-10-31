import type { FrozenScope } from "../services/implementation/contracts.ts";
import type { ReviewRequest } from "../services/publication/contracts.ts";
import { RuntimeError } from "./agents.ts";
import type { Conversation } from "./agents.ts";
import type { IssueContext } from "./jobs.ts";
import type { Question } from "../services/clarification-contracts.ts";

export class StateError extends RuntimeError {
  constructor(code: string) {
    super(code);
  }
}

export interface TaskDurability {
  question(): Question | null;
  replies(question: string): Conversation["messages"];
  prepareIssue(context: IssueContext): void;
  checkpoint(signal: AbortSignal, artifacts?: boolean): Promise<void>;
  scopeRequest(scope: FrozenScope): ReviewRequest;
  acceptScope(
    scope: FrozenScope,
    reviewId: string,
    signal: AbortSignal,
  ): Promise<void>;
  recoveryContext():
    | {
        findings: string;
        scope: FrozenScope | null;
        legacy_questions?: string[];
      }
    | undefined;
}
