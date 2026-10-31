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
  sessionFixtures,
}) {
  const node = "/opt/orm-runtime/bin/node";
  const completed = [];
  let resets = 0;
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
  function runtimeEnvironment(fresh = false) {
    const run = fresh ? 101 : 100;
    return Object.entries({
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_REPOSITORY_ID: "42",
      GITHUB_RUN_ID: String(run),
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: "f".repeat(40),
      ACTIONS_RUNTIME_TOKEN: config.artifact_tokens[run],
      ACTIONS_RESULTS_URL:
        "https://results-receiver.actions.githubusercontent.com/",
    }).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  }
  function launch(name, number, fresh = false, options = {}) {
    upstream(
      `/select?issue=${number}&fresh=${fresh}&session=${options.session ?? "seed"}`,
      "POST",
    );
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
      ...runtimeEnvironment(fresh),
      ...Object.entries(options.environment ?? {}).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]),
      "--mount",
      `type=bind,src=${sessionFixtures},dst=/actions-fixtures,readonly`,
      ...["config", "skills", "prompts"].flatMap((name) => [
        "--mount",
        `type=bind,src=${join(directory, name === "prompts" && options.changedPrompts ? "prompts-incompatible" : name)},dst=/${name},readonly`,
      ]),
      "--entrypoint",
      "/usr/bin/tini",
      image,
      "--",
      node,
      options.session
        ? "/actions-fixtures/session.mjs"
        : "/opt/orm/app/dist/actions/main.js",
      String(number),
      ...(options.session ? [options.session] : []),
    ]);
    assert.deepEqual(inspect(name).Config.Healthcheck.Test, ["NONE"]);
  }
  function output(name) {
    const logs = result(["logs", name]);
    assert.equal(logs.status, 0);
    for (const secret of [
      config.github.token,
      config.proxy.key,
      config.session_key,
      ...Object.values(config.artifact_tokens),
    ])
      assert(
        !(logs.stdout + logs.stderr).includes(secret),
        "Credential in Actions output",
      );
    const lines = logs.stdout.trim().split("\n");
    assert.equal(lines.length, 1, logs.stdout + logs.stderr);
    assert(lines[0], logs.stdout + logs.stderr);
    const outcome = JSON.parse(lines[0]);
    return { logs, outcome };
  }
  async function finished(name, expected, reason) {
    await waitUntil(
      () => !inspect(name).State.Running,
      `Actions ${sdk}/${name} did not exit`,
      300_000,
    );
    const { logs, outcome } = output(name);
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
  assert.equal(
    cancelled.checkpoint_failed,
    true,
    "Failed final checkpoint was not reported",
  );
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
      ...runtimeEnvironment(),
      ...["config", "skills", "prompts"].flatMap((name) => [
        "--mount",
        `type=bind,src=${join(directory, name)},dst=/${name},readonly`,
      ]),
      "--entrypoint",
      node,
      image,
      "--input-type=module",
      "-e",
      "import {Store} from '/opt/orm/app/dist/repositories/store.js'; import {ActionsState} from '/opt/orm/app/dist/actions/persistence.js'; import {ActionsArtifacts} from '/opt/orm/app/dist/actions/artifacts.js'; import {GitHubArtifacts} from '/opt/orm/app/dist/adapters/github/artifacts.js'; import {loadProtectedActionsConfiguration} from '/opt/orm/app/dist/config/load.js'; const root='/data/actions/'+process.argv[1]; const store=new Store(root+'/state/manager.sqlite'); const signal=AbortSignal.timeout(30000); if(process.argv[3]==='true'){const loaded=await loadProtectedActionsConfiguration(); const artifacts=new ActionsArtifacts(loaded.actions,loaded.snapshot,loaded.secrets,root+'/runtime',new GitHubArtifacts(loaded.actions,loaded.secrets)); await ActionsState.open(store,loaded.snapshot,loaded.secrets,Number(process.argv[1]),signal,{artifacts});} store.db.exec(process.argv[2]); if(process.argv[3]==='true') await store.checkpoint(signal); store.close();",
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
  assert.equal(readyState.pending.status, "uncertain");
  const publicationCount = proof().mutations.filter(
    (kind) => kind !== "comment",
  ).length;
  launch(`${manager}-older-artifact-publication-authority`, 1, true);
  const importedOwnership = await finished(
    `${manager}-older-artifact-publication-authority`,
    "waiting",
    "retry_scheduled",
  );
  assert.equal(importedOwnership.pull_number, readyState.pull.number);
  assert.equal(importedOwnership.head_sha, readyState.pull.head);
  assert.equal(importedOwnership.retry_at, readyState.pending.retry_at);
  assert.deepEqual(durable(1).budget, readyState.budget);
  assert.deepEqual(durable(1).pull, readyState.pull);
  assert.equal(durable(1).pending.status, "uncertain");
  assert.equal(proof().requests.length, 0);
  assert.equal(
    proof().mutations.filter((kind) => kind !== "comment").length,
    publicationCount,
  );
  const inspection = `${manager}-inspect-import`;
  register("container", inspection);
  const restoredRuns = Number(
    docker([
      "run",
      "--rm",
      "--name",
      inspection,
      "--label",
      `${label}=${id}`,
      "--mount",
      `type=volume,src=${freshData},dst=/data,readonly`,
      "--entrypoint",
      node,
      image,
      "--input-type=module",
      "-e",
      "import assert from 'node:assert/strict'; import {copyFileSync,existsSync} from 'node:fs'; import Database from 'better-sqlite3'; process.umask(0o077); const source='/data/actions/1/state/manager.sqlite'; assert(!existsSync(source+'-wal')); copyFileSync(source,'/tmp/checkpoint.sqlite'); const db=new Database('/tmp/checkpoint.sqlite',{readonly:true,fileMustExist:true}); console.log(db.prepare('SELECT count(*) AS count FROM agent_runs').get().count); db.close();",
    ]),
  );
  assert(restoredRuns > 0, "Older checkpoint database was not imported");
  assert(
    proof().artifacts.requests.some(
      (item) =>
        item.path ===
        `/repos/owner/repo/actions/artifacts/${readyState.session_artifact.artifact_id}/zip`,
    ),
  );
  discardTask(1, true);
  assert(readyState.budget.wait_ms > 0, "CI waiting was not accounted");
  assert(
    readyState.session_artifact,
    "Production entrypoint did not publish a session checkpoint",
  );
  upstream(
    `/artifact-fault?id=${readyState.session_artifact.artifact_id}&kind=expired`,
    "POST",
  );
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
  assert.equal(owned.session_recovery, "expired_or_deleted");

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
  try {
    await waitUntil(
      () => {
        if (!inspect(unpublished).State.Running)
          assert.fail(
            `Unpublished invocation exited: ${JSON.stringify(output(unpublished).outcome)}`,
          );
        return proof().held;
      },
      "Unpublished implementation did not reach the held provider",
      300000,
    );
  } catch (error) {
    const { workflow, runs, requests } = proof();
    throw new Error(
      `${error.message}; workflow ${JSON.stringify({ workflow, runs, requests })}`,
      { cause: error },
    );
  }
  assert(durable(9).scope, "Frozen scope was not saved before coding");
  docker(["kill", "--signal", "SIGTERM", unpublished]);
  await finished(unpublished, "failed", "cancelled");
  upstream("/release", "POST");
  const interrupted = durable(9);
  const unpublishedAuthority = {
    budget: interrupted.budget,
    pull: interrupted.pull,
    branch: interrupted.branch,
    reference: interrupted.session_artifact,
  };
  launch(`${manager}-artifact-changed-configuration`, 9, true, {
    changedPrompts: true,
  });
  await finished(
    `${manager}-artifact-changed-configuration`,
    "blocked",
    "session_incompatible",
  );
  assert.equal(proof().requests.length, 0);
  assert.deepEqual(
    {
      budget: durable(9).budget,
      pull: durable(9).pull,
      branch: durable(9).branch,
      reference: durable(9).session_artifact,
    },
    unpublishedAuthority,
  );
  discardTask(9, true);
  upstream("/advance-main", "POST");
  launch(`${manager}-artifact-changed-source`, 9, true);
  await finished(
    `${manager}-artifact-changed-source`,
    "blocked",
    "state_incompatible",
  );
  assert.equal(proof().requests.length, 0);
  assert.deepEqual(
    {
      budget: durable(9).budget,
      pull: durable(9).pull,
      branch: durable(9).branch,
      reference: durable(9).session_artifact,
    },
    unpublishedAuthority,
  );
  upstream(`/restore-main?sha=${interrupted.job.source.sha}`, "POST");
  discardTask(9, true);
  assert(
    interrupted.session_artifact,
    "Graceful interruption lost completed investigation/bootstrap checkpoints",
  );
  discardTask(9, false);
  launch(`${manager}-fresh-unpublished`, 9, true);
  await finished(`${manager}-fresh-unpublished`, "waiting", "remote_checks");
  const resumed = durable(9);
  assert.equal(resumed.task_id, interrupted.task_id);
  assert.equal(resumed.scope_digest, interrupted.scope_digest);
  assert.equal(resumed.findings.objective, interrupted.findings.objective);
  assert.equal(resumed.scope.objective, interrupted.scope.objective);
  assert(resumed.budget.model_requests > interrupted.budget.model_requests);
  assert(resumed.budget.active_ms >= interrupted.budget.active_ms);
  for (const task of ["implementation_audit", "external_output_review"])
    assert(proof().requests.includes(task));
  assert(
    !proof().requests.includes("investigation_result"),
    "Restored completed investigation was rerun",
  );
  assert.equal(
    proof().reconstructed,
    0,
    "Rebuilt evidence must support retained continuation",
  );
  upstream("/advance-main", "POST");
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
  function discardTask(number, fresh) {
    upstream(`/select?issue=${number}&fresh=${fresh}`, "POST");
    upstream("/forget-local", "POST");
    const name = `${manager}-discard-${resets++}`;
    register("container", name);
    docker([
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      `${label}=${id}`,
      "--mount",
      `type=volume,src=${fresh ? freshData : data},dst=/data`,
      "--entrypoint",
      node,
      image,
      "--input-type=module",
      "-e",
      "import {rm,access} from 'node:fs/promises'; const path='/data/actions/'+process.argv[1]; await rm(path,{recursive:true,force:true}); await access(path).then(()=>{throw Error('Task storage survived')},error=>{if(error.code!=='ENOENT')throw error});",
      String(number),
    ]);
  }
  const number = 30;
  upstream(`/session-issue?issue=${number}`, "POST");
  upstream("/artifact-fault?kind=drop_finalize", "POST");
  upstream("/artifact-fault?kind=drop_reference", "POST");
  launch(`${manager}-session-seed`, number, false, { session: "seed" });
  const seeded = await finished(
    `${manager}-session-seed`,
    "waiting",
    "session_verified",
  );
  const checkpoint = durable(number).session_artifact;
  assert.equal(checkpoint.run_id, 100);
  assert.equal(seeded.messages, 1);
  assert.equal(
    proof().lost_reference_response,
    true,
    "Reference acknowledgement loss was not exercised",
  );
  assert(
    proof().artifacts.requests.some((item) =>
      item.path.endsWith("/FinalizeArtifact"),
    ),
  );
  discardTask(number, false);
  for (const [fault, reason] of [
    ["foreign", "session_provenance_invalid"],
    ["corrupt", "session_corrupt"],
  ]) {
    upstream(
      `/artifact-fault?id=${checkpoint.artifact_id}&kind=${fault}`,
      "POST",
    );
    const name = `${manager}-session-${fault}`;
    launch(name, number, true);
    await finished(name, "blocked", reason);
    assert.equal(
      proof().requests.length,
      0,
      "Unverified artifact started model work",
    );
    assert.equal(
      durable(number).session_artifact.artifact_id,
      checkpoint.artifact_id,
    );
    discardTask(number, true);
  }
  upstream(`/artifact-fault?id=${checkpoint.artifact_id}&kind=none`, "POST");
  launch(`${manager}-session-missing-runtime`, number, true, {
    environment: { ACTIONS_RUNTIME_TOKEN: "" },
  });
  await finished(
    `${manager}-session-missing-runtime`,
    "failed",
    "configuration_invalid",
  );
  launch(`${manager}-session-wrong-key`, number, true, {
    environment: { ORM_SESSION_KEY: Buffer.alloc(32, 19).toString("base64") },
  });
  await finished(`${manager}-session-wrong-key`, "blocked", "state_invalid");
  discardTask(number, true);
  const interruptedName = `${manager}-session-unacknowledged`;
  launch(interruptedName, number, true, { session: "interrupt" });
  await waitUntil(
    () => !inspect(interruptedName).State.Running,
    "Native checkpoint interruption did not finish",
    600000,
  );
  assert.equal(
    inspect(interruptedName).State.ExitCode,
    137,
    result(["logs", interruptedName]).stderr,
  );
  assert.equal(
    durable(number).session_artifact.artifact_id,
    checkpoint.artifact_id,
    "Unacknowledged local work replaced the verified checkpoint",
  );
  const charged = durable(number).budget;
  assert(charged.model_requests > seeded.after.model_requests);
  discardTask(number, true);
  launch(`${manager}-session-resumed`, number, true, { session: "resume" });
  const resumedSession = await finished(
    `${manager}-session-resumed`,
    "waiting",
    "session_verified",
  );
  assert.equal(
    resumedSession.native_id,
    seeded.native_id,
    "Native session identity was not retained",
  );
  assert.equal(resumedSession.messages, 2);
  assert.deepEqual(
    resumedSession.before,
    charged,
    "Old artifact rolled back charged work",
  );
  assert.equal(durable(number).session_artifact.run_id, 101);
  assert(
    proof().artifacts.requests.some((item) =>
      /\/artifacts\/\d+\/zip$/.test(item.path),
    ),
    "Real artifact download client was not exercised",
  );
  let previous = resumedSession;
  for (const kind of ["expired", "deleted"]) {
    const reference = durable(number).session_artifact;
    upstream(
      `/artifact-fault?id=${reference.artifact_id}&kind=${kind}`,
      "POST",
    );
    discardTask(number, true);
    launch(`${manager}-session-${kind}`, number, true, { session: "fresh" });
    const fresh = await finished(
      `${manager}-session-${kind}`,
      "waiting",
      "session_verified",
    );
    assert.equal(fresh.session_recovery, "expired_or_deleted");
    assert.notEqual(
      fresh.native_id,
      previous.native_id,
      "Expired native conversation was reused",
    );
    assert.deepEqual(fresh.before, previous.after, "Expiry reset task budgets");
    assert.equal(
      proof().pulls.length,
      3,
      "Session recovery created another PR",
    );
    assert(
      proof()
        .comments.find(([issue]) => issue === number)[1]
        .some((comment) =>
          comment.body.includes("Saved session expired or was deleted."),
        ),
    );
    previous = fresh;
  }
  assert.deepEqual(proof().artifacts.errors, []);
  assert.deepEqual(proof().errors, []);
  upstream(`/restore-main?sha=${proof().source.sha}`, "POST");
  for (const [issue, mode] of [
    [40, "clarification_investigation"],
    [41, "clarification_planning"],
    [42, "clarification_coding"],
    [43, "clarification_intent"],
    [44, "monitor_clarification"],
    [45, "disguised_feature"],
    [46, "clarification_investigation"],
    [47, "clarification_coding"],
    [48, "clarification_coding"],
    [49, "clarification_investigation"],
    [50, "clarification_rejected"],
    [53, "clarification_invalid"],
    [54, "clarification_marker"],
  ]) {
    upstream(
      `/clarification-issue?issue=${issue}&mode=${mode}&early=${issue === 46}`,
      "POST",
    );
    const prefix = `${manager}-clarify-${issue}`;
    launch(`${prefix}-question`, issue);
    if (mode === "clarification_rejected" || mode === "clarification_invalid") {
      await finished(`${prefix}-question`, "blocked", "investigation_blocked");
      assert(
        !proof()
          .comments.find(([number]) => number === issue)[1]
          .some((row) => row.body.includes("Reply in a new issue comment.")),
      );
      if (mode === "clarification_invalid") {
        const evidence = proof();
        assert.deepEqual(evidence.errors, []);
        assert(
          evidence.runs.some(
            (run) => run.role === "investigation" && run.status === "completed",
          ),
        );
        assert(
          evidence.workflow
            .find((phase) => phase.phase === "investigations")
            .records.some(
              (record) => record.failure === "investigation_failed",
            ),
        );
      }
      continue;
    }
    if (mode === "disguised_feature") {
      await finished(`${prefix}-question`, "out_of_scope", "manual_feature");
      assert(
        !proof().requests.some(
          (task) =>
            task.startsWith("bootstrap_") || task.startsWith("implementation_"),
        ),
      );
      continue;
    }
    if (mode === "monitor_clarification") {
      await finished(`${prefix}-question`, "waiting", "remote_checks");
      upstream(`/review?issue=${issue}`, "POST");
      launch(`${prefix}-repair-question`, issue);
      await finished(
        `${prefix}-repair-question`,
        "waiting",
        "needs_information",
      );
    } else await finished(`${prefix}-question`, "waiting", "needs_information");
    if (issue === 49) {
      const legacy = durable(issue);
      upstream(`/legacy-question?issue=${issue}`, "POST");
      discardTask(issue, true);
      launch(`${prefix}-legacy-reissued`, issue, true);
      await finished(
        `${prefix}-legacy-reissued`,
        "waiting",
        "needs_information",
      );
      assert.equal(durable(issue).task_id, legacy.task_id);
      assert.equal(durable(issue).job.revision, legacy.job.revision);
      assert.equal(durable(issue).question.audience, "maintainer");
      assert(
        durable(issue).budget.model_requests >= legacy.budget.model_requests,
      );
    }
    const before = durable(issue),
      questions = () =>
        proof()
          .comments.find(([number]) => number === issue)[1]
          .filter((row) => row.body.includes("Reply in a new issue comment."));
    assert.equal(before.active, null);
    assert.equal(before.wait_accounted_at, null);
    const nativeBefore = proof().conversations.find(
      (conversation) => conversation.id === before.question.conversation_id,
    );
    assert.equal(questions().length, issue === 49 ? 2 : 1);
    if (mode === "clarification_marker") {
      assert(!questions().at(-1).body.includes("<!-- orm:task-state:"));
      assert.equal(
        proof()
          .comments.find(([number]) => number === issue)[1]
          .filter((row) => row.body.includes("<!-- orm:task-state:")).length,
        1,
      );
    }
    assert.equal(
      before.question.phase,
      issue === 49
        ? "investigation_triage"
        : ["clarification_investigation", "clarification_marker"].includes(mode)
          ? "investigation_plan"
          : mode === "clarification_planning"
            ? "implementation_plan"
            : mode === "clarification_intent"
              ? "investigation_triage"
              : "implementation_change",
    );
    if (issue !== 46) {
      upstream(
        `/answer?issue=${issue}&actor=${mode === "clarification_intent" || issue === 49 ? "reporter" : "outsider"}${issue === 47 ? "&body=UNADMITTED_CLARIFICATION_REPLY_OUTSIDER" : ""}`,
        "POST",
      );
      if (issue === 47)
        upstream(
          `/answer?issue=${issue}&actor=robot%5Bbot%5D&body=UNADMITTED_CLARIFICATION_REPLY_BOT`,
          "POST",
        );
      discardTask(issue, true);
      launch(`${prefix}-unauthorized`, issue, true);
      await finished(`${prefix}-unauthorized`, "waiting", "needs_information");
      assert.deepEqual(durable(issue).budget, before.budget);
      assert.equal(proof().requests.length, 0);
    }
    if (issue === 40) {
      upstream(`/answer?issue=${issue}&body=insufficient`, "POST");
      discardTask(issue, true);
      launch(`${prefix}-insufficient`, issue, true);
      await finished(`${prefix}-insufficient`, "waiting", "needs_information");
      assert.equal(questions().length, 2);
      const afterInsufficient = durable(issue);
      discardTask(issue, true);
      launch(`${prefix}-duplicate`, issue, true);
      await finished(`${prefix}-duplicate`, "waiting", "needs_information");
      assert.deepEqual(durable(issue).budget, afterInsufficient.budget);
      assert.equal(proof().requests.length, 0);
    }
    if (issue !== 46)
      upstream(
        `/answer?issue=${issue}&actor=${mode === "clarification_intent" || issue === 49 || issue === 48 ? "fixture" : "reporter"}${issue === 48 ? "&body=SCOPE_EXPANSION%3A%20add%20an%20unrelated%20feature" : ""}`,
        "POST",
      );
    if (issue === 47)
      upstream(
        `/artifact-fault?id=${durable(issue).session_artifact.artifact_id}&kind=expired`,
        "POST",
      );
    discardTask(issue, true);
    launch(`${prefix}-resumed`, issue, true);
    if (issue === 48) {
      await finished(`${prefix}-resumed`, "blocked", "implementation_blocked");
      assert.equal(durable(issue).scope_digest, before.scope_digest);
      assert.equal(durable(issue).scope.objective, before.scope.objective);
      const continued = proof().conversations.find(
        (conversation) => conversation.id === before.question.conversation_id,
      );
      assert.equal(continued.request_digest, nativeBefore.request_digest);
      assert.equal(continued.native_id, nativeBefore.native_id);
      assert.equal(
        proof().pulls.filter((pull) => pull.branch.endsWith(`/issue-${issue}`))
          .length,
        0,
      );
      assert(
        proof()
          .workflow.find((phase) => phase.phase === "implementations")
          .records.some(
            (record) => record.failure === "implementation_out_of_scope",
          ),
      );
      continue;
    }
    const resumed = await finished(
      `${prefix}-resumed`,
      "waiting",
      "remote_checks",
    );
    assert.equal(durable(issue).task_id, before.task_id);
    assert.equal(durable(issue).job.revision, before.job.revision);
    assert(durable(issue).budget.active_ms >= before.budget.active_ms);
    assert(
      durable(issue).budget.model_requests >= before.budget.model_requests,
    );
    assert(durable(issue).budget.wait_ms < before.budget.wait_ms + 60000);
    if (issue === 47) {
      assert.equal(resumed.session_recovery, "expired_or_deleted");
      const evidence = proof(),
        rejected = evidence.comments
          .find(([number]) => number === issue)[1]
          .filter((row) => row.body.includes("UNADMITTED_CLARIFICATION_REPLY")),
        messages = evidence.conversations.flatMap((item) => item.messages);
      assert.equal(rejected.length, 2);
      assert(
        rejected.every(
          (row) =>
            !messages.some((item) => item.id === `github-comment:${row.id}`),
        ),
      );
      assert(
        evidence.workflow
          .find((phase) => phase.phase === "investigations")
          .records.some((record) => record.context_comment_count === 0),
      );
    }
    if (nativeBefore && issue !== 47) {
      const continued = proof().conversations.find(
        (conversation) => conversation.id === before.question.conversation_id,
      );
      assert.equal(continued.native_id, nativeBefore.native_id);
      assert.equal(continued.request_digest, nativeBefore.request_digest);
    }
    if (mode === "monitor_clarification")
      assert.equal(resumed.pull_number, before.pull.number);
    assert.equal(
      proof().pulls.filter((pull) => pull.branch.endsWith(`/issue-${issue}`))
        .length,
      1,
    );
    assert.equal(questions().length, issue === 40 || issue === 49 ? 2 : 1);
    assert.deepEqual(proof().errors, []);
  }
  for (const [issue, boundary] of [
    [51, "checkpoint"],
    [52, "dispatch"],
  ]) {
    upstream(
      `/clarification-issue?issue=${issue}&mode=clarification_coding&boundary=${boundary}`,
      "POST",
    );
    const prefix = `${manager}-question-boundary-${boundary}`;
    launch(`${prefix}-interrupted`, issue);
    await waitUntil(
      () => proof().question_boundary?.held,
      `Question ${boundary} boundary was not reached`,
      300000,
    );
    const before = durable(issue);
    assert.equal(
      before.active,
      null,
      "Question publication retained an active worker deadline",
    );
    const beforeConversation = proof().conversations.find(
      (conversation) => conversation.id === before.question.conversation_id,
    );
    const questions = () =>
      proof()
        .comments.find(([number]) => number === issue)[1]
        .filter((row) => row.body.includes("Reply in a new issue comment."));
    assert.equal(questions().length, boundary === "checkpoint" ? 0 : 1);
    docker(["kill", "--signal", "KILL", `${prefix}-interrupted`]);
    await waitUntil(
      () => !inspect(`${prefix}-interrupted`).State.Running,
      "Interrupted question container stayed alive",
    );
    upstream("/release-question-boundary", "POST");
    discardTask(issue, true);
    launch(`${prefix}-restored`, issue, true);
    if (boundary === "checkpoint") {
      await finished(`${prefix}-restored`, "waiting", "needs_information");
      assert.equal(durable(issue).question.id, before.question.id);
      assert.equal(questions().length, 1);
      upstream(`/answer?issue=${issue}`, "POST");
      discardTask(issue, true);
      launch(`${prefix}-answered`, issue, true);
      await finished(`${prefix}-answered`, "waiting", "remote_checks");
    } else {
      await finished(`${prefix}-restored`, "waiting", "remote_checks");
      const continued = proof().conversations.find(
        (conversation) => conversation.id === before.question.conversation_id,
      );
      assert.equal(continued.native_id, beforeConversation.native_id);
      assert.equal(continued.messages.length, 1);
    }
    assert.equal(questions().length, 1);
    assert.equal(durable(issue).task_id, before.task_id);
    assert.equal(
      proof().pulls.filter((pull) => pull.branch.endsWith(`/issue-${issue}`))
        .length,
      1,
    );
    const completedBudget = durable(issue).budget;
    discardTask(issue, true);
    launch(`${prefix}-duplicate`, issue, true);
    await finished(`${prefix}-duplicate`, "waiting", "remote_checks");
    assert.equal(proof().requests.length, 0);
    assert.equal(
      durable(issue).budget.model_requests,
      completedBudget.model_requests,
    );
    assert.equal(durable(issue).budget.active_ms, completedBudget.active_ms);
  }
  return {
    sdk,
    actions: "passed",
    completed_scenarios: completed,
    credential_exclusion: "passed",
    no_public_listener: "passed",
    unrelated_issue: "untouched",
    native_session_artifacts: "passed",
  };
}
