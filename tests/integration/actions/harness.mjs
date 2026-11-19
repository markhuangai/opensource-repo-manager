import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

export async function runActionsTests({
  sdk,
  group,
  cpuSet,
  manager,
  upstreamName,
  data,
  freshData,
  directory,
  eventDirectory,
  image,
  net,
  label,
  id,
  docker,
  result,
  register,
  sessionFixtures,
}) {
  const node = "/opt/orm-runtime/bin/node";
  const config = JSON.parse(
    await readFile(join(directory, "configuration.json"), "utf8"),
  );
  const toolchainCache = JSON.parse(
    await readFile(join(directory, "toolchain-cache.json"), "utf8"),
  );
  const completed = [];
  const resourceSamples = [];
  const diagnosticEvents = [];
  const originalSecrets = {
    ORM_GITHUB_TOKEN: config.github.token,
    ORM_SESSION_KEY: config.session_key,
  };
  let sequence = 0;
  const seeded = new Set();
  const logs = [];
  const upstream = (path, body) =>
    JSON.parse(
      docker([
        "exec",
        upstreamName,
        node,
        "-e",
        `fetch("http://localhost:8317"+process.argv[1],
      process.argv[2] ? {method:"POST",body:process.argv[2]} : {}).then(async r=>{
        const text=await r.text();
        if(!r.ok) throw Error(text); console.log(text);
      })`,
        path,
        ...(body ? [JSON.stringify(body)] : []),
      ]),
    );
  const setup = (issue, mode) => upstream(`/seed?issue=${issue}&mode=${mode}`);
  const proof = (issue) => upstream(`/proof?issue=${issue}`);
  const pending = (issue) => upstream(`/pending?issue=${issue}`);
  async function container(
    args,
    environment = {},
    {
      fresh = false,
      main = false,
      expected = 0,
      secrets = originalSecrets,
      mounts = [],
    } = {},
  ) {
    const name = `${manager}-${++sequence}`;
    register("container", name);
    const run = fresh ? 101 : 100;
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_REPOSITORY_ID: "42",
      GITHUB_RUN_ID: String(run),
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: "f".repeat(40),
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      ACTIONS_RUNTIME_TOKEN: config.artifact_tokens[run],
      ACTIONS_RESULTS_URL:
        "https://results-receiver.actions.githubusercontent.com/",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
      ...(main
        ? { ORM_SESSION_KEY: config.session_key }
        : {
            ORM_BOOTSTRAP_GITHUB_TOKEN: config.bootstrap_token,
            ORM_CONFIGURATION_VARIABLES: "{}",
            ORM_CONFIGURATION_SECRETS: JSON.stringify(secrets),
          }),
      ...environment,
    };
    const state = result(
      [
        "run",
        "--name",
        name,
        "--label",
        `${label}=${id}`,
        "--network",
        net,
        "--cpuset-cpus",
        cpuSet,
        "--no-healthcheck",
        "--mount",
        `type=volume,src=${fresh ? freshData : data},dst=/data`,
        "--mount",
        `type=bind,src=${join(directory, "ca-bundle.pem")},dst=/etc/ssl/certs/ca-certificates.crt,readonly`,
        ...mounts.flatMap((mount) => ["--mount", mount]),
        ...Object.entries(env).flatMap(([key, value]) => [
          "--env",
          `${key}=${value}`,
        ]),
        ...(main
          ? [
              ...["config", "prompts", "skills"].flatMap((item) => [
                "--mount",
                `type=bind,src=${join(directory, item)},dst=/${item},readonly`,
              ]),
              image,
            ]
          : [
              "--entrypoint",
              "/usr/bin/tini",
              image,
              "--",
              node,
              "/opt/orm/app/dist/actions/controller.js",
            ]),
        ...args,
      ],
      { timeout: 120_000 },
    );
    logs.push(state.stderr);
    assert.equal(state.status, expected, state.stdout + state.stderr);
    for (const secret of [
      config.github.token,
      config.session_key,
      config.bootstrap_token,
      ...Object.values(config.artifact_tokens),
    ])
      assert(
        !(state.stdout + state.stderr).includes(secret),
        "Credential in task output",
      );
    const [inspection] = JSON.parse(docker(["container", "inspect", name]));
    assert.equal(inspection.State.Running, false);
    assert.equal(inspection.State.OOMKilled, false);
    assert.equal(inspection.State.Pid, 0);
    assert.equal(inspection.HostConfig.CpusetCpus, cpuSet);
    assert.equal(Object.keys(inspection.NetworkSettings.Ports ?? {}).length, 0);
    if (!resourceSamples.length)
      resourceSamples.push({
        id: name,
        observed_at: new Date().toISOString(),
        cpu_set: inspection.HostConfig.CpusetCpus,
      });
    return JSON.parse(state.stdout.trim());
  }
  const invoke = (issue, options) => {
    const volume = options?.fresh ? freshData : data;
    const key = `${volume}/${issue}`;
    if (!seeded.has(key)) {
      seeded.add(key);
      docker([
        "run",
        "--rm",
        "--name",
        `${manager}-cache-${++sequence}`,
        "--label",
        `${label}=${id}`,
        "--network",
        "none",
        "--mount",
        `type=volume,src=${volume},dst=/data`,
        "--mount",
        `type=bind,src=${directory},dst=/fixture,readonly`,
        "--mount",
        `type=bind,src=${sessionFixtures},dst=/actions-fixtures,readonly`,
        "--entrypoint",
        node,
        image,
        "/actions-fixtures/toolchain-cache.mjs",
        "seed",
        String(issue),
      ]);
    }
    return container(
      options?.main ? [String(issue)] : ["run", String(issue)],
      {},
      options,
    );
  };
  const native = (entry, attempt = 1, override = {}) =>
    container(
      [
        "authorize-agent",
        String(
          entry.turn.issue ??
            Number(entry.run.display_title.split("#")[1].split(" ")[0]),
        ),
      ],
      {
        GITHUB_RUN_ID: String(entry.run.id),
        GITHUB_RUN_ATTEMPT: String(attempt),
        ORM_AGENT_TURN: entry.turn.id,
        ORM_AGENT_PLAN: entry.plan,
        ...override,
      },
      { expected: attempt !== 1 || Object.keys(override).length ? 1 : 0 },
    );
  async function route(run) {
    const path = join(eventDirectory, `event-${run.id}.json`);
    await writeFile(
      path,
      JSON.stringify({
        repository: run.repository,
        action: "completed",
        workflow_run: run,
      }),
    );
    return container(
      ["route"],
      { GITHUB_EVENT_NAME: "workflow_run", GITHUB_EVENT_PATH: "/event.json" },
      {
        mounts: [`type=bind,src=${path},dst=/event.json,readonly`],
      },
    );
  }
  async function advance(issue, turn, onTurn, options) {
    const selection = await native(turn);
    assert.equal(selection.runner, turn.turn.runner);
    assert.equal(selection.write, Boolean(turn.turn.work_branch));
    if (turn.turn.role === "implementation")
      assert.equal(selection.runner, sdk);
    if (turn.turn.role === "audit") assert.notEqual(selection.runner, sdk);
    await onTurn?.(turn, selection);
    upstream(`/complete?run=${turn.run.id}`, selection);
    assert.deepEqual((await route(turn.run)).issues, [issue]);
    return invoke(issue, options);
  }
  async function drain(issue, outcome, options = {}) {
    let result = outcome ?? (await invoke(issue, options));
    for (
      let step = 0;
      result.reason === "agent_run" || result.reason === "retry_scheduled";
      step++
    ) {
      assert(step < 36, "issue never left the agent phase");
      if (result.reason === "retry_scheduled") {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, result.retry_at - Date.now())),
        );
        result = await invoke(issue, options);
        continue;
      }
      const runs = pending(issue);
      assert.equal(runs.length, 1, JSON.stringify(proof(issue).events));
      result = await advance(issue, runs[0], options.onTurn, options);
    }
    return result;
  }
  async function scenario(name, run) {
    const started = performance.now();
    const actual = await run();
    completed.push({
      id: name,
      outcome: actual?.outcome ?? "passed",
      duration_ms: performance.now() - started,
    });
  }
  const nativeEvents = (issue, task) =>
    proof(issue).events.filter(
      (row) => row.type === "complete" && row.task === task,
    );
  function assertPublished(issue, outcome) {
    assert.equal(outcome.reason, "remote_checks");
    const evidence = proof(issue);
    const [pull] = evidence.pulls;
    assert.equal(evidence.pulls.length, 1);
    assert.equal(pull.draft, false);
    const [change] = nativeEvents(issue, "implementation_change").slice(-1);
    const [audit] = nativeEvents(issue, "implementation_audit").slice(-1);
    assert.equal(change.head, audit.start);
    assert.equal(audit.head, pull.head);
    assert.equal(pull.head, outcome.head_sha);
    assert.equal(evidence.work_heads[change.branch], pull.head);
    assert.match(pull.body, /Supervisor verification.*UID 10002/);
    assert.equal(evidence.errors.length, 0, JSON.stringify(evidence.errors));
    return pull;
  }

  if (group === "lifecycle") {
    await scenario("publication", async () => {
      setup(1, "reproduced");
      setup(99, "unrelated");
      const status = await drain(1);
      assertPublished(1, status);
      const unrelated = proof(99);
      assert.deepEqual(unrelated.comments, []);
      assert.deepEqual(unrelated.pulls, []);
      assert.deepEqual(unrelated.events, []);
      return status;
    });
    await scenario("ready", async () => {
      upstream("/checks?issue=1");
      const status = await drain(1);
      assert.equal(status.reason, "human_review");
      assert.equal(status.head_sha, proof(1).pulls[0].head);
      return status;
    });
    await scenario("audit-rejection", async () => {
      setup(2, "audit_rejection");
      const status = await drain(2);
      assertPublished(2, status);
      const audits = nativeEvents(2, "implementation_audit");
      assert.equal(audits.length, 2);
      assert.notEqual(audits[0].head, status.head_sha);
      return status;
    });
    await scenario("missing-push", async () => {
      setup(3, "missing_push");
      let status = await invoke(3);
      for (
        let count = 0;
        count < 25 &&
        !logs.some((line) => line.includes('"event":"agent.push_missing"'));
        count++
      ) {
        const [turn] = pending(3);
        assert(turn);
        status = await advance(3, turn);
      }
      assert(
        logs.some((line) => line.includes('"event":"agent.push_missing"')),
      );
      assert.equal(nativeEvents(3, "implementation_audit").length, 0);
      assert.equal(proof(3).pulls.length, 0);
      return status;
    });
    await scenario("moved-head", async () => {
      setup(4, "moved_head");
      const status = await drain(4);
      assertPublished(4, status);
      const moved = proof(4).events.find((row) => row.type === "move");
      const audits = nativeEvents(4, "implementation_audit");
      assert.equal(audits.length, 2);
      const failure = logs
        .flatMap((line) => line.split("\n"))
        .filter((line) => line.startsWith("{"))
        .map(JSON.parse)
        .find((line) => line.event === "agent.stale_audit");
      assert.equal(failure.expected_sha, audits[0].head);
      assert.equal(failure.observed_sha, moved.head);
      assert.equal(failure.run_id, audits[0].run);
      assert.equal(failure.run_attempt, 1);
      assert.equal(failure.issue_number, 4);
      assert.equal(failure.phase, "implementation");
      assert.notEqual(failure.runner, sdk);
      assert.equal(failure.level, "error");
      assert(Number.isFinite(failure.elapsed_ms));
      assert(Number.isFinite(failure.remaining_active_ms));
      assert(failure.recovery.includes("new audit and test"));
      diagnosticEvents.push(failure);
      return status;
    });
  }
  if (group === "sessions") {
    await scenario("fresh-container", async () => {
      setup(1, "source_only");
      const first = await invoke(1);
      assert.equal(first.reason, "agent_run");
      const [turn] = pending(1);
      const status = await drain(
        1,
        await advance(1, turn, undefined, { fresh: true }),
        { fresh: true },
      );
      assertPublished(1, status);
      assert.equal(status.task_id, first.task_id);
      assert.equal(
        proof(1).events.filter((event) => event.turn === turn.turn.id).length,
        1,
      );
      assert(
        proof(1).artifacts.some(
          (artifact) =>
            artifact.workflow_run.id === 101 && artifact.name.endsWith(".orm"),
        ),
      );
      assert(
        proof(1).artifacts.some((artifact) =>
          artifact.name.startsWith("orm-agent-input-"),
        ),
      );
      return status;
    });
    await scenario("corrupt-checkpoint", async () => {
      setup(2, "source_only");
      const first = await invoke(2);
      assert.equal(first.reason, "agent_run");
      const latest = proof(2).artifacts.findLast((artifact) =>
        artifact.name.endsWith(".orm"),
      );
      upstream(`/fault?artifact=${latest.id}&kind=corrupt`);
      const status = await invoke(2, { fresh: true, expected: 1 });
      assert.equal(status.reason, "session_corrupt");
      assert.equal(pending(2).length, 1);
      return status;
    });
  }
  if (group === "pr-recovery") {
    await scenario("repair-handoff", async () => {
      setup(1, "monitor_repair");
      const initial = assertPublished(1, await drain(1));
      upstream("/checks?issue=1&repair=true");
      const status = await drain(1, undefined, {
        onTurn(turn) {
          if (turn.turn.role === "audit")
            assert.equal(proof(1).pulls[0].head, initial.head);
        },
      });
      const repaired = assertPublished(1, status);
      assert.equal(repaired.number, initial.number);
      assert.notEqual(repaired.head, initial.head);
      return status;
    });
    await scenario("cancel-stale-repair", async () => {
      setup(3, "monitor_repair");
      const original = assertPublished(3, await drain(3));
      upstream("/checks?issue=3&repair=true");
      let status = await invoke(3);
      let repair = null;
      for (let count = 0; count < 24; count++) {
        assert.equal(status.reason, "agent_run");
        const [turn] = pending(3);
        assert(turn);
        if (turn.turn.work_branch) {
          repair = turn;
          break;
        }
        status = await advance(3, turn);
      }
      assert(repair);
      assert.equal(repair.turn.starting_sha, original.head);
      await native(repair);
      upstream(`/start?run=${repair.run.id}`);
      const moved = upstream("/move-owned?issue=3");
      const preflight = await native(repair, 1, {
        ORM_AGENT_PLAN: repair.plan,
      });
      assert.equal(preflight.reason, "agent_revision_superseded");
      assert.equal((await invoke(3, { fresh: true })).reason, "agent_run");
      status = await invoke(3, { fresh: true, expected: 1 });
      assert.equal(status.reason, "state_conflict");
      const evidence = proof(3);
      assert.equal(evidence.pulls.length, 1);
      assert.equal(evidence.pulls[0].head, moved.head);
      assert.equal(
        evidence.events.filter(
          (event) => event.type === "cancel" && event.run === repair.run.id,
        ).length,
        1,
      );
      const late = {
        ...repair.run,
        status: "completed",
        conclusion: "success",
      };
      assert.deepEqual((await route(late)).issues, []);
      assert.equal(nativeEvents(3, "implementation_audit").length, 1);
      return status;
    });
    await scenario("expired-owned-checkpoint", async () => {
      setup(2, "source_only");
      const first = assertPublished(2, await drain(2));
      const latest = proof(2).artifacts.findLast((artifact) =>
        artifact.name.endsWith(".orm"),
      );
      upstream(`/fault?artifact=${latest.id}&kind=expired`);
      const status = await drain(2, undefined, { fresh: true });
      assert.equal(status.head_sha, first.head);
      assert.equal(proof(2).pulls.length, 1);
      const latestAudit = nativeEvents(2, "implementation_audit").at(-1);
      assert.equal(latestAudit.start, first.head);
      return status;
    });
  }
  if (group === "clarification") {
    await scenario("authorized-reply", async () => {
      setup(1, "clarification");
      const waiting = await drain(1);
      assert.equal(waiting.reason, "needs_information");
      const before = proof(1).events.length;
      upstream("/reply?issue=1&allowed=false");
      assert.equal(
        (await invoke(1, { fresh: true })).reason,
        "needs_information",
      );
      assert.equal(proof(1).events.length, before);
      upstream("/reply?issue=1&allowed=true");
      const status = await drain(1, undefined, { fresh: true });
      assertPublished(1, status);
      return status;
    });
    await scenario("feature-remains-manual", async () => {
      setup(2, "manual_feature");
      const status = await drain(2);
      assert.equal(status.reason, "manual_feature");
      assert.equal(nativeEvents(2, "implementation_change").length, 0);
      return status;
    });
  }
  if (group === "clarification-recovery") {
    await scenario("ambiguous-dispatch", async () => {
      setup(1, "dispatch_response_lost");
      const first = await invoke(1);
      assert.equal(first.reason, "agent_run");
      const [turn] = pending(1);
      assert(turn);
      assert.equal((await invoke(1, { fresh: true })).reason, "agent_run");
      assert.equal(pending(1).length, 1);
      assert.equal(
        proof(1).events.filter((event) => event.type === "dispatch").length,
        1,
      );
      const rerun = await native(turn, 2);
      assert.equal(rerun.outcome, "failed");
      const duplicate = upstream(`/duplicate?run=${turn.run.id}`);
      const denied = await native(duplicate, 1, {
        ORM_AGENT_PLAN: duplicate.plan,
      });
      assert.equal(denied.reason, "agent_run_mismatch");
      upstream(`/discard-duplicate?run=${duplicate.run.id}`);
      const wrongPlan = await native(turn, 1, {
        ORM_AGENT_PLAN: "Substituted instructions.",
      });
      assert.equal(wrongPlan.reason, "agent_request_unauthorized");
      const status = await drain(1, undefined, { fresh: true });
      assertPublished(1, status);
      return status;
    });
    await scenario("cancel-superseded", async () => {
      setup(2, "source_only");
      const first = await invoke(2);
      assert.equal(first.reason, "agent_run");
      assert.equal(pending(2).length, 1);
      upstream("/close?issue=2");
      assert.equal((await invoke(2, { fresh: true })).reason, "agent_run");
      const status = await invoke(2, { fresh: true });
      assert.equal(status.reason, "issue_closed");
      assert.equal(
        proof(2).events.filter((event) => event.type === "cancel").length,
        1,
      );
      assert.equal(pending(2).length, 0);
      return status;
    });
    await scenario("denied-dispatch", async () => {
      const { sha } = setup(3, "denied_dispatch");
      const status = await invoke(3, { expected: 1 });
      const event = logs
        .at(-1)
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map(JSON.parse)
        .find((line) => line.event === "agent.dispatch_failed");
      assert.equal(event.status, 403);
      assert.equal(event.outcome, "denied");
      assert.equal(event.issue_number, 3);
      assert.equal(event.runner, sdk);
      assert.equal(event.phase, "investigation");
      assert.equal(event.expected_sha, sha);
      assert.equal(event.level, "error");
      assert(event.request_id);
      assert(Number.isFinite(event.elapsed_ms));
      assert(Number.isFinite(event.remaining_agent_runs));
      assert(event.recovery.includes("Actions write"));
      assert.equal(pending(3).length, 0);
      diagnosticEvents.push(event);
      return status;
    });
  }
  return {
    actions: "passed",
    sdk,
    group,
    cpu_set: cpuSet,
    completed_scenarios: completed,
    diagnostic_events: diagnosticEvents,
    resource_samples: resourceSamples,
    toolchain_cache: toolchainCache,
    credential_exclusion: "passed",
    no_public_listener: "passed",
    unrelated_issue: "untouched",
    artifact_transport: proof(1).requests,
    checkpoint_timings: [],
  };
}
