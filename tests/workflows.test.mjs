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
const promotion = await workflow("promote-release");
const ci = await workflow("ci");
const codeql = await workflow("codeql");
const maintenance = await workflow("maintenance");
const aiTest = await workflow("test-ai");
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
  const maskedValues = [];
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
    setSecret: (value) => maskedValues.push(value),
    notice: (message) => notices.push(message),
    setOutput: (key, value) => (outputs[key] = value),
    setFailed: (message) => failures.push(message),
    info: (message) => notices.push(message),
    error: (message) => notices.push(message),
    warning: (message) => notices.push(message),
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
  return { outputs, notices, failures, writes, summaries, maskedValues };
}

const resolve = step(review.jobs.resolve, "Resolve and fence pull request head")
  .with.script;
const finalize = step(review.jobs.review, "Publish final review status").with
  .script;
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
  it("publishes candidates only after native builds and shares its mutation lock with promotion", () => {
    expect(release.on).toEqual({
      workflow_run: {
        workflows: ["Repository CI", "CodeQL"],
        types: ["completed"],
        branches: ["main"],
      },
    });
    expect(promotion.on.workflow_dispatch.inputs.source_rc.required).toBe(true);
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(ci)).not.toContain("packages");
    expect(release.jobs.resolve.permissions).toEqual({
      contents: "write",
      actions: "read",
    });
    expect(release.jobs.build.needs).toBe("resolve");
    expect(release.jobs.build.if).toContain("build_required == 'true'");
    expect(release.jobs.publish.needs).toEqual(["resolve", "build"]);
    expect(release.jobs.publish.if).toContain(
      "needs.build.result == 'success'",
    );
    expect(release.jobs.build.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(release.jobs.build.strategy.matrix.include).toEqual(
      ci.jobs.containers.strategy.matrix.include,
    );
    expect(JSON.stringify(release)).not.toContain("setup-qemu");
    expect(
      step(release.jobs.build, "Build and push by digest").with.outputs,
    ).toContain("push-by-digest=true");
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
    expect(promotion.concurrency["cancel-in-progress"]).toBe(false);
    expect(release.concurrency.group).not.toBe(promotion.concurrency.group);
    for (const job of [
      release.jobs.resolve,
      release.jobs.publish,
      promotion.jobs.promote,
    ])
      expect(job.concurrency).toEqual({
        group: "release-state-${{ github.repository }}",
        "cancel-in-progress": false,
      });
    expect(JSON.stringify(promotion)).not.toContain("build-push-action");
    expect(promotion.jobs.promote.if).toBe("github.ref == 'refs/heads/main'");
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
    for (const document of [
      ci,
      codeql,
      review,
      release,
      promotion,
      maintenance,
      aiTest,
    ]) {
      for (const job of Object.values(document.jobs)) {
        for (const entry of job.steps ?? []) {
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
      model: "${{ env.AI_REVIEW_MODEL }}",
      effort: "xhigh",
      "parallel-count": "6",
      "max-turns": "200",
      "auto-approve": "false",
    });
    expect(reviewer["timeout-minutes"]).toBe(50);
    expect(review.jobs.review.env.AI_REVIEW_MODEL).toBe(
      "${{ vars.AI_REVIEW_MODEL || 'auto' }}",
    );
    expect(review.jobs.review.env.AI_ENDPOINT).toBe(
      "${{ vars.AI_ENDPOINT || secrets.AI_ENDPOINT }}",
    );
    expect(reviewer.with["ai-base-url"]).toBe("${{ env.AI_ENDPOINT }}");
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

  it("validates the resolved reviewer model and endpoint without exposing their values", async () => {
    const script = step(review.jobs.review, "Validate reviewer configuration")
      .with.script;
    const env = {
      PR_REVIEW_PAT: "pat-canary",
      AI_ENDPOINT: "https://endpoint-canary.invalid",
      AI_REVIEW_MODEL: "model-canary",
      LOCAL_AI_SECRET: "key-canary",
      PROJECT_MEMORY_MCP_ENDPOINT: "https://memory.invalid",
      PROJECT_MEMORY_MCP_TOKEN: "memory-key-canary",
    };
    expect((await run(script, { env })).failures).toEqual([]);
    for (const key of ["AI_ENDPOINT", "AI_REVIEW_MODEL"]) {
      await expect(
        run(script, { env: { ...env, [key]: " " } }),
      ).rejects.toThrow("Missing reviewer configuration: " + key);
    }
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
          `Container tests (${architecture}, implementation-monitor-state)`,
      );
    it(`requires all ten ${architecture} suites and reports queue time separately`, async () => {
      const result = await run(script, { env, jobs: jobs() });
      expect(result.failures).toEqual([]);
      expect(result.notices.map((value) => JSON.parse(value))).toEqual(
        containerSuites.map((suite) => ({
          suite,
          architecture,
          workflow_run_id: 123,
          run_attempt: 1,
          queue_ms: 10000,
          execution_ms: 900000,
          job_url: "https://example.invalid/job",
        })),
      );
    });
    for (const suite of ["bootstrap-node", "bootstrap-python", "bootstrap-go"])
      it(`rejects missing ${architecture} ${suite} coverage`, async () => {
        const list = jobs().filter(
          (job) => job.name !== `Container tests (${architecture}, ${suite})`,
        );
        expect((await run(script, { env, jobs: list })).failures).toHaveLength(
          1,
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
    it(`marks inconsistent ${architecture} timestamps unavailable instead of reporting negative latency`, async () => {
      const list = jobs();
      list[selected(list)].created_at = "2026-10-25T00:20:00Z";
      list[selected(list)].completed_at = "2026-10-25T00:00:00Z";
      const result = await run(script, { env, jobs: list });
      expect(result.failures).toEqual([]);
      expect(JSON.parse(result.notices.at(-1))).toMatchObject({
        queue_ms: null,
        execution_ms: null,
        timing_error: "invalid_timestamps",
        run_attempt: 1,
      });
    });
  }
});

describe("pinned reusable maintenance workflow", () => {
  const image = `ghcr.io/markhuangai/opensource-repo-manager@sha256:${"a".repeat(64)}`;
  const route = step(
    maintenance.jobs.resolve,
    "Route through the pinned controller",
  ).with.script;
  const execute = step(
    maintenance.jobs.maintenance,
    "Execute the bounded maintenance task",
  ).with.script;
  const cleanup = step(
    maintenance.jobs.maintenance,
    "Remove the maintenance container",
  ).with.script;
  const environment = {
    ORM_RUNTIME_IMAGE: image,
    ORM_SELECTED_ISSUE: "7",
    ORM_BOOTSTRAP_GITHUB_TOKEN: "protected-bootstrap",
    ORM_CONFIGURATION_SECRETS: JSON.stringify({
      PAT: "protected-pat",
      KEY: "protected-proxy",
      SESSION: "protected-key",
    }),
    ORM_CONFIGURATION_VARIABLES: JSON.stringify({ MODEL: "model-canary" }),
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_REPOSITORY_ID: "42",
    GITHUB_RUN_ID: "123",
    GITHUB_SHA: sha,
    GITHUB_EVENT_PATH: "/runner/event.json",
    ACTIONS_RUNTIME_TOKEN: "protected-runtime",
    ACTIONS_RESULTS_URL: "https://results.actions.githubusercontent.com/",
  };
  it("accepts an explicit secret map and resolves root issues before the shared concurrency group", async () => {
    expect(Object.keys(maintenance.on["workflow_call"].secrets).sort()).toEqual(
      ["ORM_CONFIGURATION_SECRETS", "ORM_CONFIGURATION_VARIABLES"],
    );
    expect(maintenance.on["workflow_call"].inputs.runner.default).toBe(
      "ubuntu-24.04",
    );
    expect(
      maintenance.on["workflow_call"].inputs["runtime-image"].required,
    ).toBe(false);
    for (const job of [
      maintenance.jobs.resolve,
      maintenance.jobs.maintenance,
    ]) {
      expect(job.steps[0].env.ORM_CONFIGURATION_VARIABLES).toBe(
        "${{ secrets.ORM_CONFIGURATION_VARIABLES }}",
      );
    }
    expect(maintenance.jobs.maintenance.needs).toBe("resolve");
    expect(maintenance.jobs.maintenance.concurrency).toEqual({
      group: "orm-${{ github.repository_id }}-issue-${{ matrix.issue }}",
      "cancel-in-progress": false,
    });
    expect(JSON.stringify(maintenance)).not.toMatch(
      /queue:|actions\/checkout|--privileged|docker.sock|--network.?host/,
    );
    const consumer = parse(
      await readFile(
        new URL("../examples/actions/maintenance.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(consumer.on.schedule).toEqual([{ cron: "7,22,37,52 * * * *" }]);
    expect(consumer.on.pull_request_target.types).toEqual([
      "synchronize",
      "closed",
    ]);
    expect(consumer.on.issue_comment.types).toEqual(["created"]);
    expect(consumer.jobs.maintenance.uses).toMatch(/@v1-prerelease$/);
    expect(consumer.jobs.maintenance.with["runtime-image"]).toBeUndefined();
  });
  for (const mutable of [
    "ghcr.io/owner/image:latest",
    "ghcr.io/owner/image:sha-abc",
    "ghcr.io/owner/image@sha256:short",
    `${image}; unsafe`,
  ])
    it(`rejects mutable or malformed image ${mutable} before Docker execution`, async () => {
      const calls = [];
      for (const script of [route, execute])
        await expect(
          run(script, {
            env: { ...environment, ORM_RUNTIME_IMAGE: mutable },
            executor: { exec: async (...args) => calls.push(args) },
          }),
        ).rejects.toThrow("pinned by digest");
      expect(calls).toEqual([]);
    });
  it("runs only the pinned controller and passes credentials by environment name", async () => {
    const calls = [];
    const result = await run(route, {
      env: environment,
      executor: {
        exec: async (command, args) => calls.push([command, args]),
        getExecOutput: async () => ({
          stdout: JSON.stringify({
            version: 1,
            repository_id: 42,
            issues: [7, 9],
          }),
          exitCode: 0,
        }),
      },
    });
    expect(result.outputs).toEqual({ issues: "[7,9]", has_work: "true" });
    expect(calls[1][1].slice(-4)).toEqual([
      "--",
      "/opt/orm-runtime/bin/node",
      "/opt/orm/app/dist/actions/controller.js",
      "route",
    ]);
    expect(JSON.stringify(calls)).not.toContain("protected-");
    expect(calls[1][1]).toContain("ORM_BOOTSTRAP_GITHUB_TOKEN");
    expect(calls[1][1]).toContain("ORM_CONFIGURATION_SECRETS");
    expect(calls[1][1]).toContain("ORM_CONFIGURATION_VARIABLES");
    expect(calls[1][1]).not.toContain("ORM_PROXY_KEY");
    expect(result.maskedValues).toEqual([]);
  });
  for (const field of [
    "ORM_CONFIGURATION_VARIABLES",
    "ORM_CONFIGURATION_SECRETS",
  ])
    it(`preserves routing and diagnostics for scalar values in ${field}`, async () => {
      const env = {
        ...environment,
        [field]: JSON.stringify({
          ...JSON.parse(environment[field]),
          ENABLED: "true",
          COUNT: "0",
          ISSUE_DIGIT: "1",
        }),
      };
      const diagnostic = JSON.stringify({
        event: "configuration_resolved",
        run_id: "100",
        source_sha: "a0".repeat(20),
        schema_version: 1,
        elapsed_ms: 0,
      });
      const routed = await run(route, {
        env,
        executor: {
          exec: async () => {},
          getExecOutput: async () => ({
            stdout: JSON.stringify({
              version: 1,
              repository_id: 42,
              issues: [1, 10],
            }),
            stderr: diagnostic,
            exitCode: 0,
          }),
        },
      });
      expect(routed.outputs).toEqual({ issues: "[1,10]", has_work: "true" });
      expect(routed.maskedValues).toEqual([]);
      expect(routed.notices).toContain(diagnostic);
      const executed = await run(execute, {
        env,
        executor: {
          exec: async () => {},
          getExecOutput: async () => ({
            stdout: JSON.stringify({
              version: 1,
              outcome: "waiting",
              reason: "remote_checks",
            }),
            stderr: diagnostic,
            exitCode: 0,
          }),
        },
      });
      expect(executed.maskedValues).toEqual([]);
      expect(executed.notices).toContain(diagnostic);
      expect(maintenance.on.workflow_call.secrets[field].required).toBe(true);
    });
  it("forwards safe controller diagnostics into the Actions log", async () => {
    const diagnostic = JSON.stringify({
      event: "configuration_load_failed",
      cause: "source_missing",
      source: "variable",
      name: "MODEL",
    });
    const result = await run(execute, {
      env: environment,
      executor: {
        exec: async () => {},
        getExecOutput: async () => ({
          exitCode: 1,
          stderr: diagnostic,
          stdout: JSON.stringify({
            version: 1,
            outcome: "failed",
            reason: "source_missing",
          }),
        }),
      },
    });
    expect(result.notices).toContain(diagnostic);
    expect(result.failures).toEqual(["Maintenance stopped: source_missing"]);
    expect(JSON.stringify(result.notices)).not.toContain("protected-");
  });
  for (const [field, label] of [
    ["ORM_CONFIGURATION_SECRETS", "secret"],
    ["ORM_CONFIGURATION_VARIABLES", "variable"],
  ])
    for (const value of ["{invalid-canary", "[]", '{"TOKEN":7}'])
      it(`rejects invalid ${label} transport without echoing its contents`, async () => {
        const calls = [];
        for (const script of [route, execute])
          await expect(
            run(script, {
              env: { ...environment, [field]: value },
              executor: { exec: async (...args) => calls.push(args) },
            }),
          ).rejects.toThrow(`Invalid configuration ${label} map`);
        expect(calls).toEqual([]);
      });
  it("treats waiting as a successful bounded exit and preserves failed results", async () => {
    for (const exitCode of [0, 1]) {
      const result = await run(execute, {
        env: environment,
        executor: {
          exec: async () => {},
          getExecOutput: async () => ({
            exitCode,
            stdout: JSON.stringify({
              version: 1,
              outcome: exitCode ? "blocked" : "waiting",
              reason: "needs_information",
            }),
          }),
        },
      });
      expect(result.failures).toHaveLength(exitCode);
      expect(result.summaries[0].outcome).toBe(
        exitCode ? "blocked" : "waiting",
      );
    }
  });
  it("refuses cleanup when container ownership is different or unverified", async () => {
    const calls = [];
    await expect(
      run(cleanup, {
        env: environment,
        executor: {
          exec: async (...args) => calls.push(args),
          getExecOutput: async () => ({
            exitCode: 0,
            stdout: "other-run",
            stderr: "",
          }),
        },
      }),
    ).rejects.toThrow("ownership is unverified");
    expect(calls).toEqual([]);
    const result = await run(cleanup, {
      env: environment,
      executor: {
        exec: async (...args) => calls.push(args),
        getExecOutput: async () => ({
          exitCode: 0,
          stdout: "123-1",
          stderr: "",
        }),
      },
    });
    expect(calls.map((row) => row[1][0])).toEqual(["stop", "rm"]);
    expect(JSON.parse(result.notices[0]).cleanup).toBe("passed");
  });
});

const image = "ghcr.io/markhuangai/opensource-repo-manager";
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

describe("native image smoke receipts", () => {
  for (const receipt of nativeReceipts) {
    for (const failure of [
      null,
      "node",
      "mise",
      "gitleaks",
      "timeout",
      "result",
      "success",
      "entrypoint",
    ]) {
      it(
        receipt.platform +
          " requires bounded startup and every native executable (" +
          failure +
          ")",
        async () => {
          await withReceipts(async (directory) => {
            const commands = [];
            let containerName;
            const executor = {
              exec: async (command, args) => {
                expect(command).toBe("docker");
                commands.push(args);
                if (args.includes("/opt/orm-runtime/bin/" + failure))
                  throw new Error("Native binary failed");
              },
              getExecOutput: async (command, args, options) => {
                if (command === "timeout") {
                  expect(args.slice(0, 5)).toEqual([
                    "--kill-after=15s",
                    "30s",
                    "docker",
                    "run",
                    "--rm",
                  ]);
                  expect(args).not.toContain("--entrypoint");
                  expect(args).not.toContain("--env");
                  expect(args.at(-1)).toBe("1");
                  expect(options.ignoreReturnCode).toBe(true);
                  containerName = args[args.indexOf("--name") + 1];
                  return {
                    exitCode:
                      failure === "timeout"
                        ? 124
                        : failure === "success"
                          ? 0
                          : 1,
                    stdout: JSON.stringify({
                      version: 1,
                      outcome: "failed",
                      reason:
                        failure === "result"
                          ? "runtime_failed"
                          : "configuration_invalid",
                    }),
                  };
                }
                expect(command).toBe("docker");
                if (args[0] === "container") {
                  expect(args).toEqual(["container", "inspect", containerName]);
                  return failure === "timeout"
                    ? {
                        exitCode: 0,
                        stdout: JSON.stringify([
                          {
                            Id: "owned-container",
                            Config: {
                              Labels: {
                                "org.opensource-repo-manager.release-smoke":
                                  containerName,
                              },
                            },
                          },
                        ]),
                      }
                    : { exitCode: 1, stdout: "" };
                }
                return {
                  exitCode: 0,
                  stdout: JSON.stringify(
                    args[0] === "image"
                      ? [
                          {
                            Os: "linux",
                            Architecture: receipt.platform.split("/")[1],
                            Config: {
                              Entrypoint:
                                failure === "entrypoint"
                                  ? ["/retired/main.js"]
                                  : [
                                      "/usr/bin/tini",
                                      "--",
                                      "/opt/orm-runtime/bin/node",
                                      "/opt/orm/app/dist/actions/main.js",
                                    ],
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
                };
              },
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
            if (failure) {
              await expect(invocation).rejects.toThrow();
              expect(await readdir(directory)).toEqual([]);
              if (failure === "timeout")
                expect(commands).toContainEqual([
                  "container",
                  "rm",
                  "--force",
                  "owned-container",
                ]);
            } else {
              await invocation;
              expect(
                JSON.parse(
                  await readFile(
                    join(
                      directory,
                      "image-" + receipt.platform.split("/")[1] + ".json",
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
        },
      );
    }
  }
});

describe.each([
  ["maintenance", maintenance],
  ["test-ai", aiTest],
])("release-bound runtime selection (%s)", (name, document) => {
  const runtimeScript = step(
    document.jobs.runtime,
    "Resolve the workflow runtime",
  ).with.script;
  const source = "b".repeat(40);
  const identity = (ref = "refs/tags/v1-prerelease") => ({
    workflow_repository: "markhuangai/opensource-repo-manager",
    workflow_file_path: `.github/workflows/${name}.yml`,
    workflow_ref: `markhuangai/opensource-repo-manager/.github/workflows/${name}.yml@${ref}`,
    workflow_sha: source,
    check_run_id: 456,
  });
  const manifest = () => ({
    digest: digest("f"),
    manifests: [
      ...nativeReceipts.map(descriptor).reverse(),
      {
        digest: digest("e"),
        platform: { os: "unknown", architecture: "unknown" },
        annotations: { "vnd.docker.reference.type": "attestation-manifest" },
      },
    ],
    annotations: {
      "org.opensource-repo-manager.publication": JSON.stringify({
        version: 2,
        source_sha: source,
        release_version: "1.0.0-rc.3",
        platforms: nativeReceipts.map(({ platform, platform_digest }) => ({
          platform,
          platform_digest,
        })),
      }),
    },
  });
  async function select({ env = {}, response = {}, transportError } = {}) {
    const calls = [];
    const result = await run(runtimeScript, {
      context: { repo: { owner: "consumer", repo: "project" } },
      env: {
        ORM_RUNTIME_IMAGE: "",
        ORM_WORKFLOW_JOB: JSON.stringify(identity()),
        GITHUB_JOB: "runtime",
        GITHUB_SHA: sha,
        ...env,
      },
      executor: {
        getExecOutput: async (...args) => {
          calls.push(args);
          if (transportError) throw transportError;
          return {
            exitCode: 0,
            stdout: JSON.stringify(manifest()),
            stderr: "",
            ...response,
          };
        },
      },
    });
    return { ...result, calls };
  }
  const failure = (result) => {
    expect(result.outputs).toEqual({});
    expect(result.failures).toHaveLength(1);
    return JSON.parse(result.failures[0]);
  };
  it("resolves within the called workflow without nesting, forwarding configuration or increasing permissions", () => {
    expect(document.jobs.runtime).toMatchObject({
      permissions: { contents: "read" },
      "runs-on": "${{ inputs.runner }}",
      "timeout-minutes": 10,
      outputs: {
        "runtime-image": "${{ steps.runtime.outputs.runtime-image }}",
      },
    });
    expect(document.jobs.runtime.secrets).toBeUndefined();
    const selectionStep = step(
      document.jobs.runtime,
      "Resolve the workflow runtime",
    );
    expect(selectionStep.env).toEqual({
      ORM_RUNTIME_IMAGE: "${{ inputs.runtime-image }}",
      ORM_WORKFLOW_JOB: "${{ toJSON(job) }}",
    });
    expect(document.on.workflow_call.inputs["runtime-image"]).toMatchObject({
      type: "string",
      required: false,
      default: "",
    });
    expect(Object.values(document.jobs).filter((job) => job.uses)).toHaveLength(
      0,
    );
    expect(maintenance.jobs.resolve.needs).toBe("runtime");
    expect(maintenance.jobs.resolve.outputs["runtime-image"]).toBe(
      "${{ needs.runtime.outputs.runtime-image }}",
    );
    expect(
      step(maintenance.jobs.resolve, "Route through the pinned controller").env
        .ORM_RUNTIME_IMAGE,
    ).toBe("${{ needs.runtime.outputs.runtime-image }}");
    expect(
      step(maintenance.jobs.maintenance, "Execute the bounded maintenance task")
        .env.ORM_RUNTIME_IMAGE,
    ).toBe("${{ needs.resolve.outputs.runtime-image }}");
    expect(aiTest.jobs.test.needs).toBe("runtime");
    expect(
      step(aiTest.jobs.test, "Test one AI response").env.ORM_RUNTIME_IMAGE,
    ).toBe("${{ needs.runtime.outputs.runtime-image }}");
  });
  for (const ref of [
    "refs/tags/v1-prerelease",
    "refs/tags/v1",
    "refs/tags/v1.0.0-rc.3",
    "refs/tags/v1.0.0",
    source,
  ])
    it(`selects the loaded workflow source for ${ref}, independently of caller and alias revisions`, async () => {
      const result = await select({
        env: { ORM_WORKFLOW_JOB: JSON.stringify(identity(ref)) },
      });
      expect(result.failures).toEqual([]);
      expect(result.outputs).toEqual({
        "runtime-image": `${image}@${digest("f")}`,
      });
      expect(result.calls).toEqual([
        [
          "timeout",
          [
            "--kill-after=5s",
            "60s",
            "docker",
            "buildx",
            "imagetools",
            "inspect",
            `${image}:sha-${source}`,
            "--format",
            "{{json .Manifest}}",
          ],
          { silent: true, ignoreReturnCode: true },
        ],
      ]);
      const resolved = result.notices
        .map(JSON.parse)
        .find((record) => record.event === "runtime.resolved");
      expect(resolved).toMatchObject({
        level: "info",
        repository: "consumer/project",
        run_id: 123,
        attempt: 1,
        job: "runtime",
        check_run_id: 456,
        mode: "default",
        timeout_ms: 60000,
        workflow_sha: source,
        workflow_ref: identity(ref).workflow_ref,
        runtime_image: result.outputs["runtime-image"],
        release_version: "1.0.0-rc.3",
      });
      expect(resolved.elapsed_ms).toBeGreaterThanOrEqual(0);
    });
  for (const override of [
    `${image}@${digest("a")}`,
    `registry.example:5000/custom/runtime@${digest("b")}`,
  ])
    it(`preserves explicit override ${override} without job identity or registry lookup`, async () => {
      const result = await select({
        env: { ORM_RUNTIME_IMAGE: override, ORM_WORKFLOW_JOB: "unavailable" },
      });
      expect(result.failures).toEqual([]);
      expect(result.outputs["runtime-image"]).toBe(override);
      expect(result.calls).toEqual([]);
      expect(result.notices.map(JSON.parse).at(-1)).toMatchObject({
        event: "runtime.resolved",
        mode: "override",
      });
    });
  for (const override of [
    "latest",
    "ghcr.io/owner/runtime:latest",
    "ghcr.io/owner/runtime@sha256:short",
    "bad-secret-canary; unsafe",
  ])
    it(`rejects invalid override ${override} without echoing the value or looking up a default`, async () => {
      const result = await select({ env: { ORM_RUNTIME_IMAGE: override } });
      expect(failure(result)).toMatchObject({
        event: "runtime.failed",
        level: "error",
        stage: "input",
        cause: { content: "runtime-image must be pinned by digest." },
      });
      expect(result.calls).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(override);
    });
  for (const value of [
    undefined,
    "{identity-secret-canary",
    "null",
    "[]",
    JSON.stringify({ ...identity(), workflow_repository: "consumer/project" }),
    JSON.stringify({
      ...identity(),
      workflow_file_path: ".github/workflows/caller.yml",
    }),
    JSON.stringify({
      ...identity(),
      workflow_ref: "consumer/project/.github/workflows/caller.yml@main",
    }),
    JSON.stringify({ ...identity(), workflow_sha: undefined }),
    JSON.stringify({ ...identity(), workflow_sha: source + "\n" }),
  ])
    it(`rejects unavailable or invalid called-workflow identity ${value} without caller-SHA fallback`, async () => {
      const result = await select({ env: { ORM_WORKFLOW_JOB: value } });
      expect(failure(result)).toMatchObject({
        stage: "identity",
        mode: "default",
      });
      expect(result.calls).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("identity-secret-canary");
    });
  for (const [exitCode, stderr, cause] of [
    [1, "manifest unknown: image not found", "Registry inspection failed."],
    [124, "", "Registry inspection timed out."],
    [137, "inspection killed after deadline", "Registry inspection timed out."],
  ])
    it(`reports registry exit ${exitCode} with correlation and corrective action without retry`, async () => {
      const result = await select({ response: { exitCode, stderr } });
      expect(failure(result)).toMatchObject({
        event: "runtime.failed",
        level: "error",
        stage: "registry",
        repository: "consumer/project",
        run_id: 123,
        attempt: 1,
        check_run_id: 456,
        workflow_sha: source,
        reference: `${image}:sha-${source}`,
        provider_status: exitCode,
        provider_error: { content: stderr, omitted_bytes: 0 },
        cause: { content: cause },
      });
      expect(failure(result).recovery).toContain(
        "publication for this workflow commit",
      );
      expect(result.calls).toHaveLength(1);
    });
  it("reports a registry executable failure without issuing another request", async () => {
    const result = await select({
      transportError: new Error("Unable to locate executable file: timeout"),
    });
    expect(failure(result)).toMatchObject({
      stage: "registry",
      cause: { content: "Unable to locate executable file: timeout" },
    });
    expect(result.calls).toHaveLength(1);
  });
  it("retains invalid manifest evidence and reports oversized captures explicitly", async () => {
    const invalid = await select({
      response: { stdout: "{invalid-public-manifest" },
    });
    expect(failure(invalid)).toMatchObject({
      stage: "manifest",
      observed: {
        manifest_capture: {
          content: "{invalid-public-manifest",
          omitted_bytes: 0,
        },
      },
    });
    const oversized = await select({
      response: { stdout: "x".repeat(64 * 1024 + 1) },
    });
    expect(failure(oversized).observed.manifest_capture).toMatchObject({
      bytes: 64 * 1024 + 1,
      omitted_bytes: 1,
    });
    expect(failure(oversized).cause.content).toContain("64 KiB");
    const provider = await select({
      response: { exitCode: 1, stderr: "é".repeat(9000) + "tail" },
    });
    const captured = failure(provider).provider_error;
    expect(Buffer.byteLength(captured.content)).toBeLessThanOrEqual(16 * 1024);
    expect(captured.bytes - Buffer.byteLength(captured.content)).toBe(
      captured.omitted_bytes,
    );
    expect(captured.omitted_bytes).toBeGreaterThan(0);
  });
  const corruptions = [
    [
      "missing annotation",
      (value) => {
        value.annotations = {};
      },
    ],
    [
      "malformed proof",
      (value) => {
        value.annotations["org.opensource-repo-manager.publication"] =
          "{invalid-public-proof";
      },
    ],
    [
      "invalid index digest",
      (value) => {
        value.digest = "sha256:short";
      },
    ],
    [
      "wrong source",
      (value, proof) => {
        proof.source_sha = sha;
      },
    ],
    [
      "unsupported proof version",
      (value, proof) => {
        proof.version = 1;
      },
    ],
    [
      "missing native proof",
      (value, proof) => {
        proof.platforms.pop();
      },
    ],
    [
      "duplicate native proof",
      (value, proof) => {
        proof.platforms[1] = proof.platforms[0];
      },
    ],
    [
      "invalid native digest",
      (value, proof) => {
        proof.platforms[0].platform_digest = "sha256:short";
      },
    ],
    [
      "missing manifest",
      (value) => {
        value.manifests.pop();
        value.manifests.pop();
      },
    ],
    [
      "extra runnable manifest",
      (value) => {
        value.manifests.push(descriptor(nativeReceipts[0]));
      },
    ],
    [
      "mismatched native digest",
      (value) => {
        value.manifests[0].digest = digest("e");
      },
    ],
    [
      "missing index",
      (value) => {
        delete value.manifests;
      },
    ],
    ...["1.0.0-rc.0", "01.0.0", "1.0.0\n", "1.0.9007199254740992"].map(
      (version) => [
        `invalid version ${JSON.stringify(version)}`,
        (value, proof) => {
          proof.release_version = version;
        },
      ],
    ),
  ];
  for (const [name, corrupt] of corruptions)
    it(`rejects ${name} before producing an image reference`, async () => {
      const value = manifest();
      const proof = JSON.parse(
        value.annotations["org.opensource-repo-manager.publication"],
      );
      corrupt(value, proof);
      if (
        value.annotations["org.opensource-repo-manager.publication"] ===
        manifest().annotations["org.opensource-repo-manager.publication"]
      )
        value.annotations["org.opensource-repo-manager.publication"] =
          JSON.stringify(proof);
      const result = await select({
        response: { stdout: JSON.stringify(value) },
      });
      expect(failure(result)).toMatchObject({
        stage: "proof",
        expected: {
          source_sha: source,
          proof_version: 2,
          platforms: ["linux/amd64", "linux/arm64"],
        },
      });
      expect(result.calls).toHaveLength(1);
      expect(
        result.notices
          .map(JSON.parse)
          .find((record) => record.event === "runtime.manifest").manifest,
      ).toEqual(value);
    });
  it("uses the selected digest for routing, every maintenance issue and the configured AI role", async () => {
    const selected = await select();
    const selectedImage = selected.outputs["runtime-image"];
    const env = {
      ORM_RUNTIME_IMAGE: selectedImage,
      ORM_BOOTSTRAP_GITHUB_TOKEN: "bootstrap-secret-canary",
      ORM_CONFIGURATION_SECRETS: "{}",
      ORM_CONFIGURATION_VARIABLES: "{}",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "consumer/project",
      GITHUB_REPOSITORY_ID: "42",
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: sha,
      ACTIONS_RUNTIME_TOKEN: "artifact-secret-canary",
      ACTIONS_RESULTS_URL: "https://results.actions.githubusercontent.com/",
      GITHUB_EVENT_PATH: "/runner/event.json",
      GITHUB_JOB: "consume",
    };
    const consumed = [];
    const invoke = async (script, result, extra = {}, context = {}) => {
      const executed = await run(script, {
        env: { ...env, ...extra },
        context,
        executor: {
          exec: async (command, args) => {
            if (args[0] === "pull") consumed.push(args[1]);
          },
          getExecOutput: async () => ({
            exitCode: 0,
            stdout: JSON.stringify(result),
            stderr: "",
          }),
        },
      });
      expect(executed.failures).toEqual([]);
      expect(
        executed.notices
          .map(JSON.parse)
          .find((record) => record.event === "runtime.used").runtime_image,
      ).toBe(selectedImage);
      expect(JSON.stringify(executed.notices)).not.toContain("secret-canary");
      return executed;
    };
    const routed = await invoke(
      step(maintenance.jobs.resolve, "Route through the pinned controller").with
        .script,
      { version: 1, repository_id: 42, issues: [7, 9] },
    );
    for (const issue of JSON.parse(routed.outputs.issues))
      await invoke(
        step(
          maintenance.jobs.maintenance,
          "Execute the bounded maintenance task",
        ).with.script,
        { version: 1, outcome: "waiting", reason: "remote_checks" },
        { ORM_SELECTED_ISSUE: String(issue) },
      );
    await invoke(
      aiTestScript,
      { version: 1, outcome: "completed", cleanup: "passed" },
      { ORM_TEST_ROLE: "audit" },
      {
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        payload: { repository: { default_branch: "main" } },
      },
    );
    expect(consumed).toEqual(Array(4).fill(selectedImage));
    expect(selected.calls).toHaveLength(1);
  });
});

const aiTestScript = step(aiTest.jobs.test, "Test one AI response").with.script;
const aiTestCleanup = step(aiTest.jobs.test, "Remove the AI test container")
  .with.script;
describe("manual consumer AI test", () => {
  const env = {
    ORM_RUNTIME_IMAGE: `${image}@${digest("a")}`,
    ORM_TEST_ROLE: "audit",
  };
  const context = {
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    payload: { repository: { default_branch: "main" } },
  };
  it("exposes configured-role selection and forwards the existing configuration sources", async () => {
    expect(Object.keys(aiTest.on)).toEqual(["workflow_call"]);
    expect(aiTest.on.workflow_call.inputs.role.default).toBe("implementation");
    expect(aiTest.permissions).toEqual({ contents: "read" });
    const caller = parse(
      await readFile(
        new URL("../examples/actions/test-ai.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(Object.keys(caller.on)).toEqual(["workflow_dispatch"]);
    expect(caller.jobs.test.uses).toBe(
      "markhuangai/opensource-repo-manager/.github/workflows/test-ai.yml@v1-prerelease",
    );
    expect(caller.jobs.test.with["runtime-image"]).toBeUndefined();
    expect(caller.jobs.test.secrets.ORM_CONFIGURATION_VARIABLES).toBe(
      "${{ toJSON(vars) }}",
    );
    const calls = [];
    const result = await run(aiTestScript, {
      context,
      env,
      executor: {
        exec: async (...args) => calls.push(args),
        getExecOutput: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            version: 1,
            outcome: "completed",
            reason: "ai_interaction_completed",
            cleanup: "passed",
          }),
          stderr: "",
        }),
      },
    });
    expect(calls[1][1].slice(-2)).toEqual(["test-ai", "audit"]);
    expect(calls[1][1]).toContain("ORM_CONFIGURATION_SECRETS");
    expect(result.failures).toEqual([]);
    expect(result.summaries[0].runtime_image).toBe(env.ORM_RUNTIME_IMAGE);
  });
  for (const override of [
    { eventName: "pull_request" },
    { ref: "refs/heads/feature" },
  ])
    it("rejects non-manual or non-default-branch callers before starting a container", async () => {
      await expect(
        run(aiTestScript, { context: { ...context, ...override }, env }),
      ).rejects.toThrow();
    });
  it("reports failed interaction and refuses cleanup of another run's container", async () => {
    const result = await run(aiTestScript, {
      context,
      env,
      executor: {
        exec: async () => {},
        getExecOutput: async () => ({
          exitCode: 1,
          stdout: JSON.stringify({
            version: 1,
            outcome: "failed",
            reason: "ai_test_timeout",
            cleanup: "passed",
          }),
          stderr: "",
        }),
      },
    });
    expect(result.failures).toEqual(["AI test stopped: ai_test_timeout"]);
    await expect(
      run(aiTestCleanup, {
        context,
        env,
        executor: {
          getExecOutput: async () => ({
            exitCode: 0,
            stdout: "another-run",
            stderr: "",
          }),
        },
      }),
    ).rejects.toThrow("ownership is unverified");
  });
});
