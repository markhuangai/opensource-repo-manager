import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import Database from "better-sqlite3";
import { OctokitReader } from "../src/adapters/github/reader.ts";
import { OctokitWriter } from "../src/adapters/github/writer.ts";
import { prMonitorPolicy, parseConfiguration } from "../src/config/schema.ts";
import { digest } from "../src/domain/agents.ts";
import { Store } from "../src/repositories/store.ts";
import { PrMonitorRepository } from "../src/repositories/pr-monitor.ts";
import type {
  PrMonitor,
  PrSnapshot,
} from "../src/services/pr-monitor/contracts.ts";
import {
  evaluateReadiness,
  reviewSurfaces,
} from "../src/services/pr-monitor/policy.ts";
import {
  createPublicationFixture,
  makeCheck,
  makeThread,
} from "./fixtures/publication.ts";
import { fixtureConfiguration, fixtureSnapshot } from "./fixtures.ts";
import { stringify } from "yaml";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;
const publishedAt = Date.now() - 10_000;
const head = "a".repeat(40);
const policy = (extra = {}) =>
  prMonitorPolicy.parse({ required_checks: ["Fixture CI"], ...extra });
function snapshot(): PrSnapshot {
  return {
    id: 77,
    node_id: "PR_77",
    number: 77,
    state: "open",
    draft: false,
    merged: false,
    author_id: 7,
    repository_id: 42,
    base_repository_id: 42,
    branch: "orm/test/issue-1",
    base: "main",
    base_sha: "b".repeat(40),
    head_sha: head,
    updated_at: new Date().toISOString(),
    comments: [],
    reviews: [],
    threads: [],
    reactions: [],
    checks: [makeCheck(head)],
    statuses: [],
    requirements: { checks: [], unknown: [], human_approvals: 1 },
  };
}

async function transport() {
  const root = await mkdtemp(join(tmpdir(), "orm-pr-monitor-"));
  cleanups.push(() => rm(root, { recursive: true }));
  const remote = await createPublicationFixture(root);
  cleanups.push(() => remote.close());
  remote.git(["update-ref", "refs/heads/orm/test/issue-1", remote.source.sha]);
  remote.state.pulls.push({
    id: 77,
    number: 77,
    title: "Fix the defect",
    body: "Reviewed fix",
    branch: "orm/test/issue-1",
    base: "main",
    state: "open",
    author: 7,
    draft: false,
  });
  const client = new Octokit({
    auth: remote.state.token,
    baseUrl: remote.url,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  return {
    remote,
    reader: new OctokitReader("owner/repo", client),
    writer: new OctokitWriter("owner/repo", client),
  };
}

describe("current-head PR readiness policy", () => {
  it("permits successful automation with human approval still outstanding", () => {
    const result = evaluateReadiness(snapshot(), policy(), publishedAt);
    expect(result.clean).toBe(true);
    expect(snapshot().requirements.human_approvals).toBe(1);
  });

  it.each([
    "failure",
    "cancelled",
    "skipped",
    "neutral",
    "timed_out",
    "action_required",
    null,
  ])("rejects required check conclusion %s", (conclusion) => {
    const input = snapshot();
    input.checks[0].conclusion = conclusion;
    expect(evaluateReadiness(input, policy(), publishedAt)).toMatchObject({
      clean: false,
      reason: "pr_checks_failed",
    });
  });

  it("rejects old-head success and the older successful attempt of a pending rerun", () => {
    const input = snapshot();
    input.checks[0].head_sha = "c".repeat(40);
    expect(evaluateReadiness(input, policy(), publishedAt).clean).toBe(false);
    input.checks = [
      makeCheck(head),
      makeCheck(head, { id: 502, status: "queued", conclusion: null }),
    ];
    expect(evaluateReadiness(input, policy(), publishedAt)).toMatchObject({
      clean: false,
      pending: ["Fixture CI"],
    });
  });

  it("keeps required integration identity and independently evaluates same-name statuses", () => {
    const input = snapshot();
    input.requirements.checks = [{ name: "Fixture CI", app_id: 999 }];
    expect(evaluateReadiness(input, policy(), publishedAt).clean).toBe(false);
    input.requirements.checks = [];
    input.statuses = [
      {
        id: 1,
        context: "Fixture CI",
        state: "failure",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        creator: { id: 8, login: "ci" },
        description: null,
        target_url: null,
      },
    ];
    expect(evaluateReadiness(input, policy(), publishedAt).reason).toBe(
      "pr_checks_failed",
    );
    input.statuses.push({ ...input.statuses[0], id: 2, state: "success" });
    expect(evaluateReadiness(input, policy(), publishedAt).clean).toBe(true);
  });

  it("never treats an empty check set or inaccessible requirements as success", () => {
    const input = snapshot();
    input.checks = [];
    expect(
      evaluateReadiness(input, policy({ required_checks: [] }), publishedAt)
        .reason,
    ).toBe("pr_checks_unconfigured");
    expect(
      evaluateReadiness(
        input,
        policy({
          required_checks: [],
          requirements_source: "operator",
          local_checks_only: true,
        }),
        publishedAt,
      ).clean,
    ).toBe(true);
    input.requirements.unknown = ["branch_protection"];
    expect(
      evaluateReadiness(
        input,
        policy({
          required_checks: [],
          requirements_source: "operator",
          local_checks_only: true,
        }),
        publishedAt,
      ).clean,
    ).toBe(false);
    input.checks = [makeCheck(head)];
    expect(evaluateReadiness(input, policy(), publishedAt).reason).toBe(
      "pr_requirements_unknown",
    );
    expect(
      evaluateReadiness(
        input,
        policy({ requirements_source: "operator" }),
        publishedAt,
      ).clean,
    ).toBe(true);
  });

  it("combines discovered requirements and operator additions including PR-specific statuses", () => {
    const input = snapshot();
    input.requirements.checks = [{ name: "Security", app_id: null }];
    const settings = policy({
      requirements_source: "operator",
      required_checks: ["Fixture CI", "AI PR review / PR #{pr}"],
    });
    expect(evaluateReadiness(input, settings, publishedAt).pending).toEqual([
      "Security",
      "AI PR review / PR #77",
    ]);
  });

  it.each(["review-bot", "review-bot[bot]"])(
    "requires a current-SHA submitted review from exact identity %s",
    (login) => {
      const input = snapshot(),
        settings = policy({
          automated_reviewers: [{ login, signal: "github_review" }],
        });
      const review = {
        id: 1,
        node_id: "R1",
        user: {
          id: 8,
          login: login.endsWith("[bot]") ? "review-bot" : "review-bot[bot]",
        },
        commit_id: "c".repeat(40),
        state: "APPROVED",
        body: null,
        submitted_at: new Date().toISOString(),
      };
      input.reviews = [review];
      expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(false);
      review.commit_id = head;
      expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(false);
      review.user.login = login.toUpperCase();
      expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(true);
      review.state = "PENDING";
      expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(false);
    },
  );

  it.each([
    { signal: "codex", login: "chatgpt-codex-connector" },
    { signal: "coderabbit", login: "coderabbitai" },
  ] as const)(
    "keeps $signal REST identities exact with configured aliases",
    ({ signal, login }) => {
      for (const configured of [login, `${login}[bot]`]) {
        const input = snapshot(),
          settings = policy({
            automated_reviewers: [{ login: configured, signal }],
          }),
          user = { id: 8, login: login.toLowerCase() },
          time = new Date(Date.now() - 100).toISOString();
        input.reviews = [
          {
            id: 1,
            node_id: "R1",
            user,
            commit_id: head,
            state: "COMMENTED",
            body: "Completed review",
            submitted_at: time,
          },
        ];
        expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(
          false,
        );
        user.login = `${login}[bot]`.toUpperCase();
        expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(
          true,
        );
        input.reviews = [];
        user.login = login;
        if (signal === "codex") {
          input.reactions = [{ id: 1, content: "+1", user, created_at: time }];
        } else {
          input.comments = [
            {
              id: 1,
              node_id: "IC1",
              user,
              body: "No actionable comments were generated in the recent review",
              created_at: time,
              updated_at: time,
            },
          ];
        }
        expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(
          false,
        );
        user.login = `${login}[bot]`;
        expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(
          true,
        );
        input.reactions.push({
          id: 2,
          content: "eyes",
          user: { id: 9, login },
          created_at: new Date().toISOString(),
        });
        expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(
          true,
        );
        input.comments.push({
          id: 2,
          node_id: "IC2",
          user: { id: 9, login },
          body: "Review unavailable",
          created_at: time,
          updated_at: new Date().toISOString(),
        });
        expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(
          true,
        );
      }
    },
  );

  it("binds Codex signals to the current cycle and waits for newer eyes", () => {
    const input = snapshot(),
      settings = policy({
        automated_reviewers: [
          { login: "chatgpt-codex-connector[bot]", signal: "codex" },
        ],
      });
    input.reactions = [
      {
        id: 1,
        content: "+1",
        user: { id: 8, login: "chatgpt-codex-connector[bot]" },
        created_at: new Date(publishedAt - 1000).toISOString(),
      },
    ];
    expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(false);
    input.reactions[0].created_at = new Date().toISOString();
    expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(true);
    input.reactions[0].created_at = new Date(Date.now() - 100).toISOString();
    input.reactions.push({
      ...input.reactions[0],
      id: 2,
      content: "eyes",
      created_at: new Date().toISOString(),
    });
    expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(false);
  });

  it("requires a publication boundary for unbound markers while accepting exact-SHA reviews", () => {
    const input = snapshot(),
      settings = policy({
        automated_reviewers: [
          { login: "chatgpt-codex-connector[bot]", signal: "codex" },
        ],
      });
    input.reactions = [
      {
        id: 1,
        content: "+1",
        user: { id: 8, login: "chatgpt-codex-connector[bot]" },
        created_at: new Date().toISOString(),
      },
    ];
    expect(evaluateReadiness(input, settings, null).clean).toBe(false);
    input.reviews = [
      {
        id: 1,
        node_id: "R1",
        user: input.reactions[0].user,
        commit_id: head,
        state: "COMMENTED",
        body: "Completed",
        submitted_at: new Date().toISOString(),
      },
    ];
    expect(evaluateReadiness(input, settings, null).clean).toBe(true);
  });

  it.each([
    "Review skipped",
    "Review unavailable",
    "Quota exceeded",
    "Review limit reached",
    "rate limited by coderabbit.ai",
  ])(
    "blocks current-SHA submitted notice %s until a later completed review",
    (body) => {
      const input = snapshot(),
        settings = policy({
          automated_reviewers: [
            { login: "coderabbitai[bot]", signal: "coderabbit" },
          ],
        });
      input.reviews = [
        {
          id: 1,
          node_id: "R1",
          user: { id: 8, login: "coderabbitai[bot]" },
          commit_id: head,
          state: "COMMENTED",
          body,
          submitted_at: new Date(Date.now() - 1000).toISOString(),
        },
      ];
      expect(evaluateReadiness(input, settings, publishedAt)).toMatchObject({
        clean: false,
        reason: "pr_reviewer_unavailable",
      });
      input.reviews.push({
        ...input.reviews[0],
        id: 2,
        node_id: "R2",
        body: "Completed review",
        submitted_at: new Date().toISOString(),
      });
      expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(true);
    },
  );

  it("accepts CodeRabbit's current-cycle summary but blocks quota deferral and spoofed authors", () => {
    const input = snapshot(),
      settings = policy({
        automated_reviewers: [
          { login: "coderabbitai[bot]", signal: "coderabbit" },
        ],
      });
    input.comments = [
      {
        id: 1,
        node_id: "IC1",
        body: "No actionable comments were generated in the recent review",
        user: { id: 8, login: "human" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(false);
    input.comments[0].user!.login = "coderabbitai[bot]";
    expect(evaluateReadiness(input, settings, publishedAt).clean).toBe(true);
    input.comments[0].body =
      "Review limit reached: rate limited by coderabbit.ai";
    expect(evaluateReadiness(input, settings, publishedAt).reason).toBe(
      "pr_reviewer_unavailable",
    );
  });

  it.each(["Review limit reached", "Review unavailable"])(
    "retains legacy review chronology for a newer %s comment",
    (body) => {
      const input = snapshot(),
        settings = policy({
          automated_reviewers: [
            { login: "coderabbitai[bot]", signal: "coderabbit" },
          ],
        });
      const started = Date.now() - 3000;
      input.reviews = [
        {
          id: 1,
          node_id: "R1",
          user: { id: 8, login: "coderabbitai[bot]" },
          commit_id: head,
          state: "COMMENTED",
          body: "Review completed",
          submitted_at: new Date(started).toISOString(),
        },
      ];
      expect(evaluateReadiness(input, settings, null).clean).toBe(true);
      input.comments = [
        {
          id: 2,
          node_id: "IC2",
          user: input.reviews[0].user,
          body,
          created_at: new Date(started + 1000).toISOString(),
          updated_at: new Date(started + 1000).toISOString(),
        },
      ];
      expect(evaluateReadiness(input, settings, null).reason).toBe(
        "pr_reviewer_unavailable",
      );
      input.reviews.push({
        ...input.reviews[0],
        id: 3,
        node_id: "R3",
        submitted_at: new Date(started + 2000).toISOString(),
      });
      expect(evaluateReadiness(input, settings, null).clean).toBe(true);
      input.comments[0].updated_at = "unknown";
      expect(evaluateReadiness(input, settings, null).clean).toBe(false);
    },
  );

  it("retains resolved/outdated feedback and every reply while excluding recorded output", () => {
    const input = snapshot(),
      thread = makeThread(1000, head);
    thread.isResolved = true;
    thread.isOutdated = true;
    thread.comments.push({
      ...thread.comments[0],
      id: "RC1001",
      databaseId: 1001,
      body: "This is still reachable",
    });
    thread.comments.push({
      ...thread.comments[0],
      id: "RC1002",
      databaseId: 1002,
      body: "Owned reply",
    });
    input.threads = [thread];
    const surfaces = reviewSurfaces(
      input,
      (kind, id) => kind === "review_comment" && id === 1002,
    );
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].body).toContain("This is still reachable");
    expect(surfaces[0].body).not.toContain("Owned reply");
  });

  it("validates explicit policies without granting vendor markers to arbitrary logins", () => {
    const config = fixtureConfiguration();
    config.pr_monitor.automated_reviewers = [
      { login: "human", signal: "codex" },
    ];
    expect(() => parseConfiguration(stringify(config))).toThrow(
      "schema_invalid",
    );
    config.pr_monitor.automated_reviewers = [];
    config.pr_monitor.local_checks_only = true;
    expect(() => parseConfiguration(stringify(config))).toThrow(
      "schema_invalid",
    );
  });
});

describe("complete GitHub monitor reads and scoped thread mutations", () => {
  it("checks frozen issue scope through the real writer transport", async () => {
    const f = await transport();
    const issue = {
      id: 1001,
      number: 1,
      title: "Bug",
      body: "Fix add-one",
      updated_at: new Date().toISOString(),
    };
    f.remote.state.issues.set(1, issue);
    const expected = { ...issue };
    expect(await f.writer.issueOpen(1, signal(), expected)).toBe(true);
    issue.body = "Add a different feature";
    expect(await f.writer.issueOpen(1, signal(), expected)).toBe(false);
    expect(await f.writer.issueOpen(1, signal())).toBe(true);
  });

  it("paginates threads, nested replies, reviews, checks and branch rules through actual HTTP/GraphQL", async () => {
    const f = await transport(),
      head = f.remote.source.sha;
    const threads = Array.from({ length: 101 }, (_, i) =>
      makeThread(i + 1000, head),
    );
    threads[0].comments = Array.from({ length: 102 }, (_, i) => ({
      ...threads[0].comments[0],
      id: `RC_${i}`,
      databaseId: i + 100000,
    }));
    f.remote.state.threads.set(77, threads);
    f.remote.state.reviews.set(
      77,
      Array.from({ length: 101 }, (_, i) => ({
        id: i + 1,
        node_id: `R_${i}`,
        user: { id: 8, login: "reviewer" },
        commit_id: head,
        state: "COMMENTED",
        body: "Review",
        submitted_at: new Date().toISOString(),
      })),
    );
    f.remote.state.checks.set(
      head,
      Array.from({ length: 101 }, (_, i) =>
        makeCheck(head, { id: i + 1, name: `Check ${i}` }),
      ),
    );
    f.remote.state.rules = [
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "Check 0" }] },
      },
      ...Array.from({ length: 99 }, () => ({ type: "deletion" })),
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "Late CI", integration_id: 15368 },
          ],
        },
      },
      {
        type: "pull_request",
        parameters: { required_approving_review_count: 2 },
      },
    ];
    const result = await f.reader.monitor(77, signal());
    expect(
      evaluateReadiness(result, policy({ required_checks: [] }), publishedAt),
    ).toMatchObject({
      clean: false,
      reason: "pr_waiting",
      pending: ["Late CI"],
    });
    expect(result.threads).toHaveLength(101);
    expect(result.threads[0].comments).toHaveLength(102);
    expect(result.reviews).toHaveLength(101);
    expect(result.checks).toHaveLength(101);
    expect(result.requirements.unknown).toEqual([]);
    expect(result.requirements.checks).toEqual([
      { name: "Check 0", app_id: null },
      { name: "Late CI", app_id: 15368 },
    ]);
    expect(result.requirements.human_approvals).toBe(2);
    f.remote.state.rules.push({ type: "code_quality" });
    const unsupported = await f.reader.monitor(77, signal());
    expect(unsupported.requirements.unknown).toEqual(["code_quality"]);
    expect(
      evaluateReadiness(
        unsupported,
        policy({ required_checks: [] }),
        publishedAt,
      ).reason,
    ).toBe("pr_requirements_unknown");
    expect(
      (await f.writer.thread(threads[0].id, signal())).comments,
    ).toHaveLength(102);
  });

  it("distinguishes unavailable legacy protection and unsupported automation rules", async () => {
    const f = await transport();
    f.remote.state.protectionUnavailable = true;
    f.remote.state.rules = [
      { type: "code_quality", parameters: { severity: "errors" } },
      {
        type: "pull_request",
        parameters: { required_approving_review_count: 1 },
      },
    ];
    expect((await f.reader.monitor(77, signal())).requirements).toEqual({
      checks: [],
      unknown: ["branch_protection", "code_quality"],
      human_approvals: 1,
    });
    f.remote.state.protection = {
      required_status_checks: { checks: [{ context: "CI", app_id: 15368 }] },
    };
    expect((await f.reader.monitor(77, signal())).requirements.checks).toEqual([
      { name: "CI", app_id: 15368 },
    ]);
  });

  it("records a reply effect even when its HTTP response is lost, then reads exact thread membership", async () => {
    const f = await transport(),
      thread = makeThread(1000, f.remote.source.sha);
    f.remote.state.threads.set(77, [thread]);
    f.remote.state.dropAfter = "thread_reply";
    await expect(
      f.writer.replyThread(thread.id, "Evidence-backed disposition", signal()),
    ).rejects.toThrow("github_publication_failed");
    const observed = await f.writer.thread(thread.id, signal());
    expect(observed).toMatchObject({
      pull_id: 77,
      pull_number: 77,
      repository_id: 42,
      resolved: false,
    });
    expect(
      observed.comments.filter(
        (item) => item.body === "Evidence-backed disposition",
      ),
    ).toHaveLength(1);
    await f.writer.resolveThread(thread.id, signal());
    expect((await f.writer.thread(thread.id, signal())).resolved).toBe(true);
  });
});

describe("monitor persistence and published-job revision boundaries", () => {
  async function database() {
    const root = await mkdtemp(join(tmpdir(), "orm-monitor-db-"));
    cleanups.push(() => rm(root, { recursive: true }));
    const path = join(root, "state", "manager.sqlite"),
      store = new Store(path);
    cleanups.push(() => {
      if (store.db.open) store.close();
    });
    const { snapshot } = await fixtureSnapshot();
    store.saveSnapshot(snapshot);
    store.enroll({
      id: 42,
      full_name: "owner/repo",
      default_branch: "main",
      private: false,
    });
    const input = {
      id: 1001,
      number: 1,
      title: "Bug",
      body: "Fix add-one",
      state: "open" as const,
      updated_at: new Date().toISOString(),
      comments: [],
      source: { default_branch: "main", sha: head, tree_sha: "b".repeat(40) },
    };
    store.applyIssue(store.refreshIssue(1), input, snapshot);
    store.recordPublication({
      operation_key: "pull",
      job_id: 1,
      revision: 1,
      kind: "pull_request",
      object_id: "77",
      number: 77,
      head_sha: head,
      receipt_json: "{}",
    });
    return { path, store, snapshot, input };
  }

  it("keeps coding scope/revision while recording new issue/PR observation generations", async () => {
    const f = await database(),
      before = f.store.job(1)!;
    f.input.source.sha = "c".repeat(40);
    f.store.applyIssue(f.store.refreshIssue(1), f.input, f.snapshot);
    f.store.accept("pull-update", "digest", "pull_request", [
      { kind: "pull", number: 77 },
    ]);
    f.store.applyPull(f.store.nextDirty()!, {
      id: 77,
      number: 77,
      state: "open",
      head_sha: "d".repeat(40),
      updated_at: new Date().toISOString(),
      comments: [],
      reviews: [],
      review_comments: [],
      checks: [],
      statuses: [],
    });
    expect(f.store.job(1)!.revision).toBe(before.revision);
    expect(f.store.job(1)!.input_json).toBe(before.input_json);
    expect(f.store.ownedPull(77)!.head_sha).toBe("d".repeat(40));
    expect(
      f.store.db
        .prepare("SELECT kind,generation FROM pr_observations ORDER BY kind")
        .all(),
    ).toEqual([
      { kind: "issue", generation: 1 },
      { kind: "pull", generation: 1 },
    ]);
  });

  it("persists wait accounting across restart without taking a coding slot", async () => {
    const f = await database();
    const record: PrMonitor = {
      id: "monitor",
      job_id: 1,
      implementation_id: "implementation",
      revision: 1,
      pull_number: 77,
      expected_head: head,
      observed_head: head,
      publication_id: "publication",
      stage: "waiting",
      policy_digest: digest(policy()),
      policy_generation: 1,
      generation: 0,
      snapshot_digest: null,
      assessment_digest: null,
      findings: [],
      pending_agent: null,
      recovery_attempts: [],
      mcp_done_for: null,
      readiness_id: null,
      status_operation: null,
      status_text: null,
      notification_id: null,
      started_at: publishedAt,
      head_published_at: publishedAt,
      wait_accounted_at: publishedAt,
      retry_at: 0,
      failure: null,
    };
    f.store.db
      .prepare("INSERT INTO pr_monitors VALUES(?,?,?,?)")
      .run(record.id, 1, record.stage, JSON.stringify(record));
    const repository = new PrMonitorRepository(f.store);
    repository.accountWait(record, publishedAt + 1000);
    f.store.close();
    const restarted = new Store(f.path);
    cleanups.push(() => restarted.close());
    const resumed = new PrMonitorRepository(restarted),
      loaded = resumed.get(1)!;
    resumed.accountWait(loaded, publishedAt + 5000);
    expect(JSON.parse(restarted.job(1)!.budget_json).wait_ms).toBe(5000);
    expect(restarted.leases()).toEqual([]);
  });

  it("fences post-publication scope edits without changing the coding revision", async () => {
    const f = await database();
    f.store.assertPublishedScope(1);
    f.input.body = "A different maintenance scope";
    f.store.applyIssue(f.store.refreshIssue(1), f.input, f.snapshot);
    expect(f.store.job(1)!.revision).toBe(1);
    expect(() => f.store.assertPublishedScope(1)).toThrow("pr_scope_changed");
  });

  it("migrates schema 9 additively and rolls back a conflicting migration", async () => {
    const f = await database(),
      before = f.store.job(1)!;
    f.store.db.exec(
      "DROP TABLE agent_conversations; DROP TABLE pr_monitors; DROP TABLE pr_monitor_evidence; DROP TABLE pr_observations; PRAGMA user_version=9",
    );
    f.store.close();
    const migrated = new Store(f.path);
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(11);
    expect(migrated.job(1)).toEqual(before);
    expect(migrated.ownedPull(77)!.object_id).toBe("77");
    migrated.db.exec(
      "DROP TABLE agent_conversations; DROP TABLE pr_monitors; DROP TABLE pr_observations; PRAGMA user_version=9",
    );
    migrated.close();
    expect(() => new Store(f.path)).toThrow();
    const raw = new Database(f.path);
    expect(raw.pragma("user_version", { simple: true })).toBe(9);
    expect(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE name='pr_monitors'")
        .get(),
    ).toBeUndefined();
    raw.close();
  });
});
