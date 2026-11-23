import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { StateCodec } from "../../../src/actions/state.ts";

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
  waitForContainer,
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
    const sample = !resourceSamples.length;
    let state = result(
      [
        "run",
        ...(sample ? ["--detach"] : []),
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
    if (sample) {
      assert.equal(
        state.status,
        0,
        "Could not start the Actions task container",
      );
      const status = await waitForContainer(name, {
        timeout: 120_000,
        sample: () => {
          if (resourceSamples.length) return;
          const output = docker([
            "stats",
            "--no-stream",
            "--format",
            "{{json .}}",
            name,
          ]);
          if (!output) return;
          const stats = JSON.parse(output);
          if (parseFloat(stats.MemUsage) > 0)
            resourceSamples.push({
              observed_at: new Date().toISOString(),
              ...stats,
            });
        },
      });
      const output = result(["logs", name]);
      assert.equal(output.status, 0, "Could not read the Actions task output");
      state = { ...output, status };
    }
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
    logs.push(state.stderr);
    assert.equal(state.status, expected, state.stdout + state.stderr);
    const [inspection] = JSON.parse(docker(["container", "inspect", name]));
    assert.equal(inspection.State.Running, false);
    assert.equal(inspection.State.OOMKilled, false);
    assert.equal(inspection.State.Pid, 0);
    assert.equal(inspection.HostConfig.CpusetCpus, cpuSet);
    assert.equal(Object.keys(inspection.NetworkSettings.Ports ?? {}).length, 0);
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
  const native = (
    entry,
    attempt = 1,
    override = {},
    expected = attempt !== 1 || Object.keys(override).length ? 1 : 0,
  ) =>
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
      { expected },
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
      assert(runs.length <= 1, JSON.stringify(proof(issue).events));
      result = runs.length
        ? await advance(issue, runs[0], options.onTurn, options)
        : await invoke(issue, options);
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
    const [change] = evidence.events
      .filter(
        (item) =>
          item.type === "complete" &&
          item.branch &&
          item.task === "implementation_change",
      )
      .slice(-1);
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
      const outage = proof(1).events.find(
        (event) => event.type === "collection_unavailable",
      );
      assert(outage);
      assert.equal(
        proof(1).events.filter(
          (event) => event.type === "dispatch" && event.turn === outage.turn,
        ).length,
        1,
      );
      assert(
        logs.some((log) => log.includes('"event":"agent.collection_failed"')),
      );
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
      const { sha } = setup(2, "audit_rejection");
      const status = await drain(2);
      assertPublished(2, status);
      const audits = nativeEvents(2, "implementation_audit");
      assert.equal(audits.length, 2);
      assert.notEqual(audits[0].head, status.head_sha);
      const repairs = nativeEvents(2, "implementation_change");
      assert.equal(repairs[1].start, audits[0].head);
      assert.equal(repairs[1].parent, sha);
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
      const assessment = await invoke(1);
      assert.equal(assessment.reason, "agent_run");
      const [obsolete] = pending(1);
      await native(obsolete);
      upstream(`/start?run=${obsolete.run.id}`);
      upstream("/checks?issue=1&repair=false");
      const retiring = await invoke(1, { fresh: true });
      assert.equal(retiring.reason, "agent_run");
      const ready = await drain(1, undefined, { fresh: true });
      assert.equal(ready.reason, "human_review");
      assert.equal(ready.head_sha, initial.head);
      assert(
        proof(1).events.some(
          (event) => event.type === "cancel" && event.run === obsolete.run.id,
        ),
      );
      upstream("/checks?issue=1&repair=true");
      const status = await drain(1, undefined, {
        fresh: true,
        onTurn(turn) {
          if (turn.turn.role === "audit")
            assert.equal(proof(1).pulls[0].head, initial.head);
        },
      });
      const repaired = assertPublished(1, status);
      assert.equal(repaired.number, initial.number);
      assert.notEqual(repaired.head, initial.head);
      assert.equal(
        nativeEvents(1, "implementation_change").at(-1).parent,
        initial.head,
      );
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
      const events = proof(1).events;
      const queries = nativeEvents(1, "investigation_triage");
      assert.equal(queries.length, 2);
      assert(
        events.some(
          (item) =>
            item.role === "output_review" &&
            item.type === "complete" &&
            item.run > queries[0].run &&
            item.run < queries[1].run,
        ),
      );
      assert(
        events.some(
          (item) =>
            item.type === "native_restore" &&
            item.parent === queries[0].run &&
            item.run === queries[1].run,
        ),
      );
      return status;
    });
    await scenario("feature-remains-manual", async () => {
      setup(2, "manual_feature");
      const status = await drain(2, undefined, { main: true });
      assert.equal(status.outcome, "out_of_scope");
      assert.equal(status.reason, "manual_feature");
      assert.equal(nativeEvents(2, "implementation_change").length, 0);
      return status;
    });
  }
  if (group === "clarification-recovery") {
    await scenario("dispatch-registration", async () => {
      for (const { issue, mode, reads, failure } of [
        { issue: 6, mode: "immediate", reads: 1 },
        { issue: 7, mode: "transient", reads: 2 },
        { issue: 8, mode: "persistent", reads: 5, failure: true },
        { issue: 9, mode: "slow", reads: 2, failure: true },
        { issue: 10, mode: "visibility", reads: 3 },
        { issue: 11, mode: "invisible", reads: 5 },
      ]) {
        setup(issue, `registration_${mode}`);
        const status = await invoke(issue, {
          main: true,
          expected: failure ? 1 : 0,
        });
        assert.equal(status.reason, failure ? "runtime_failed" : "agent_run");
        const [entry] = pending(issue);
        const runId = entry.run.id;
        const log = logs.at(-1);
        const trace = log
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map(JSON.parse);
        const events = proof(issue).events;
        assert.equal(
          events.filter(({ type }) => type === "dispatch").length,
          1,
        );
        assert.deepEqual(
          events
            .filter(({ type }) => type.startsWith("registration_"))
            .map(({ type, run_id }) => [type, run_id]),
          [
            ...Array.from({ length: reads }, () => ["registration_read", null]),
            ...(failure || mode === "invisible"
              ? []
              : [["registration_write", runId]]),
          ],
        );
        // Checkpoint I/O also fetches the controller's own run.
        const requests = trace.filter(
          (line) =>
            line.event === "api.request.started" &&
            line.route !==
              `/repos/owner/repo/actions/runs/${line.workflow_run_id}/attempts/${line.run_attempt}` &&
            /\/actions\/(?:workflows\/[^/]+\/(?:dispatches|runs)|runs\/\d+(?:\/attempts\/\d+)?)$/.test(
              line.route ?? "",
            ),
        );
        const attemptRoute = `/repos/owner/repo/actions/runs/${runId}/attempts/1`;
        assert.deepEqual(
          requests.map(({ method, route }) => `${method} ${route}`),
          [
            "POST /repos/owner/repo/actions/workflows/91/dispatches",
            ...Array.from({ length: reads }, () => `GET ${attemptRoute}`),
          ],
        );
        const mismatches = trace.filter(
          (line) => line.event === "agent.dispatch_run_mismatch",
        );
        const registered = trace.filter(
          (line) => line.event === "agent.dispatch_registered",
        );
        assert.deepEqual(
          registered.map((line) => line.run_id),
          failure || mode === "invisible" ? [] : [runId],
        );
        for (const record of mismatches) {
          assert.equal(record.issue_number, issue);
          assert.equal(record.operation_id, entry.turn.id);
          assert.equal(record.run_id, runId);
          assert.equal(record.reason, "agent_run_mismatch");
          assert(Number.isFinite(record.elapsed_ms));
          assert(Buffer.byteLength(JSON.stringify(record)) <= 2048);
        }
        if (failure) {
          assert.equal(
            trace.find((line) => line.event === "actions.failed").cause,
            "agent_run_mismatch",
          );
          assert.equal(mismatches.at(-1).level, "error");
          assert.equal(mismatches.at(-1).outcome, "exhausted");
        }
        if (mode === "immediate") assert.deepEqual(mismatches, []);
        if (mode === "transient") {
          const [mismatch] = mismatches;
          assert.equal(mismatches.length, 1);
          assert.equal(mismatch.level, "warn");
          assert.equal(mismatch.outcome, "retrying");
          assert.equal(mismatch.verification_attempt, 1);
          assert.equal(mismatch.mismatch_field, "display_title");
          assert.equal(mismatch.expected_value, entry.run.display_title);
          assert.equal(mismatch.observed_value, "ORM agent");
          assert.equal((await native(entry)).runner, sdk);
        }
        if (mode === "persistent") {
          assert.deepEqual(
            mismatches.map((line) => line.verification_attempt),
            [1, 2, 3, 4, 5],
          );
          for (const mismatch of mismatches) {
            assert.equal(mismatch.mismatch_field, "display_title");
            assert.equal(mismatch.expected_value, entry.run.display_title);
            assert.match(
              mismatch.observed_value,
              /^\[omitted \d+ bytes, digest=[a-f0-9]{64}\]$/,
            );
          }
          assert(!log.includes("PRIVATE_TITLE_BODY"));
        }
        if (mode === "slow") {
          assert.deepEqual(
            mismatches.map((line) => line.outcome),
            ["retrying", "exhausted"],
          );
          for (const mismatch of mismatches) {
            assert.equal(mismatch.verification_attempt, 1);
            assert.equal(mismatch.mismatch_field, "id");
            assert.equal(mismatch.expected_value, runId);
            assert.equal(mismatch.observed_value, 9999);
          }
          assert(
            trace.some(
              (line) =>
                line.event === "api.request.failed" &&
                line.route === attemptRoute,
            ),
          );
        }
        if (mode === "visibility" || mode === "invisible") {
          const retries = trace.filter(
            (row) => row.event === "agent.dispatch_run_not_visible",
          );
          assert.equal(retries.length, mode === "visibility" ? 1 : 5);
          assert(
            retries.every(
              (row) =>
                row.level === "warn" &&
                row.status === 404 &&
                row.run_id === runId &&
                row.request_id,
            ),
          );
          if (mode === "invisible") {
            assert.equal(
              (await invoke(issue, { main: true })).reason,
              "agent_run",
            );
            assert.equal(
              proof(issue).events.filter((row) => row.type === "dispatch")
                .length,
              1,
            );
          }
          assert.equal((await native(entry)).runner, sdk);
        }
        diagnosticEvents.push(...mismatches, ...registered);
      }
    });
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
      upstream(`/complete?run=${turn.run.id}`, await native(turn));
      upstream(`/rerun?run=${turn.run.id}`);
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
    await scenario("caller-revision-changed", async () => {
      setup(4, "caller_revision_changed");
      const first = await invoke(4);
      assert.equal(first.reason, "agent_run");
      assert.equal(pending(4).length, 0);
      assert.equal((await invoke(4, { fresh: true })).reason, "agent_run");
      const waiting = await invoke(4, { fresh: true });
      assert.equal(waiting.reason, "agent_run");
      const [authorized] = pending(4);
      assert(authorized);
      await native(authorized);
      const events = proof(4).events;
      assert.equal(
        events.filter((event) => event.type === "dispatch").length,
        2,
      );
      assert.equal(events.filter((event) => event.type === "cancel").length, 1);
      return waiting;
    });
    await scenario("agent-run-limit", async () => {
      setup(5, "source_only");
      assert.equal((await invoke(5)).reason, "agent_run");
      const [first] = pending(5);
      upstream(`/budget?issue=5&used=${config.limits.agent_runs - 1}`);
      const waiting = await advance(5, first, undefined, { fresh: true });
      assert.equal(waiting.reason, "agent_run");
      const [last] = pending(5);
      const blocked = await advance(5, last, undefined, {
        fresh: true,
        expected: 1,
      });
      assert.equal(blocked.reason, "investigation_blocked");
      assert.equal(pending(5).length, 0);
      assert.equal(
        proof(5).events.filter((event) => event.type === "dispatch").length,
        2,
      );
      assert(logs.at(-1).includes("agent_run_limit"));
      return blocked;
    });
  }
  if (group === "managed-recovery") {
    async function untilTurn(issue, status, matches) {
      for (let step = 0; step < 36; step++) {
        assert(
          ["agent_run", "retry_scheduled"].includes(status.reason),
          JSON.stringify(status),
        );
        const runs = pending(issue);
        assert(runs.length <= 1, JSON.stringify(proof(issue).events));
        const [entry] = runs;
        if (entry && matches(entry.turn)) return entry;
        if (status.reason === "retry_scheduled")
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, status.retry_at - Date.now())),
          );
        status = entry ? await advance(issue, entry) : await invoke(issue);
      }
      assert.fail("The expected recovery turn was never scheduled");
    }
    function signedState(issue) {
      const { id, author_id, body } = proof(issue).comments[0];
      return new StateCodec(config.session_key).decode(body, {
        repository_id: 42,
        issue_id: issue + 1000,
        comment_id: id,
        author_id,
      }).state;
    }
    await scenario("checkpoint-acknowledgement", async () => {
      setup(1, "reproduced");
      upstream("/fault?kind=checkpoint_visibility_delay");
      upstream("/fault?kind=checkpoint_lookup_unavailable");
      const registered = await invoke(1);
      assert.equal(registered.reason, "agent_run");
      const readRetries = logs
        .at(-1)
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map(JSON.parse)
        .filter((line) => line.event === "checkpoint.read_retry");
      assert.deepEqual(
        readRetries.map((line) => line.phase),
        ["preflight", "acknowledgement"],
      );
      assert(
        readRetries.every((line) => line.level === "warn" && line.request_id),
      );
      diagnosticEvents.push(...readRetries);
      assert(
        logs.some(
          (log) =>
            log.includes('"event":"checkpoint.visibility"') &&
            log.includes('"level":"warn"'),
        ),
      );

      setup(2, "reproduced");
      upstream("/fault?kind=checkpoint_ack_lost");
      const failed = await invoke(2, { expected: 1 });
      assert.equal(failed.checkpoint_error, "session_upload_uncertain");
      assert.match(
        proof(2).comments[0].body,
        /Controller checkpoint awaiting confirmation/,
      );
      const resumed = await invoke(2, { fresh: true });
      assert.equal(resumed.reason, "agent_run");
      assert.equal(
        proof(2).events.filter((row) => row.type === "dispatch").length,
        1,
      );
      assert.match(logs.at(-1), /"event":"checkpoint.reconciled"/);

      setup(7, "reproduced");
      upstream("/fault?kind=checkpoint_ack_lost");
      await invoke(7, { expected: 1 });
      const orphan = proof(7).artifacts.findLast((artifact) =>
        artifact.name.endsWith(".orm"),
      );
      upstream(`/fault?artifact=${orphan.id}&kind=duplicate`);
      const rejected = await invoke(7, { fresh: true, expected: 1 });
      assert.equal(rejected.reason, "session_provenance_invalid");
      assert.deepEqual(proof(7).events, []);
      return resumed;
    });
    await scenario("conflicting-assessment", async () => {
      setup(16, "conflicting_assessment");
      const conflict = await untilTurn(16, await invoke(16), (turn) =>
        Boolean(turn.assessment),
      );
      const waiting = await advance(16, conflict);
      assert.equal(waiting.reason, "agent_run");
      assert.match(
        logs.at(-1),
        /"event":"agent.result_rejected".*"cause":"agent_artifact_conflict"/,
      );
      const [review] = pending(16);
      assert.equal(review?.turn.role, "output_review");
      const blocked = await advance(16, review, undefined, { expected: 1 });
      assert.equal(blocked.reason, "implementation_blocked");
      assert.match(
        proof(16).comments[0].body,
        /Implementation blocked \(agent_artifact_conflict\)/,
      );
      assert.equal(nativeEvents(16, "implementation_audit").length, 0);
      assert.equal(proof(16).pulls.length, 0);
      assert.equal(
        proof(16).events.filter((item) => item.type === "write_attempt").length,
        1,
      );
      return blocked;
    });
    for (const [issue, mode, name] of [
      [3, "interrupted_coding", "resume-pushed-progress"],
      [4, "expired_coding", "resume-without-conversation"],
      [5, "lost_final_result", "collect-lost-final-result"],
    ])
      await scenario(name, async () => {
        const base = setup(issue, mode);
        let outcome;
        if (mode === "expired_coding") {
          outcome = await drain(issue);
        } else {
          const writer = await untilTurn(issue, await invoke(issue), (turn) =>
            Boolean(
              turn.work_branch && (mode === "lost_final_result" || turn.resume),
            ),
          );
          const selection = await native(writer);
          upstream(`/complete?run=${writer.run.id}`, selection);
          assert.deepEqual((await route(writer.run)).issues, [issue]);
          const [completed] = nativeEvents(issue, "implementation_change");
          const evidence = proof(issue);
          const gitPath = writer.turn.resume
            ? `git/commits/${completed.head}`
            : `compare/${base.sha}...${evidence.work_heads[writer.turn.progress.branch]}`;
          if (writer.turn.resume) {
            assert.equal(selection.resume_run_id, writer.turn.resume.run_id);
            upstream(
              `/fault?artifact=${writer.turn.resume.artifact_id}&kind=expired`,
            );
            const child = evidence.artifacts.find((artifact) =>
              artifact.name.startsWith(
                `remote-dev-session-r${writer.run.id}-a1-`,
              ),
            );
            upstream(`/fault?artifact=${child.id}&kind=hide_once`);
          }
          const options = { fresh: true };
          const collecting = await invoke(issue, options);
          assert.equal(collecting.reason, "agent_run");
          assert.deepEqual(pending(issue), []);
          const before = signedState(issue);
          assert.equal(before.agent_turn.id, writer.turn.id);
          assert.equal(before.agent_turn.collection_retries, 1);
          upstream(`/fail-git-read?path=${gitPath}`);
          const readStartedAt = Date.now();
          const retry = await invoke(issue, options);
          assert.equal(retry.reason, "retry_scheduled");
          assert.deepEqual(pending(issue), []);
          const cause = writer.turn.resume
            ? "github_rate_limited"
            : "github_read_failed";
          const after = signedState(issue);
          assert.equal(
            after.budget.infrastructure_retries,
            before.budget.infrastructure_retries + 1,
          );
          assert.equal(after.budget.agent_runs, before.budget.agent_runs);
          assert.deepEqual(after.agent_turn, {
            ...before.agent_turn,
            collection_retry: { cause, retry_at: retry.retry_at },
          });
          assert(
            retry.retry_at >=
              readStartedAt + (writer.turn.resume ? 5000 : 1000),
          );
          assert(
            proof(issue).comments[0].body.includes(
              `Implementation paused (${cause})`,
            ),
          );
          const warning = logs
            .at(-1)
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .map(JSON.parse)
            .find((row) => row.event === "agent.collection_failed");
          assert.equal(warning.level, "warn");
          assert.equal(warning.run_id, writer.run.id);
          assert.equal(warning.cause, cause);
          assert.equal(warning.retry_at, retry.retry_at);
          assert(warning.request_id);
          diagnosticEvents.push(warning);
          outcome = await drain(issue, retry, options);
          assert.equal(outcome.head_sha, completed.head);
          if (writer.turn.resume)
            assert.deepEqual(
              nativeEvents(issue, "implementation_candidate_assessment"),
              [],
            );
        }
        assertPublished(issue, outcome);
        const { events, coding_candidate } = proof(issue);
        const first = events.find((item) => item.type === "progress_only");
        const writes = events.filter((item) => item.type === "write_attempt");
        if (mode !== "lost_final_result") {
          assert(first);
          assert.equal(writes.length, 2);
          assert.notEqual(first.first, first.head);
          const [finished] = nativeEvents(issue, "implementation_change");
          assert.equal(finished.start, first.head);
          assert.equal(finished.progress_branch, first.branch);
          assert.equal(finished.parent, base.sha);
          const restores = events.filter(
            (item) =>
              item.type === "native_restore" && item.role === "implementation",
          );
          if (mode === "interrupted_coding") {
            assert.equal(restores.length, 1);
            assert.equal(restores[0].restored_sha, first.first);
            assert.equal(restores[0].start, first.head);
          } else {
            assert.deepEqual(restores, []);
            setup(8, "reproduced");
            await invoke(8);
            const [producer] = pending(8);
            const selection = await native(producer);
            upstream(`/complete?run=${producer.run.id}`, selection);
            upstream(`/rerun?run=${producer.run.id}`);
            assert.equal((await invoke(8)).reason, "agent_run");
            const [next] = pending(8);
            assert.notEqual(next.run.id, producer.run.id);
            assert(!next.turn.resume);
          }
        } else {
          assert.equal(first, undefined);
          assert.equal(writes.length, 1);
          const [writer] = nativeEvents(issue, "implementation_change");
          const [assessment] = nativeEvents(
            issue,
            "implementation_candidate_assessment",
          );
          assert.equal(assessment.assessment_of, outcome.head_sha);
          assert.equal(coding_candidate?.sha, outcome.head_sha);
          assert.equal(coding_candidate?.writer_run_id, writer.run);
          assert(
            logs.some((log) =>
              log
                .split("\n")
                .filter((line) => line.startsWith("{"))
                .map(JSON.parse)
                .some(
                  (row) =>
                    row.event === "agent.collection_pending" &&
                    row.issue_number === issue &&
                    row.run_id === writer.run,
                ),
            ),
          );
        }
        return outcome;
      });
    await scenario("reject-moved-progress", async () => {
      setup(6, "moved_progress");
      const entry = await untilTurn(
        6,
        await invoke(6),
        (turn) => turn.previous_writer_run_id && turn.work_branch,
      );
      assert(entry.turn.work_branch);
      const changed = upstream("/move-progress?issue=6");
      assert.match(changed.head, /^[a-f0-9]{40}$/);
      await native(entry, 1, {}, 1);
      assert.match(logs.at(-1), /"cause":"agent_progress_conflict"/);
      assert.equal(
        proof(6).events.filter((item) => item.type === "write_attempt").length,
        1,
      );
      assert.equal(proof(6).pulls.length, 0);
    });
    await scenario("coding-clarification", async () => {
      setup(9, "coding_clarification");
      const waiting = await drain(9);
      assert.equal(waiting.reason, "needs_information");
      const [first] = nativeEvents(9, "implementation_change");
      assert.equal(first.branch, first.progress_branch);
      assert.match(
        proof(9).comments[0].body,
        new RegExp(`Saved conversation.*runs/${first.run}`),
      );
      assert.equal(proof(9).pulls.length, 0);
      upstream("/reply?issue=9&allowed=true");
      const outcome = await drain(9, undefined, { fresh: true });
      assertPublished(9, outcome);
      const [, last] = nativeEvents(9, "implementation_change");
      assert.equal(last.start, first.head);
      assert.equal(last.progress_branch, first.progress_branch);
      assert(
        proof(9).events.some(
          (item) =>
            item.type === "native_restore" &&
            item.parent === first.run &&
            item.run === last.run,
        ),
      );
      assert(
        proof(9).events.some(
          (item) =>
            item.type === "complete" &&
            item.role === "output_review" &&
            item.run > first.run &&
            item.run < last.run,
        ),
      );
      return outcome;
    });
    await scenario("native-result-recovery", async () => {
      setup(10, "no_coding_session");
      const outcome = await drain(10);
      assertPublished(10, outcome);
      const progress = proof(10).events.find(
        (item) => item.type === "progress_only",
      );
      const [last] = nativeEvents(10, "implementation_change");
      assert.equal(last.start, progress.head);
      assert(
        !proof(10).events.some(
          (item) =>
            item.type === "native_restore" && item.role === "implementation",
        ),
      );
      for (const [issue, mode, resumes] of [
        [11, "failed_investigation", false],
        [12, "interrupted_investigation", true],
      ]) {
        setup(issue, mode);
        await invoke(issue);
        const [first] = pending(issue);
        const stopped = await advance(issue, first);
        const retry = await untilTurn(
          issue,
          stopped,
          (turn) => turn.role === "investigation",
        );
        assert.equal(
          retry.turn.resume?.run_id,
          resumes ? first.run.id : undefined,
        );
        assert.equal(
          await advance(issue, retry).then((result) => result.reason),
          "agent_run",
        );
        assert.equal(
          proof(issue).events.some(
            (item) =>
              item.type === "native_restore" && item.parent === first.run.id,
          ),
          resumes,
        );
      }
      setup(18, "clarification");
      assert.equal((await drain(18)).reason, "needs_information");
      const [legacy] = nativeEvents(18, "investigation_triage");
      upstream(`/delete-legacy-producer?issue=18&run=${legacy.run}`);
      upstream("/reply?issue=18&allowed=true");
      const replacement = await untilTurn(
        18,
        await invoke(18, { fresh: true }),
        (turn) => turn.role === "investigation",
      );
      assert.equal(replacement.turn.resume, undefined);
      assert.match(logs.join("\n"), /"cause":"legacy_run_not_visible"/);
      assert.equal(
        (await advance(18, replacement, undefined, { fresh: true })).reason,
        "agent_run",
      );
      return outcome;
    });
    await scenario("conflicting-resume", async () => {
      setup(13, "clarification");
      assert.equal((await drain(13)).reason, "needs_information");
      const [prior] = nativeEvents(13, "investigation_triage");
      const saved = proof(13).artifacts.find((artifact) =>
        artifact.name.startsWith(`remote-dev-session-r${prior.run}-a1-`),
      );
      upstream(`/fault?artifact=${saved.id}&kind=changed_digest`);
      upstream("/reply?issue=13&allowed=true");
      const rejected = await invoke(13, { expected: 1 });
      assert.equal(rejected.reason, "agent_resume_conflict");
      assert.equal(pending(13).length, 0);
      assert.match(
        proof(13).comments[0].body,
        /Investigation blocked \(agent_resume_conflict\)/,
      );

      setup(14, "changed_session");
      await invoke(14);
      const [first] = pending(14);
      const next = await untilTurn(14, await advance(14, first), (turn) =>
        Boolean(turn.resume),
      );
      const invalid = await advance(14, next, undefined, { expected: 1 });
      assert.equal(invalid.reason, "investigation_blocked");
      assert.match(logs.at(-1), /"cause":"agent_artifact_conflict"/);
      assert.equal(pending(14).length, 0);

      setup(17, "clarification");
      assert.equal((await drain(17)).reason, "needs_information");
      upstream("/reply?issue=17&allowed=true");
      const resumed = await untilTurn(17, await invoke(17), (turn) =>
        Boolean(turn.resume),
      );
      const selection = await native(resumed);
      assert.equal(selection.resume_run_id, resumed.turn.resume.run_id);
      upstream(
        `/fault?artifact=${resumed.turn.resume.artifact_id}&kind=changed_digest`,
      );
      upstream(`/complete?run=${resumed.run.id}`, selection);
      const changed = await invoke(17, { expected: 1 });
      assert.equal(changed.reason, "investigation_blocked");
      assert.match(logs.at(-1), /"cause":"agent_resume_conflict"/);
      assert.equal(pending(17).length, 0);
      return changed;
    });
    await scenario("incomplete-assessment", async () => {
      setup(15, "incomplete_assessment");
      const outcome = await drain(15);
      assertPublished(15, outcome);
      const [first, next] = nativeEvents(15, "implementation_change");
      const [assessment] = nativeEvents(
        15,
        "implementation_candidate_assessment",
      );
      assert.equal(assessment.assessment_of, first.head);
      assert.equal(first.progress_branch, next.progress_branch);
      assert.notEqual(outcome.head_sha, first.head);
      assert.match(
        logs.join("\n"),
        /"event":"agent.candidate_assessed".*"outcome":"needs_work"/,
      );
      return outcome;
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
