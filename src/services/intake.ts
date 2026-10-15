import { createHash } from "node:crypto";
import { z } from "zod";
import type { GitHubReader } from "../adapters/github/reader.ts";
import type { RunSnapshot } from "../config/load.ts";
import { githubId, IntakeError, type Target } from "../domain/jobs.ts";
import type { KnownSecretChecker, SafeLogger } from "../logging/redact.ts";
import type { Store } from "../repositories/store.ts";

const envelope = z.object({
  repository: z.object({ id: githubId }),
  issue: z
    .object({
      id: githubId,
      number: githubId,
      pull_request: z.unknown().optional(),
    })
    .optional(),
  comment: z.object({ id: githubId }).optional(),
  review: z.object({ id: githubId }).optional(),
  pull_request: z.object({ id: githubId, number: githubId }).optional(),
  check_run: z
    .object({
      head_sha: z.string(),
      pull_requests: z
        .array(z.object({ id: githubId, number: githubId }))
        .default([]),
    })
    .optional(),
  check_suite: z
    .object({
      head_sha: z.string(),
      pull_requests: z
        .array(z.object({ id: githubId, number: githubId }))
        .default([]),
    })
    .optional(),
  sha: z.string().optional(),
});

export class IntakeService {
  private readonly store: Store;
  private readonly reader: GitHubReader;
  private readonly snapshot: RunSnapshot;
  private readonly secrets: KnownSecretChecker;
  private readonly logger: SafeLogger;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private started = false;
  private verified = false;
  private nextScan = 0;
  private retryAt = 0;
  private state: "starting" | "ready" | "degraded" = "starting";
  private failure: string | null = null;

  constructor(
    store: Store,
    reader: GitHubReader,
    snapshot: RunSnapshot,
    secrets: KnownSecretChecker,
    logger: SafeLogger,
  ) {
    this.store = store;
    this.reader = reader;
    this.snapshot = snapshot;
    this.secrets = secrets;
    this.logger = logger;
    store.saveSnapshot(snapshot);
  }

  status() {
    return { state: this.state, reason: this.failure, ...this.store.counts() };
  }

  accept(delivery: string, event: string, payload: unknown, bytes: Buffer) {
    if (!this.verified || this.controller.signal.aborted)
      throw new IntakeError("enrollment_pending");
    const parsed = envelope.safeParse(payload);
    if (!parsed.success) throw new IntakeError("event_invalid");
    const data = parsed.data;
    if (data.repository.id !== this.store.repository()?.id)
      throw new IntakeError("repository_mismatch");
    if (
      (event === "issues" && !data.issue) ||
      (event === "issue_comment" && (!data.issue || !data.comment)) ||
      ([
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
      ].includes(event) &&
        !data.pull_request) ||
      (event === "pull_request_review" && !data.review) ||
      (event === "pull_request_review_comment" && !data.comment) ||
      (event === "check_run" && !data.check_run) ||
      (event === "check_suite" && !data.check_suite) ||
      (event === "status" && !data.sha)
    )
      throw new IntakeError("event_invalid");
    const targets: Target[] = [];
    const ownPull = (number: number, id?: number) => {
      const owned = this.store.ownedPull(number);
      if (owned && (id === undefined || owned.object_id === String(id)))
        targets.push({ kind: "pull", number });
    };
    if (event === "issues" && data.issue && !data.issue.pull_request)
      targets.push({ kind: "issue", number: data.issue.number });
    else if (
      event === "issue_comment" &&
      data.issue &&
      data.comment &&
      !this.store.owns("issue_comment", data.comment.id)
    ) {
      if (data.issue.pull_request) ownPull(data.issue.number);
      else targets.push({ kind: "issue", number: data.issue.number });
    } else if (
      [
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
      ].includes(event) &&
      data.pull_request
    ) {
      const own =
        (event === "pull_request_review_comment" &&
          data.comment &&
          this.store.owns("review_comment", data.comment.id)) ||
        (event === "pull_request_review" &&
          data.review &&
          this.store.owns("review", data.review.id));
      if (!own) ownPull(data.pull_request.number, data.pull_request.id);
    } else if (["check_run", "check_suite", "status"].includes(event)) {
      const check = data.check_run ?? data.check_suite;
      for (const pull of check?.pull_requests ?? [])
        ownPull(pull.number, pull.id);
      for (const pull of this.store.ownedPulls())
        if (pull.head_sha === (check?.head_sha ?? data.sha))
          ownPull(pull.number!);
    }
    const unique = [
      ...new Map(
        targets.map((target) => [`${target.kind}:${target.number}`, target]),
      ).values(),
    ];
    const accepted = this.store.accept(
      delivery,
      createHash("sha256").update(bytes).digest("hex"),
      event,
      unique,
    );
    if (this.started) this.wake();
    return accepted;
  }

  start() {
    this.started = true;
    this.wake();
  }

  private wake() {
    if (this.controller.signal.aborted || this.running) return;
    clearTimeout(this.timer);
    this.running = this.cycle().finally(() => {
      this.running = undefined;
      if (!this.controller.signal.aborted && this.started) {
        const due = Math.max(
          this.retryAt,
          Math.min(
            this.nextScan || Date.now(),
            this.store.nextRetry() ?? Infinity,
          ),
        );
        this.timer = setTimeout(
          () => this.wake(),
          Math.min(2_147_483_647, Math.max(1, due - Date.now())),
        );
      }
    });
  }

  async reconcile() {
    if (this.running) return this.running;
    this.nextScan = 0;
    this.running = this.cycle();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async cycle() {
    if (this.controller.signal.aborted || Date.now() < this.retryAt) return;
    const interval =
      this.snapshot.settings.limits.reconciliation_minutes * 60_000;
    try {
      const repository = await this.reader.repository(this.controller.signal);
      this.store.enroll(repository);
      this.verified = true;
      if (Date.now() >= this.nextScan || this.store.cursor().page > 1) {
        this.store.reconcileKnown();
        while (!this.controller.signal.aborted) {
          const { page } = this.store.cursor();
          const batch = await this.reader.issuePage(
            page,
            this.controller.signal,
          );
          this.store.discover(batch.numbers, page, batch.finished);
          await this.drain();
          if (batch.finished) {
            this.nextScan = Date.now() + interval;
            break;
          }
        }
      }
      await this.drain();
      this.retryAt = 0;
      this.state = this.store.counts().failed ? "degraded" : "ready";
      if (this.state === "ready") this.failure = null;
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.failure =
        error instanceof IntakeError ? error.code : "intake_failed";
      this.state = "degraded";
      this.retryAt = Math.max(
        Date.now() + interval,
        error instanceof IntakeError ? error.retryAt : 0,
      );
      this.logger.error(`Intake unavailable (${this.failure}).`);
    }
  }

  private async drain() {
    let target;
    while (
      !this.controller.signal.aborted &&
      (target = this.store.nextDirty())
    ) {
      try {
        if (target.kind === "issue") {
          const context = await this.reader.issue(
            target.number,
            this.store.repository()!,
            this.controller.signal,
          );
          context.comments = context.comments.filter(
            (comment) => !this.store.owns("issue_comment", comment.id),
          );
          if (this.secrets.contains(context))
            throw new IntakeError("secret_in_input");
          this.store.applyIssue(target, context, this.snapshot);
        } else {
          const context = await this.reader.pull(
            target.number,
            this.controller.signal,
          );
          context.comments = context.comments.filter(
            (comment) => !this.store.owns("issue_comment", comment.id),
          );
          context.review_comments = context.review_comments.filter(
            (comment) =>
              !this.store.owns(
                "review_comment",
                (comment as { id: number }).id,
              ),
          );
          context.reviews = context.reviews.filter(
            (review) =>
              !this.store.owns("review", (review as { id: number }).id),
          );
          if (this.secrets.contains(context))
            throw new IntakeError("secret_in_input");
          this.store.applyPull(target, context);
        }
      } catch (error) {
        if (this.controller.signal.aborted) return;
        if (
          !(error instanceof IntakeError) ||
          ![
            "github_not_found",
            "issue_is_pull_request",
            "secret_in_input",
          ].includes(error.code)
        )
          throw error;
        this.failure = error.code;
        this.logger.error(`Pending input unavailable (${error.code}).`);
        this.store.defer(
          target,
          error.code,
          Date.now() +
            this.snapshot.settings.limits.reconciliation_minutes * 60_000,
        );
      }
    }
  }

  async stop() {
    this.started = false;
    this.controller.abort();
    clearTimeout(this.timer);
    await this.running;
  }
}
