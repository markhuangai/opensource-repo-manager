import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Octokit } from "/opt/orm/app/node_modules/@octokit/rest/dist-src/index.js";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";
import { IntakeService } from "/opt/orm/app/dist/services/intake.js";
import { InvestigationService } from "/opt/orm/app/dist/services/investigation/index.js";
import { ImplementationService } from "/opt/orm/app/dist/services/implementation/index.js";
import { verifyCandidate } from "/opt/orm/app/dist/services/implementation/verify.js";
import { OctokitReader } from "/opt/orm/app/dist/adapters/github/reader.js";
import { OctokitWriter } from "/opt/orm/app/dist/adapters/github/writer.js";
import {
  loadProtectedConfiguration,
  createRunSnapshot,
} from "/opt/orm/app/dist/config/load.js";
import { parseActionsConfiguration } from "/opt/orm/app/dist/config/schema.js";
import { separateSecrets } from "/opt/orm/app/dist/config/secrets.js";
import {
  sourceProcesses,
  userProcesses,
} from "/opt/orm/app/dist/runtime/process.js";
import {
  createPublicationFixture,
  makeCheck,
  makeThread,
} from "/publication-fixture.ts";
import { PrMonitorService } from "/opt/orm/app/dist/services/pr-monitor/index.js";
import { evaluateReadiness } from "/opt/orm/app/dist/services/pr-monitor/policy.js";
import { respond as claude } from "/agent-fixtures/claude.mjs";
import { respond as codex } from "/agent-fixtures/codex.mjs";
import {
  sourceFiles,
  bundlesWithCanaries,
  modelFixture,
  maintenanceCommand,
} from "/investigation-fixtures/protocol.mjs";
import { performance } from "node:perf_hooks";
import {
  implementationScenarios,
  verifyImplementationReceipts,
} from "/container-suites.mjs";

export async function runImplementationTests(sdks, suite) {
  assert(
    sdks.length === 1 && sdks.every((sdk) => ["codex", "claude"].includes(sdk)),
  );
  assert(
    Object.hasOwn(implementationScenarios, suite),
    "Unknown implementation suite",
  );
  const completedScenarios = [];
  const root = "/data/implementation-proof";
  await mkdir(root, { mode: 0o711 });
  const loaded = await loadProtectedConfiguration();
  const logs = [],
    errors = [],
    cleanupFailures = [],
    proof = [];
  let fixture,
    sdk,
    store,
    supervisor,
    intake,
    investigation,
    implementation,
    monitor,
    remote,
    receipt;
  const controls = {};
  const model = createServer((req, res) =>
    (sdk === "claude" ? claude : codex)(req, res, fixture),
  );
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const logger = {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
  };
  const recordWorkflowFailure = () => {
    const job = store?.db.open ? store.jobs().at(-1) : undefined;
    if (!job) return;
    const phases = [
      ["investigation", investigation?.repository.current(job)],
      ["implementation", implementation?.repository.current(job)],
      ["monitor", monitor?.repository.get(job.id)],
    ];
    errors.push(
      new Error(
        `Workflow state: ${JSON.stringify({
          job: {
            id: job.id,
            revision: job.revision,
            phase: job.phase,
            status: job.status,
          },
          phases: phases.map(([phase, record]) => ({
            phase,
            stage: record?.stage ?? null,
            failure: record?.failure ?? null,
            retry_at: record?.retry_at ?? null,
          })),
        })}`,
      ),
    );
  };
  const closeRuntime = async () => {
    await monitor?.stop();
    await investigation?.stop();
    await intake?.stop();
    await supervisor?.close();
    if (fixture) errors.push(...fixture.errors.splice(0));
    if (store?.db.open) store.close();
    investigation = undefined;
    monitor = undefined;
    intake = undefined;
    supervisor = undefined;
    store = undefined;
    fixture = undefined;
  };
  try {
    for (sdk of sdks) {
      let phaseStarted = performance.now();
      const complete = (id) => {
        const now = performance.now();
        completedScenarios.push({ id, duration_ms: now - phaseStarted });
        phaseStarted = now;
      };
      const sdkRoot = join(root, sdk);
      await mkdir(sdkRoot, { mode: 0o711 });
      remote = await createPublicationFixture(join(sdkRoot, "git"));
      const source = remote.commit(sourceFiles);
      remote.git(["update-ref", "refs/heads/main", source.sha]);
      const config = parseActionsConfiguration(
        await readFile("/config/actions.yml", "utf8"),
      );
      config.github.repository = "owner/repo";
      config.github.token = remote.state.token;
      config.proxy.url = `http://127.0.0.1:${model.address().port}/v1`;
      config.proxy.key = `implementation-proxy-${randomUUID()}`;
      config.profiles = {
        worker:
          sdk === "codex"
            ? { sdk, model: "gpt-5.5", effort: "xhigh" }
            : {
                sdk,
                model: "auto",
                behaves_as: "claude-opus-4-8",
                effort: "xhigh",
              },
      };
      for (const role of Object.keys(config.roles)) {
        config.roles[role].profile = "worker";
      }
      let snapshot, secrets;
      const configure = () => {
        const separated = separateSecrets(config);
        secrets = separated.secrets;
        snapshot = createRunSnapshot(
          separated.settings,
          bundlesWithCanaries(loaded),
          secrets,
        );
      };
      configure();
      const database = join(sdkRoot, "state", "manager.sqlite"),
        runtimeRoot = join(sdkRoot, "runtime");
      const start = async () => {
        store = new Store(database);
        const silent = () => {},
          client = new Octokit({
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
        for (const [method, requestIndex] of [
          ["run", 0],
          ["runReview", 1],
        ]) {
          const run = supervisor[method].bind(supervisor);
          supervisor[method] = async function* (...args) {
            try {
              yield* run(...args);
            } catch (error) {
              if (
                error.code === "cleanup_failed" &&
                cleanupFailures.length < 16
              )
                cleanupFailures.push({
                  job: args[requestIndex].job_id,
                  role: args[requestIndex].role,
                  codes: [
                    error.code,
                    error.cause?.code,
                    error.cause?.cause?.code,
                  ].filter(
                    (code) =>
                      typeof code === "string" &&
                      /^[A-Za-z_]{1,64}$/.test(code) &&
                      !secrets.containsCredentials(code),
                  ),
                });
              throw error;
            }
          };
        }
        intake = new IntakeService(
          store,
          new OctokitReader("owner/repo", client),
          snapshot,
          secrets,
          {
            beforeIssue: (value, signal) =>
              investigation.beforeIssue(value, signal),
          },
        );
        implementation = new ImplementationService(
          store,
          intake,
          supervisor,
          secrets,
          logger,
        );
        investigation = new InvestigationService(
          store,
          intake,
          supervisor,
          secrets,
          logger,
          () => remote.url + "/owner/repo.git",
          implementation,
        );
        fixture = modelFixture(config, store, runtimeRoot, controls);
        for (const number of remote.state.issues.keys())
          await intake.enrollIssue(number, AbortSignal.timeout(10000));
      };
      await start();
      let number = 200;
      const add = async (mode) => {
        const n = ++number;
        remote.state.issues.set(n, {
          id: n + 1000,
          number: n,
          title: mode,
          body: "Fix only the documented existing maintenance defect.",
          updated_at: "2026-10-21T00:00:00Z",
        });
        await intake.enrollIssue(n, AbortSignal.timeout(10000));
        await investigation.reconcile();
        return store.job(n);
      };
      const record = (job) =>
        implementation.repository
          .all()
          .findLast((item) => item.job_id === job.id);
      const advance = async (job) => {
        await investigation.reconcile();
        assert.equal(
          fixture.errors.length,
          0,
          fixture.errors.map((error) => error.stack).join("\n"),
        );
        return record(job);
      };
      const run = async (mode, handler) => {
        controls.implementation = handler;
        const job = await add(mode),
          result = await advance(job);
        controls.implementation = undefined;
        return { job, result };
      };
      const noPull = (job) =>
        assert.equal(
          supervisor.publication.repository.target(job.id).pull,
          null,
        );
      if (suite === "implementation-candidates") {
        const passed = await run("reproduced");
        assert.equal(
          passed.result.stage,
          "remote_review",
          JSON.stringify(passed.result),
        );
        const investigated = investigation.repository.current(
          store.job(passed.job.issue_number),
        );
        assert.deepEqual(investigated.source, source);
        const reproduction = investigated.evidence_ids
          .map((id) =>
            investigation.repository.evidence(
              id,
              passed.job.id,
              passed.job.revision,
              investigated.source,
            ),
          )
          .find((item) => item.kind === "command");
        assert.equal(reproduction.details.command.exit_code, 1);
        const test = passed.result.tests.find(
          (item) => item.id === passed.result.test_id,
        );
        assert.equal(test.state, "passed");
        assert(test.commands.length >= 2);
        assert(
          test.commands.every(
            (command) =>
              command.uid === 10002 &&
              command.exit_code === 0 &&
              command.output_digest &&
              command.finished_at,
          ),
        );
        assert.equal(test.artifact_digest, passed.result.artifact_digest);
        assert.equal(test.scope_digest, passed.result.scope_digest);
        const target = supervisor.publication.repository.target(passed.job.id);
        assert(target.pull);
        assert.equal(remote.state.pulls.length, 1);
        assert.equal(remote.state.pulls[0].draft, false);
        assert(
          remote.state.pulls[0].body.includes(
            `close #${passed.job.issue_number}`,
          ),
        );
        assert(remote.state.pulls[0].body.includes(test.artifact_digest));
        assert(
          remote.git(["show", `${target.head}:bug.mjs`]).includes("value + 1"),
        );
        assert.equal(remote.git(["rev-parse", "refs/heads/main"]), source.sha);
        const commentId = remote.state.comments.get(passed.job.issue_number)[0]
          .id;
        assert(
          remote.state.comments
            .get(passed.job.issue_number)[0]
            .body.includes("awaiting remote validation"),
        );
        const effects = remote.state.mutations.length;
        const changes = () =>
          store.db.prepare("SELECT total_changes() AS total").get().total;
        const idleChanges = changes();
        await implementation.reconcile(new globalThis.AbortController().signal);
        await implementation.reconcile(new globalThis.AbortController().signal);
        await implementation.reconcile(new globalThis.AbortController().signal);
        assert.equal(
          changes(),
          idleChanges,
          "Completed maintenance reconciliation wrote unchanged SQLite state",
        );
        assert.equal(remote.state.mutations.length, effects);
        const completed = record(passed.job);
        completed.stage = "publishing";
        implementation.repository.save(completed);
        store.db
          .prepare("UPDATE jobs SET phase='implementation' WHERE id=?")
          .run(passed.job.id);
        await implementation.reconcile(new globalThis.AbortController().signal);
        assert.equal(record(passed.job).stage, "remote_review");
        assert.equal(store.jobById(passed.job.id).phase, "remote_review");
        assert.equal(remote.state.mutations.length, effects);
        const nextStatus = record(passed.job);
        nextStatus.status_generation++;
        implementation.repository.save(nextStatus);
        await implementation.reconcile(new globalThis.AbortController().signal);
        const status = supervisor.publication.repository.operation(
          record(passed.job).status_operation,
        );
        assert.equal(status.status, "confirmed");
        assert.equal(
          remote.state.mutations.length,
          effects + 1,
          "A changed status operation was skipped",
        );
        status.status = "uncertain";
        status.steps.find((step) => step.kind === "comment").state =
          "uncertain";
        supervisor.publication.repository.save(status);
        await implementation.reconcile(new globalThis.AbortController().signal);
        assert.equal(
          supervisor.publication.repository.operation(status.id).status,
          "confirmed",
        );
        assert.equal(
          remote.state.mutations.length,
          effects + 1,
          "Confirmed remote status was sent again during recovery",
        );
        const recoveredIdleChanges = changes();
        await implementation.reconcile(new globalThis.AbortController().signal);
        await implementation.reconcile(new globalThis.AbortController().signal);
        assert.equal(changes(), recoveredIdleChanges);
        proof.push({
          sdk,
          idle_implementation_sqlite_unchanged: "passed",
          confirmed_change_handoff_recovery: "passed",
          unconfirmed_status_recovery: "passed",
        });
        const reconciledEffects = remote.state.mutations.length;
        await investigation.reconcile();
        await investigation.reconcile();
        assert.equal(remote.state.mutations.length, reconciledEffects);
        assert.equal(
          remote.state.comments.get(passed.job.issue_number).length,
          1,
        );
        assert.equal(
          remote.state.comments.get(passed.job.issue_number)[0].id,
          commentId,
        );
        proof.push({
          sdk,
          actual_regression_before_after: "passed",
          independent_audit_and_uid10002_receipts: "passed",
          one_reviewed_pr_and_comment: "passed",
        });

        complete("publication");

        const sourceOnly = await run("source_only");
        assert.equal(sourceOnly.result.stage, "remote_review");
        assert.equal(
          investigation.repository.current(
            store.job(sourceOnly.job.issue_number),
          ).result.proof,
          "source",
        );
        assert(
          remote.state.comments
            .get(sourceOnly.job.issue_number)[0]
            .body.includes("not reproduced"),
        );
        complete("source-only");
        const feature = await add("manual_feature");
        await investigation.reconcile();
        assert.equal(record(feature), undefined);
        noPull(feature);
        complete("manual-feature");

        for (const mode of [
          "scope",
          "protected",
          "audit_mismatch",
          "audit_mutation",
          "test_mutation",
          "test_addition",
          "failed_tests",
          "audit_rejection",
        ]) {
          const { job, result } = await run(mode, (task, value) => {
            if (task === "implementation_change" && !value.results.length) {
              if (mode === "scope")
                return {
                  command: maintenanceCommand(1, {
                    "README.md": "Unapproved rewrite\n",
                  }),
                };
              if (mode === "protected")
                return {
                  command: maintenanceCommand(1, {
                    ".github/workflows/build.yml": "name: unapproved\n",
                  }),
                };
              if (mode === "test_mutation")
                return {
                  command: maintenanceCommand(1, {
                    "regression.mjs":
                      "import fs from 'node:fs'; fs.writeFileSync('bug.mjs', 'changed after audit');\n",
                  }),
                };
              if (mode === "test_addition")
                return {
                  command: maintenanceCommand(1, {
                    "regression.mjs":
                      "import fs from 'node:fs'; fs.writeFileSync('added-source.mjs', 'export const changed = true;');\n",
                  }),
                };
              if (mode === "failed_tests")
                return { command: maintenanceCommand(2) };
            }
            if (task === "implementation_audit") {
              if (mode === "audit_mutation" && !value.results.length)
                return { command: maintenanceCommand(9) };
              if (mode === "audit_mismatch")
                return {
                  result: {
                    approved: true,
                    findings: [],
                    scope_digest: "f".repeat(64),
                    artifact_digest: value.record.artifact_digest,
                  },
                };
              if (mode === "audit_rejection")
                return {
                  result: {
                    approved: false,
                    findings: ["The acceptance criterion is missing"],
                    scope_digest: value.record.scope_digest,
                    artifact_digest: value.record.artifact_digest,
                  },
                };
            }
          });
          assert.equal(
            result.stage,
            "blocked",
            `${mode}: ${JSON.stringify(result)}`,
          );
          noPull(job);
          if (
            [
              "scope",
              "protected",
              "audit_mismatch",
              "audit_mutation",
              "audit_rejection",
            ].includes(mode)
          )
            assert.equal(result.tests.length, 0);
          if (mode === "failed_tests") {
            assert(
              result.tests.every(
                (item) =>
                  item.state === "failed" &&
                  item.commands.some((command) => command.exit_code !== 0),
              ),
            );
            assert.equal(
              JSON.parse(store.job(job.issue_number).budget_json).repair_cycles,
              3,
            );
          }
          if (["test_mutation", "test_addition"].includes(mode))
            assert.equal(result.failure, "implementation_source_mutated");
          proof.push({
            sdk,
            scenario: mode,
            gate: "blocked_before_publication",
          });
          complete(`rejection-${mode}`);
        }
        await assert.rejects(
          () =>
            verifyCandidate(
              supervisor,
              store,
              { ...passed.result, audit_id: null },
              AbortSignal.timeout(1000),
              () => {},
            ),
          /implementation_audit_missing/,
        );
        const mismatched = globalThis.structuredClone(passed.result);
        mismatched.audits.find(
          (item) => item.id === mismatched.audit_id,
        ).result.artifact_digest = "f".repeat(64);
        await assert.rejects(
          () =>
            verifyCandidate(
              supervisor,
              store,
              mismatched,
              AbortSignal.timeout(1000),
              () => {},
            ),
          /implementation_audit_mismatch/,
        );

        complete("audit-receipts");

        const exhausted = await add("exhausted_budget");
        store.db
          .prepare(
            "UPDATE jobs SET budget_json=json_set(budget_json,'$.active_ms',?) WHERE id=?",
          )
          .run(config.limits.active_minutes * 60000, exhausted.id);
        assert.equal(
          (await advance(exhausted)).failure,
          "active_budget_exhausted",
        );
        noPull(exhausted);
        complete("active-budget");
        const rejected = await add("publication_review_rejection");
        controls.review = (text) => {
          if (text.includes('"kind":"change"')) controls.rejectReview = true;
        };
        const rejectedResult = await advance(rejected);
        controls.review = undefined;
        controls.rejectReview = false;
        assert.equal(rejectedResult.stage, "blocked");
        noPull(rejected);
        assert.equal(rejectedResult.failure, "output_review_rejected");
        complete("publication-review");

        for (const drift of ["base", "human_branch"]) {
          const job = await add(drift);
          let changed = false;
          controls.review = (text) => {
            if (changed || !text.includes('"kind":"change"')) return;
            changed = true;
            const human = remote.commit(
              { ...sourceFiles, "human.txt": "human work\n" },
              source.sha,
            );
            remote.git([
              "update-ref",
              `refs/heads/${drift === "base" ? "main" : supervisor.publication.repository.target(job.id).branch}`,
              human.sha,
            ]);
          };
          const result = await advance(job);
          controls.review = undefined;
          assert(changed);
          assert.equal(result.stage, "blocked");
          noPull(job);
          assert.equal(
            result.failure,
            drift === "base"
              ? "publication_source_changed"
              : "publication_head_changed",
          );
          if (drift === "base")
            remote.git(["update-ref", "refs/heads/main", source.sha]);
          proof.push({ sdk, scenario: drift, drift_preserved: "passed" });
          complete(`drift-${drift}`);
        }
      }
      if (suite === "implementation-recovery") {
        const restartJob = await add("restart_branch");
        const scanner = supervisor.publication.outputReview.scanner,
          scan = scanner.scan.bind(scanner);
        let scopeScanStop;
        scanner.scan = (...args) => {
          if (args[0]?.job_id === restartJob.id && args[0]?.plan)
            scopeScanStop ??= investigation.stop();
          return scan(...args);
        };
        await advance(restartJob);
        assert(scopeScanStop, "Scope scan shutdown boundary was not exercised");
        await scopeScanStop;
        scanner.scan = scan;
        assert.equal(record(restartJob).scope, null);
        assert.equal(record(restartJob).scope_digest, null);
        assert.equal(
          record(restartJob).agent_pending.task,
          "implementation_plan",
        );
        noPull(restartJob);
        await closeRuntime();
        await start();
        let stopping;
        remote.state.afterMutation = (kind) => {
          if (kind === "branch" && !stopping) stopping = investigation.stop();
        };
        await advance(restartJob);
        remote.state.afterMutation = undefined;
        assert(stopping, "Branch publication boundary was not exercised");
        await stopping;
        const checkpoint = record(restartJob),
          testIds = checkpoint.tests.map((item) => item.id),
          auditIds = checkpoint.audits.map((item) => item.id),
          publicationId = checkpoint.publication_id;
        assert(
          supervisor.publication.repository.target(restartJob.id).head ||
            remote.head(
              supervisor.publication.repository.target(restartJob.id).branch,
            ),
        );
        await closeRuntime();
        await start();
        await delay(1100);
        const resumed = await advance(restartJob);
        assert.equal(resumed.stage, "remote_review", JSON.stringify(resumed));
        assert.deepEqual(
          resumed.tests.map((item) => item.id),
          testIds,
        );
        assert.deepEqual(
          resumed.audits.map((item) => item.id),
          auditIds,
        );
        assert.equal(resumed.publication_id, publicationId);
        const restartTarget = supervisor.publication.repository.target(
          restartJob.id,
        );
        assert.equal(
          remote.state.pulls.filter(
            (pull) => pull.branch === restartTarget.branch,
          ).length,
          1,
        );
        proof.push({
          sdk,
          restart_during_scope_scan: "passed",
          restart_after_branch_preserves_receipts: "passed",
        });

        complete("publication-restart");

        remote.state.dropAfter = "pull";
        const responseLoss = await run("lost_pull_response");
        if (responseLoss.result.stage !== "remote_review") {
          await delay(1100);
          await advance(responseLoss.job);
        }
        assert.equal(record(responseLoss.job).stage, "remote_review");
        const lostTarget = supervisor.publication.repository.target(
          responseLoss.job.id,
        );
        assert.equal(
          remote.state.pulls.filter((pull) => pull.branch === lostTarget.branch)
            .length,
          1,
        );

        complete("lost-pull-response");

        const closed = await add("close_during_implementation");
        controls.implementation = async (task) => {
          if (task === "implementation_change") {
            remote.state.closed.add(closed.issue_number);
            await intake.refresh(
              closed.issue_number,
              AbortSignal.timeout(10000),
            );
          }
        };
        await advance(closed);
        controls.implementation = undefined;
        assert.equal(record(closed).stage, "cancelled");
        noPull(closed);
        complete("issue-closed");
        const revised = await add("edit_during_implementation");
        controls.implementation = async (task) => {
          if (task === "implementation_change") {
            remote.state.issues.get(revised.issue_number).body =
              "A materially revised issue";
            await intake.refresh(
              revised.issue_number,
              AbortSignal.timeout(10000),
            );
          }
        };
        await advance(revised);
        controls.implementation = undefined;
        assert.equal(record(revised).stage, "cancelled");
        noPull(revised);
        complete("issue-revised");
        remote.state.closed.add(revised.issue_number);
        await intake.refresh(revised.issue_number, AbortSignal.timeout(10000));
      }
      if (!suite.startsWith("implementation-monitor-")) {
        assert(
          ![...remote.state.comments.values()]
            .flat()
            .some((comment) =>
              comment.body.includes("Automation clean; awaiting human review"),
            ),
        );

        complete("pre-monitor-readiness");
      }
      if (suite.startsWith("implementation-monitor-")) {
        await closeRuntime();
        config.pr_monitor = {
          enabled: true,
          requirements_source: "github",
          required_checks: ["Fixture CI"],
          automated_reviewers: [
            { login: "chatgpt-codex-connector[bot]", signal: "codex" },
            { login: "coderabbitai[bot]", signal: "coderabbit" },
          ],
          local_checks_only: false,
        };
        configure();
        await start();
        const attachMonitor = () => {
          monitor = new PrMonitorService(
            store,
            intake,
            new OctokitReader(
              "owner/repo",
              new Octokit({
                auth: remote.state.token,
                baseUrl: remote.url,
                log: {
                  debug: () => {},
                  info: () => {},
                  warn: () => {},
                  error: () => {},
                },
              }),
            ),
            implementation,
            supervisor,
            snapshot,
            secrets,
            logger,
          );
        };
        attachMonitor();
        const certify = (job) => {
          const target = supervisor.publication.repository.target(job.id),
            head = target.head;
          remote.state.checks.set(head, [makeCheck(head)]);
          remote.state.reviews.set(
            target.pull.number,
            ["chatgpt-codex-connector[bot]", "coderabbitai[bot]"].map(
              (login, index) => ({
                id:
                  40000 + job.id * 100 + record(job).audits.length * 10 + index,
                node_id: `R_${head}_${index}`,
                user: { id: 200 + index, login },
                commit_id: head,
                state: "COMMENTED",
                body: "",
                submitted_at: new Date().toISOString(),
              }),
            ),
          );
        };
        const pump = async (job, condition, rounds = 12) => {
          for (let cycle = 0; cycle < rounds; cycle++) {
            await monitor.reconcile();
            if (condition(monitor.repository.get(job.id)))
              return monitor.repository.get(job.id);
            await investigation.reconcile();
          }
          assert.fail(
            `PR monitor failed to reach its expected state: ${JSON.stringify(monitor.repository.get(job.id))}; errors ${fixture.errors.map((error) => error.stack).join("\n")}`,
          );
        };
        const until = async (condition, message) => {
          const deadline = Date.now() + 15000;
          while (!condition()) {
            assert(Date.now() < deadline, message);
            await delay(20);
          }
        };
        if (suite === "implementation-monitor-repair") {
          const monitored = await run("monitor_pipeline");
          const first = supervisor.publication.repository.target(
            monitored.job.id,
          );
          const statusCancellation = new globalThis.AbortController(),
            beforeInterruptedStatus = remote.state.mutations.length;
          let statusEntered = false,
            releaseStatus;
          const heldStatus = new Promise((resolve) => {
            releaseStatus = resolve;
          });
          remote.state.beforeRequest = async (method, path) => {
            if (method === "GET" && path === "/user") {
              statusEntered = true;
              await heldStatus;
            }
          };
          const interruptedMonitor = monitor.reconcile(
            statusCancellation.signal,
          );
          try {
            await until(
              () => statusEntered,
              "PR status preparation did not reach the held transport",
            );
            statusCancellation.abort();
          } finally {
            remote.state.beforeRequest = undefined;
            releaseStatus();
          }
          await interruptedMonitor;
          const interruptedStatus = supervisor.publication.repository.pending(
            monitored.job.id,
          );
          assert.equal(interruptedStatus.proposal.kind, "pr_stage");
          assert.equal(interruptedStatus.status, "prepared");
          assert.equal(interruptedStatus.actor, null);
          assert.equal(interruptedStatus.payload, null);
          assert.deepEqual(interruptedStatus.steps, []);
          assert.equal(remote.state.mutations.length, beforeInterruptedStatus);
          const retriesBeforeRestart = JSON.parse(
            store.jobById(monitored.job.id).budget_json,
          ).infrastructure_retries;
          await closeRuntime();
          await start();
          attachMonitor();
          await monitor.reconcile();
          assert.equal(
            supervisor.publication.repository.operation(interruptedStatus.id)
              .status,
            "confirmed",
          );
          assert.deepEqual(
            remote.state.mutations.slice(beforeInterruptedStatus),
            ["comment"],
          );
          assert.equal(
            JSON.parse(store.jobById(monitored.job.id).budget_json)
              .infrastructure_retries,
            retriesBeforeRestart + 1,
          );
          assert.equal(
            monitor.repository.get(monitored.job.id).stage,
            "waiting",
          );
          assert.deepEqual(store.leases(), []);
          certify(monitored.job);
          remote.state.threads.set(first.pull.number, [
            makeThread(30001, first.head),
          ]);
          const originalRevision = store.jobById(monitored.job.id).revision;
          let oldHeadMarkerAt;
          controls.review = (text) => {
            if (text.includes('"kind":"change"') && text.includes(first.head)) {
              oldHeadMarkerAt = new Date().toISOString();
              remote.state.reactions.set(first.pull.number, [
                {
                  id: 99001,
                  content: "+1",
                  user: { id: 200, login: "chatgpt-codex-connector[bot]" },
                  created_at: oldHeadMarkerAt,
                },
              ]);
              remote.state.comments.set(first.pull.number, [
                {
                  id: 99002,
                  body: "No actionable comments were generated in the recent review",
                  author_id: 201,
                  author_login: "coderabbitai[bot]",
                  created_at: oldHeadMarkerAt,
                  updated_at: oldHeadMarkerAt,
                },
              ]);
            }
          };
          await pump(
            monitored.job,
            (item) => item.expected_head !== first.head,
          );
          controls.review = undefined;
          const repaired = supervisor.publication.repository.target(
            monitored.job.id,
          );
          const repairMonitor = monitor.repository.get(monitored.job.id);
          assert(oldHeadMarkerAt);
          assert(repairMonitor.head_published_at > Date.parse(oldHeadMarkerAt));
          const remoteAfterRepair = await new OctokitReader(
            "owner/repo",
            new Octokit({ auth: remote.state.token, baseUrl: remote.url }),
          ).monitor(first.pull.number, AbortSignal.timeout(10000));
          for (const reviewer of config.pr_monitor.automated_reviewers) {
            const decision = evaluateReadiness(
              remoteAfterRepair,
              {
                ...config.pr_monitor,
                required_checks: [],
                local_checks_only: true,
                automated_reviewers: [reviewer],
              },
              repairMonitor.head_published_at,
            );
            assert.equal(decision.clean, false);
            assert(decision.pending.includes(`review:${reviewer.login}`));
          }
          assert.equal(
            store.ownedPull(first.pull.number).head_sha,
            repaired.head,
          );
          assert.equal(
            store.jobById(monitored.job.id).revision,
            originalRevision,
          );
          assert.equal(
            remote.git(["rev-parse", `${repaired.head}^`]),
            first.head,
          );
          assert(remote.git(["show", `${first.head}:bug.mjs`]).includes("99"));
          assert(
            !remote.git(["show", `${repaired.head}:bug.mjs`]).includes("99"),
          );
          assert(
            remote
              .git(["show", `${repaired.head}:regression.mjs`])
              .includes("increment(2)"),
          );
          for (const [sha, expected] of [
            [first.head, 1],
            [repaired.head, 0],
          ]) {
            const code = remote.git(["show", `${sha}:bug.mjs`]);
            const actual = spawnSync(
              "/opt/orm-runtime/bin/node",
              [
                "--input-type=module",
                "-e",
                `import assert from 'node:assert/strict'; ${code}; assert.equal(increment(2),3);`,
              ],
              {
                uid: 10002,
                gid: 10002,
                cwd: "/",
                env: { PATH: "/opt/orm-runtime/bin:/usr/bin:/bin" },
                encoding: "utf8",
              },
            );
            assert.equal(actual.status, expected, actual.stderr);
          }
          await pump(
            monitored.job,
            () => remote.state.threads.get(first.pull.number)[0].isResolved,
          );
          assert.notEqual(
            monitor.repository.get(monitored.job.id).stage,
            "ready",
          );
          assert(
            !remote.state.comments
              .get(monitored.job.issue_number)
              .some((comment) =>
                comment.body.includes(
                  "Automation clean; awaiting human review",
                ),
              ),
          );
          const repairRecord = record(monitored.job);
          assert.equal(
            repairRecord.tests.filter((item) => item.state === "passed").length,
            2,
          );
          assert.equal(
            JSON.parse(store.jobById(monitored.job.id).budget_json)
              .repair_cycles,
            1,
          );
          certify(monitored.job);
          const directReady = await pump(
            monitored.job,
            (item) => item.stage === "ready",
          );
          assert(directReady.notification_id);
          assert.equal(
            store.ownedPull(first.pull.number).head_sha,
            repaired.head,
          );
          remote.state.checks.set(repaired.head, [
            makeCheck(repaired.head, {
              id: 602,
              status: "queued",
              conclusion: null,
            }),
          ]);
          await monitor.reconcile();
          assert.notEqual(
            monitor.repository.get(monitored.job.id).stage,
            "ready",
          );
          const beforeRestart = remote.state.mutations.length;
          await closeRuntime();
          await start();
          attachMonitor();
          await monitor.reconcile();
          assert.notEqual(
            monitor.repository.get(monitored.job.id).stage,
            "ready",
          );
          assert.equal(remote.state.mutations.length, beforeRestart);
          certify(monitored.job);
          let clean = await pump(
            monitored.job,
            (item) => item.stage === "ready",
          );
          await monitor.validateReadiness(
            clean.readiness_id,
            new globalThis.AbortController().signal,
          );
          await delay(50);
          const readyComments = remote.state.comments.get(
            monitored.job.issue_number,
          );
          assert(readyComments.length >= 2);
          const commentCount = readyComments.length;
          await monitor.reconcile();
          assert.equal(readyComments.length, commentCount);
          assert(
            remote.state.comments
              .get(monitored.job.issue_number)[0]
              .body.includes("Automation clean; awaiting human review"),
          );
          proof.push({
            sdk,
            monitor_real_review_repair_and_regression: "passed",
            monitor_new_head_invalidates_ci_and_reviews: "passed",
            monitor_wait_restart_and_slot_release: "passed",
            monitor_incomplete_status_restart: "passed",
            old_head_markers_during_output_review_rejected: "passed",
            repaired_head_ready_without_intake_refresh: "passed",
          });

          complete("reviewed-repair");
          const scopeEdit = await run("monitor_scope_edit"),
            scopeTarget = supervisor.publication.repository.target(
              scopeEdit.job.id,
            );
          certify(scopeEdit.job);
          remote.state.threads.set(scopeTarget.pull.number, [
            makeThread(34000 + scopeEdit.job.id, scopeTarget.head),
          ]);
          await pump(scopeEdit.job, (item) => item.stage === "repairing");
          controls.implementation = async (task, value) => {
            if (
              task === "implementation_change" &&
              value.job.id === scopeEdit.job.id
            ) {
              remote.state.issues.get(scopeEdit.job.issue_number).body =
                "A different scope while repairing";
              await intake.refresh(
                scopeEdit.job.issue_number,
                AbortSignal.timeout(10000),
              );
            }
          };
          await investigation.reconcile();
          controls.implementation = undefined;
          await monitor.reconcile();
          assert.equal(
            supervisor.publication.repository.target(scopeEdit.job.id).head,
            scopeTarget.head,
          );
          assert.equal(
            monitor.repository.get(scopeEdit.job.id).stage,
            "blocked",
          );
          assert.equal(
            monitor.repository.get(scopeEdit.job.id).failure,
            "pr_scope_changed",
          );
          assert.equal(
            store.jobById(scopeEdit.job.id).revision,
            scopeEdit.job.revision,
          );
          proof.push({
            sdk,
            issue_scope_edit_during_repair_blocks_publication: "passed",
          });

          complete("repair-scope-edit");
          await closeRuntime();
          const regularPolicy = globalThis.structuredClone(config.pr_monitor);
          config.pr_monitor = {
            enabled: true,
            requirements_source: "operator",
            required_checks: [],
            automated_reviewers: [],
            local_checks_only: true,
          };
          configure();
          await start();
          attachMonitor();
          const localOnly = await run("monitor_local_only"),
            localTarget = supervisor.publication.repository.target(
              localOnly.job.id,
            );
          remote.state.threads.set(localTarget.pull.number, [
            makeThread(35000 + localOnly.job.id, localTarget.head),
          ]);
          const localReady = await pump(
            localOnly.job,
            (item) => item.stage === "ready",
          );
          assert.notEqual(localReady.expected_head, localTarget.head);
          assert(localReady.notification_id);
          assert.equal(
            store.ownedPull(localTarget.pull.number).head_sha,
            localReady.expected_head,
          );
          assert.equal(
            remote.state.checks.has(localReady.expected_head),
            false,
          );
          proof.push({
            sdk,
            local_checks_only_repair_notifies_without_intake_refresh: "passed",
          });
          complete("local-checks-only");
          await closeRuntime();
          config.pr_monitor = regularPolicy;
          configure();
          await start();
          attachMonitor();

          const disabledRepair = await run("monitor_disabled"),
            disabledTarget = supervisor.publication.repository.target(
              disabledRepair.job.id,
            );
          certify(disabledRepair.job);
          remote.state.threads.set(disabledTarget.pull.number, [
            makeThread(36000 + disabledRepair.job.id, disabledTarget.head),
          ]);
          await pump(disabledRepair.job, (item) => item.stage === "repairing");
          const disabledRuns = store
            .runs()
            .filter((item) => item.job_id === disabledRepair.job.id).length;
          const disabledBudget = JSON.parse(
            store.jobById(disabledRepair.job.id).budget_json,
          ).repair_cycles;
          await closeRuntime();
          config.pr_monitor.enabled = false;
          configure();
          await start();
          attachMonitor();
          await monitor.reconcile();
          await investigation.reconcile();
          assert.equal(
            supervisor.publication.repository.target(disabledRepair.job.id)
              .head,
            disabledTarget.head,
          );
          assert.equal(record(disabledRepair.job).stage, "implementing");
          assert.equal(
            store.runs().filter((item) => item.job_id === disabledRepair.job.id)
              .length,
            disabledRuns,
          );
          assert.equal(
            JSON.parse(store.jobById(disabledRepair.job.id).budget_json)
              .repair_cycles,
            disabledBudget,
          );
          await closeRuntime();
          config.pr_monitor.enabled = true;
          configure();
          await start();
          attachMonitor();
          await pump(
            disabledRepair.job,
            (item) => item.expected_head !== disabledTarget.head,
          );
          certify(disabledRepair.job);
          await pump(disabledRepair.job, (item) => item.stage === "ready");
          assert.equal(
            JSON.parse(store.jobById(disabledRepair.job.id).budget_json)
              .repair_cycles,
            disabledBudget,
          );
          proof.push({
            sdk,
            disabled_monitor_preserves_queued_repair_across_restart: "passed",
          });

          complete("disabled-monitor");
          const frozenSnapshot = store.jobById(
            monitored.job.id,
          ).snapshot_digest;
          await closeRuntime();
          config.pr_monitor.required_checks.push("Additional CI");
          configure();
          await start();
          attachMonitor();
          await monitor.reconcile();
          assert.notEqual(
            monitor.repository.get(monitored.job.id).stage,
            "ready",
          );
          assert.equal(
            store.jobById(monitored.job.id).snapshot_digest,
            frozenSnapshot,
          );
          remote.state.checks
            .get(repaired.head)
            .push(makeCheck(repaired.head, { id: 601, name: "Additional CI" }));
          await pump(monitored.job, (item) => item.stage === "ready");
          await closeRuntime();
          config.pr_monitor.required_checks = ["Fixture CI"];
          configure();
          await start();
          attachMonitor();
          clean = await pump(monitored.job, (item) => item.stage === "ready");
          assert.equal(
            store.jobById(monitored.job.id).snapshot_digest,
            frozenSnapshot,
          );
          proof.push({
            sdk,
            readiness_policy_reload_keeps_coding_snapshot: "passed",
          });

          complete("policy-reload");
          const human = remote.commit(
            {
              ...sourceFiles,
              "bug.mjs": "export const increment=value=>value+1;\n",
            },
            repaired.head,
          );
          remote.git([
            "update-ref",
            `refs/heads/${repaired.branch}`,
            human.sha,
          ]);
          const mutationsBeforeHuman = remote.state.mutations.filter(
            (item) => item === "branch",
          ).length;
          await monitor.reconcile();
          assert.equal(
            monitor.repository.get(monitored.job.id).failure,
            "pr_head_changed",
          );
          assert.equal(
            remote.state.mutations.filter((item) => item === "branch").length,
            mutationsBeforeHuman,
          );
          await assert.rejects(() =>
            monitor.validateReadiness(
              clean.readiness_id,
              new globalThis.AbortController().signal,
            ),
          );
          proof.push({ sdk, monitor_timeout_and_human_head_handoff: "passed" });

          complete("human-head-handoff");
        }
        if (suite === "implementation-monitor-state") {
          {
            const transient = await run("source_only");
            certify(transient.job);
            const ready = await pump(
              transient.job,
              (item) => item.stage === "ready",
            );
            const target = supervisor.publication.repository.target(
              transient.job.id,
            );
            const comments = remote.state.comments.get(
              transient.job.issue_number,
            );
            const commentId = comments[0].id;
            remote.state.rateLimit = {
              method: "GET",
              path: `/repos/owner/repo/pulls/${target.pull.number}`,
              seconds: 1,
            };
            await assert.rejects(
              () =>
                monitor.validateReadiness(
                  ready.readiness_id,
                  AbortSignal.timeout(10000),
                ),
              /github_rate_limited/,
            );
            remote.state.rateLimit = undefined;
            await closeRuntime();
            await start();
            attachMonitor();
            const recovered = await pump(
              transient.job,
              (item) => item.stage === "ready",
            );
            await monitor.validateReadiness(
              recovered.readiness_id,
              AbortSignal.timeout(10000),
            );
            assert.equal(comments[0].id, commentId);
            assert.equal(comments.length, 2);
            assert(
              comments[0].body.includes(
                "Automation clean; awaiting human review",
              ),
            );
            proof.push({
              sdk,
              readiness_read_failure_and_restart_deduplication: "passed",
            });
          }

          complete("readiness-transient-recovery");
          const concurrent = await run("source_only"),
            concurrentTarget = supervisor.publication.repository.target(
              concurrent.job.id,
            );
          certify(concurrent.job);
          remote.state.threads.set(concurrentTarget.pull.number, [
            makeThread(
              33000 + concurrent.job.id,
              concurrentTarget.head,
              "SCOPE_EXPANSION: add a new feature",
            ),
          ]);
          await monitor.reconcile();
          let releaseAssessment,
            assessmentStarted,
            releaseObservation,
            observationHeld;
          const assessing = new Promise((resolve) => {
            assessmentStarted = resolve;
          });
          const assessmentGate = new Promise((resolve) => {
            releaseAssessment = resolve;
          });
          const observationGate = new Promise((resolve) => {
            releaseObservation = resolve;
          });
          const held = new Promise((resolve) => {
            observationHeld = resolve;
          });
          controls.implementation = async (task, value) => {
            if (
              task === "implementation_review_feedback" &&
              value.job.id === concurrent.job.id
            ) {
              assessmentStarted();
              await assessmentGate;
            }
          };
          const advancingSignal = AbortSignal.timeout(30000),
            started = Date.now(),
            advancing = monitor.advance(
              store.jobById(concurrent.job.id),
              advancingSignal,
            ),
            deferredMonitors = [];
          try {
            await assessing;
            for (const item of monitor.repository.all()) {
              if (item.job_id === concurrent.job.id) continue;
              deferredMonitors.push({
                job_id: item.job_id,
                retry_at: item.retry_at,
              });
              item.retry_at = Date.now() + 60_000;
              monitor.repository.save(item);
            }
            remote.state.beforeRequest = async (method, path) => {
              if (
                method === "GET" &&
                path ===
                  `/repos/owner/repo/pulls/${concurrentTarget.pull.number}`
              ) {
                observationHeld();
                await observationGate;
              }
            };
            const observing = monitor.reconcile();
            await Promise.race([observing, held]);
            remote.state.beforeRequest = undefined;
            releaseAssessment();
            await advancing;
            const committed = monitor.repository.get(concurrent.job.id),
              committedFindings = committed.findings;
            assert(
              committedFindings.some((item) => item.publication_id),
              JSON.stringify({
                aborted: advancingSignal.aborted,
                elapsed_ms: Date.now() - started,
                stage: committed.stage,
                failure: committed.failure,
                recent_runs: store
                  .runs()
                  .filter((item) => item.job_id === concurrent.job.id)
                  .slice(-3)
                  .map(({ role, status }) => ({ role, status })),
              }),
            );
            releaseObservation();
            await observing;
            assert.deepEqual(
              monitor.repository.get(concurrent.job.id).findings,
              committedFindings,
            );
          } finally {
            releaseAssessment();
            releaseObservation();
            remote.state.beforeRequest = undefined;
            controls.implementation = undefined;
            for (const item of deferredMonitors) {
              const current = monitor.repository.get(item.job_id);
              current.retry_at = item.retry_at;
              monitor.repository.save(current);
            }
          }
          await pump(concurrent.job, (item) => item.stage === "ready");
          assert.equal(
            remote.state.threads.get(concurrentTarget.pull.number)[0].comments
              .length,
            2,
          );
          const scopeReceipt = monitor.repository.get(
            concurrent.job.id,
          ).readiness_id;
          remote.state.issues.get(concurrent.job.issue_number).body =
            "Scope changed without a webhook";
          await assert.rejects(
            () =>
              monitor.validateReadiness(
                scopeReceipt,
                AbortSignal.timeout(10000),
              ),
            /pr_scope_changed/,
          );
          assert.equal(
            monitor.repository.get(concurrent.job.id).readiness_id,
            null,
          );
          proof.push({
            sdk,
            concurrent_observation_preserves_confirmed_disposition: "passed",
            readiness_rechecks_scope_without_webhook: "passed",
          });

          complete("concurrent-observation");
          for (const boundary of ["thread_reply", "thread_resolution"]) {
            const candidate = await run("source_only"),
              target = supervisor.publication.repository.target(
                candidate.job.id,
              );
            certify(candidate.job);
            remote.state.threads.set(target.pull.number, [
              makeThread(
                31000 + candidate.job.id,
                target.head,
                "SCOPE_EXPANSION: add a new feature",
              ),
            ]);
            await monitor.reconcile();
            const stop = new globalThis.AbortController();
            remote.state.afterMutation = (kind) => {
              if (kind === boundary)
                stop.abort(new Error("planned feedback shutdown"));
            };
            await monitor.advance(store.jobById(candidate.job.id), stop.signal);
            remote.state.afterMutation = undefined;
            await closeRuntime();
            await start();
            attachMonitor();
            await pump(candidate.job, (item) => item.stage === "ready");
            const thread = remote.state.threads.get(target.pull.number)[0];
            assert.equal(thread.comments.length, 2);
            assert.equal(thread.isResolved, true);
            assert.equal(
              remote.state.pulls.filter(
                (item) => item.number === target.pull.number,
              ).length,
              1,
            );
            complete(`restart-${boundary}`);
          }
          proof.push({
            sdk,
            feedback_reply_and_resolution_restart_no_duplicate: "passed",
          });

          const budgetCase = await run("monitor_pipeline");
          const budgetTarget = supervisor.publication.repository.target(
            budgetCase.job.id,
          );
          certify(budgetCase.job);
          remote.state.threads.set(budgetTarget.pull.number, [
            makeThread(32000 + budgetCase.job.id, budgetTarget.head),
          ]);
          store.db
            .prepare(
              "UPDATE jobs SET budget_json=json_set(budget_json,'$.repair_cycles',?) WHERE id=?",
            )
            .run(snapshot.settings.limits.repair_cycles, budgetCase.job.id);
          await pump(budgetCase.job, (item) => item.stage === "blocked");
          assert.equal(
            monitor.repository.get(budgetCase.job.id).failure,
            "repair_budget_exhausted",
          );
          assert.equal(
            supervisor.publication.repository.target(budgetCase.job.id).head,
            budgetTarget.head,
          );
          const failedCI = await run("source_only");
          certify(failedCI.job);
          const failedTarget = supervisor.publication.repository.target(
            failedCI.job.id,
          );
          remote.state.checks.set(failedTarget.head, [
            makeCheck(failedTarget.head, {
              conclusion: "failure",
              output: {
                title: "External CI failure",
                summary:
                  "No supported source cause is established by this transport receipt",
                text: null,
              },
            }),
          ]);
          await pump(failedCI.job, (item) => item.stage === "blocked");
          assert.equal(
            monitor.repository.get(failedCI.job.id).failure,
            "pr_checks_failed",
          );
          proof.push({
            sdk,
            repair_budget_and_unproved_ci_failure_handoffs: "passed",
          });

          complete("repair-budget-and-ci-failure");
          const stale = await run("source_only");
          certify(stale.job);
          const staleClean = await pump(
            stale.job,
            (item) => item.stage === "ready",
          );
          const staleComments = remote.state.comments.get(
            stale.job.issue_number,
          );
          const staleCommentCount = staleComments.length;
          const staleTarget = supervisor.publication.repository.target(
              stale.job.id,
            ),
            staleHuman = remote.commit(sourceFiles, staleTarget.head);
          remote.git([
            "update-ref",
            `refs/heads/${staleTarget.branch}`,
            staleHuman.sha,
          ]);
          await monitor.reconcile();
          await assert.rejects(() =>
            monitor.validateReadiness(
              staleClean.readiness_id,
              AbortSignal.timeout(10000),
            ),
          );
          assert.equal(
            monitor.repository.get(stale.job.id).failure,
            "pr_head_changed",
          );
          assert.equal(staleComments.length, staleCommentCount);
          assert(
            !staleComments[0].body.includes(
              "Automation clean; awaiting human review",
            ),
          );
          proof.push({
            sdk,
            stale_ready_retry_suppressed_after_human_head_change: "passed",
          });

          complete("stale-readiness-comment");
          const timeoutJob = await run("source_only");
          await monitor.reconcile();
          store.db
            .prepare(
              "UPDATE jobs SET budget_json=json_set(budget_json,'$.wait_ms',?) WHERE id=?",
            )
            .run(
              snapshot.settings.limits.wait_hours * 3_600_000,
              timeoutJob.job.id,
            );
          await monitor.reconcile();
          assert.equal(
            monitor.repository.get(timeoutJob.job.id).failure,
            "pr_wait_budget_exhausted",
          );
          const delayedBudget = await run("source_only");
          await monitor.reconcile();
          certify(delayedBudget.job);
          const delayedTarget = supervisor.publication.repository.target(
            delayedBudget.job.id,
          );
          remote.state.beforeRequest = async (method, path) => {
            if (
              method === "GET" &&
              path === `/repos/owner/repo/pulls/${delayedTarget.pull.number}`
            )
              store.db
                .prepare(
                  "UPDATE jobs SET budget_json=json_set(budget_json,'$.wait_ms',?) WHERE id=?",
                )
                .run(
                  snapshot.settings.limits.wait_hours * 3_600_000,
                  delayedBudget.job.id,
                );
          };
          await monitor.reconcile();
          remote.state.beforeRequest = undefined;
          assert.equal(
            monitor.repository.get(delayedBudget.job.id).failure,
            "pr_wait_budget_exhausted",
          );
          assert.equal(
            monitor.repository.get(delayedBudget.job.id).readiness_id,
            null,
          );
          const legacy = await run("source_only");
          const legacyImplementation = record(legacy.job),
            savedScope = legacyImplementation.scope;
          legacyImplementation.scope = null;
          implementation.repository.save(legacyImplementation);
          await monitor.reconcile();
          assert.equal(monitor.repository.get(legacy.job.id), undefined);
          assert.equal(monitor.status().reason, "pr_handoff_invalid");
          assert.equal(record(legacy.job).scope, null);
          legacyImplementation.scope = savedScope;
          implementation.repository.save(legacyImplementation);
          proof.push({
            sdk,
            wait_budget_rechecked_after_remote_read: "passed",
            missing_receipts_visible_handoff: "passed",
          });
          complete("wait-budget-and-required-receipts");
        }
      }
      assert(!logs.join("\n").includes(config.github.token));
      assert(!logs.join("\n").includes(config.proxy.key));
      await closeRuntime();
      await remote.close();
      remote = undefined;
      for (const uid of [10001, 10002, 10003])
        assert.deepEqual(await userProcesses(uid), []);
    }
    assert.equal(
      errors.length,
      0,
      errors.map((error) => error.stack).join("\n"),
    );
    receipt = {
      suite,
      sdk: sdks[0],
      implementation: "passed",
      scenarios: proof,
      completed_scenarios: completedScenarios,
      cleanup: "passed",
    };
    verifyImplementationReceipts(suite, [receipt], sdks);
  } catch (error) {
    errors.push(error);
    if (cleanupFailures.length)
      errors.push(
        new Error(
          `Runtime cleanup cause codes: ${JSON.stringify(cleanupFailures)}`,
        ),
      );
    try {
      recordWorkflowFailure();
      const pending = [];
      for (const run of store?.db.open ? store.runs() : []) {
        if (run.finished_at !== null) continue;
        pending.push({
          id: run.id,
          role: run.role,
          workers: await userProcesses(run.uid),
          source_pids: await sourceProcesses(
            run.id,
            join(supervisor.workspaces.privateRoot, "sources", run.id),
          ),
        });
      }
      if (pending.length)
        errors.push(
          new Error(`Cleanup process diagnostics: ${JSON.stringify(pending)}`),
        );
    } catch (diagnostic) {
      errors.push(diagnostic);
    }
  } finally {
    for (const cleanup of [
      () => closeRuntime(),
      () => remote?.close(),
      ...[model].map((server) => async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(
      [...new Set(errors)],
      `Implementation verification or cleanup failed for ${suite}/${sdk} after ${completedScenarios.length} completed scenarios`,
    );
  return receipt;
}
