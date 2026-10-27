import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { containerSuites } from "../scripts/container-suites.mjs";

async function workflow(name) {
  return parse(
    await readFile(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );
}

const review = await workflow("ai-pr-review");
const release = await workflow("release");
const ci = await workflow("ci");
const codeql = await workflow("codeql");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const step = (job, name) => job.steps.find((entry) => entry.name === name);
const sha = "a".repeat(40);

function pull(overrides = {}) {
  return {
    number: 17,
    state: "open",
    draft: false,
    user: { login: "Z-M-Huang" },
    base: { ref: "main", repo: { id: 1 } },
    head: { sha, ref: "feature", repo: { id: 1 } },
    ...overrides,
  };
}

async function run(
  script,
  {
    context = {},
    env = {},
    current = pull(),
    pulls,
    statuses = [],
    jobs = [],
    transport = {},
    executor = {},
  } = {},
) {
  const outputs = {};
  const notices = [];
  const failures = [];
  const writes = [];
  const summaries = [];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: current }), list: "pulls" },
      repos: {
        listCommitStatusesForRef: "statuses",
        createCommitStatus: async (value) => writes.push(value),
        ...transport.repos,
      },
      actions: { listJobsForWorkflowRun: "jobs", ...transport.actions },
    },
    paginate: async (kind) => {
      if (kind === "pulls") return pulls ?? [current];
      if (kind === "statuses") return statuses;
      if (kind === "jobs") return jobs;
      throw new Error(`Unexpected API transport ${kind}`);
    },
  };
  const summary = {
    addHeading: () => summary,
    addCodeBlock: (value) => {
      summaries.push(JSON.parse(value));
      return summary;
    },
    write: async () => {},
  };
  const core = {
    summary,
    notice: (message) => notices.push(message),
    setOutput: (key, value) => (outputs[key] = value),
    setFailed: (message) => failures.push(message),
    info: (message) => notices.push(message),
  };
  await new AsyncFunction(
    "github",
    "context",
    "core",
    "process",
    "require",
    "exec",
    script,
  )(
    github,
    {
      eventName: "pull_request_target",
      actor: "Z-M-Huang",
      serverUrl: "https://github.com",
      repo: { owner: "markhuangai", repo: "opensource-repo-manager" },
      runId: 123,
      payload: { pull_request: pull() },
      ...context,
    },
    core,
    {
      env: {
        TRIGGERING_ACTOR: "Z-M-Huang",
        REVIEW_STATUS_CONTEXT_PREFIX: "AI PR review",
        GITHUB_WORKSPACE: fileURLToPath(new URL("../", import.meta.url)),
        GITHUB_RUN_ATTEMPT: "1",
        ...env,
      },
    },
    createRequire(import.meta.url),
    executor,
  );
  return { outputs, notices, failures, writes, summaries };
}

const resolve = step(review.jobs.resolve, "Resolve and fence pull request head")
  .with.script;
const finalize = step(review.jobs.review, "Publish final review status").with
  .script;
const validate = step(
  release.jobs.resolve,
  "Validate release source and version",
).with.script;

describe("AI review routing and exact-head policy", () => {
  it("registers edited PR events for CI, CodeQL and the trusted review route", () => {
    for (const trigger of [
      ci.on.pull_request,
      codeql.on.pull_request,
      review.on.pull_request_target,
    ]) {
      expect(trigger.branches).toEqual(["main"]);
      expect(trigger.types).toEqual([
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
        "edited",
      ]);
    }
    expect(ci.jobs.checks.if).toBeUndefined();
    expect(ci.jobs.containers.if).toBeUndefined();
    expect(codeql.jobs.analyze.if).toBeUndefined();
  });

  for (const changes of [
    { base: { ref: { from: "other" }, sha: { from: "b".repeat(40) } } },
    { title: { from: "Previous title" } },
    { body: { from: "Previous description" } },
  ])
    it("reviews an unchanged trusted head on retarget, title or body edit", async () => {
      const result = await run(resolve, {
        context: {
          payload: { action: "edited", changes, pull_request: pull() },
        },
      });
      expect(result.outputs.should_run).toBe("true");
      expect(result.outputs.head_sha).toBe(sha);
    });

  for (const event of [
    pull({ user: { login: "contributor" } }),
    pull({ head: { sha, ref: "feature", repo: { id: 2 } } }),
  ])
    it("keeps edited other-author and fork PRs on the CodeQL route", async () => {
      const direct = await run(resolve, {
        context: {
          payload: {
            action: "edited",
            changes: { base: { ref: { from: "other" } } },
            pull_request: event,
          },
        },
      });
      expect(direct.outputs.should_run).toBe("false");
      const completion = await run(resolve, {
        current: event,
        context: {
          eventName: "workflow_run",
          payload: {
            workflow_run: completedRun({ head_repository: event.head.repo }),
          },
        },
      });
      expect(completion.outputs.should_run).toBe("true");
      expect(completion.outputs.head_sha).toBe(sha);
    });

  it("preserves duplicate suppression and head fences on edited events", async () => {
    const context = { payload: { action: "edited", pull_request: pull() } };
    const duplicate = await run(resolve, {
      context,
      statuses: [{ id: 1, context: "AI PR review / PR #17", state: "success" }],
    });
    expect(duplicate.outputs.should_run).toBe("false");
    for (const current of [
      pull({ draft: true }),
      pull({ state: "closed" }),
      pull({ base: { ref: "other", repo: { id: 1 } } }),
      pull({ head: { sha: "b".repeat(40), ref: "feature", repo: { id: 1 } } }),
    ]) {
      expect(
        (await run(resolve, { context, current })).outputs.should_run,
      ).toBe("false");
    }
  });

  it("resolves a trusted maintainer's same-repository head", async () => {
    const result = await run(resolve);
    expect(result.outputs).toEqual({
      head_sha: sha,
      pr_number: "17",
      review_status_context: "AI PR review / PR #17",
      should_run: "true",
    });
  });

  for (const event of [
    pull({ user: { login: "contributor" } }),
    pull({ head: { sha, ref: "feature", repo: { id: 2 } } }),
  ]) {
    it("defers an untrusted author or fork to CodeQL completion", async () => {
      const result = await run(resolve, {
        context: { payload: { pull_request: event } },
      });
      expect(result.outputs).toEqual({ should_run: "false" });
    });
  }

  it("does not use a maintainer's direct route when another actor retriggers it", async () => {
    const result = await run(resolve, {
      env: { TRIGGERING_ACTOR: "contributor" },
    });
    expect(result.outputs.should_run).toBe("false");
  });

  function completedRun(overrides = {}) {
    return {
      event: "pull_request",
      conclusion: "success",
      actor: { login: "contributor" },
      triggering_actor: { login: "contributor" },
      head_sha: sha,
      head_branch: "feature",
      head_repository: { id: 2 },
      ...overrides,
    };
  }

  it("reviews the matching fork after successful CodeQL", async () => {
    const current = pull({ head: { sha, ref: "feature", repo: { id: 2 } } });
    const result = await run(resolve, {
      current,
      context: {
        eventName: "workflow_run",
        payload: { workflow_run: completedRun() },
      },
    });
    expect(result.outputs.should_run).toBe("true");
    expect(result.outputs.head_sha).toBe(sha);
  });

  for (const runData of [
    completedRun({ conclusion: "failure" }),
    completedRun({ event: "push" }),
  ]) {
    it("does not review failed or non-PR CodeQL runs", async () => {
      const result = await run(resolve, {
        context: {
          eventName: "workflow_run",
          payload: { workflow_run: runData },
        },
      });
      expect(result.outputs.should_run).toBe("false");
    });
  }

  it("requires one matching PR rather than a branch name alone", async () => {
    await expect(
      run(resolve, {
        pulls: [
          pull({ head: { sha, ref: "feature", repo: { id: 2 } } }),
          pull({ number: 18, head: { sha, ref: "feature", repo: { id: 2 } } }),
        ],
        context: {
          eventName: "workflow_run",
          payload: { workflow_run: completedRun() },
        },
      }),
    ).rejects.toThrow("Expected one open pull request");
  });

  it("ignores a completed run for a head that moved", async () => {
    const result = await run(resolve, {
      context: {
        eventName: "workflow_run",
        payload: { workflow_run: completedRun({ head_sha: "b".repeat(40) }) },
      },
    });
    expect(result.outputs.should_run).toBe("false");
  });

  for (const current of [
    pull({ draft: true }),
    pull({ state: "closed" }),
    pull({ base: { ref: "other", repo: { id: 1 } } }),
    pull({ head: { sha: "b".repeat(40), ref: "feature", repo: { id: 1 } } }),
  ]) {
    it("refuses draft, closed, wrong-base, or stale PRs", async () => {
      const result = await run(resolve, { current });
      expect(result.outputs.should_run).toBe("false");
      expect(result.outputs.head_sha).toBeUndefined();
    });
  }

  for (const state of ["pending", "success"]) {
    it(`does not duplicate the current PR's ${state} review`, async () => {
      const result = await run(resolve, {
        statuses: [{ id: 1, context: "AI PR review / PR #17", state }],
      });
      expect(result.outputs.should_run).toBe("false");
    });
  }

  it("does not let a different PR's status suppress review", async () => {
    const result = await run(resolve, {
      statuses: [{ id: 1, context: "AI PR review / PR #18", state: "success" }],
    });
    expect(result.outputs.should_run).toBe("true");
  });

  it("permits an explicit manual rerun after an incomplete cycle", async () => {
    const result = await run(resolve, {
      statuses: [{ id: 1, context: "AI PR review / PR #17", state: "pending" }],
      context: {
        eventName: "workflow_dispatch",
        payload: { inputs: { "pull-request-number": "17" } },
      },
    });
    expect(result.outputs.should_run).toBe("true");
  });

  for (const number of ["0", "-1", "1; echo unsafe", "9007199254740992"]) {
    it("rejects an invalid manual PR number", async () => {
      await expect(
        run(resolve, {
          context: {
            eventName: "workflow_dispatch",
            payload: { inputs: { "pull-request-number": number } },
          },
        }),
      ).rejects.toThrow();
    });
  }

  it("blocks stale final status without writing to another head", async () => {
    const result = await run(finalize, {
      current: pull({ head: { sha: "b".repeat(40) } }),
      env: { HEAD_SHA: sha, PR_NUMBER: "17", REVIEW_OUTCOME: "success" },
    });
    expect(result.writes).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
  });

  for (const outcome of ["failure", "cancelled", "skipped", ""]) {
    it("keeps an incomplete review visibly blocking", async () => {
      const result = await run(finalize, {
        env: {
          HEAD_SHA: sha,
          PR_NUMBER: "17",
          REVIEW_OUTCOME: outcome,
          REVIEW_STATUS_CONTEXT: "AI PR review / PR #17",
        },
      });
      expect(result.writes[0]).toMatchObject({
        sha,
        state: "error",
        context: "AI PR review / PR #17",
      });
    });
  }

  it("publishes success only for the fenced completed review", async () => {
    const result = await run(finalize, {
      env: { HEAD_SHA: sha, PR_NUMBER: "17", REVIEW_OUTCOME: "success" },
    });
    expect(result.writes[0]).toMatchObject({ sha, state: "success" });
  });

  it("reports missing configuration by name without printing supplied credentials", async () => {
    const script = step(review.jobs.review, "Validate reviewer configuration")
      .with.script;
    await expect(
      run(script, { env: { PR_REVIEW_PAT: "credential-canary" } }),
    ).rejects.toThrow("PROJECT_MEMORY_MCP_TOKEN");
    try {
      await run(script, { env: { PR_REVIEW_PAT: "credential-canary" } });
    } catch (error) {
      expect(error.message).not.toContain("credential-canary");
    }
  });
});

describe("release and CI boundaries", () => {
  it("publishes only release events after both native jobs succeed", () => {
    expect(release.on).toEqual({ release: { types: ["published"] } });
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(ci)).not.toContain("secrets.");
    expect(JSON.stringify(ci)).not.toContain("packages");
    expect(release.jobs.resolve.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(release.jobs.build.needs).toBe("resolve");
    expect(release.jobs.publish.needs).toEqual(["resolve", "build"]);
    expect(release.jobs.publish.if).toBeUndefined();
    expect(release.jobs.build.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(release.jobs.publish.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(release.jobs.build.strategy.matrix.include).toEqual(
      ci.jobs.containers.strategy.matrix.include,
    );
    expect(JSON.stringify(release)).not.toContain("setup-qemu");
    const build = step(release.jobs.build, "Build and push by digest");
    expect(build.with.outputs).toContain("push-by-digest=true");
    expect(build.with.tags).toBeUndefined();
    const upload = release.jobs.build.steps.find((entry) =>
      entry.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload.with["retention-days"]).toBe(1);
    expect(release.jobs.build.steps.indexOf(upload)).toBeGreaterThan(
      release.jobs.build.steps.indexOf(
        step(release.jobs.build, "Smoke-test the published native image"),
      ),
    );
    expect(release.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("requires native smoke tests for both architectures", () => {
    expect(ci.jobs.containers.strategy["fail-fast"]).toBe(false);
    expect(ci.jobs.containers.strategy.matrix.architecture).toEqual([
      "amd64",
      "arm64",
    ]);
    expect(ci.jobs.containers.strategy.matrix.suite).toEqual(containerSuites);
    expect(ci.jobs.containers.strategy.matrix.include).toEqual([
      {
        architecture: "amd64",
        platform: "linux/amd64",
        runner: "ubuntu-24.04",
      },
      {
        architecture: "arm64",
        platform: "linux/arm64",
        runner: "ubuntu-24.04-arm",
      },
    ]);
    expect(ci.jobs.container_results.strategy.matrix.architecture).toEqual([
      "amd64",
      "arm64",
    ]);
    expect(ci.jobs.container_results.needs).toBe("containers");
    expect(ci.jobs.container_results.if).toBe("always()");
    expect(ci.jobs.container_results.name).toBe(
      "Container smoke (${{ matrix.architecture }})",
    );
    expect(ci.jobs.result.needs).toEqual([
      "checks",
      "containers",
      "container_results",
    ]);
    const build = step(ci.jobs.containers, "Build and test the native image");
    expect(build.run).toContain('--suite "$TEST_SUITE"');
    expect(build.env.TEST_SUITE).toBe("${{ matrix.suite }}");
    expect(build.env.TEST_PR_HEAD_SHA).toBe(
      "${{ github.event.pull_request.head.sha }}",
    );
    expect(codeql.jobs.analyze.strategy.matrix.language).toEqual([
      "actions",
      "javascript-typescript",
    ]);
  });

  it("uses the reviewer release alias, pins other actions and protects checkout credentials", () => {
    expect(step(review.jobs.review, "Review pull request").uses).toBe(
      "markhuangai/ai-pr-reviewer@v1-prerelease",
    );
    for (const document of [ci, codeql, review, release]) {
      for (const job of Object.values(document.jobs)) {
        for (const entry of job.steps) {
          if (
            entry.uses &&
            entry.uses !== "markhuangai/ai-pr-reviewer@v1-prerelease"
          )
            expect(entry.uses).toMatch(/@[0-9a-f]{40}$/);
          if (entry.uses?.startsWith("actions/checkout@"))
            expect(entry.with["persist-credentials"]).toBe(false);
        }
      }
    }
  });

  it("delegates checkout to the action's isolated PR workspace", () => {
    const job = review.jobs.review;
    expect(
      job.steps.some((entry) => entry.uses?.startsWith("actions/checkout@")),
    ).toBe(false);
    expect(step(job, "Review pull request").with["pull-request-url"]).toContain(
      "needs.resolve.outputs.pr_number",
    );
    expect(step(job, "Publish final review status").env.HEAD_SHA).toBe(
      "${{ needs.resolve.outputs.head_sha }}",
    );
  });

  it("keeps AI review separate from builds with only read-only project recall", () => {
    expect(review.on.pull_request).toBeUndefined();
    const reviewer = step(review.jobs.review, "Review pull request");
    expect(reviewer.with).toMatchObject({
      executor: "claude",
      model: "auto",
      effort: "xhigh",
      "parallel-count": "6",
      "max-turns": "200",
      "auto-approve": "false",
    });
    expect(reviewer["timeout-minutes"]).toBe(50);
    const mcp = parse(reviewer.with["mcp-servers"]);
    expect(Object.keys(mcp)).toEqual(["project_memory"]);
    expect(mcp.project_memory.tools.map((tool) => tool.name)).toEqual([
      "recall_memory",
    ]);
    expect(
      review.jobs.review.steps.some((entry) =>
        /npm |docker build/.test(entry.run ?? ""),
      ),
    ).toBe(false);
  });
});

describe("native suite aggregation", () => {
  const script = step(ci.jobs.container_results, "Require every native suite")
    .with.script;
  const jobs = () =>
    ["amd64", "arm64"].flatMap((architecture) =>
      containerSuites.map((suite) => ({
        name: `Container tests (${architecture}, ${suite})`,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        created_at: "2026-10-25T00:00:00Z",
        started_at: "2026-10-25T00:00:10Z",
        completed_at: "2026-10-25T00:15:10Z",
        html_url: "https://example.invalid/job",
      })),
    );

  for (const architecture of ["amd64", "arm64"]) {
    const env = { TEST_ARCHITECTURE: architecture, GITHUB_RUN_ATTEMPT: "2" };
    const selected = (list) =>
      list.findIndex(
        (job) =>
          job.name ===
          `Container tests (${architecture}, implementation-monitor-mcp)`,
      );
    it(`requires all nine ${architecture} suites and reports queue time separately`, async () => {
      const result = await run(script, { env, jobs: jobs() });
      expect(result.failures).toEqual([]);
      expect(result.notices.map((value) => JSON.parse(value))).toEqual(
        containerSuites.map((suite) => ({
          suite,
          architecture,
          queue_ms: 10000,
          execution_ms: 900000,
          job_url: "https://example.invalid/job",
        })),
      );
    });
    for (const conclusion of [
      "failure",
      "skipped",
      "cancelled",
      "timed_out",
      null,
    ]) {
      it(`rejects a ${conclusion} latest ${architecture} suite despite an older success`, async () => {
        const list = jobs();
        list.push({ ...list[selected(list)], run_attempt: 2, conclusion });
        expect((await run(script, { env, jobs: list })).failures).toHaveLength(
          1,
        );
      });
    }
    for (const status of ["queued", "in_progress"]) {
      it(`rejects a ${status} latest ${architecture} suite`, async () => {
        const list = jobs();
        list.push({ ...list[selected(list)], run_attempt: 2, status });
        expect((await run(script, { env, jobs: list })).failures).toHaveLength(
          1,
        );
      });
    }
    it(`rejects missing and duplicate ${architecture} executions`, async () => {
      const missing = jobs();
      missing.splice(selected(missing), 1);
      expect((await run(script, { env, jobs: missing })).failures).toHaveLength(
        1,
      );
      const duplicate = jobs();
      duplicate.push({ ...duplicate[selected(duplicate)] });
      expect(
        (await run(script, { env, jobs: duplicate })).failures,
      ).toHaveLength(1);
    });
    it(`accepts a successful latest ${architecture} attempt after an earlier failure`, async () => {
      const list = jobs(),
        index = selected(list);
      list.push({ ...list[index], run_attempt: 2 });
      list[index].conclusion = "failure";
      expect((await run(script, { env, jobs: list })).failures).toEqual([]);
    });
  }
});

const image = "ghcr.io/markhuangai/opensource-repo-manager";
const publishedRelease = {
  id: 42,
  tag_name: "v0.1.0",
  draft: false,
  prerelease: false,
  published_at: "2026-10-26T00:00:00Z",
};
function releaseContext(releaseData = publishedRelease, overrides = {}) {
  return {
    eventName: "release",
    ref: `refs/tags/${releaseData.tag_name}`,
    sha,
    payload: { action: "published", release: releaseData },
    ...overrides,
  };
}
function releaseTransport({
  commit = sha,
  comparison = "ahead",
  runs = {},
  current = publishedRelease,
  latest = publishedRelease,
} = {}) {
  return {
    repos: {
      getCommit: async () => ({ data: { sha: commit } }),
      getBranch: async () => ({ data: { commit: { sha: "b".repeat(40) } } }),
      compareCommits: async () => ({ data: { status: comparison } }),
      getRelease: async () => ({ data: current }),
      getLatestRelease: async () => ({ data: latest }),
    },
    actions: {
      listWorkflowRuns: async (args) => {
        expect(args).toMatchObject({
          head_sha: sha,
          branch: "main",
          event: "push",
          per_page: 1,
        });
        return {
          data: {
            workflow_runs: runs[args.workflow_id] ?? [
              {
                head_sha: sha,
                head_branch: "main",
                event: "push",
                status: "completed",
                conclusion: "success",
                html_url: "https://example.invalid/run",
              },
            ],
          },
        };
      },
    },
  };
}

describe("release source policy", () => {
  for (const [tag, prerelease, expected] of [
    ["v0.1.0", false, "false"],
    ["v0.1.0-rc.1", true, "true"],
    ["v0.1.0-rc.1", false, "true"],
    ["v0.1.0", true, "true"],
  ]) {
    it(`resolves ${tag} with prerelease=${prerelease}`, async () => {
      const result = await run(validate, {
        context: releaseContext({
          ...publishedRelease,
          tag_name: tag,
          prerelease,
        }),
        transport: releaseTransport(),
      });
      expect(result.outputs).toEqual({
        version: tag.slice(1),
        source_sha: sha,
        prerelease: expected,
      });
    });
  }
  for (const tag_name of [
    "0.1.0",
    "latest",
    "v01.1.0",
    "v0.1.0-rc.01",
    "v0.1.0+build",
    "v0.1.0; echo unsafe",
    "v0.1.0\n",
    `v0.1.0-${"x".repeat(128)}`,
  ]) {
    it(`rejects malformed tag ${JSON.stringify(tag_name)}`, async () => {
      await expect(
        run(validate, {
          context: releaseContext({ ...publishedRelease, tag_name }),
          transport: releaseTransport(),
        }),
      ).rejects.toThrow();
    });
  }
  for (const context of [
    releaseContext(publishedRelease, { eventName: "pull_request" }),
    releaseContext(publishedRelease, { eventName: "workflow_dispatch" }),
    releaseContext(publishedRelease, { ref: "refs/heads/main" }),
    releaseContext(publishedRelease, { sha: "moving-branch" }),
    releaseContext(publishedRelease, {
      payload: { action: "edited", release: publishedRelease },
    }),
    releaseContext({ ...publishedRelease, draft: true }),
    releaseContext({ ...publishedRelease, published_at: null }),
  ]) {
    it("rejects nonpublication events and invalid release sources", async () => {
      await expect(
        run(validate, { context, transport: releaseTransport() }),
      ).rejects.toThrow();
    });
  }
  for (const overrides of [
    { commit: "c".repeat(40) },
    { comparison: "behind" },
    { comparison: "diverged" },
  ]) {
    it("rejects moved tags and commits outside main", async () => {
      await expect(
        run(validate, {
          context: releaseContext(),
          transport: releaseTransport(overrides),
        }),
      ).rejects.toThrow();
    });
  }
  for (const workflow of ["ci.yml", "codeql.yml"]) {
    for (const change of [
      null,
      { conclusion: "failure" },
      { conclusion: "cancelled" },
      { conclusion: "skipped" },
      { status: "in_progress", conclusion: null },
      { head_sha: "c".repeat(40) },
      { head_branch: "feature" },
      { event: "pull_request" },
    ]) {
      it(`requires successful exact-source ${workflow}: ${JSON.stringify(change)}`, async () => {
        const runs =
          change === null
            ? []
            : [
                {
                  head_sha: sha,
                  head_branch: "main",
                  event: "push",
                  status: "completed",
                  conclusion: "success",
                  ...change,
                },
              ];
        await expect(
          run(validate, {
            context: releaseContext(),
            transport: releaseTransport({ runs: { [workflow]: runs } }),
          }),
        ).rejects.toThrow("successful main-push run");
      });
    }
  }
});

const digest = (letter) => `sha256:${letter.repeat(64)}`;
const nativeReceipts = ["amd64", "arm64"].map((architecture, index) => ({
  source_sha: sha,
  version: "0.1.0",
  platform: `linux/${architecture}`,
  digest: digest(index ? "b" : "a"),
  platform_digest: digest(index ? "d" : "c"),
  smoke: "passed",
}));
const descriptor = (receipt) => ({
  digest: receipt.platform_digest,
  platform: { os: "linux", architecture: receipt.platform.split("/")[1] },
});
const combinedManifest = {
  digest: digest("e"),
  manifests: nativeReceipts.map(descriptor),
};
const publishScript = step(
  release.jobs.publish,
  "Verify manifests and publish release tags",
).with.script;
const smokeScript = step(
  release.jobs.build,
  "Smoke-test the published native image",
).with.script;

async function withReceipts(callback, receipts = nativeReceipts) {
  const directory = await mkdtemp(join(tmpdir(), "orm-release-policy-"));
  try {
    for (const receipt of receipts) {
      await writeFile(
        join(directory, `image-${receipt.platform.split("/")[1]}.json`),
        JSON.stringify(receipt),
      );
    }
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true });
  }
}

function registryTransport(overrides = {}) {
  const publications = [];
  const manifests = Object.fromEntries(
    nativeReceipts.map((receipt) => [
      `${image}@${receipt.digest}`,
      { digest: receipt.digest, manifests: [descriptor(receipt)] },
    ]),
  );
  return {
    publications,
    executor: {
      exec: async (command, args) => {
        expect(command).toBe("docker");
        expect(args.slice(0, 3)).toEqual(["buildx", "imagetools", "create"]);
        publications.push(args);
      },
      getExecOutput: async (command, args) => {
        expect(command).toBe("docker");
        expect(args.slice(0, 3)).toEqual(["buildx", "imagetools", "inspect"]);
        expect(args.slice(4)).toEqual(["--format", "{{json .Manifest}}"]);
        return {
          stdout: JSON.stringify(
            overrides[args[3]] ?? manifests[args[3]] ?? combinedManifest,
          ),
        };
      },
    },
  };
}
const publicationEnv = (directory) => ({
  IMAGE: image,
  SOURCE_SHA: sha,
  VERSION: "0.1.0",
  IS_PRERELEASE: "false",
  RECEIPTS: directory,
});

describe("release manifest promotion", () => {
  it("combines the tested digests and promotes only the verified combined digest", async () => {
    await withReceipts(async (directory) => {
      const registry = registryTransport();
      const result = await run(publishScript, {
        context: releaseContext(),
        env: publicationEnv(directory),
        transport: releaseTransport(),
        executor: registry.executor,
      });
      expect(registry.publications).toEqual([
        [
          "buildx",
          "imagetools",
          "create",
          "--tag",
          `${image}:0.1.0`,
          "--tag",
          `${image}:sha-${sha}`,
          ...nativeReceipts.map((receipt) => `${image}@${receipt.digest}`),
        ],
        [
          "buildx",
          "imagetools",
          "create",
          "--tag",
          `${image}:latest`,
          `${image}@${digest("e")}`,
        ],
      ]);
      expect(result.summaries).toEqual([
        {
          repository: image,
          version: "0.1.0",
          source_sha: sha,
          digest: digest("e"),
          tags: [`${image}:0.1.0`, `${image}:sha-${sha}`, `${image}:latest`],
          platforms: nativeReceipts.map(
            ({ platform, digest, platform_digest }) => ({
              platform,
              digest,
              platform_digest,
            }),
          ),
          run_url:
            "https://github.com/markhuangai/opensource-repo-manager/actions/runs/123",
        },
      ]);
    });
  });
  for (const scenario of [
    "older release",
    "initial prerelease",
    "became prerelease",
    "suffix without prerelease flag",
  ]) {
    it(`does not promote latest for ${scenario}`, async () => {
      const version = scenario.startsWith("suffix") ? "0.1.0-rc.1" : "0.1.0";
      const current = {
        ...publishedRelease,
        tag_name: `v${version}`,
        prerelease: scenario === "became prerelease",
      };
      await withReceipts(
        async (directory) => {
          const registry = registryTransport();
          await run(publishScript, {
            context: releaseContext(current),
            env: {
              ...publicationEnv(directory),
              VERSION: version,
              IS_PRERELEASE:
                scenario === "initial prerelease" ? "true" : "false",
            },
            transport: releaseTransport({
              current,
              latest:
                scenario === "older release"
                  ? { ...publishedRelease, id: 43 }
                  : current,
            }),
            executor: registry.executor,
          });
          expect(registry.publications).toHaveLength(1);
        },
        nativeReceipts.map((receipt) => ({ ...receipt, version })),
      );
    });
  }
  for (const changes of [
    { source_sha: "f".repeat(40) },
    { version: "0.2.0" },
    { smoke: "failed" },
    { digest: "invalid" },
    { platform_digest: "invalid" },
  ]) {
    it(`rejects mismatched architecture receipt ${JSON.stringify(changes)}`, async () => {
      await withReceipts(
        async (directory) => {
          const registry = registryTransport();
          await expect(
            run(publishScript, {
              context: releaseContext(),
              env: publicationEnv(directory),
              transport: releaseTransport(),
              executor: registry.executor,
            }),
          ).rejects.toThrow();
          expect(registry.publications).toEqual([]);
        },
        [{ ...nativeReceipts[0], ...changes }, nativeReceipts[1]],
      );
    });
  }
  it("does not publish with a missing or duplicate architecture", async () => {
    for (const receipts of [
      nativeReceipts.slice(0, 1),
      [nativeReceipts[0], nativeReceipts[0]],
    ]) {
      await withReceipts(async (directory) => {
        const registry = registryTransport();
        await expect(
          run(publishScript, {
            context: releaseContext(),
            env: publicationEnv(directory),
            transport: releaseTransport(),
            executor: registry.executor,
          }),
        ).rejects.toThrow("Both architecture receipts");
        expect(registry.publications).toEqual([]);
      }, receipts);
    }
  });
  for (const overrides of [
    { commit: "f".repeat(40) },
    { current: { ...publishedRelease, draft: true } },
    { current: { ...publishedRelease, tag_name: "v0.2.0" } },
  ]) {
    it("rechecks live release identity before publishing", async () => {
      await withReceipts(async (directory) => {
        const registry = registryTransport();
        await expect(
          run(publishScript, {
            context: releaseContext(),
            env: publicationEnv(directory),
            transport: releaseTransport(overrides),
            executor: registry.executor,
          }),
        ).rejects.toThrow();
        expect(registry.publications).toEqual([]);
      });
    });
  }
  it("rechecks the tag again before latest promotion", async () => {
    await withReceipts(async (directory) => {
      const registry = registryTransport();
      const transport = releaseTransport();
      let reads = 0;
      transport.repos.getCommit = async () => ({
        data: { sha: ++reads === 1 ? sha : "f".repeat(40) },
      });
      await expect(
        run(publishScript, {
          context: releaseContext(),
          env: publicationEnv(directory),
          transport,
          executor: registry.executor,
        }),
      ).rejects.toThrow("tag moved");
      expect(registry.publications).toHaveLength(1);
    });
  });
  it("rejects a native registry manifest that differs from its smoke receipt", async () => {
    await withReceipts(async (directory) => {
      const registry = registryTransport({
        [`${image}@${nativeReceipts[0].digest}`]: {
          digest: nativeReceipts[0].digest,
          manifests: [descriptor(nativeReceipts[1])],
        },
      });
      await expect(
        run(publishScript, {
          context: releaseContext(),
          env: publicationEnv(directory),
          transport: releaseTransport(),
          executor: registry.executor,
        }),
      ).rejects.toThrow("smoke-tested platforms");
      expect(registry.publications).toEqual([]);
    });
  });
  for (const manifests of [
    [],
    [descriptor(nativeReceipts[0])],
    [descriptor(nativeReceipts[0]), descriptor(nativeReceipts[0])],
  ]) {
    it("never promotes a combined manifest missing either tested platform", async () => {
      await withReceipts(async (directory) => {
        const registry = registryTransport({
          [`${image}:0.1.0`]: { digest: digest("e"), manifests },
        });
        await expect(
          run(publishScript, {
            context: releaseContext(),
            env: publicationEnv(directory),
            transport: releaseTransport(),
            executor: registry.executor,
          }),
        ).rejects.toThrow("smoke-tested platforms");
        expect(registry.publications).toHaveLength(1);
      });
    });
  }
  it("accepts provenance attestations alongside both runnable platforms", async () => {
    await withReceipts(async (directory) => {
      const registry = registryTransport({
        [`${image}:0.1.0`]: {
          ...combinedManifest,
          manifests: [
            ...combinedManifest.manifests,
            {
              digest: digest("f"),
              platform: { os: "unknown", architecture: "unknown" },
              annotations: {
                "vnd.docker.reference.type": "attestation-manifest",
              },
            },
          ],
        },
      });
      await run(publishScript, {
        context: releaseContext(),
        env: publicationEnv(directory),
        transport: releaseTransport(),
        executor: registry.executor,
      });
      expect(registry.publications).toHaveLength(2);
    });
  });
});

describe("native image smoke receipts", () => {
  for (const receipt of nativeReceipts) {
    for (const failBinary of [null, "node", "mise", "gitleaks"]) {
      it(`${receipt.platform} requires every native executable before issuing a receipt (${failBinary})`, async () => {
        await withReceipts(async (directory) => {
          const commands = [];
          const executor = {
            exec: async (command, args) => {
              expect(command).toBe("docker");
              commands.push(args);
              if (args.includes(`/opt/orm-runtime/bin/${failBinary}`))
                throw new Error("Native binary failed");
            },
            getExecOutput: async (command, args) => ({
              stdout: JSON.stringify(
                args[0] === "image"
                  ? [
                      {
                        Os: "linux",
                        Architecture: receipt.platform.split("/")[1],
                        Config: {
                          Labels: {
                            "org.opencontainers.image.revision": sha,
                            "org.opencontainers.image.version": "0.1.0",
                          },
                        },
                      },
                    ]
                  : {
                      digest: receipt.digest,
                      manifests: [descriptor(receipt)],
                    },
              ),
            }),
          };
          const invocation = run(smokeScript, {
            env: {
              IMAGE: image,
              IMAGE_DIGEST: receipt.digest,
              PLATFORM: receipt.platform,
              SOURCE_SHA: sha,
              VERSION: "0.1.0",
              RUNNER_TEMP: directory,
            },
            executor,
          });
          if (failBinary) {
            await expect(invocation).rejects.toThrow("Native binary failed");
            expect(await readdir(directory)).toEqual([]);
          } else {
            await invocation;
            expect(
              JSON.parse(
                await readFile(
                  join(
                    directory,
                    `image-${receipt.platform.split("/")[1]}.json`,
                  ),
                  "utf8",
                ),
              ),
            ).toEqual(receipt);
            expect(commands.filter((args) => args[0] === "run")).toHaveLength(
              3,
            );
            expect(commands[1].at(-1)).toContain("better-sqlite3");
          }
        }, []);
      });
    }
  }
});
