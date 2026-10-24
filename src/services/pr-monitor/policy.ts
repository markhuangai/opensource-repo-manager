import { digest } from "../../domain/agents.ts";
import type {
  FindingDisposition,
  PrMonitorPolicy,
  PrSnapshot,
  RequiredCheck,
  ReviewSurface,
} from "./contracts.ts";

export function findingIdentity(finding: FindingDisposition) {
  return digest({ ...finding, publication_id: null });
}

export function observationDigest(snapshot: PrSnapshot) {
  return digest(snapshot);
}

function login(value: string) {
  return value.toLowerCase();
}

export function reviewSurfaces(
  snapshot: PrSnapshot,
  owned: (
    kind: "issue_comment" | "review_comment" | "review",
    id: number,
  ) => boolean,
): ReviewSurface[] {
  const result: ReviewSurface[] = [];
  const add = (surface: Omit<ReviewSurface, "digest">) => {
    if (surface.body.trim())
      result.push({ ...surface, digest: digest(surface) });
  };
  const threadedReviews = new Set<number>();
  for (const thread of snapshot.threads) {
    for (const comment of thread.comments) {
      if (comment.pullRequestReview)
        threadedReviews.add(comment.pullRequestReview.databaseId);
    }
    const root = thread.comments[0];
    if (owned("review_comment", root.databaseId)) continue;
    add({
      id: `thread:${thread.id}`,
      kind: "thread",
      author: root.author?.login ?? null,
      reviewed_sha:
        root.pullRequestReview?.commit.oid ??
        root.originalCommit?.oid ??
        root.commit?.oid ??
        null,
      thread_id: thread.id,
      body: thread.comments
        .filter((item) => !owned("review_comment", item.databaseId))
        .map((item) => `${item.author?.login ?? "unknown"}: ${item.body}`)
        .join("\n\n"),
    });
  }
  for (const review of snapshot.reviews) {
    if (
      owned("review", review.id) ||
      (!review.body?.trim() && threadedReviews.has(review.id))
    )
      continue;
    add({
      id: `review:${review.id}`,
      kind: "review",
      author: review.user?.login ?? null,
      reviewed_sha: review.commit_id,
      thread_id: null,
      body: review.body ?? "",
    });
  }
  for (const comment of snapshot.comments) {
    if (owned("issue_comment", comment.id)) continue;
    add({
      id: `comment:${comment.id}`,
      kind: "comment",
      author: comment.user?.login ?? null,
      reviewed_sha: null,
      thread_id: null,
      body: comment.body ?? "",
    });
  }
  for (const check of latestChecks(snapshot)) {
    if (check.status !== "completed" || check.conclusion === "success")
      continue;
    add({
      id: `check:${check.id}`,
      kind: "check",
      author: check.app.slug ?? null,
      reviewed_sha: check.head_sha,
      thread_id: null,
      body: JSON.stringify({
        name: check.name,
        conclusion: check.conclusion,
        output: check.output,
      }),
    });
  }
  return result;
}

export function latestChecks(snapshot: PrSnapshot) {
  const latest = new Map<string, PrSnapshot["checks"][number]>();
  for (const check of snapshot.checks) {
    if (check.head_sha !== snapshot.head_sha) continue;
    const key = `${check.app.id}:${check.name}`;
    if (!latest.has(key) || latest.get(key)!.id < check.id)
      latest.set(key, check);
  }
  return [...latest.values()];
}

export function requiredChecks(snapshot: PrSnapshot, policy: PrMonitorPolicy) {
  const checks: RequiredCheck[] = [
    ...snapshot.requirements.checks,
    ...policy.required_checks.map((name) => ({
      name: name.replaceAll("{pr}", String(snapshot.number)),
      app_id: null,
    })),
  ];
  return [
    ...new Map(
      checks.map((item) => [`${item.app_id}:${item.name}`, item]),
    ).values(),
  ];
}

export type ReadinessDecision = {
  clean: boolean;
  reason: string | null;
  pending: string[];
  checks: RequiredCheck[];
  reviewers: { login: string; signal: string; receipt: string }[];
};

export function evaluateReadiness(
  snapshot: PrSnapshot,
  policy: PrMonitorPolicy,
  publishedAt: number | null,
): ReadinessDecision {
  const checks = requiredChecks(snapshot, policy),
    pending: string[] = [],
    reviewers: ReadinessDecision["reviewers"] = [];
  const result = (reason: string | null): ReadinessDecision => ({
    clean: reason === null && pending.length === 0,
    reason,
    pending,
    checks,
    reviewers,
  });
  if (!policy.enabled) return result("pr_monitor_disabled");
  if (snapshot.state !== "open" || snapshot.draft || snapshot.merged)
    return result("pr_not_open");
  if (
    snapshot.requirements.unknown.length &&
    (policy.requirements_source !== "operator" ||
      policy.required_checks.length === 0)
  )
    return result("pr_requirements_unknown");
  if (
    !checks.length &&
    !(policy.local_checks_only && snapshot.requirements.unknown.length === 0)
  )
    return result("pr_checks_unconfigured");
  const latest = latestChecks(snapshot);
  const statuses = new Map<string, PrSnapshot["statuses"][number]>();
  for (const status of snapshot.statuses)
    if (
      !statuses.has(status.context) ||
      statuses.get(status.context)!.id < status.id
    )
      statuses.set(status.context, status);
  for (const required of checks) {
    const matching = latest.filter(
      (item) =>
        item.name === required.name &&
        (required.app_id === null || item.app.id === required.app_id),
    );
    const status =
      required.app_id === null ? statuses.get(required.name) : undefined;
    if (matching.length) {
      if (matching.some((item) => item.status !== "completed"))
        pending.push(required.name);
      else if (matching.some((item) => item.conclusion !== "success"))
        return result("pr_checks_failed");
    }
    if (status) {
      if (status.state === "pending") pending.push(required.name);
      else if (status.state !== "success") return result("pr_checks_failed");
    } else if (!matching.length) pending.push(required.name);
  }
  const currentStarts = latest
    .map((item) => Date.parse(item.started_at ?? ""))
    .filter(Number.isFinite);
  const cycleStart =
    publishedAt === null
      ? null
      : Math.max(
          publishedAt,
          currentStarts.length ? Math.min(...currentStarts) : publishedAt,
        );
  const unavailableNotice =
    /review limit reached|rate limited by coderabbit\.ai|rate limit exceeded by coderabbit\.ai|review skipped|couldn.t start this review|too many files|quota exceeded|review unavailable/i;
  for (const required of policy.automated_reviewers) {
    const expectedLogin =
      required.signal === "github_review"
        ? login(required.login)
        : `${login(required.login).replace(/\[bot\]$/, "")}[bot]`;
    const authored = snapshot.reviews.filter(
      (item) => item.user && login(item.user.login) === expectedLogin,
    );
    const current = authored.filter(
      (item) =>
        item.commit_id === snapshot.head_sha &&
        item.state !== "PENDING" &&
        item.state !== "DISMISSED" &&
        Number.isFinite(Date.parse(item.submitted_at ?? "")) &&
        Date.parse(item.submitted_at ?? "") <= Date.now(),
    );
    const signals = current
      .filter((item) => !unavailableNotice.test(item.body ?? ""))
      .map((item) => ({
        time: Date.parse(item.submitted_at!),
        receipt: `review:${item.id}`,
      }));
    if (required.signal !== "github_review") {
      for (const reaction of snapshot.reactions) {
        const time = Date.parse(reaction.created_at);
        if (
          reaction.user &&
          cycleStart !== null &&
          login(reaction.user.login) === expectedLogin &&
          time >= cycleStart &&
          time <= Date.now() &&
          required.signal === "codex" &&
          reaction.content === "+1"
        )
          signals.push({ time, receipt: `reaction:${reaction.id}` });
      }
      if (required.signal === "coderabbit") {
        for (const comment of snapshot.comments) {
          const time = Date.parse(comment.updated_at);
          if (
            !comment.user ||
            cycleStart === null ||
            login(comment.user.login) !== expectedLogin ||
            time < cycleStart ||
            time > Date.now()
          )
            continue;
          if (
            (comment.body ?? "").includes(
              "No actionable comments were generated in the recent review",
            )
          )
            signals.push({ time, receipt: `comment:${comment.id}` });
        }
      }
    }
    signals.sort((a, b) => b.time - a.time);
    const unavailable =
      current.some(
        (review) =>
          Date.parse(review.submitted_at!) >= (signals[0]?.time ?? -Infinity) &&
          unavailableNotice.test(review.body ?? ""),
      ) ||
      snapshot.comments.some((comment) => {
        if (
          !comment.user ||
          login(comment.user.login) !== expectedLogin ||
          !unavailableNotice.test(comment.body ?? "")
        )
          return false;
        const time = Date.parse(comment.updated_at);
        return (
          !Number.isFinite(time) ||
          time > Date.now() ||
          time >= (signals[0]?.time ?? publishedAt ?? -Infinity)
        );
      });
    if (unavailable) return result("pr_reviewer_unavailable");
    const eyes = snapshot.reactions
      .filter(
        (item) =>
          item.user &&
          login(item.user.login) === expectedLogin &&
          item.content === "eyes",
      )
      .map((item) => Date.parse(item.created_at))
      .filter(Number.isFinite);
    if (!signals.length || Math.max(-Infinity, ...eyes) > signals[0].time)
      pending.push(`review:${required.login}`);
    else reviewers.push({ ...required, receipt: signals[0].receipt });
  }
  return result(pending.length ? "pr_waiting" : null);
}
