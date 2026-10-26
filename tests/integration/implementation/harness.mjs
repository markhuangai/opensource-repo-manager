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
import { McpGateway } from "/opt/orm/app/dist/services/mcp/index.js";
import { OctokitReader } from "/opt/orm/app/dist/adapters/github/reader.js";
import { OctokitWriter } from "/opt/orm/app/dist/adapters/github/writer.js";
import { createApp } from "/opt/orm/app/dist/http/app.js";
import {
  loadProtectedConfiguration,
  createRunSnapshot,
} from "/opt/orm/app/dist/config/load.js";
import { parseConfiguration } from "/opt/orm/app/dist/config/schema.js";
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
  taskInput,
} from "/investigation-fixtures/protocol.mjs";
import { contextServer } from "/investigation-fixtures/mcp.mjs";
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
  const loaded = await loadProtectedConfiguration(),
    context = await contextServer();
  const notifications = [],
    discordRequests = [],
    logs = [],
    errors = [],
    cleanupFailures = [],
    proof = [];
  let fixture,
    sdk,
    store,
    supervisor,
    gateway,
    intake,
    investigation,
    implementation,
    monitor,
    app,
    remote,
    receipt;
  const controls = {};
  const model = createServer((req, res) =>
    (sdk === "claude" ? claude : codex)(req, res, fixture),
  );
  const notifier = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const event = JSON.parse(body);
    if (req.url === "/discord") {
      discordRequests.push(event);
      res.end("accepted");
      return;
    }
    notifications.push(event);
    if (controls.deferReady && event.outcome === "ready_for_review") {
      res.writeHead(429, { "retry-after": "1" });
      res.end("deferred");
      return;
    }
    if (controls.loseReady && event.outcome === "ready_for_review") {
      res.destroy();
      return;
    }
    res.end("accepted");
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => notifier.listen(0, "127.0.0.1", resolve));
  const logger = {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
  };
  const closeRuntime = async () => {
    await monitor?.stop();
    await investigation?.stop();
    await intake?.stop();
    await app?.close();
    await supervisor?.close();
    await gateway?.close();
    if (fixture) errors.push(...fixture.errors.splice(0));
    if (store?.db.open) store.close();
    investigation = undefined;
    monitor = undefined;
    intake = undefined;
    app = undefined;
    supervisor = undefined;
    gateway = undefined;
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
      const config = parseConfiguration(
        await readFile("/config/config.yml", "utf8"),
      );
      config.github.repository = "owner/repo";
      config.github.token = remote.state.token;
      config.proxy.url = `http://127.0.0.1:${model.address().port}/v1`;
      config.proxy.key = `implementation-proxy-${randomUUID()}`;
      config.notifications = {
        discord: { enabled: false },
        smtp: { enabled: false },
        webhook: {
          enabled: true,
          url: `http://127.0.0.1:${notifier.address().port}`,
          headers: {},
        },
      };
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
        config.roles[role].mcp = {};
      }
      config.mcp.servers = {};
      config.mcp.credentials = {};
      let snapshot, secrets;
      const configure = (mcp) => {
        config.mcp.servers = mcp
          ? {
              context: {
                transport: "streamable_http",
                url: context.url,
                allow_plain_http: true,
                review_required_tools: ["store_record"],
                tools: {
                  lookup_record: { effect: "read" },
                  store_record: {
                    effect: "write",
                    idempotency_argument: "key",
                  },
                },
              },
            }
          : {};
        config.roles.implementation.mcp = mcp
          ? { context: { tools: ["lookup_record", "store_record"] } }
          : {};
        const separated = separateSecrets(config);
        secrets = separated.secrets;
        snapshot = createRunSnapshot(
          separated.settings,
          bundlesWithCanaries(loaded),
          secrets,
        );
      };
      configure(false);
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
        gateway = new McpGateway(store, snapshot, secrets);
        supervisor = await Supervisor.create(store, snapshot, secrets, {
          root: runtimeRoot,
          workers: { [sdk]: `/opt/orm/app/dist/adapters/agents/${sdk}.js` },
          sourceUrl: () => remote.url + "/owner/repo.git",
          publicationWriter: (ready) =>
            new OctokitWriter("owner/repo", client, ready),
          mcp: gateway,
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
        gateway.setWriteDispatcher(supervisor.mcpWrites);
        gateway.setReadResultScanner(
          supervisor.publication.outputReview.scanner,
        );
        await gateway.start();
        intake = new IntakeService(
          store,
          new OctokitReader("owner/repo", client),
          snapshot,
          secrets,
          logger,
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
        app = createApp(
          intake,
          config.github.webhook_secret,
          supervisor.notifications,
          supervisor.mcpWrites,
          investigation,
        );
        fixture = modelFixture(config, store, runtimeRoot, controls);
        supervisor.notifications.start();
        await intake.reconcile();
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
        await intake.reconcile();
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

        await closeRuntime();
        configure(true);
        await start();
        controls.implementation = (task, value) => {
          if (task !== "implementation_milestone") return;
          const read = store
            .mcpCalls()
            .find((item) => item.run_id === value.run.id);
          if (!read)
            return {
              tool: "mcp__context__lookup_record",
              arguments: {
                query: "Verify current source rather than stale knowledge",
              },
            };
          const write = supervisor.mcpWrites.repository
            .all()
            .find((item) => item.binding.run_id === value.run.id);
          if (!write)
            return {
              tool: "mcp__context__store_record",
              arguments: {
                arguments: {
                  text: "An audited candidate passed actual local checks; PR publication and remote validation remain pending.",
                },
                purpose: "Record only the verified tested-candidate milestone",
                evidence: [
                  value.record.audits.find(
                    (item) => item.id === value.record.audit_id,
                  ).evidence_id,
                  value.record.tests.find(
                    (item) => item.id === value.record.test_id,
                  ).evidence_id,
                ].map((id) => ({ kind: "publication_evidence", id })),
              },
            };
        };
        const mcpJob = await add("implementation_mcp");
        let publicationLimited = false;
        controls.review = (text) => {
          if (publicationLimited || !text.includes('"kind":"change"')) return;
          publicationLimited = true;
          remote.state.rateLimit = {
            method: "GET",
            path: "/repos/owner/repo",
            seconds: 1,
          };
        };
        const mcpCheckpoint = await advance(mcpJob);
        controls.review = undefined;
        assert(
          publicationLimited,
          "Publication read failure was not exercised",
        );
        assert.equal(mcpCheckpoint.stage, "blocked");
        assert.equal(mcpCheckpoint.failure, "github_rate_limited");
        assert.equal(mcpCheckpoint.retry_stage, "publishing");
        assert.equal(mcpCheckpoint.milestone_done, true);
        assert.equal(mcpCheckpoint.agent_pending, null);
        noPull(mcpJob);
        const implementationRuns = store
            .runs()
            .filter(
              (run) =>
                run.job_id === mcpJob.id && run.role === "implementation",
            )
            .map((run) => run.id),
          checkpointEffects = context.effects.size;
        await closeRuntime();
        await start();
        await delay(Math.max(0, mcpCheckpoint.retry_at - Date.now()) + 100);
        const mcpResult = await advance(mcpJob);
        assert.equal(
          mcpResult.stage,
          "remote_review",
          JSON.stringify(mcpResult),
        );
        assert.equal(mcpResult.test_id, mcpCheckpoint.test_id);
        assert.equal(mcpResult.audit_id, mcpCheckpoint.audit_id);
        assert.equal(mcpResult.publication_id, mcpCheckpoint.publication_id);
        assert.deepEqual(
          store
            .runs()
            .filter(
              (run) =>
                run.job_id === mcpJob.id && run.role === "implementation",
            )
            .map((run) => run.id),
          implementationRuns,
        );
        assert.equal(context.effects.size, checkpointEffects);
        const mcpTarget = supervisor.publication.repository.target(mcpJob.id);
        assert.equal(
          remote.state.pulls.filter((pull) => pull.branch === mcpTarget.branch)
            .length,
          1,
        );
        const writes = supervisor.mcpWrites.repository
          .all()
          .filter((item) => item.job_id === mcpJob.id);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].state, "response_recorded");
        assert.equal(writes[0].review, "required");
        assert.equal(writes[0].response.value.structuredContent.accepted, true);
        assert(context.effects.size > 0);
        controls.rejectWrite = true;
        const denied = await add("implementation_denied");
        await advance(denied);
        controls.rejectWrite = false;
        const deniedWrite = supervisor.mcpWrites.repository
          .all()
          .find((item) => item.job_id === denied.id);
        assert.equal(deniedWrite.state, "rejected");
        assert.equal(deniedWrite.failure, "output_review_rejected");
        assert.equal(record(denied).stage, "remote_review");
        context.state.fail = true;
        const failedWrite = await add("implementation_provider_error");
        await advance(failedWrite);
        context.state.fail = false;
        const failedOperation = supervisor.mcpWrites.repository
          .all()
          .find((item) => item.job_id === failedWrite.id);
        assert.equal(failedOperation.state, "response_recorded");
        assert.equal(failedOperation.response.value.isError, true);
        assert.equal(
          failedOperation.response.value.structuredContent.accepted,
          false,
        );
        assert.equal(record(failedWrite).stage, "remote_review");
        const priorEffects = context.effects.size;
        context.state.drop = true;
        const uncertain = await add("implementation_uncertain");
        await advance(uncertain);
        assert.equal(record(uncertain).stage, "blocked");
        noPull(uncertain);
        assert.equal(record(uncertain).failure, "mcp_write_uncertain");
        await closeRuntime();
        await start();
        await advance(uncertain);
        assert.equal(record(uncertain).stage, "blocked");
        noPull(uncertain);
        assert.equal(context.effects.size, priorEffects + 1);
        assert(record(uncertain).tests.some((item) => item.state === "passed"));
        assert.equal(
          record(uncertain).failure,
          "implementation_interrupted_after_write",
        );
        controls.implementation = undefined;
        proof.push({
          sdk,
          generic_reviewed_mcp_tested_milestone: "passed",
          publication_retry_after_completed_mcp: "passed",
          uncertain_write_restart_preserves_tests: "passed",
          disabled_mcp: "passed",
        });

        complete("mcp-milestone-recovery");
      }
      if (!suite.startsWith("implementation-monitor-")) {
        const ready = await app.inject({ method: "GET", url: "/readyz" });
        assert.equal(ready.statusCode, 503);
        assert(ready.json().implementation.awaiting_remote_validation > 0);
        assert(!ready.body.includes("owner/repo"));
        assert(!logs.join("\n").includes(config.github.token));
        assert(!logs.join("\n").includes(config.proxy.key));
        assert(
          notifications.every(
            (item) =>
              !JSON.stringify(item).includes('"outcome":"ready_for_review"'),
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
        configure(false);
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
          await monitor.reconcile();
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
            !supervisor.notifications.repository
              .receipts()
              .some(
                (item) =>
                  supervisor.notifications.repository.event(item.event_id)
                    ?.prepared.event.job_id === monitored.job.id,
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
          assert(
            supervisor.notifications.repository
              .receipts()
              .some((item) => item.event_id === clean.notification_id),
          );
          assert.equal(
            remote.state.comments.get(monitored.job.issue_number).length,
            1,
          );
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
          configure(false);
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
          configure(false);
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
          configure(false);
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
          configure(false);
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
          configure(false);
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
          configure(false);
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
            await closeRuntime();
            config.notifications.discord = {
              enabled: true,
              webhook_url: `http://127.0.0.1:${notifier.address().port}/discord`,
            };
            configure(false);
            await start();
            attachMonitor();
            const transientReady = await run("source_only");
            certify(transientReady.job);
            controls.deferReady = true;
            const readyEvent = await pump(
              transientReady.job,
              (item) => item.stage === "ready",
            );
            const eventId = readyEvent.notification_id,
              readinessId = readyEvent.readiness_id,
              verificationGeneration = readyEvent.policy_generation,
              receipt = (channel) =>
                supervisor.notifications
                  .receipt(eventId)
                  .find((item) => item.channel === channel),
              wakeNotifications = async () => {
                const event = supervisor.notifications.prepare({
                  id: `wake-${readyEvent.id}`,
                  job_id: transientReady.job.id,
                  revision: transientReady.job.revision,
                  repository_id: 42,
                  issue_number: transientReady.job.issue_number,
                  occurred_at: readyEvent.started_at,
                  outcome: "needs_attention",
                  reason: "workflow_blocked",
                });
                await supervisor.notifications.enqueue(
                  event,
                  {},
                  new globalThis.AbortController().signal,
                );
              },
              expediteWebhook = () => {
                const pending = globalThis.structuredClone(receipt("webhook"));
                pending.retry_at = 0;
                supervisor.notifications.repository.save(pending);
              },
              releaseObservation = () => {
                const current = monitor.repository.get(transientReady.job.id);
                current.retry_at = 0;
                monitor.repository.save(current);
              };
            await until(
              () =>
                receipt("discord")?.state === "confirmed" &&
                receipt("webhook")?.state === "pending" &&
                receipt("webhook")?.attempts.length === 1,
              "Two-channel ready delivery did not reach its partial checkpoint",
            );
            controls.deferReady = false;
            const confirmedDiscord = globalThis.structuredClone(
                receipt("discord"),
              ),
              discordCount = () =>
                discordRequests.filter((event) =>
                  event.content.includes(`Event: ${eventId}`),
                ).length,
              webhookCount = () =>
                notifications.filter((event) => event.event_id === eventId)
                  .length,
              originalBudget = store.jobById(transientReady.job.id).budget_json;
            assert.equal(discordCount(), 1);
            assert.equal(webhookCount(), 1);
            remote.state.rateLimit = {
              method: "GET",
              path: `/repos/owner/repo/issues/${transientReady.job.issue_number}`,
              seconds: 60,
            };
            expediteWebhook();
            await wakeNotifications();
            await until(
              () => receipt("webhook")?.reason === "readiness_unavailable",
              "Delivery-time readiness outage was not retained as pending",
            );
            const suspended = monitor.repository.get(transientReady.job.id);
            assert.equal(suspended.stage, "waiting");
            assert.equal(suspended.failure, "github_rate_limited");
            assert(suspended.retry_at > Date.now() + 55_000);
            assert.equal(suspended.readiness_id, readinessId);
            assert.equal(suspended.notification_id, eventId);
            assert.equal(suspended.policy_generation, verificationGeneration);
            assert.throws(
              () => monitor.repository.readiness(readinessId),
              /pr_readiness_unavailable/,
            );
            assert.deepEqual(receipt("discord"), confirmedDiscord);
            assert.equal(receipt("webhook").attempts.length, 1);
            assert.equal(
              store.jobById(transientReady.job.id).budget_json,
              originalBudget,
            );
            const requestsBeforeRetry = remote.state.requests.length;
            expediteWebhook();
            await wakeNotifications();
            await until(
              () => receipt("webhook").retry_at > Date.now() + 29_000,
              "Suspended validation did not defer its retry",
            );
            assert.equal(
              remote.state.requests.length,
              requestsBeforeRetry,
              "Readiness retry ignored the retained GitHub backoff",
            );
            assert.equal(receipt("webhook").state, "pending");
            assert.equal(receipt("webhook").attempts.length, 1);
            assert.equal(webhookCount(), 1);
            assert.equal(discordCount(), 1);
            const deferredWebhook = globalThis.structuredClone(
              receipt("webhook"),
            );
            deferredWebhook.retry_at = Date.now() + 3_600_000;
            supervisor.notifications.repository.save(deferredWebhook);
            await closeRuntime();
            await start();
            attachMonitor();
            assert.deepEqual(receipt("discord"), confirmedDiscord);
            assert.equal(
              monitor.repository.get(transientReady.job.id).readiness_id,
              readinessId,
            );
            releaseObservation();
            await monitor.reconcile();
            assert.equal(
              monitor.repository.get(transientReady.job.id).stage,
              "ready",
            );
            assert.equal(
              monitor.repository.get(transientReady.job.id).readiness_id,
              readinessId,
            );
            assert.equal(
              monitor.repository.get(transientReady.job.id).notification_id,
              eventId,
            );
            assert.equal(
              monitor.repository.get(transientReady.job.id).policy_generation,
              verificationGeneration,
            );
            const target = supervisor.publication.repository.target(
                transientReady.job.id,
              ),
              retriesBefore = JSON.parse(
                store.jobById(transientReady.job.id).budget_json,
              ).infrastructure_retries;
            remote.state.readFailure = {
              path: `/repos/owner/repo/pulls/${target.pull.number}`,
              status: 503,
            };
            await monitor.reconcile();
            const periodicallySuspended = monitor.repository.get(
              transientReady.job.id,
            );
            assert.equal(periodicallySuspended.stage, "waiting");
            assert.equal(periodicallySuspended.failure, "github_read_failed");
            assert.equal(periodicallySuspended.readiness_id, readinessId);
            assert.equal(
              periodicallySuspended.policy_generation,
              verificationGeneration,
            );
            assert.equal(
              JSON.parse(store.jobById(transientReady.job.id).budget_json)
                .infrastructure_retries,
              retriesBefore + 1,
            );
            assert.deepEqual(receipt("discord"), confirmedDiscord);
            assert.equal(discordCount(), 1);
            assert.equal(webhookCount(), 1);
            releaseObservation();
            await monitor.reconcile();
            assert.equal(
              monitor.repository.get(transientReady.job.id).stage,
              "ready",
            );
            const cancellation = new globalThis.AbortController();
            cancellation.abort(new Error("fixture validation cancellation"));
            await assert.rejects(() =>
              monitor.validateReadiness(readinessId, cancellation.signal),
            );
            assert.equal(
              monitor.repository.get(transientReady.job.id).readiness_id,
              readinessId,
            );
            assert.equal(
              monitor.repository.get(transientReady.job.id).policy_generation,
              verificationGeneration,
            );
            expediteWebhook();
            await wakeNotifications();
            await until(
              () => receipt("webhook").state === "confirmed",
              "Recovered readiness did not resume the pending channel",
            );
            assert.deepEqual(receipt("discord"), confirmedDiscord);
            assert.equal(discordCount(), 1);
            assert.equal(webhookCount(), 2);
            assert.equal(receipt("webhook").attempts.length, 2);
            assert.equal(
              new Set(
                supervisor.notifications.repository
                  .receipts()
                  .filter(
                    (item) =>
                      supervisor.notifications.repository.event(item.event_id)
                        ?.prepared.event.job_id === transientReady.job.id &&
                      supervisor.notifications.repository.event(item.event_id)
                        ?.prepared.event.outcome === "ready_for_review",
                  )
                  .map((item) => item.event_id),
              ).size,
              1,
            );
            remote.state.readFailure = {
              path: `/repos/owner/repo/pulls/${target.pull.number}`,
              status: 200,
              body: {},
            };
            await assert.rejects(() =>
              monitor.validateReadiness(
                readinessId,
                new globalThis.AbortController().signal,
              ),
            );
            assert.equal(
              monitor.repository.get(transientReady.job.id).readiness_id,
              null,
            );
            assert.equal(
              monitor.repository.get(transientReady.job.id).policy_generation,
              verificationGeneration + 1,
            );
            controls.deferReady = true;
            const replacement = await pump(
              transientReady.job,
              (item) => item.stage === "ready",
            );
            const replacementId = replacement.notification_id,
              replacementReceipt = (channel) =>
                supervisor.notifications
                  .receipt(replacementId)
                  .find((item) => item.channel === channel);
            await until(
              () =>
                replacementReceipt("discord")?.state === "confirmed" &&
                replacementReceipt("webhook")?.state === "pending" &&
                replacementReceipt("webhook")?.attempts.length === 1,
              "Replacement ready event did not reach its partial checkpoint",
            );
            controls.deferReady = false;
            remote.state.readFailure = {
              path: `/repos/owner/repo/issues/${transientReady.job.issue_number}`,
              status: 503,
            };
            await assert.rejects(
              () =>
                monitor.validateReadiness(
                  replacement.readiness_id,
                  new globalThis.AbortController().signal,
                ),
              /github_read_failed/,
            );
            const originalWebhookUrl = config.notifications.webhook.url;
            await closeRuntime();
            config.notifications.webhook.url = originalWebhookUrl + "/changed";
            configure(false);
            await start();
            attachMonitor();
            assert.equal(replacementReceipt("webhook").state, "held");
            assert.equal(
              replacementReceipt("webhook").reason,
              "destination_changed",
            );
            assert.equal(replacementReceipt("discord").state, "confirmed");
            store.db
              .prepare(
                "UPDATE jobs SET budget_json=json_set(budget_json,'$.infrastructure_retries',?) WHERE id=?",
              )
              .run(
                snapshot.settings.limits.infrastructure_retries,
                transientReady.job.id,
              );
            releaseObservation();
            remote.state.readFailure = {
              path: `/repos/owner/repo/pulls/${target.pull.number}`,
              status: 503,
            };
            await monitor.reconcile();
            assert.equal(
              monitor.repository.get(transientReady.job.id).stage,
              "blocked",
            );
            assert.equal(
              monitor.repository.get(transientReady.job.id).failure,
              "github_read_failed",
            );
            assert.equal(
              monitor.repository.get(transientReady.job.id).readiness_id,
              null,
            );
            proof.push({
              sdk,
              readiness_partial_channels_transient_delivery_and_periodic_reads:
                "passed",
              readiness_transient_restart_same_event: "passed",
              readiness_cancellation_preserves_identity: "passed",
              readiness_unknown_response_invalidates: "passed",
            });
            await closeRuntime();
            config.notifications.webhook.url = originalWebhookUrl;
            config.notifications.discord = { enabled: false };
            configure(false);
            await start();
            attachMonitor();
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
          controls.loseReady = true;
          const staleClean = await pump(
            stale.job,
            (item) => item.stage === "ready",
          );
          await until(
            () =>
              supervisor.notifications
                .receipt(staleClean.notification_id)
                .some(
                  (item) =>
                    item.attempts.length === 1 && item.state === "pending",
                ),
            "Ready delivery did not record its ambiguous first attempt",
          );
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
          await until(
            () =>
              supervisor.notifications
                .receipt(staleClean.notification_id)
                .every((item) => item.state === "held"),
            "Stale ready notification was not held",
          );
          controls.loseReady = false;
          assert.equal(
            notifications.filter(
              (item) => item.event_id === staleClean.notification_id,
            ).length,
            1,
          );
          proof.push({
            sdk,
            stale_ready_retry_suppressed_after_human_head_change: "passed",
          });

          complete("stale-notification");
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
          const handoff = supervisor.notifications.repository.event(
            `pr-handoff-${legacyImplementation.id}`,
          );
          assert.equal(handoff.prepared.event.outcome, "needs_attention");
          assert.equal(record(legacy.job).scope, null);
          legacyImplementation.scope = savedScope;
          implementation.repository.save(legacyImplementation);
          proof.push({
            sdk,
            wait_budget_rechecked_after_remote_read: "passed",
            legacy_missing_receipts_visible_handoff: "passed",
          });
          complete("wait-budget-and-legacy-receipts");
        }
        if (suite === "implementation-monitor-mcp") {
          for (const denseMem of [false, true]) {
            const tools = await contextServer({ denseMem });
            try {
              await closeRuntime();
              const readTool = denseMem ? "recall_memory" : "lookup_record",
                writeTool = denseMem ? "remember" : "store_record",
                key = denseMem ? "idempotency_key" : "key";
              tools.state.expectedAuthorization =
                "Bearer monitor-project-scope-canary";
              config.mcp.credentials = {
                project: {
                  headers: { Authorization: tools.state.expectedAuthorization },
                },
              };
              config.mcp.servers = {
                context: {
                  transport: "streamable_http",
                  url: tools.url,
                  allow_plain_http: true,
                  credential_ref: "project",
                  review_required_tools: [writeTool],
                  tools: {
                    [readTool]: { effect: "read" },
                    [writeTool]: { effect: "write", idempotency_argument: key },
                  },
                },
              };
              config.roles.implementation.mcp = {
                context: { tools: [readTool, writeTool] },
              };
              const separated = separateSecrets(config);
              secrets = separated.secrets;
              snapshot = createRunSnapshot(
                separated.settings,
                bundlesWithCanaries(loaded),
                secrets,
              );
              await start();
              attachMonitor();
              const noteHandler = async (task, { run, text }) => {
                if (task !== "implementation_review_readiness") return;
                const input = taskInput(text),
                  calls = store
                    .mcpCalls()
                    .filter((item) => item.run_id === run.id);
                if (!calls.some((item) => item.tool === readTool))
                  return {
                    tool: `mcp__context__${readTool}`,
                    arguments: { query: "Current PR readiness evidence" },
                  };
                const write = supervisor.mcpWrites.repository
                  .all()
                  .find((item) => item.binding.run_id === run.id);
                if (!write)
                  return {
                    tool: `mcp__context__${writeTool}`,
                    arguments: {
                      arguments: denseMem
                        ? {
                            target_space: "team_shared",
                            evidence: [
                              {
                                content: `Current-head readiness ${input.receipt.head_sha}; human review required.`,
                              },
                            ],
                            relationships: [],
                          }
                        : {
                            text: `Current-head readiness ${input.receipt.head_sha}; human review required.`,
                          },
                      purpose:
                        "Record only the controller-proven current-head readiness milestone.",
                      evidence: [
                        { kind: "pr_monitor_evidence", id: input.readiness_id },
                      ],
                    },
                  };
                return {
                  result: {
                    summary: `Read outcome and write receipt ${write.state} are retained; a recorded provider response does not prove persistence.`,
                  },
                };
              };
              controls.implementation = noteHandler;
              let reviewed = 0;
              controls.review = async (text) => {
                if (
                  text.includes('"type":"mcp_write"') &&
                  text.includes('"kind":"pr_monitor_evidence"')
                )
                  reviewed++;
              };
              const notes = await run("source_only", noteHandler);
              controls.implementation = noteHandler;
              certify(notes.job);
              const noted = await pump(
                notes.job,
                (item) => item.stage === "ready",
              );
              assert.equal(tools.effects.size, 1);
              assert(reviewed > 0);
              const written = supervisor.mcpWrites.repository
                .all()
                .find((item) => item.job_id === notes.job.id);
              assert.equal(written.state, "response_recorded");
              assert.equal(written.review, "required");
              assert.equal(
                written.evidence[0].receipt.head_sha,
                noted.expected_head,
              );
              tools.state.denyRead = true;
              controls.rejectWrite = true;
              const denied = await run("source_only", noteHandler);
              controls.implementation = noteHandler;
              certify(denied.job);
              await pump(denied.job, (item) => item.stage === "ready");
              assert.equal(
                supervisor.mcpWrites.repository
                  .all()
                  .find((item) => item.job_id === denied.job.id).state,
                "rejected",
              );
              assert.equal(tools.effects.size, 1);
              controls.rejectWrite = false;
              tools.state.denyRead = false;
              const ambiguousHandler = async (task, context) => {
                if (task !== "implementation_review_readiness") return;
                const input = taskInput(context.text),
                  write = supervisor.mcpWrites.repository
                    .all()
                    .find((item) => item.binding.run_id === context.run.id);
                if (!write)
                  return {
                    tool: `mcp__context__${writeTool}`,
                    arguments: {
                      arguments: denseMem
                        ? {
                            target_space: "team_shared",
                            evidence: [
                              {
                                content: `Current head ${input.receipt.head_sha}, human review pending.`,
                              },
                            ],
                            relationships: [],
                          }
                        : {
                            text: `Current head ${input.receipt.head_sha}, human review pending.`,
                          },
                      purpose: "Record the actual readiness receipt once.",
                      evidence: [
                        { kind: "pr_monitor_evidence", id: input.readiness_id },
                      ],
                    },
                  };
                return {
                  result: {
                    summary:
                      "The actual write response is retained; persistence is not inferred from transport success.",
                  },
                };
              };
              controls.implementation = ambiguousHandler;
              const uncertain = await run("source_only", ambiguousHandler);
              controls.implementation = ambiguousHandler;
              certify(uncertain.job);
              await monitor.reconcile();
              const effectsBefore = tools.effects.size;
              tools.state.hold = true;
              const stop = new globalThis.AbortController(),
                advancing = monitor.advance(
                  store.jobById(uncertain.job.id),
                  stop.signal,
                );
              const deadline = Date.now() + 30000;
              while (tools.effects.size === effectsBefore) {
                assert(
                  Date.now() < deadline,
                  "readiness write was not dispatched",
                );
                await delay(20);
              }
              stop.abort(new Error("planned readiness cancellation"));
              await advancing;
              tools.state.hold = false;
              tools.state.release?.();
              await closeRuntime();
              await start();
              attachMonitor();
              const recovered = await pump(
                uncertain.job,
                (item) => item.stage === "ready",
              );
              assert.equal(tools.effects.size, effectsBefore + 1);
              assert.equal(
                supervisor.publication.repository.target(uncertain.job.id).head,
                recovered.expected_head,
              );
              assert.equal(
                record(uncertain.job).tests.filter(
                  (item) => item.state === "passed",
                ).length,
                1,
              );
              proof.push({
                sdk,
                provider: denseMem ? "Dense-Mem example" : "generic MCP",
                readiness_reviewed_write: "passed",
                read_denial_and_write_rejection: "passed",
                cancelled_ambiguous_write_recovery_preserves_github: "passed",
              });
              complete(`readiness-mcp-${denseMem ? "dense" : "generic"}`);
            } catch (error) {
              errors.push(error);
              throw error;
            } finally {
              controls.implementation = undefined;
              controls.review = undefined;
              controls.rejectWrite = false;
              await closeRuntime();
              await tools.close();
            }
          }
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
      () => context.close(),
      ...[model, notifier].map((server) => async () => {
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
