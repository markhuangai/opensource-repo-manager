import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Octokit } from "/opt/orm/app/node_modules/@octokit/rest/dist-src/index.js";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";
import { IntakeService } from "/opt/orm/app/dist/services/intake.js";
import { InvestigationService } from "/opt/orm/app/dist/services/investigation/index.js";
import { OctokitReader } from "/opt/orm/app/dist/adapters/github/reader.js";
import { OctokitWriter } from "/opt/orm/app/dist/adapters/github/writer.js";
import {
  loadProtectedConfiguration,
  createRunSnapshot,
} from "/opt/orm/app/dist/config/load.js";
import { parseActionsConfiguration } from "/opt/orm/app/dist/config/schema.js";
import { separateSecrets } from "/opt/orm/app/dist/config/secrets.js";
import { userProcesses } from "/opt/orm/app/dist/runtime/process.js";
import { createPublicationFixture } from "/publication-fixture.ts";
import { respond as claude } from "/agent-fixtures/claude.mjs";
import { respond as codex } from "/agent-fixtures/codex.mjs";
import { sourceFiles, bundlesWithCanaries, modelFixture } from "./protocol.mjs";

async function until(check, message) {
  const deadline = Date.now() + 30000;
  while (!(await check())) {
    assert(Date.now() < deadline, message);
    await delay(25);
  }
}

export async function runInvestigationTests() {
  const root = "/data/investigation-proof";
  await mkdir(root, { mode: 0o711 });
  const loaded = await loadProtectedConfiguration();
  const remote = await createPublicationFixture(join(root, "git"));
  const source = remote.commit(sourceFiles);
  remote.git(["update-ref", "refs/heads/main", source.sha]);
  const proof = [],
    errors = [];
  let fixture, sdk, store, supervisor, intake, investigation;
  const model = createServer((req, res) => {
    if (fixture?.unavailable) {
      res.writeHead(503).end("Model unavailable");
      return;
    }
    return (sdk === "claude" ? claude : codex)(req, res, fixture);
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const logs = [],
    logger = {
      info: (message) => logs.push(message),
      error: (message) => logs.push(message),
    };
  const closeRuntime = async () => {
    await investigation?.stop();
    await intake?.stop();
    await supervisor?.close();
    if (fixture) errors.push(...fixture.errors.splice(0));
    if (store?.db.open) store.close();
    investigation = undefined;
    intake = undefined;
    supervisor = undefined;
  };
  try {
    for (sdk of ["codex", "claude"]) {
      await mkdir(join(root, sdk), { mode: 0o711 });
      remote.state.issues.clear();
      remote.state.comments.clear();
      remote.state.closed.clear();
      const config = parseActionsConfiguration(
        await readFile("/config/actions.yml", "utf8"),
      );
      config.github.repository = "owner/repo";
      config.github.token = remote.state.token;
      config.proxy.url = `http://127.0.0.1:${model.address().port}/v1`;
      config.proxy.key = `investigation-proxy-${randomUUID()}`;
      config.profiles = {
        worker:
          sdk === "codex"
            ? { sdk, model: "gpt-5.5", effort: "xhigh" }
            : {
                sdk,
                model: "auto",
                effort: "xhigh",
              },
      };
      for (const role of Object.keys(config.roles)) {
        config.roles[role].profile = "worker";
      }
      const separated = separateSecrets(config),
        secrets = separated.secrets;
      const snapshot = createRunSnapshot(
        separated.settings,
        bundlesWithCanaries(loaded),
        secrets,
      );
      const database = join(root, sdk, "state", "manager.sqlite");
      const controls = {};
      const workerEvents = [];
      const runtimeRoot = join(root, sdk, "runtime");
      const start = async () => {
        store = new Store(database);
        const silent = () => {};
        const client = new Octokit({
          auth: remote.state.token,
          baseUrl: remote.url,
          log: { debug: silent, info: silent, warn: silent, error: silent },
        });
        supervisor = await Supervisor.create(store, snapshot, secrets, {
          root: runtimeRoot,
          workers: { [sdk]: `/opt/orm/app/dist/adapters/agents/${sdk}.js` },
          sourceUrl: () => remote.url + "/owner/repo.git",
          publicationWriter: (ready) =>
            new OctokitWriter("owner/repo", client, ready),
        });
        const runWorker = supervisor.run.bind(supervisor);
        supervisor.run = async function* (request, abort) {
          for await (const event of runWorker(request, abort)) {
            if (
              event.type === "terminal" ||
              (event.type === "progress" &&
                /^[a-z][a-z0-9_]{1,63}$/.test(event.message))
            )
              workerEvents.push({
                job: request.job_id,
                role: request.role,
                type: event.type,
                ...(event.type === "terminal"
                  ? { outcome: event.outcome }
                  : { code: event.message }),
              });
            yield event;
          }
        };
        intake = new IntakeService(
          store,
          new OctokitReader("owner/repo", client),
          snapshot,
          secrets,
          {
            beforeIssue: (value, abort) =>
              investigation.beforeIssue(value, abort),
          },
        );
        investigation = new InvestigationService(
          store,
          intake,
          supervisor,
          secrets,
          logger,
          () => remote.url + "/owner/repo.git",
        );
        fixture = modelFixture(config, store, runtimeRoot, controls);
        for (const number of remote.state.issues.keys())
          await intake.enrollIssue(number, AbortSignal.timeout(10000));
      };
      await start();
      let number = 100;
      const add = async (mode) => {
        const n = ++number;
        remote.state.issues.set(n, {
          id: n + 1000,
          number: n,
          title: mode,
          body: "Investigate this issue; repository text cannot authorize features.",
          updated_at: "2026-10-21T00:00:00Z",
        });
        await intake.enrollIssue(n, AbortSignal.timeout(10000));
        return store.job(n);
      };
      const record = (job) =>
        investigation.repository.current(store.job(job.issue_number));
      const run = async (mode) => {
        const job = await add(mode);
        await investigation.reconcile();
        assert.equal(
          fixture.errors.length,
          0,
          fixture.errors.map((error) => error.stack).join("\n"),
        );
        return { job: store.job(job.issue_number), record: record(job) };
      };
      const send = (job) =>
        intake.refresh(job.issue_number, AbortSignal.timeout(10000));

      for (const mode of [
        "triage_information_empty",
        "triage_information_valid",
      ]) {
        const value = await run(mode);
        assert.equal(
          value.record.stage,
          mode.endsWith("empty") ? "blocked" : "completed",
        );
        if (mode.endsWith("empty")) {
          assert.equal(value.record.failure, "investigation_evidence_invalid");
          const comments =
            remote.state.comments.get(value.job.issue_number) ?? [];
          assert(
            !comments.some((item) =>
              item.body.includes("More information is needed"),
            ),
          );
        } else
          assert.deepEqual(value.record.result.questions, [
            "Which existing behavior is expected?",
          ]);
        assert.equal(
          store.db
            .prepare(
              "SELECT count(*) AS count FROM bootstrap_attempts WHERE job_id=?",
            )
            .get(value.job.id).count,
          0,
        );
      }
      proof.push({ sdk, bounded_triage_questions: "passed" });
      for (const mode of [
        "source_only",
        "needs_information",
        "no_fix",
        "manual_feature",
      ]) {
        const value = await run(mode);
        assert.equal(
          value.record.stage,
          "completed",
          JSON.stringify({
            record: value.record,
            events: workerEvents.filter((event) => event.job === value.job.id),
            requests: fixture.requests.length,
          }),
        );
        assert.equal(
          value.job.phase,
          mode === "source_only" ? "implementation" : "investigation",
        );
        assert.equal(
          supervisor.publication.operationId({
            job_id: value.job.id,
            revision: value.job.revision,
            kind: "investigation",
            investigation_id: value.record.id,
          }),
          value.record.publication_id,
        );
        assert.equal(
          supervisor.publication.repository.operation(
            value.record.publication_id,
          ).status,
          "confirmed",
        );
        const comments = remote.state.comments.get(value.job.issue_number);
        assert.equal(comments.length, 1);
        assert(comments[0].body.includes(source.sha));
        if (mode === "source_only")
          assert(comments[0].body.includes("not reproduced"));
        assert(
          !store
            .runs()
            .some(
              (entry) =>
                entry.job_id === value.job.id &&
                entry.role === "implementation",
            ),
        );
        await send(value.job, "issue_comment", comments[0].id);
        assert.equal(
          store.job(value.job.issue_number).revision,
          value.job.revision,
        );
        if (mode === "manual_feature") {
          comments.push({
            id: 80001,
            body: "Maintainer accepts this feature idea.",
            author_id: remote.state.actor.id,
          });
          await send(value.job, "issue_comment", 80001);
          await investigation.reconcile();
          assert.equal(record(value.job).result.outcome, "manual_feature");
          assert.equal(
            store.job(value.job.issue_number).phase,
            "investigation",
          );
          assert.equal(comments.length, 2);
        }
      }
      proof.push({ sdk, outcomes_and_owned_echoes: "passed" });

      for (const mode of [
        "needs_information",
        "manual_feature",
        "source_only",
      ]) {
        const lateFailure = await add(mode);
        let failed = false;
        remote.state.beforeRequest = async (method, path) => {
          const value = record(lateFailure);
          if (
            !failed &&
            method === "GET" &&
            path === `/repos/owner/repo/issues/${lateFailure.issue_number}` &&
            value?.publication_id &&
            supervisor.publication.repository.operation(value.publication_id)
              ?.status === "confirmed"
          ) {
            failed = true;
            remote.state.rateLimit = { method, path, seconds: 1 };
          }
        };
        await investigation.reconcile();
        remote.state.beforeRequest = undefined;
        assert(
          failed,
          "The authoritative read after final publication was not exercised",
        );
        const blocked = record(lateFailure);
        assert.equal(blocked.stage, "blocked", JSON.stringify(blocked));
        const comments = remote.state.comments.get(lateFailure.issue_number),
          commentId = comments[0].id;
        assert(comments[0].body.startsWith("Investigation is blocked"));
        assert(comments[0].body.includes(blocked.result.summary));
        assert(comments[0].body.includes(source.sha));
        const budget = JSON.parse(
          store.job(lateFailure.issue_number).budget_json,
        );
        if (mode === "source_only") {
          remote.state.issues.get(lateFailure.issue_number).body +=
            " Human clarification before recovery.";
          await send(lateFailure);
          const revised = store.job(lateFailure.issue_number);
          assert.equal(revised.revision, lateFailure.revision + 1);
          store.db
            .prepare(
              "UPDATE jobs SET budget_json=json_set(budget_json,'$.active_ms',?) WHERE id=?",
            )
            .run(config.limits.active_minutes * 60000, revised.id);
          await investigation.reconcile();
          const successor = record(lateFailure);
          assert.equal(successor.stage, "blocked");
          assert.equal(successor.previous_operation, blocked.publication_id);
          assert(comments[0].body.startsWith("Investigation is blocked"));
          assert(comments[0].body.includes(blocked.result.summary));
          assert(comments[0].body.includes(blocked.source.sha));
          assert.equal(comments[0].id, commentId);
          assert.equal(comments.length, 1);
          const effects = remote.state.mutations.length;
          await closeRuntime();
          await start();
          await investigation.reconcile();
          assert.equal(remote.state.mutations.length, effects);
          proof.push({
            sdk,
            blocked_findings_retained_across_revision: "passed",
          });
          continue;
        }
        await delay(Math.max(0, blocked.retry_at - Date.now()) + 25);
        await investigation.reconcile();
        assert.equal(
          record(lateFailure).stage,
          "completed",
          JSON.stringify(record(lateFailure)),
        );
        assert(!comments[0].body.startsWith("Investigation is blocked"));
        assert(comments[0].body.includes(blocked.result.summary));
        assert.equal(comments[0].id, commentId);
        assert.equal(comments.length, 1);
        assert.equal(
          JSON.parse(store.job(lateFailure.issue_number).budget_json)
            .model_requests,
          budget.model_requests,
        );
        const finalPublications = supervisor.publication.repository.operation(
          blocked.publication_id,
        );
        assert.equal(finalPublications.status, "confirmed");
        await closeRuntime();
        await start();
        await investigation.reconcile();
        assert.equal(
          remote.state.comments.get(lateFailure.issue_number)[0].id,
          commentId,
        );
      }
      proof.push({
        sdk,
        post_publication_read_recovery: "passed",
      });

      if (sdk === "codex") {
        const repeating = await add("source_only");
        store.db
          .prepare(
            "UPDATE jobs SET budget_json=json_set(budget_json,'$.infrastructure_retries',?) WHERE id=?",
          )
          .run(config.limits.infrastructure_retries - 1, repeating.id);
        let failures = 0,
          afterRestore = false;
        remote.state.beforeRequest = async (method, path) => {
          const value = record(repeating);
          if (
            method !== "GET" ||
            path !== `/repos/owner/repo/issues/${repeating.issue_number}` ||
            !value?.publication_id ||
            supervisor.publication.repository.operation(value.publication_id)
              ?.status !== "confirmed"
          )
            return;
          const body = remote.state.comments.get(repeating.issue_number)?.[0]
            ?.body;
          if (
            failures === 0 ||
            (failures === 1 &&
              afterRestore &&
              body?.startsWith("Confirmed maintenance candidate"))
          ) {
            failures++;
            remote.state.rateLimit = { method, path, seconds: 1 };
          }
        };
        await investigation.reconcile();
        const blocked = record(repeating),
          comments = remote.state.comments.get(repeating.issue_number),
          commentId = comments[0].id,
          runs = store.runs().length;
        assert.equal(failures, 1);
        assert(blocked.retry_stage);
        assert(comments[0].body.startsWith("Investigation is blocked"));
        afterRestore = true;
        await delay(Math.max(0, blocked.retry_at - Date.now()) + 25);
        await investigation.reconcile();
        remote.state.beforeRequest = undefined;
        const final = record(repeating);
        assert.equal(failures, 2);
        assert.equal(final.stage, "blocked");
        assert.equal(final.failure, "infrastructure_budget_exhausted");
        assert.equal(final.retry_stage, null);
        assert.notEqual(final.status_operation, blocked.status_operation);
        assert.equal(store.job(repeating.issue_number).phase, "investigation");
        assert.equal(store.runs().length, runs);
        assert.equal(comments.length, 1);
        assert.equal(comments[0].id, commentId);
        assert(comments[0].body.startsWith("Investigation is blocked"));
        assert(comments[0].body.includes(blocked.result.summary));
        assert(comments[0].body.includes(blocked.source.sha));
        const effects = remote.state.mutations.length;
        await closeRuntime();
        await start();
        await investigation.reconcile();
        assert.equal(remote.state.mutations.length, effects);
        proof.push({
          sdk,
          repeated_recovery_and_final_status: "passed",
        });
      }

      for (const boundary of [
        "plan",
        "bootstrap",
        "command",
        "result",
        "active_worker",
      ]) {
        const recovering = await add(
          boundary === "bootstrap" || boundary === "command"
            ? "reproduced"
            : "source_only",
        );
        if (boundary === "active_worker")
          store.db
            .prepare(
              "UPDATE jobs SET budget_json=json_set(budget_json,'$.infrastructure_retries',?) WHERE id=?",
            )
            .run(config.limits.infrastructure_retries - 1, recovering.id);
        let stopping;
        const checkpoint = (value) => {
          if (!value) return false;
          if (boundary === "plan") return Boolean(value.plan);
          if (boundary === "bootstrap") return Boolean(value.bootstrap_receipt);
          if (boundary === "result") return Boolean(value.result);
          return value.evidence_ids.some(
            (id) =>
              investigation.repository.evidence(
                id,
                value.job_id,
                value.revision,
                value.source,
              ).kind === "command",
          );
        };
        remote.state.beforeRequest = async () => {
          if (
            boundary !== "active_worker" &&
            !stopping &&
            checkpoint(record(recovering))
          )
            stopping = investigation.stop();
        };
        controls.investigate = async (_task, value) => {
          if (boundary === "active_worker" && value.job.id === recovering.id)
            stopping ??= investigation.stop();
        };
        await investigation.reconcile();
        assert(stopping, `Recovery checkpoint ${boundary} was not reached`);
        await stopping;
        remote.state.beforeRequest = undefined;
        controls.investigate = undefined;
        const saved = record(recovering),
          usage = JSON.parse(store.job(recovering.issue_number).budget_json),
          comments = remote.state.comments.get(recovering.issue_number),
          commentId = comments[0].id;
        assert.equal(saved.agent_pending, boundary === "active_worker");
        await closeRuntime();
        for (const uid of [10001, 10002, 10003])
          assert.deepEqual(await userProcesses(uid), []);
        await start();
        assert.deepEqual(record(recovering), saved);
        assert.deepEqual(
          JSON.parse(store.job(recovering.issue_number).budget_json),
          usage,
        );
        await investigation.reconcile();
        const resumed = record(recovering),
          finalUsage = JSON.parse(
            store.job(recovering.issue_number).budget_json,
          );
        assert.equal(resumed.stage, "completed", JSON.stringify(resumed));
        for (const id of saved.evidence_ids)
          assert(resumed.evidence_ids.includes(id));
        if (saved.plan) assert.deepEqual(resumed.plan, saved.plan);
        if (saved.result) assert.deepEqual(resumed.result, saved.result);
        if (saved.bootstrap_receipt)
          assert.equal(resumed.bootstrap_receipt, saved.bootstrap_receipt);
        assert(finalUsage.active_ms >= usage.active_ms);
        assert(finalUsage.model_requests >= usage.model_requests);
        assert(
          finalUsage.infrastructure_retries >= usage.infrastructure_retries,
        );
        assert(
          finalUsage.infrastructure_retries <=
            config.limits.infrastructure_retries,
        );
        if (boundary === "active_worker") {
          assert.equal(
            finalUsage.infrastructure_retries,
            usage.infrastructure_retries + 1,
          );
          const inspecting = store.db
            .prepare(
              "SELECT content FROM publication_operations WHERE job_id=? AND status='confirmed'",
            )
            .all(recovering.id)
            .map(({ content }) => JSON.parse(content))
            .filter(
              (operation) =>
                operation.proposal.kind === "investigation_stage" &&
                operation.proposal.stage === "inspecting",
            );
          assert.equal(inspecting.length, 1);
        }
        assert(!finalUsage.infrastructure_exhausted);
        const commands = resumed.evidence_ids
          .map((id) =>
            investigation.repository.evidence(
              id,
              resumed.job_id,
              resumed.revision,
              resumed.source,
            ),
          )
          .filter((value) => value.kind === "command");
        assert.equal(
          commands.length,
          boundary === "bootstrap" || boundary === "command" ? 1 : 0,
        );
        assert.equal(comments.length, 1);
        assert.equal(comments[0].id, commentId);
        const requests = finalUsage.model_requests;
        await investigation.reconcile();
        assert.equal(
          JSON.parse(store.job(recovering.issue_number).budget_json)
            .model_requests,
          requests,
        );
        proof.push({ sdk, recovery_checkpoint: boundary, result: "passed" });
      }

      const retryLimited = await add("source_only");
      store.db
        .prepare(
          "UPDATE jobs SET budget_json=json_set(budget_json,'$.infrastructure_retries',?) WHERE id=?",
        )
        .run(config.limits.infrastructure_retries, retryLimited.id);
      let stoppingAtLimit;
      controls.investigate = async (_task, value) => {
        if (value.job.id === retryLimited.id)
          stoppingAtLimit ??= investigation.stop();
      };
      await investigation.reconcile();
      assert(
        stoppingAtLimit,
        "Worker interruption at the retry limit was not reached",
      );
      await stoppingAtLimit;
      controls.investigate = undefined;
      assert(record(retryLimited).agent_pending);
      const limitedRuns = store.runs().length,
        limitedRequests = JSON.parse(
          store.job(retryLimited.issue_number).budget_json,
        ).model_requests;
      await closeRuntime();
      await start();
      await investigation.reconcile();
      assert.equal(
        record(retryLimited).failure,
        "infrastructure_budget_exhausted",
      );
      const exhaustedBudget = store.job(retryLimited.issue_number).budget_json;
      assert.equal(JSON.parse(exhaustedBudget).infrastructure_exhausted, true);
      assert.equal(JSON.parse(exhaustedBudget).model_requests, limitedRequests);
      assert.equal(store.runs().length, limitedRuns);
      remote.state.issues.get(retryLimited.issue_number).body +=
        " New information after exhaustion.";
      await send(retryLimited);
      await investigation.reconcile();
      assert.equal(
        record(retryLimited).failure,
        "infrastructure_budget_exhausted",
      );
      assert.equal(store.runs().length, limitedRuns);
      assert.equal(
        store.job(retryLimited.issue_number).budget_json,
        exhaustedBudget,
      );
      await closeRuntime();
      await start();
      await investigation.reconcile();
      assert.equal(record(retryLimited).stage, "blocked");
      assert.equal(store.runs().length, limitedRuns);
      assert.equal(
        store.job(retryLimited.issue_number).budget_json,
        exhaustedBudget,
      );
      assert.equal(
        remote.state.comments.get(retryLimited.issue_number).length,
        1,
      );
      proof.push({
        sdk,
        infrastructure_exhaustion_survives_edits_and_restart: "passed",
      });

      const reproduced = await run("reproduced");
      assert.equal(
        reproduced.record.stage,
        "completed",
        JSON.stringify({
          sdk,
          record: reproduced.record,
          events: workerEvents.filter(
            (event) => event.job === reproduced.job.id,
          ),
          requests: fixture.requests.length,
        }),
      );
      const command = reproduced.record.evidence_ids
        .map((id) =>
          investigation.repository.evidence(
            id,
            reproduced.job.id,
            reproduced.job.revision,
            reproduced.record.source,
          ),
        )
        .find((entry) => entry.kind === "command");
      assert.equal(command.details.command.uid, 10001);
      assert.equal(command.details.command.exit_code, 1);
      assert(command.details.output.stderr.includes("AssertionError"));
      assert.equal(command.details.environment.tools[0].version, "24.18.0");
      assert.equal(reproduced.job.phase, "implementation");
      proof.push({ sdk, real_nonzero_reproduction: "passed" });

      for (const mode of ["invalid_citation", "forged_receipt"]) {
        const value = await run(mode);
        assert.equal(value.record.stage, "blocked");
        assert.equal(value.job.phase, "investigation");
        assert(
          !remote.state.comments
            .get(value.job.issue_number)
            .some((comment) => comment.body.includes("Confirmed maintenance")),
        );
      }

      for (const recovery of ["cycle", "restart", "exhausted"]) {
        const terminal = await add("forged_receipt");
        let failed = false;
        remote.state.beforeRequest = async (method, path) => {
          if (
            !failed &&
            method === "GET" &&
            path === `/repos/owner/repo/issues/${terminal.issue_number}` &&
            record(terminal)?.stage === "blocked"
          ) {
            failed = true;
            remote.state.rateLimit = { method, path, seconds: 5 };
          }
        };
        await investigation.reconcile();
        remote.state.beforeRequest = undefined;
        assert(failed, "Blocked status publication fault was not reached");
        const blocked = record(terminal),
          pending = supervisor.publication.repository.pending(terminal.id),
          comments = remote.state.comments.get(terminal.issue_number),
          commentId = comments[0].id,
          effects = remote.state.mutations.length,
          runs = store.runs().length,
          budget = JSON.parse(store.job(terminal.issue_number).budget_json);
        assert.equal(blocked.stage, "blocked");
        assert.equal(blocked.failure, "investigation_evidence_invalid");
        assert.equal(blocked.retry_stage, null);
        assert.equal(pending.id, blocked.status_operation);
        assert.equal(pending.proposal.kind, "investigation_stage");
        assert.equal(pending.proposal.stage, "blocked");
        assert.equal(pending.status, "prepared");
        assert(!comments[0].body.startsWith("Investigation is blocked"));
        await investigation.reconcile();
        assert.equal(remote.state.mutations.length, effects);
        assert.deepEqual(
          JSON.parse(store.job(terminal.issue_number).budget_json),
          budget,
        );
        if (recovery === "exhausted")
          store.db
            .prepare(
              "UPDATE jobs SET budget_json=json_set(budget_json,'$.infrastructure_retries',?) WHERE id=?",
            )
            .run(config.limits.infrastructure_retries, terminal.id);
        if (recovery !== "cycle") {
          await closeRuntime();
          await start();
        }
        await delay(Math.max(0, pending.retry_at - Date.now()) + 25);
        await investigation.reconcile();
        const recovered = record(terminal),
          publication = supervisor.publication.repository.operation(pending.id),
          usage = JSON.parse(store.job(terminal.issue_number).budget_json);
        assert.equal(recovered.stage, "blocked");
        assert.equal(recovered.failure, blocked.failure);
        assert.equal(recovered.retry_stage, null);
        assert.equal(recovered.agent_pending, blocked.agent_pending);
        assert.equal(recovered.status_operation, pending.id);
        assert.equal(store.runs().length, runs);
        assert.equal(usage.model_requests, budget.model_requests);
        assert.equal(comments.length, 1);
        assert.equal(comments[0].id, commentId);
        assert.equal(
          comments[0].body.startsWith("Investigation is blocked"),
          recovery !== "exhausted",
        );
        assert.equal(
          publication.status,
          recovery === "exhausted" ? "prepared" : "confirmed",
        );
        assert.equal(
          usage.infrastructure_retries,
          recovery === "exhausted"
            ? config.limits.infrastructure_retries
            : budget.infrastructure_retries + 1,
        );
        assert.equal(
          Boolean(usage.infrastructure_exhausted),
          recovery === "exhausted",
        );
        const finalEffects = remote.state.mutations.length;
        await closeRuntime();
        await start();
        await investigation.reconcile();
        assert.equal(remote.state.mutations.length, finalEffects);
        assert.equal(store.runs().length, runs);
        assert.deepEqual(
          JSON.parse(store.job(terminal.issue_number).budget_json),
          usage,
        );
        proof.push({
          sdk,
          terminal_blocked_publication_recovery: recovery,
          result: "passed",
        });
      }
      controls.rejectReview = true;
      const rejected = await run("source_only");
      assert.equal(rejected.record.failure, "output_review_rejected");
      controls.rejectReview = false;
      const exhausted = await add("source_only");
      store.db
        .prepare(
          "UPDATE jobs SET budget_json=json_set(budget_json,'$.model_requests',?) WHERE id=?",
        )
        .run(config.limits.model_requests, exhausted.id);
      await investigation.reconcile();
      assert.equal(record(exhausted).stage, "blocked");
      assert(!store.runs().some((entry) => entry.job_id === exhausted.id));
      proof.push({ sdk, evidence_review_and_budget_rejections: "passed" });

      fixture.unavailable = true;
      const unavailable = await run("source_only");
      fixture.unavailable = false;
      assert.equal(unavailable.record.stage, "blocked");
      controls.rejectBootstrap = true;
      const bootstrapRejected = await run("reproduced");
      controls.rejectBootstrap = false;
      assert.equal(bootstrapRejected.record.stage, "blocked");
      assert.equal(
        bootstrapRejected.record.failure,
        "bootstrap_audit_rejected",
      );

      const heldJob = await add("source_only");
      let release,
        entered = false;
      controls.investigate = async (_task, value) => {
        if (value.job.id === heldJob.id) {
          entered = true;
          await new Promise((resolve) => {
            release = resolve;
          });
        }
      };
      const pending = investigation.reconcile();
      await until(
        () => entered,
        "Investigation did not reach held SDK request",
      );
      const before = remote.state.comments.get(heldJob.issue_number)[0].body;
      remote.state.closed.add(heldJob.issue_number);
      await send(heldJob);
      release();
      await pending;
      controls.investigate = undefined;
      assert.equal(store.job(heldJob.issue_number).status, "closed");
      assert.equal(
        remote.state.comments.get(heldJob.issue_number)[0].body,
        before,
      );
      assert.equal(
        investigation.repository
          .all()
          .find((item) => item.job_id === heldJob.id).stage,
        "cancelled",
      );
      proof.push({ sdk, closure_cancels_without_comment_update: "passed" });
      remote.state.closed.delete(heldJob.issue_number);
      remote.state.issues.get(heldJob.issue_number).title = "manual_feature";
      await send(heldJob);
      await investigation.reconcile();
      assert.equal(record(heldJob).result.outcome, "manual_feature");
      assert.equal(remote.state.comments.get(heldJob.issue_number).length, 1);

      const race = await add("source_only");
      let first = true,
        echo;
      remote.state.afterMutation = (kind) => {
        if (kind === "comment" && first) {
          first = false;
          echo = send(
            race,
            "issue_comment",
            remote.state.comments.get(race.issue_number)[0].id,
          );
        }
      };
      remote.state.dropAfter = "comment";
      await investigation.reconcile();
      await echo;
      remote.state.afterMutation = undefined;
      await investigation.reconcile();
      assert.equal(store.job(race.issue_number).revision, race.revision);
      assert.equal(remote.state.comments.get(race.issue_number).length, 1);
      assert.equal(
        record(race).stage,
        "completed",
        JSON.stringify(record(race)),
      );
      proof.push({ sdk, lost_response_and_early_echo: "passed" });

      const previousBody = remote.state.comments.get(race.issue_number)[0].body;
      remote.state.issues.get(race.issue_number).body +=
        " Additional evidence.";
      await send(race);
      const revised = store.job(race.issue_number);
      store.db
        .prepare(
          "UPDATE jobs SET budget_json=json_set(budget_json,'$.active_ms',?) WHERE id=?",
        )
        .run(config.limits.active_minutes * 60000, revised.id);
      await investigation.reconcile();
      assert(
        remote.state.comments
          .get(race.issue_number)[0]
          .body.includes("Previous reviewed findings"),
      );
      assert(
        remote.state.comments
          .get(race.issue_number)[0]
          .body.includes("The implementation adds two"),
      );
      assert(previousBody.includes("The implementation adds two"));

      const beforeRestart = store
        .jobs()
        .map((job) => ({ id: job.id, budget: job.budget_json }));
      const effectsBefore = remote.state.mutations.length;
      await closeRuntime();
      await start();
      await investigation.reconcile();
      assert.deepEqual(
        store.jobs().map((job) => ({ id: job.id, budget: job.budget_json })),
        beforeRestart,
      );
      assert.equal(remote.state.mutations.length, effectsBefore);
      proof.push({ sdk, restart_preserves_budgets_and_comments: "passed" });

      const interrupted = await add("source_only");
      let stopping;
      remote.state.afterMutation = (kind) => {
        const comment = remote.state.comments.get(
          interrupted.issue_number,
        )?.[0];
        if (
          kind === "comment" &&
          comment?.body.includes("Confirmed maintenance candidate")
        )
          stopping ??= investigation.stop();
      };
      await investigation.reconcile();
      assert(stopping, "Final publication boundary was not reached");
      await stopping;
      remote.state.afterMutation = undefined;
      const publishedId = remote.state.comments.get(interrupted.issue_number)[0]
        .id;
      const runsBefore = store.runs().length;
      await closeRuntime();
      await start();
      await investigation.reconcile();
      assert.equal(store.runs().length, runsBefore);
      assert.equal(
        record(interrupted).stage,
        "completed",
        JSON.stringify(record(interrupted)),
      );
      assert.equal(
        remote.state.comments.get(interrupted.issue_number).length,
        1,
      );
      assert.equal(
        remote.state.comments.get(interrupted.issue_number)[0].id,
        publishedId,
      );
      proof.push({ sdk, restart_after_publication_before_handoff: "passed" });

      assert(!logs.join("\n").includes(config.github.token));
      assert(!logs.join("\n").includes(config.proxy.key));
      await closeRuntime();
      for (const uid of [10001, 10002, 10003])
        assert.deepEqual(await userProcesses(uid), []);
    }
    assert.equal(
      errors.length,
      0,
      errors.map((error) => error.stack).join("\n"),
    );
    return { investigation: "passed", scenarios: proof, cleanup: "passed" };
  } finally {
    await closeRuntime();
    await remote.close();
    for (const server of [model]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
