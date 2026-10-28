import type { FrozenScope } from "../services/implementation/contracts.ts";
import type { ReviewRequest } from "../services/publication/contracts.ts";

export interface TaskDurability {
  checkpoint(signal: AbortSignal): Promise<void>;
  scopeRequest(scope: FrozenScope): ReviewRequest;
  acceptScope(
    scope: FrozenScope,
    reviewId: string,
    signal: AbortSignal,
  ): Promise<void>;
  recoveryContext():
    { findings: string; scope: FrozenScope | null } | undefined;
}
