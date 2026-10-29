import type { FrozenScope } from "../services/implementation/contracts.ts";
import type { ReviewRequest } from "../services/publication/contracts.ts";
import { RuntimeError } from "./agents.ts";

export class StateError extends RuntimeError {
  constructor(code: string) {
    super(code);
  }
}

export interface TaskDurability {
  checkpoint(signal: AbortSignal, artifacts?: boolean): Promise<void>;
  scopeRequest(scope: FrozenScope): ReviewRequest;
  acceptScope(
    scope: FrozenScope,
    reviewId: string,
    signal: AbortSignal,
  ): Promise<void>;
  recoveryContext():
    { findings: string; scope: FrozenScope | null } | undefined;
}
