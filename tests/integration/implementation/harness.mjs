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
import { userProcesses } from "/opt/orm/app/dist/runtime/process.js";
import { createPublicationFixture } from "/publication-fixture.ts";
import { respond as claude } from "/agent-fixtures/claude.mjs";
import { respond as codex } from "/agent-fixtures/codex.mjs";
import {
  sourceFiles,
  bundlesWithCanaries,
  modelFixture,
  maintenanceCommand,
} from "/investigation-fixtures/protocol.mjs";
import { contextServer } from "/investigation-fixtures/mcp.mjs";

export async function runImplementationTests(sdks = ["codex", "claude"]) {
  assert(
    sdks.length > 0 && sdks.every((sdk) => ["codex", "claude"].includes(sdk)),
  );
  const root = "/data/implementation-proof";
  await mkdir(root, { mode: 0o711 });
  const loaded = await loadProtectedConfiguration(),
    context = await contextServer();
  const notifications = [],
    logs = [],
    errors = [],
    proof = [];
  let fixture,
    sdk,
    store,
    supervisor,
    gateway,
    intake,
    investigation,
    implementation,
    app,
    remote;
  const controls = {};
  const model = createServer((req, res) =>
    (sdk === "claude" ? claude : codex)(req, res, fixture),
  );
  const notifier = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    notifications.push(JSON.parse(body));
    res.end("accepted");
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => notifier.listen(0, "127.0.0.1", resolve));
  const logger = {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
  };
  const closeRuntime = async () => {
    await investigation?.stop();
    await intake?.stop();
    await app?.close();
    await supervisor?.close();
    await gateway?.close();
    if (fixture) errors.push(...fixture.errors.splice(0));
    if (store?.db.open) store.close();
    investigation = undefined;
    intake = undefined;
    app = undefined;
    supervisor = undefined;
    gateway = undefined;
    store = undefined;
    fixture = undefined;
  };
  try {
    for (sdk of sdks) {
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
      await investigation.reconcile();
      await investigation.reconcile();
      assert.equal(remote.state.mutations.length, effects);
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

      const sourceOnly = await run("source_only");
      assert.equal(sourceOnly.result.stage, "remote_review");
      assert.equal(
        investigation.repository.current(store.job(sourceOnly.job.issue_number))
          .result.proof,
        "source",
      );
      assert(
        remote.state.comments
          .get(sourceOnly.job.issue_number)[0]
          .body.includes("not reproduced"),
      );
      const feature = await add("manual_feature");
      await investigation.reconcile();
      assert.equal(record(feature), undefined);
      noPull(feature);

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
        proof.push({ sdk, scenario: mode, gate: "blocked_before_publication" });
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
      }

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

      const closed = await add("close_during_implementation");
      controls.implementation = async (task) => {
        if (task === "implementation_change") {
          remote.state.closed.add(closed.issue_number);
          await intake.refresh(closed.issue_number, AbortSignal.timeout(10000));
        }
      };
      await advance(closed);
      controls.implementation = undefined;
      assert.equal(record(closed).stage, "cancelled");
      noPull(closed);
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
      assert(publicationLimited, "Publication read failure was not exercised");
      assert.equal(mcpCheckpoint.stage, "blocked");
      assert.equal(mcpCheckpoint.failure, "github_rate_limited");
      assert.equal(mcpCheckpoint.retry_stage, "publishing");
      assert.equal(mcpCheckpoint.milestone_done, true);
      assert.equal(mcpCheckpoint.agent_pending, null);
      noPull(mcpJob);
      const implementationRuns = store
          .runs()
          .filter(
            (run) => run.job_id === mcpJob.id && run.role === "implementation",
          )
          .map((run) => run.id),
        checkpointEffects = context.effects.size;
      await closeRuntime();
      await start();
      await delay(Math.max(0, mcpCheckpoint.retry_at - Date.now()) + 100);
      const mcpResult = await advance(mcpJob);
      assert.equal(mcpResult.stage, "remote_review", JSON.stringify(mcpResult));
      assert.equal(mcpResult.test_id, mcpCheckpoint.test_id);
      assert.equal(mcpResult.audit_id, mcpCheckpoint.audit_id);
      assert.equal(mcpResult.publication_id, mcpCheckpoint.publication_id);
      assert.deepEqual(
        store
          .runs()
          .filter(
            (run) => run.job_id === mcpJob.id && run.role === "implementation",
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
    return { implementation: "passed", scenarios: proof, cleanup: "passed" };
  } finally {
    await closeRuntime();
    await remote?.close();
    await context.close();
    for (const server of [model, notifier]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
