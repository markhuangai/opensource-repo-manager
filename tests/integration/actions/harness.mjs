import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export async function runActionsTests({
  sdk,
  manager,
  upstreamName,
  data,
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
  function launch(name, number) {
    upstream(`/select?issue=${number}`, "POST");
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
      `type=volume,src=${data},dst=/data`,
      "--mount",
      `type=bind,src=${join(directory, "ca-bundle.pem")},dst=/etc/ssl/certs/ca-certificates.crt,readonly`,
      "--env",
      "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
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
    for (const secret of [config.github.token, config.proxy.key])
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
  assert.equal(proof().mutations.length, beforeMonitorRetry.mutations.length);
  assert(
    !proof()
      .github_requests.slice(beforeMonitorRetry.github_requests.length)
      .some(({ path }) => path.includes("/pulls/") || path === "/graphql"),
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
  const mutations = proof().mutations.length;
  launch(`${manager}-publication-backoff`, 1);
  const deferred = await finished(
    `${manager}-publication-backoff`,
    "waiting",
    "retry_scheduled",
  );
  assert.equal(deferred.retry_at, retryAt);
  assert.equal(deferred.pull_number, waiting.pull_number);
  assert.equal(deferred.head_sha, waiting.head_sha);
  assert.equal(proof().mutations.length, mutations);
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

  function mutateState(sql, number = 2) {
    const name = `${manager}-seed-${completed.length}`;
    register("container", name);
    docker([
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      `${label}=${id}`,
      "--mount",
      `type=volume,src=${data},dst=/data`,
      "--entrypoint",
      node,
      image,
      "--input-type=module",
      "-e",
      "import {Store} from '/opt/orm/app/dist/repositories/store.js'; const store=new Store('/data/actions/'+process.argv[1]+'/state/manager.sqlite'); store.db.exec(process.argv[2]); store.close();",
      String(number),
      sql,
    ]);
  }
  mutateState("UPDATE jobs SET phase='unrecognized'");
  launch(`${manager}-no-progress`, 2);
  await finished(`${manager}-no-progress`, "blocked", "no_progress");
  mutateState("UPDATE jobs SET issue_number=8,issue_id=1008");
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
  assert.equal(evidence.pulls.length, 1);
  return {
    sdk,
    actions: "passed",
    completed_scenarios: completed,
    credential_exclusion: "passed",
    no_public_listener: "passed",
    unrelated_issue: "untouched",
  };
}
