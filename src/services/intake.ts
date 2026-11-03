import type { GitHubReader } from "../adapters/github/reader.ts";
import type { RunSnapshot } from "../config/load.ts";
import type { SecretAccessor } from "../config/secrets.ts";
import {
  githubId,
  IntakeError,
  type IssueRefresh,
  type IssueContext,
} from "../domain/jobs.ts";
import type { Store } from "../repositories/store.ts";

type IntakeHooks = {
  beforeIssue?: (context: IssueContext, signal: AbortSignal) => Promise<void>;
};

export class IntakeService {
  private readonly controller = new AbortController();
  private verified = false;

  constructor(
    private readonly store: Store,
    private readonly reader: GitHubReader,
    private readonly snapshot: RunSnapshot,
    private readonly secrets: Pick<SecretAccessor, "containsCredentials">,
    private readonly hooks: IntakeHooks = {},
  ) {
    store.saveSnapshot(snapshot);
  }

  async refresh(number: number, signal: AbortSignal) {
    if (!this.verified) throw new IntakeError("enrollment_pending");
    return this.readIssue(
      this.store.refreshIssue(number),
      AbortSignal.any([signal, this.controller.signal]),
    );
  }

  async enrollIssue(number: number, signal: AbortSignal) {
    githubId.parse(number);
    const abort = AbortSignal.any([signal, this.controller.signal]);
    const repository = await this.reader.repository(abort);
    this.store.enroll(repository);
    this.verified = true;
    const context = await this.refresh(number, abort);
    return context;
  }

  private async readIssue(target: IssueRefresh, signal: AbortSignal) {
    const context = await this.reader.issue(
      target.number,
      this.store.repository()!,
      signal,
    );
    this.store.durability?.prepareIssue(context);
    await this.hooks.beforeIssue?.(context, signal);
    context.comments = context.comments.filter(
      (comment) => !this.store.owns("issue_comment", comment.id),
    );
    if (this.secrets.containsCredentials(context))
      throw new IntakeError("secret_in_input");
    this.store.applyIssue(target, context, this.snapshot);
    return context;
  }

  enrolled() {
    return this.verified && !this.controller.signal.aborted;
  }

  async stop() {
    this.controller.abort();
  }
}
