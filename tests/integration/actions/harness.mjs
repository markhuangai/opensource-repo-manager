import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export async function runActionsTests({
  sdk,
  manager,
  upstreamName,
  data,
  freshData,
  directory,
  image,
  net,
  label,
  id,
  docker,
  result,
  register,
  waitUntil,
}) {
  const node = "/opt/orm-runtime/bin/node";
  const completed = [];
  const config = JSON.parse(
    await readFile(join(directory, "configuration.json"), "utf8"),
  );
  const upstream = (path, method = "GET") =>
    docker([
      "exec",
      upstreamName,
      node,
      "-e",
      "fetch('http://localhost:8317'+process.argv[1],{method:process.argv[2]}).then(async r=>{if(!r.ok)throw Error('fixture HTTP '+r.status);console.log(await r.text())})",
      path,
      method,
    ]);
  const proof = () => JSON.parse(upstream("/proof"));
  const inspect = (name) =>
    JSON.parse(docker(["container", "inspect", name]))[0];
  function launch(name, number, fresh = false) {
    upstream(`/select?issue=${number}&fresh=${fresh}`, "POST");
    register("container", name);
    docker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `${label}=${id}`,
      "--network",
      net,
      "--no-healthcheck",
      "--mount",
      `type=volume,src=${fresh ? freshData : data},dst=/data`,
      "--mount",
      `type=bind,src=${join(directory, "ca-bundle.pem")},dst=/etc/ssl/certs/ca-certificates.crt,readonly`,
      "--env",
      "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
      "--env",
      `ORM_SESSION_KEY=${config.session_key}`,
      ...["config", "skills", "prompts"].flatMap((name) => [
        "--mount",
        `type=bind,src=${join(directory, name)},dst=/${name},readonly`,
      ]),
      "--entrypoint",
      "/usr/bin/tini",
      image,
      "--",
      node,
      "/opt/orm/app/dist/actions/main.js",
      String(number),
    ]);
    assert.deepEqual(inspect(name).Config.Healthcheck.Test, ["NONE"]);
  }
  async function finished(name, expected, reason) {
    await waitUntil(
      () => !inspect(name).State.Running,
      `Actions ${sdk}/${name} did not exit`,
      300_000,
    );
    const logs = result(["logs", name]);
    assert.equal(logs.status, 0);
    for (const secret of [
      config.github.token,
      config.proxy.key,
      config.session_key,
    ])
      assert(
        !(logs.stdout + logs.stderr).includes(secret),
        "Credential in Actions output",
      );
    const lines = logs.stdout.trim().split("\n");
    assert.equal(lines.length, 1, logs.stdout + logs.stderr);
    const outcome = JSON.parse(lines[0]);
    if (outcome.outcome !== expected) {
      const evidence = proof();
      assert.fail(
        logs.stdout +
          logs.stderr +
          JSON.stringify({
            errors: evidence.errors,
            requests: evidence.requests,
            runs: evidence.runs,
          }),
      );
    }
    assert.equal(outcome.reason, reason, logs.stdout + logs.stderr);
    assert.equal(
      inspect(name).State.ExitCode,
      ["blocked", "failed"].includes(expected) ? 1 : 0,
      logs.stderr,
    );
    assert.equal(inspect(name).State.OOMKilled, false);
    assert.equal(inspect(name).State.Pid, 0);
    completed.push({ id: name.slice(manager.length + 1), outcome: expected });
    return outcome;
  }
  const first = `${manager}-publication`;
  launch(first, 1);
  const waiting = await finished(first, "waiting", "remote_checks");
  assert(waiting.pull_number > 0);
  let evidence = proof();
  assert.equal(evidence.pulls.length, 1);
  assert.equal(evidence.pulls[0].draft, false);
  assert.equal(evidence.errors.length, 0, JSON.stringify(evidence.errors));
  for (const task of [
    "implementation_change",
    "implementation_audit",
    "external_output_review",
  ])
    assert(evidence.requests.includes(task), `Missing ${task}`);
  assert(evidence.runs.every((run) => run.finished_at !== null));
  assert.equal(evidence.leases, 0);
  assert.equal(
    evidence.notifications.length +
      evidence.discord.length +
      evidence.smtp.length,
    0,
  );
  upstream("/checks", "POST");
  const readyName = `${manager}-ready`;
  launch(readyName, 1);
  const ready = await finished(readyName, "ready", "human_review");
  assert.equal(ready.pull_number, waiting.pull_number);
  assert.equal(ready.head_sha, waiting.head_sha);
  assert.equal(proof().pulls.length, 1);

  const retryAt = Date.now() + 600_000;
  mutateState(
    `UPDATE pr_monitors SET state='queued', content=json_set(content,
    '$.stage','queued','$.retry_at',${retryAt})`,
    1,
  );
  const beforeMonitorRetry = proof();
  launch(`${manager}-monitor-backoff`, 1);
  const monitorDeferred = await finished(
    `${manager}-monitor-backoff`,
    "waiting",
    "retry_scheduled",
  );
  assert.equal(monitorDeferred.retry_at, retryAt);
  assert.equal(monitorDeferred.pull_number, waiting.pull_number);
  assert.equal(
    proof().requests.length,
    0,
    "Deferred monitor started model work",
  );
  assert.equal(
    proof().mutations.filter((kind) => kind !== "comment").length,
    beforeMonitorRetry.mutations.filter((kind) => kind !== "comment").length,
  );
  assert(
    !proof()
      .github_requests.slice(beforeMonitorRetry.github_requests.length)
      .some(({ path }) => /\/pulls\/\d+\//.test(path) || path === "/graphql"),
    "Deferred monitor read remote review state",
  );
  mutateState(
    "UPDATE pr_monitors SET state='ready', content=json_set(content,'$.stage','ready','$.retry_at',0)",
    1,
  );
  mutateState(
    `UPDATE publication_operations SET status='uncertain', content=json_set(content,
    '$.status','uncertain','$.retry_at',${retryAt},'$.retry_pending',json('true'),
    '$.steps[' || (json_array_length(content,'$.steps') - 1) || '].state','uncertain')
    WHERE json_extract(content,'$.proposal.kind')='change'`,
    1,
  );
  const mutations = proof().mutations.filter(
    (kind) => kind !== "comment",
  ).length;
  launch(`${manager}-publication-backoff`, 1);
  const deferred = await finished(
    `${manager}-publication-backoff`,
    "waiting",
    "retry_scheduled",
  );
  assert.equal(deferred.retry_at, retryAt);
  assert.equal(deferred.pull_number, waiting.pull_number);
  assert.equal(deferred.head_sha, waiting.head_sha);
  assert.equal(
    proof().mutations.filter((kind) => kind !== "comment").length,
    mutations,
  );
  assert.equal(
    proof().requests.length,
    0,
    "Deferred publication started model work",
  );

  for (const [number, expected, reason] of [
    [2, "waiting", "needs_information"],
    [3, "out_of_scope", "manual_feature"],
    [4, "no_fix", "no_fix"],
    [5, "closed", "issue_closed"],
    [6, "blocked", "investigation_blocked"],
  ]) {
    const name = `${manager}-${reason}`;
    launch(name, number);
    const outcome = await finished(name, expected, reason);
    assert.equal(outcome.issue_number, number);
    evidence = proof();
    assert.equal(evidence.errors.length, 0, JSON.stringify(evidence.errors));
    assert(evidence.runs.every((run) => run.finished_at !== null));
    assert.equal(evidence.leases, 0);
    assert.equal(evidence.pulls.length, 1);
  }

  const cancelling = `${manager}-cancellation`;
  launch(cancelling, 7);
  await waitUntil(
    () => proof().held,
    "Actions coding worker did not reach the provider",
    120_000,
  );
  docker([
    "exec",
    cancelling,
    node,
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { loadProtectedActionsConfiguration } from '/opt/orm/app/dist/config/load.js';
    const {secrets} = await loadProtectedActionsConfiguration();
    for (const path of ['/data/actions','/data/actions/7'])
      assert.equal(fs.statSync(path).mode & 0o777, 0o711);
    for (const path of ['/data/actions/7/state','/data/actions/7/runtime/private'])
      assert.equal(fs.statSync(path).mode & 0o777, 0o700);
    let workers = 0;
    for (const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))) {
      try {
        const status = fs.readFileSync('/proc/'+pid+'/status','utf8');
        const uid = /^Uid:\\s+(1000[123])\\s/m.exec(status)?.[1];
        if (!uid) continue;
        workers++;
        const user = ['coding','audit','output-review'][Number(uid)-10001];
        const environment = execFileSync('/usr/sbin/runuser',['-u',user,'--','cat','/proc/'+pid+'/environ'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
        assert(!secrets.containsCredentials(environment));
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    }
    assert(workers > 0);
    for (const user of ['coding','audit','output-review']) {
      assert.throws(()=>execFileSync('/usr/sbin/runuser',['-u',user,'--','cat','/config/actions.yml'],{stdio:'pipe'}));
      assert.throws(()=>execFileSync('/usr/sbin/runuser',['-u',user,'--','test','-r','/data/actions/7/state/manager.sqlite'],{stdio:'pipe'}));
    }
    for (const file of ['/proc/net/tcp','/proc/net/tcp6'])
      for (const line of fs.readFileSync(file,'utf8').trim().split('\\n').slice(1)) {
        const columns=line.trim().split(/\\s+/);
        if(columns[3] !== '0A') continue;
        const [address,port]=columns[1].split(':');
        assert(port !== '1F90', 'Public service port is listening');
        assert(address.endsWith('7F') || address === '00000000000000000000000001000000', 'Non-loopback listener');
      }
  `,
  ]);
  upstream("/reject-checkpoint", "POST");
  docker(["kill", "--signal", "SIGTERM", cancelling]);
  const cancelled = await finished(cancelling, "failed", "cancelled");
  assert.equal(cancelled.repository, "owner/repo");
  assert.equal(cancelled.issue_number, 7);
  assert(cancelled.job_id > 0);
  assert(cancelled.revision > 0);
  upstream("/release", "POST");
  evidence = proof();
  assert(evidence.runs.length > 0);
  assert(
    evidence.runs.every((run) => run.finished_at !== null),
    "Interrupted run has no cleanup receipt",
  );
  assert.equal(evidence.leases, 0);

  assert(
    durable(7).active,
    "Failed cancellation checkpoint must retain the conservative active reservation",
  );

  function mutateState(sql, number = 2, persist = true) {
    const name = `${manager}-seed-${completed.length}`;
    register("container", name);
    docker([
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      `${label}=${id}`,
      "--network",
      net,
      "--mount",
      `type=volume,src=${data},dst=/data`,
      "--mount",
      `type=bind,src=${join(directory, "ca-bundle.pem")},dst=/etc/ssl/certs/ca-certificates.crt,readonly`,
      "--env",
      "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
      "--env",
      `ORM_SESSION_KEY=${config.session_key}`,
      ...["config", "skills", "prompts"].flatMap((name) => [
        "--mount",
        `type=bind,src=${join(directory, name)},dst=/${name},readonly`,
      ]),
      "--entrypoint",
      node,
      image,
      "--input-type=module",
      "-e",
      "import {Store} from '/opt/orm/app/dist/repositories/store.js'; import {ActionsState} from '/opt/orm/app/dist/actions/persistence.js'; import {loadProtectedActionsConfiguration} from '/opt/orm/app/dist/config/load.js'; const store=new Store('/data/actions/'+process.argv[1]+'/state/manager.sqlite'); const signal=AbortSignal.timeout(30000); if(process.argv[3]==='true'){const loaded=await loadProtectedActionsConfiguration(); await ActionsState.open(store,loaded.snapshot,loaded.secrets,Number(process.argv[1]),signal);} store.db.exec(process.argv[2]); if(process.argv[3]==='true') await store.checkpoint(signal); store.close();",
      String(number),
      sql,
      String(persist),
    ]);
  }
  mutateState("UPDATE jobs SET phase='unrecognized'", 2, false);
  launch(`${manager}-no-progress`, 2);
  await finished(`${manager}-no-progress`, "blocked", "state_invalid");
  mutateState("UPDATE jobs SET issue_number=8,issue_id=1008", 2, false);
  launch(`${manager}-foreign-state`, 2);
  await finished(`${manager}-foreign-state`, "failed", "task_state_invalid");
  for (const [number, reason] of [
    [0, "arguments_invalid"],
    [999, "intake_failed"],
  ]) {
    const name = `${manager}-${reason}`;
    launch(name, number);
    await finished(name, "failed", reason);
  }
  function durable(number) {
    const rows = proof().comments.find(([issue]) => issue === number)[1];
    const canonical = rows.filter((row) =>
      row.body.includes("<!-- orm:task-state:"),
    );
    assert.equal(canonical.length, 1, "Duplicated canonical state");
    const row = canonical[0];
    const match = /<!-- orm:task-state:v1:([A-Za-z0-9_-]+):/.exec(row.body);
    const state = JSON.parse(
      Buffer.from(match[1], "base64url").toString("utf8"),
    );
    assert(Buffer.byteLength(row.body) <= 60 * 1024);
    assert(Buffer.byteLength(JSON.stringify(state)) <= 32 * 1024);
    for (const value of [
      config.github.token,
      config.proxy.key,
      config.session_key,
      "OPERATOR_SYSTEM_CANARY",
      "OPERATOR_SKILL_CANARY",
    ])
      assert(
        !JSON.stringify(state).includes(value),
        "Private material entered durable state",
      );
    return state;
  }
  const readyState = durable(1);
  assert(readyState.budget.wait_ms > 0, "CI waiting was not accounted");
  launch(`${manager}-fresh-owned-pr`, 1, true);
  const owned = await finished(
    `${manager}-fresh-owned-pr`,
    "blocked",
    "recovery_evidence_missing",
  );
  assert.equal(owned.pull_number, waiting.pull_number);
  assert.equal(durable(1).task_id, readyState.task_id);
  assert.deepEqual(durable(1).budget, readyState.budget);
  assert.equal(proof().requests.length, 0);

  const noFixState = durable(4);
  launch(`${manager}-fresh-terminal`, 4, true);
  await finished(`${manager}-fresh-terminal`, "no_fix", "no_fix");
  assert.equal(durable(4).task_id, noFixState.task_id);
  assert.deepEqual(durable(4).budget, noFixState.budget);
  assert.equal(proof().requests.length, 0);

  const questionState = durable(2);
  launch(`${manager}-fresh-question`, 2, true);
  await finished(`${manager}-fresh-question`, "waiting", "needs_information");
  assert.deepEqual(durable(2).question, questionState.question);
  assert.deepEqual(durable(2).budget, questionState.budget);
  assert.equal(proof().requests.length, 0);

  const unpublished = `${manager}-unpublished-interruption`;
  launch(unpublished, 9);
  await waitUntil(
    () => proof().held,
    "Unpublished implementation did not reach the held provider",
    300000,
  );
  assert(durable(9).scope, "Frozen scope was not saved before coding");
  docker(["kill", "--signal", "SIGTERM", unpublished]);
  await finished(unpublished, "failed", "cancelled");
  upstream("/release", "POST");
  const interrupted = durable(9);
  launch(`${manager}-fresh-unpublished`, 9, true);
  await finished(`${manager}-fresh-unpublished`, "waiting", "remote_checks");
  const resumed = durable(9);
  assert.equal(resumed.task_id, interrupted.task_id);
  assert.equal(resumed.scope_digest, interrupted.scope_digest);
  assert(resumed.budget.model_requests > interrupted.budget.model_requests);
  assert(resumed.budget.active_ms >= interrupted.budget.active_ms);
  for (const task of ["implementation_audit", "external_output_review"])
    assert(proof().requests.includes(task));
  assert.equal(
    proof().reconstructed,
    0,
    "Rebuilt evidence must support retained continuation",
  );
  upstream("/checks?issue=9", "POST");
  launch(`${manager}-rebuilt-retained-ready`, 9, true);
  await finished(`${manager}-rebuilt-retained-ready`, "ready", "human_review");

  launch(`${manager}-lost-pull-response`, 10);
  await finished(
    `${manager}-lost-pull-response`,
    "blocked",
    "state_write_uncertain",
  );
  const uncertain = durable(10),
    count = proof().pulls.length;
  assert(
    uncertain.pending.steps.some(
      (step) => step.kind === "pull" && step.state === "dispatching",
    ),
  );
  launch(`${manager}-fresh-lost-pull`, 10, true);
  const recovered = await finished(
    `${manager}-fresh-lost-pull`,
    "blocked",
    "recovery_evidence_missing",
  );
  assert(recovered.pull_number > 0);
  assert.equal(proof().pulls.length, count);
  assert.equal(
    durable(10).budget.model_requests,
    uncertain.budget.model_requests,
  );
  assert.equal(durable(10).pending.status, "confirmed");
  assert.equal(proof().requests.length, 0);

  upstream("/merge-owned?issue=9", "POST");
  launch(`${manager}-retained-closed-after-main-advances`, 9, true);
  await finished(
    `${manager}-retained-closed-after-main-advances`,
    "closed",
    "issue_closed",
  );
  upstream("/merge-owned?issue=1", "POST");
  launch(`${manager}-closed-after-main-advances`, 1, true);
  await finished(
    `${manager}-closed-after-main-advances`,
    "closed",
    "issue_closed",
  );

  upstream("/corrupt-state?issue=3", "POST");
  launch(`${manager}-edited-comment`, 3, true);
  await finished(`${manager}-edited-comment`, "blocked", "state_invalid");
  upstream("/corrupt-state?issue=4&delete=true", "POST");
  launch(`${manager}-missing-comment`, 4, true);
  await finished(`${manager}-missing-comment`, "blocked", "state_missing");
  evidence = proof();
  assert(
    !evidence.github_requests.some(
      ({ path }) => path === "/repos/owner/repo/issues",
    ),
    "Actions performed backlog discovery",
  );
  assert(
    !evidence.github_requests.some(({ path }) =>
      /^\/repos\/owner\/repo\/issues\/8(?:\/|$)/.test(path),
    ),
    "Actions read an unrelated issue",
  );
  assert.equal(evidence.pulls.length, 3);
  return {
    sdk,
    actions: "passed",
    completed_scenarios: completed,
    credential_exclusion: "passed",
    no_public_listener: "passed",
    unrelated_issue: "untouched",
  };
}
