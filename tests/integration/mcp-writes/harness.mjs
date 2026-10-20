import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "/opt/orm/app/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js";
import { Client } from "/opt/orm/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "/opt/orm/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "/opt/orm/app/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "/opt/orm/app/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";
import { userProcesses } from "/opt/orm/app/dist/runtime/process.js";
import { McpGateway } from "/opt/orm/app/dist/services/mcp/index.js";
import { PublicationScanner } from "/opt/orm/app/dist/services/publication/scanner.js";
import {
  loadProtectedConfiguration,
  createRunSnapshot,
} from "/opt/orm/app/dist/config/load.js";
import { parseConfiguration } from "/opt/orm/app/dist/config/schema.js";
import { separateSecrets } from "/opt/orm/app/dist/config/secrets.js";
import { createApp } from "/opt/orm/app/dist/http/app.js";
import { createPublicationFixture } from "/publication-fixture.ts";
import { Octokit } from "/opt/orm/app/node_modules/@octokit/rest/dist-src/index.js";
import { OctokitWriter } from "/opt/orm/app/dist/adapters/github/writer.js";
import { respond as claude } from "/agent-fixtures/claude.mjs";
import { respond as codex } from "/agent-fixtures/codex.mjs";

async function collect(stream) {
  const result = [];
  for await (const event of stream) result.push(event);
  return result;
}
async function until(check) {
  const end = Date.now() + 20000;
  while (!(await check())) {
    assert(Date.now() < end, "MCP write fixture timed out");
    await delay(20);
  }
}
const signal = () => new globalThis.AbortController().signal;

export async function runMcpWriteTests() {
  const root = "/data/mcp-write-proof";
  await mkdir(root, { mode: 0o711 });
  const remote = await createPublicationFixture(join(root, "git")),
    loaded = await loadProtectedConfiguration();
  const sessions = new Map(),
    servers = new Set(),
    calls = [],
    effects = new Map(),
    activeResponses = new Map(),
    errors = [],
    requests = [],
    noticeRequests = [];
  let sdk,
    fixture,
    store,
    supervisor,
    gateway,
    config,
    snapshot,
    secrets,
    options,
    rejectReview = false,
    wrongBinding = false,
    lose = false,
    providerMode = "normal",
    holdReview,
    enteredReview = false,
    holdWrite,
    enteredWrite = false,
    race = false,
    catalogRevision = 0,
    shortenedDeadline = false,
    workerAuthorization,
    number = 14000;
  const credential = `mcp-write-service-${randomUUID()}`,
    unknownSecret = "ghp_" + "Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0Uv9Wx8";
  const catalogue = () =>
    ["remember", "store_record", "append", "read"].map((name) => ({
      name,
      description: `Generic ${name} fixture ${catalogRevision}`,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          ...(name === "append" || name === "read"
            ? {}
            : { key: { type: "string" } }),
        },
        required:
          name === "append" || name === "read" ? ["text"] : ["text", "key"],
        additionalProperties: false,
      },
    }));
  const upstream = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${credential}`);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      if (body?.method === "tools/call")
        activeResponses.set(`${req.headers["mcp-session-id"]}:${body.id}`, res);
      let session = sessions.get(req.headers["mcp-session-id"]);
      if (!session) {
        if (body?.method !== "initialize") {
          res.writeHead(404);
          res.end();
          return;
        }
        const server = new Server(
          { name: "generic-write-fixture", version: "1" },
          { capabilities: { tools: {} } },
        );
        let sessionId;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            sessionId = id;
            sessions.set(id, { server, transport });
          },
          keepAliveMs: 0,
        });
        servers.add(server);
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: catalogue(),
        }));
        server.setRequestHandler(
          CallToolRequestSchema,
          async (message, extra) => {
            const args = message.params.arguments,
              name = message.params.name;
            calls.push({
              name,
              args: globalThis.structuredClone(args),
              bytes: JSON.stringify(args),
            });
            assert(!JSON.stringify(args).includes(credential));
            const effectKey = args.key ?? `unkeyed-${calls.length}`;
            if (!effects.has(effectKey))
              effects.set(effectKey, { name, text: args.text });
            if (holdWrite) {
              enteredWrite = true;
              await holdWrite;
            }
            if (lose) {
              lose = false;
              activeResponses.get(`${sessionId}:${extra.requestId}`).destroy();
            }
            if (providerMode === "error")
              throw new McpError(-32008, "safe fixture error", {
                reason: "unsupported",
              });
            if (providerMode === "gateway_secret_error")
              throw new McpError(-32008, "fixture error", {
                credential: workerAuthorization,
              });
            if (providerMode === "secret")
              return { content: [{ type: "text", text: credential }] };
            if (providerMode === "tool_error")
              return {
                content: [{ type: "text", text: "domain declined" }],
                isError: true,
                structuredContent: { accepted: false },
              };
            return {
              content: [{ type: "text", text: "provider recorded" }],
              structuredContent: {
                accepted: true,
                ...(args.key ? { key: args.key } : {}),
              },
            };
          },
        );
        await server.connect(transport);
        session = { server, transport };
      }
      await session.transport.handleRequest(req, res, body);
    } catch (error) {
      errors.push(error);
      res.destroy();
    }
  });
  const model = createServer((req, res) =>
    (sdk === "claude" ? claude : codex)(req, res, fixture),
  );
  const notifications = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    noticeRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => notifications.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${upstream.address().port}/mcp`,
    proxy = `http://127.0.0.1:${model.address().port}/v1`;
  const database = join(root, "state", "db.sqlite");
  store = new Store(database);
  store.enroll({
    id: 42,
    full_name: "owner/repo",
    default_branch: "main",
    private: false,
  });
  const seed = () => {
    store.saveSnapshot(snapshot);
    store.discover([++number], 1, true);
    store.applyIssue(
      store.nextDirty(),
      {
        id: number + 10000,
        number,
        state: "open",
        title: "Captured write claim",
        body: "The source app.txt contains original.",
        updated_at: "2026-10-20T00:00:00Z",
        comments: [],
        source: remote.source,
      },
      snapshot,
    );
    return store.job(number);
  };
  const reviewed = (
    text = "The source app.txt contains original.",
    evidence = [
      { kind: "source", path: "app.txt", start_line: 1, end_line: 1 },
    ],
  ) => ({
    arguments: { text },
    purpose: "Record verified source context",
    evidence,
  });
  const run = async (
    job,
    {
      role = "implementation",
      alias = "reviewed",
      tool = "remember",
      input = reviewed(),
      controller,
    } = {},
  ) => {
    fixture.writeAlias = alias;
    fixture.writeTool = tool;
    fixture.writeInput = input;
    fixture.writeResults = [];
    return (
      await collect(
        supervisor.run(
          supervisor.request(job.id, role, { scenario: "mcp_write" }),
          controller?.signal ?? signal(),
        ),
      )
    ).at(-1);
  };
  const operation = (job) =>
    supervisor.mcpWrites.repository
      .all()
      .findLast((op) => op.job_id === job.id);
  const boot = async (openFailures = []) => {
    gateway = new McpGateway(store, snapshot, secrets);
    const open = gateway.open.bind(gateway);
    gateway.open = async (request) => {
      try {
        const session = await open(request);
        workerAuthorization = session.connections[0]?.authorization;
        return session;
      } catch (error) {
        openFailures.push(error.code);
        throw error;
      }
    };
    options.mcp = gateway;
    supervisor = await Supervisor.create(store, snapshot, secrets, options);
    gateway.setWriteDispatcher({
      assertAvailable: (reviewed) =>
        supervisor.mcpWrites.assertAvailable(reviewed),
      dispatch: async (request, channel) => {
        if (shortenedDeadline)
          request = { ...request, deadline: Date.now() + 3000 };
        if (!race) return supervisor.mcpWrites.dispatch(request, channel);
        race = false;
        const cancellation = new globalThis.AbortController();
        return supervisor.mcpWrites.dispatch(
          { ...request, signal: cancellation.signal },
          {
            ...channel,
            transmit: async (...args) => {
              const result = await channel.transmit(...args);
              cancellation.abort();
              return result;
            },
          },
        );
      },
    });
    await gateway.start();
    supervisor.notifications.start();
  };
  const shutdown = async () => {
    await supervisor?.close();
    await gateway?.close();
    supervisor = undefined;
    gateway = undefined;
  };
  const proof = [];
  try {
    for (sdk of ["codex", "claude"]) {
      config = parseConfiguration(await readFile("/config/config.yml", "utf8"));
      config.github.repository = "owner/repo";
      config.github.token = remote.state.token;
      config.proxy.url = proxy;
      config.proxy.key = `write-model-${randomUUID()}`;
      config.notifications = {
        discord: { enabled: false },
        smtp: { enabled: false },
        webhook: {
          enabled: true,
          url: `http://127.0.0.1:${notifications.address().port}/notice`,
          headers: {},
        },
      };
      config.mcp.credentials = {
        service: { headers: { Authorization: `Bearer ${credential}` } },
      };
      config.mcp.servers = Object.fromEntries(
        ["reviewed", "ordinary"].map((alias) => [
          alias,
          {
            transport: "streamable_http",
            url: endpoint,
            allow_plain_http: true,
            credential_ref: "service",
            review_required_tools:
              alias === "reviewed" ? ["remember", "store_record"] : [],
            tools: {
              remember: { effect: "write", idempotency_argument: "key" },
              store_record: { effect: "write", idempotency_argument: "key" },
              append: { effect: "write" },
              read: { effect: "read" },
            },
          },
        ]),
      );
      config.limits.infrastructure_retries = 2;
      const profile =
        sdk === "claude"
          ? {
              sdk: "claude",
              model: "auto",
              behaves_as: "claude-opus-4-8",
              effort: "xhigh",
            }
          : { sdk: "codex", model: "gpt-5.5", effort: "xhigh" };
      config.profiles = { coding: profile };
      const bundles = {};
      for (const role of Object.keys(config.roles)) {
        config.roles[role].profile = "coding";
        config.roles[role].mcp =
          role === "output_review"
            ? {}
            : {
                reviewed: {
                  tools: ["remember", "store_record", "append", "read"],
                },
                ordinary: {
                  tools: ["remember", "store_record", "append", "read"],
                },
              };
        const bundle = globalThis.structuredClone(
          loaded.snapshot.roles[role].bundle,
        );
        bundle.system += "\nOPERATOR_SYSTEM_CANARY";
        bundle.user += "\nOPERATOR_USER_CANARY";
        for (const file of bundle.skills)
          if (file.path.endsWith("SKILL.md")) {
            const bytes = Buffer.concat([
              Buffer.from(file.content_base64, "base64"),
              Buffer.from("\nOPERATOR_SKILL_CANARY"),
            ]);
            file.content_base64 = bytes.toString("base64");
            file.sha256 = createHash("sha256").update(bytes).digest("hex");
          }
        bundles[role] = bundle;
      }
      const separated = separateSecrets(config);
      secrets = separated.secrets;
      snapshot = createRunSnapshot(separated.settings, bundles, secrets);
      options = {
        root: join(root, `runtime-${sdk}`),
        sourceUrl: () => remote.url + "/owner/repo.git",
        publicationWriter: (ready) =>
          new OctokitWriter(
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
            ready,
          ),
        workers: { [sdk]: `/opt/orm/app/dist/adapters/agents/${sdk}.js` },
      };
      fixture = {
        config,
        store,
        root: options.root,
        requests,
        errors,
        histories: new Map(),
        mcpCredential: credential,
        writeResults: [],
        async outputReview(text) {
          enteredReview = true;
          const reviewer = store
            .runs()
            .findLast((run) => run.finished_at === null);
          assert.equal(reviewer.role, "output_review");
          assert.equal(reviewer.uid, 10003);
          assert.equal(reviewer.session_id, null);
          assert.equal(store.leases().length, 1);
          if (reviewer.parent_id) {
            const parent = store.run(reviewer.parent_id);
            assert([10001, 10002].includes(parent.uid));
            assert(
              (await userProcesses(parent.uid)).some(
                (process) => process.state === "T",
              ),
              "Requesting UID was not suspended",
            );
          }
          assert(text.includes('"repository":"owner/repo"'));
          const binding = /"binding":"([a-f0-9]{64})"/.exec(text)[1];
          if (holdReview) await holdReview;
          return {
            approved: !rejectReview,
            binding: wrongBinding ? "0".repeat(64) : binding,
            findings: rejectReview ? ["unsupported claim"] : [],
          };
        },
      };
      const normalSnapshot = snapshot,
        normalSecrets = secrets,
        unavailableConfig = globalThis.structuredClone(config),
        openFailures = [];
      unavailableConfig.profiles.reviewer =
        sdk === "codex"
          ? {
              sdk: "claude",
              model: "auto",
              behaves_as: "claude-opus-4-8",
              effort: "xhigh",
            }
          : { sdk: "codex", model: "gpt-5.5", effort: "xhigh" };
      unavailableConfig.roles.output_review.profile = "reviewer";
      const unavailable = separateSecrets(unavailableConfig);
      snapshot = createRunSnapshot(
        unavailable.settings,
        bundles,
        unavailable.secrets,
      );
      secrets = unavailable.secrets;
      try {
        await boot(openFailures);
        const job = seed(),
          before = calls.length;
        assert.equal(supervisor.outputReviewAvailable(), false);
        assert.equal((await run(job)).outcome, "failed");
        assert.deepEqual(openFailures, ["mcp_write_review_unavailable"]);
        assert.equal(calls.length, before);
        assert.equal(operation(job), undefined);
        assert.equal(
          store
            .runs()
            .filter(
              (run) => run.job_id === job.id && run.role === "output_review",
            ).length,
          0,
        );
        proof.push({ sdk, review_unavailable: "blocked" });
      } finally {
        await shutdown();
        snapshot = normalSnapshot;
        secrets = normalSecrets;
      }
      await boot();
      const scanner = supervisor.publication.outputReview.scanner,
        generatedKey = "89abcdef-0123-4567-89ab-cdef01234567",
        generatedBinding = createHash("sha256")
          .update(generatedKey)
          .digest("hex"),
        generatedValues = [generatedBinding, generatedKey];
      await assert.rejects(
        scanner.scan({ key: generatedKey }, signal()),
        /publication_scan_failed/,
      );
      await scanner.scan(
        { credential_binding: generatedBinding, key: generatedKey },
        signal(),
        generatedValues,
      );
      await assert.rejects(
        scanner.scan(
          { key: "01234567-89ab-4cde-8f01-23456789abcd" },
          signal(),
          generatedValues,
        ),
        /publication_scan_failed/,
      );
      await assert.rejects(
        scanner.scan(
          { key: generatedKey, text: credential },
          signal(),
          generatedValues,
        ),
        /publication_secret/,
      );
      await assert.rejects(
        scanner.scan(
          {
            key: generatedKey,
            text: unknownSecret,
          },
          signal(),
          generatedValues,
        ),
        /publication_scan_failed/,
      );
      await assert.rejects(
        new PublicationScanner(
          join(root, "generated-secret-scan"),
          separateSecrets({
            ...config,
            proxy: { ...config.proxy, key: generatedKey },
          }).secrets,
        ).scan({ key: generatedKey }, signal(), [generatedKey]),
        /publication_secret/,
      );
      await assert.rejects(
        scanner.scan({ text: "ordinary" }, signal(), [".*"]),
        /publication_scan_failed/,
      );
      proof.push({ sdk, exact_controller_values: "passed" });
      for (const role of ["implementation", "audit"])
        for (const tool of ["remember", "store_record"]) {
          const job = seed(),
            before = calls.length,
            terminal = await run(job, { role, tool });
          assert.equal(terminal.outcome, "completed");
          assert.equal(
            calls.length,
            before + 1,
            JSON.stringify({
              operation: operation(job)
                ? {
                    state: operation(job).state,
                    failure: operation(job).failure,
                  }
                : null,
              runs: store
                .runs()
                .filter((run) => run.job_id === job.id)
                .map((run) => ({ role: run.role, status: run.status })),
              model_errors: errors.map((error) => error.name),
            }),
          );
          assert.equal(operation(job).state, "response_recorded");
          assert.equal(operation(job).review, "required");
          assert(operation(job).review_id);
          assert.equal(
            store
              .runs()
              .filter(
                (run) => run.job_id === job.id && run.role === "output_review",
              ).length,
            1,
          );
          assert.deepEqual(calls.at(-1).args, {
            key: operation(job).idempotency_key,
            text: "The source app.txt contains original.",
          });
          const ordinary = seed();
          assert.equal(
            (
              await run(ordinary, {
                role,
                tool,
                alias: "ordinary",
                input: { text: "Unreviewed proposal" },
              })
            ).outcome,
            "completed",
          );
          assert.equal(operation(ordinary).review, "not_required");
          assert.equal(operation(ordinary).review_id, null);
          assert.equal(
            store
              .runs()
              .filter(
                (run) =>
                  run.job_id === ordinary.id && run.role === "output_review",
              ).length,
            0,
          );
        }
      for (const [label, input] of [
        ["unsupported", reviewed("Unsupported claim")],
        ["wrong binding", reviewed()],
        [
          "missing purpose",
          { arguments: { text: "claim" }, evidence: [{ kind: "job" }] },
        ],
        [
          "escaped source",
          reviewed("claim", [
            { kind: "source", path: "../escape", start_line: 1, end_line: 1 },
          ]),
        ],
        [
          "binary source",
          reviewed("claim", [
            { kind: "source", path: "image.bin", start_line: 1, end_line: 1 },
          ]),
        ],
        [
          "forged key",
          { ...reviewed(), arguments: { text: "claim", key: "worker-key" } },
        ],
      ]) {
        rejectReview = label === "unsupported";
        wrongBinding = label === "wrong binding";
        const job = seed(),
          before = calls.length;
        await run(job, { input });
        assert.equal(calls.length, before, label);
        assert.equal(operation(job).state, "rejected", label);
        rejectReview = false;
        wrongBinding = false;
      }
      const secret = seed(),
        beforeSecret = calls.length;
      await run(secret, {
        alias: "ordinary",
        input: { text: unknownSecret },
      });
      assert.equal(calls.length, beforeSecret);
      assert.equal(operation(secret).state, "rejected");
      assert.equal(operation(secret).arguments, null);
      assert(!JSON.stringify(operation(secret)).includes(unknownSecret));
      for (const mode of ["tool_error", "error"]) {
        providerMode = mode;
        const job = seed(),
          before = calls.length;
        await run(job, {
          alias: "ordinary",
          input: { text: "Domain response" },
        });
        assert.equal(calls.length, before + 1);
        assert.equal(operation(job).state, "response_recorded");
        assert.equal(
          operation(job).response.kind,
          mode === "error" ? "error" : "result",
        );
        if (mode === "tool_error")
          assert.equal(operation(job).response.value.isError, true);
        try {
          await supervisor.mcpWrites.recover(operation(job).id, signal());
        } catch (error) {
          assert.equal(mode, "error");
          assert.equal(error.code, -32008);
        }
        assert.equal(calls.length, before + 1);
      }
      providerMode = "normal";
      const concurrent = seed();
      let releaseWrite;
      enteredWrite = false;
      holdWrite = new Promise((resolve) => {
        releaseWrite = resolve;
      });
      const running = run(concurrent, {
        alias: "ordinary",
        input: { text: "Only one write at a time" },
      });
      await until(() => enteredWrite);
      const parent = store
        .runs()
        .findLast(
          (run) => run.job_id === concurrent.id && run.finished_at === null,
        );
      const extraSession = await gateway.open({
        run_id: parent.id,
        job_id: concurrent.id,
        revision: concurrent.revision,
        role: parent.role,
        grants: snapshot.roles[parent.role].mcp,
        deadline: Date.now() + 30000,
        signal: signal(),
      });
      const connection = extraSession.connections.find(
          (connection) => connection.alias === "reviewed",
        ),
        client = new Client(
          { name: "concurrency-fixture", version: "1" },
          { capabilities: {} },
        );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(connection.url), {
          requestInit: {
            headers: { Authorization: `Bearer ${connection.authorization}` },
          },
        }),
      );
      const concurrentCalls = calls.length;
      await assert.rejects(
        () => client.callTool({ name: "remember", arguments: reviewed() }),
        /mcp_write_busy/,
      );
      assert.equal(calls.length, concurrentCalls);
      releaseWrite();
      holdWrite = undefined;
      await running;
      await client.close();
      await extraSession.close();
      const raced = seed();
      race = true;
      await run(raced, {
        alias: "ordinary",
        input: { text: "Response before cancellation" },
      });
      assert.equal(operation(raced).state, "response_recorded");
      const raceCalls = calls.length;
      await supervisor.mcpWrites.recover(operation(raced).id, signal());
      assert.equal(calls.length, raceCalls);
      const storageFailure = seed(),
        storageCalls = calls.length;
      store.db
        .exec(`CREATE TRIGGER fail_mcp_response BEFORE UPDATE ON mcp_write_operations
        WHEN NEW.job_id=${storageFailure.id} AND NEW.state IN ('response_recorded','uncertain')
        BEGIN SELECT RAISE(ABORT,'fixture_response_storage_failure'); END`);
      const storageTerminal = await run(storageFailure, {
        alias: "ordinary",
        input: { text: "Effect with unavailable response storage" },
      });
      assert.notEqual(storageTerminal.outcome, "completed");
      assert.equal(calls.length, storageCalls + 1);
      const storageId = operation(storageFailure).id;
      assert.equal(operation(storageFailure).state, "dispatching");
      assert.equal(
        store.acquireLease(storageFailure.id, storageFailure.revision),
        undefined,
      );
      store.db.exec("DROP TRIGGER fail_mcp_response");
      await shutdown();
      store.close();
      store = new Store(database);
      fixture.store = store;
      await boot();
      assert.equal(supervisor.mcpWrites.receipt(storageId).state, "uncertain");
      assert.equal(calls.length, storageCalls + 1);
      await supervisor.mcpWrites.recover(storageId, signal());
      assert.equal(
        supervisor.mcpWrites.receipt(storageId).state,
        "response_recorded",
      );
      for (const keyed of [true, false]) {
        const job = seed();
        let priorPublication, priorNotice;
        const priorEvent = `confirmed-before-mcp-${sdk}-${job.id}`;
        if (keyed) {
          priorPublication = await supervisor.publication.publish(
            {
              job_id: job.id,
              revision: job.revision,
              kind: "status",
              body: "The captured issue requests a correction.",
            },
            signal(),
          );
          assert.equal(priorPublication.status, "confirmed");
          const prepared = supervisor.notifications.prepare({
            id: priorEvent,
            job_id: job.id,
            revision: job.revision,
            repository_id: 42,
            issue_number: job.issue_number,
            occurred_at: Date.now(),
            outcome: "needs_attention",
            reason: "workflow_blocked",
          });
          await supervisor.notifications.enqueue(prepared, {}, signal());
          await until(() =>
            supervisor.notifications
              .receipt(priorEvent)
              .every((receipt) => receipt.state === "confirmed"),
          );
          priorNotice = supervisor.notifications.receipt(priorEvent);
          assert(priorNotice.length);
          assert.equal(
            noticeRequests.filter((request) => request.event_id === priorEvent)
              .length,
            1,
          );
        }
        lose = true;
        await run(job, {
          alias: "ordinary",
          tool: keyed ? "remember" : "append",
          input: { text: "Effect before response loss" },
        });
        const uncertain = operation(job),
          before = calls.length,
          last = calls.at(-1);
        assert.equal(uncertain.state, "uncertain");
        assert.equal(uncertain.notification, "enqueued");
        assert.equal(store.acquireLease(job.id, job.revision), undefined);
        await assert.rejects(
          () =>
            collect(
              supervisor.run(
                supervisor.request(job.id, "implementation"),
                signal(),
              ),
            ),
          /mcp_write_job_blocked/,
        );
        const eventId = `mcp-write-${uncertain.id}`;
        await until(() =>
          supervisor.notifications
            .receipt(eventId)
            .every((receipt) => receipt.state === "confirmed"),
        );
        const notice = supervisor.notifications.receipt(eventId);
        assert(notice.length);
        assert.equal(
          store.db
            .prepare("SELECT count(*) AS n FROM notification_events WHERE id=?")
            .get(eventId).n,
          1,
        );
        const app = createApp(
            undefined,
            undefined,
            supervisor.notifications,
            supervisor.mcpWrites,
          ),
          ready = await app.inject("/readyz");
        assert.equal(ready.statusCode, 503);
        assert.equal(ready.json().reason, "automation_not_implemented");
        assert(ready.json().mcp_writes.uncertain >= 1);
        assert(!ready.body.includes("Effect before response loss"));
        await app.close();
        if (keyed) {
          const effectCount = effects.size,
            deadline = uncertain.deadline,
            publicationMutations = [...remote.state.mutations],
            publicationObjects = globalThis.structuredClone([
              ...remote.state.comments,
            ]),
            publicationReceipts = store.db
              .prepare("SELECT * FROM publications WHERE job_id=?")
              .all(job.id);
          await shutdown();
          store.close();
          store = new Store(database);
          fixture.store = store;
          await boot();
          assert.equal(calls.length, before, "Startup transmitted a write");
          const result = await supervisor.mcpWrites.recover(
            uncertain.id,
            signal(),
          );
          assert.equal(result.structuredContent.accepted, true);
          assert.equal(calls.length, before + 1);
          assert.equal(calls.at(-1).bytes, last.bytes);
          assert.equal(effects.size, effectCount);
          assert.equal(
            supervisor.mcpWrites.receipt(uncertain.id).deadline,
            deadline,
          );
          assert.equal(
            JSON.parse(store.jobById(job.id).budget_json)
              .infrastructure_retries,
            1,
          );
          assert.deepEqual(supervisor.notifications.receipt(eventId), notice);
          assert.deepEqual(
            supervisor.notifications.receipt(priorEvent),
            priorNotice,
          );
          assert.equal(
            noticeRequests.filter((request) => request.event_id === priorEvent)
              .length,
            1,
          );
          assert.equal(
            noticeRequests.filter((request) => request.event_id === eventId)
              .length,
            1,
          );
          assert.deepEqual(remote.state.mutations, publicationMutations);
          assert.deepEqual([...remote.state.comments], publicationObjects);
          assert.deepEqual(
            supervisor.publication.repository.operation(priorPublication.id),
            priorPublication,
          );
          assert.deepEqual(
            store.db
              .prepare("SELECT * FROM publications WHERE job_id=?")
              .all(job.id),
            publicationReceipts,
          );
          const count = calls.length;
          await supervisor.mcpWrites.recover(uncertain.id, signal());
          assert.equal(calls.length, count);
        } else {
          await assert.rejects(
            () => supervisor.mcpWrites.recover(uncertain.id, signal()),
            /mcp_write_replay_unsafe/,
          );
          assert.equal(calls.length, before);
          assert.equal(
            supervisor.mcpWrites.receipt(uncertain.id).state,
            "uncertain",
          );
          store.discover([job.issue_number], 1, true);
          const context = JSON.parse(store.jobById(job.id).input_json);
          context.body = "Changed issue revision";
          store.applyIssue(store.nextDirty(), context, snapshot);
          assert.equal(store.acquireLease(job.id, job.revision + 1), undefined);
          await assert.rejects(
            () => supervisor.mcpWrites.recover(uncertain.id, signal()),
            /mcp_write_authority_changed/,
          );
          assert.equal(calls.length, before);
          assert.equal(
            supervisor.mcpWrites.receipt(uncertain.id).state,
            "uncertain",
          );
        }
      }
      const exhausted = seed();
      lose = true;
      await run(exhausted, {
        alias: "ordinary",
        input: { text: "Lost repeated keyed responses" },
      });
      const exhaustedId = operation(exhausted).id;
      for (let index = 0; index < 2; index++) {
        lose = true;
        await assert.rejects(
          () => supervisor.mcpWrites.recover(exhaustedId, signal()),
          /mcp_write_uncertain/,
        );
      }
      const exhaustedCalls = calls.length;
      await assert.rejects(
        () => supervisor.mcpWrites.recover(exhaustedId, signal()),
        /infrastructure_budget_exhausted/,
      );
      assert.equal(calls.length, exhaustedCalls);
      const changed = seed();
      lose = true;
      await run(changed, { input: reviewed() });
      const changedId = operation(changed).id,
        changedCalls = calls.length;
      catalogRevision++;
      await assert.rejects(
        () => supervisor.mcpWrites.recover(changedId, signal()),
        /mcp_write_binding_changed/,
      );
      catalogRevision--;
      assert.equal(calls.length, changedCalls);
      assert.equal(supervisor.mcpWrites.receipt(changedId).state, "uncertain");
      rejectReview = true;
      await assert.rejects(
        () => supervisor.mcpWrites.recover(changedId, signal()),
        /output_review_rejected/,
      );
      rejectReview = false;
      assert.equal(calls.length, changedCalls);
      assert.equal(supervisor.mcpWrites.receipt(changedId).state, "uncertain");
      await supervisor.mcpWrites.recover(changedId, signal());
      assert.equal(calls.length, changedCalls + 1);
      const limited = seed(),
        limitedCalls = calls.length;
      store.db
        .prepare(
          "UPDATE jobs SET budget_json=json_set(budget_json,'$.model_requests',?) WHERE id=?",
        )
        .run(config.limits.model_requests - 1, limited.id);
      await run(limited);
      assert.equal(calls.length, limitedCalls);
      assert.equal(operation(limited).state, "rejected");
      assert.equal(
        JSON.parse(store.jobById(limited.id).budget_json).model_requests,
        config.limits.model_requests,
      );
      const expired = seed();
      shortenedDeadline = true;
      lose = true;
      await run(expired, {
        alias: "ordinary",
        input: { text: "Original bounded deadline" },
      });
      shortenedDeadline = false;
      const expiredId = operation(expired).id,
        expiredCalls = calls.length;
      await delay(
        Math.max(
          0,
          supervisor.mcpWrites.receipt(expiredId).deadline - Date.now() + 20,
        ),
      );
      await assert.rejects(
        () => supervisor.mcpWrites.recover(expiredId, signal()),
        /mcp_timeout/,
      );
      assert.equal(calls.length, expiredCalls);
      assert.equal(supervisor.mcpWrites.receipt(expiredId).state, "uncertain");
      const cancelled = seed(),
        controller = new globalThis.AbortController();
      enteredReview = false;
      holdReview = new Promise(() => {});
      const pending = run(cancelled, { controller });
      await until(() => enteredReview);
      controller.abort();
      await pending;
      holdReview = undefined;
      assert.equal(operation(cancelled).state, "rejected");
      const cancelledWrite = seed(),
        writeCancellation = new globalThis.AbortController();
      enteredWrite = false;
      let releaseCancelled;
      holdWrite = new Promise((resolve) => {
        releaseCancelled = resolve;
      });
      const pendingWrite = run(cancelledWrite, {
        alias: "ordinary",
        input: { text: "Cancel after provider effect" },
        controller: writeCancellation,
      });
      await until(() => enteredWrite);
      writeCancellation.abort();
      releaseCancelled();
      holdWrite = undefined;
      await pendingWrite;
      assert.equal(operation(cancelledWrite).state, "uncertain");
      const shutdownJob = seed();
      enteredReview = false;
      let releaseShutdown;
      holdReview = new Promise((resolve) => {
        releaseShutdown = resolve;
      });
      const shutdownCalls = calls.length,
        shutdownRun = run(shutdownJob, { role: "audit" });
      await until(() => enteredReview);
      const closing = supervisor.close();
      releaseShutdown();
      holdReview = undefined;
      await shutdownRun;
      await closing;
      await gateway.close();
      assert.equal(calls.length, shutdownCalls);
      assert.equal(operation(shutdownJob).state, "rejected");
      supervisor = undefined;
      gateway = undefined;
      await boot();
      for (const uid of [10001, 10002, 10003])
        assert.deepEqual(await userProcesses(uid), []);
      const secretResult = seed();
      providerMode = "secret";
      await run(secretResult, {
        alias: "ordinary",
        input: { text: "Sensitive result" },
      });
      providerMode = "normal";
      assert.equal(operation(secretResult).state, "uncertain");
      assert(
        !JSON.stringify(
          supervisor.mcpWrites.receipt(operation(secretResult).id),
        ).includes(credential),
      );
      const secretError = seed();
      providerMode = "gateway_secret_error";
      await run(secretError, {
        alias: "ordinary",
        input: { text: "Sensitive protocol error" },
      });
      providerMode = "normal";
      assert.equal(operation(secretError).state, "uncertain");
      assert(
        !JSON.stringify(
          supervisor.mcpWrites.receipt(operation(secretError).id),
        ).includes(workerAuthorization),
      );
      const faulted = seed(),
        faultCalls = calls.length,
        removeWorkspace = supervisor.workspaces.remove.bind(
          supervisor.workspaces,
        );
      supervisor.workspaces.remove = async (id) => {
        if (store.run(id)?.role === "output_review")
          throw new Error("fixture cleanup failure");
        return removeWorkspace(id);
      };
      await assert.rejects(
        () => run(faulted, { role: "audit" }),
        /cleanup_failed/,
      );
      assert.equal(calls.length, faultCalls);
      assert.equal(operation(faulted).state, "rejected");
      await assert.rejects(() => supervisor.close(), /cleanup_failed/);
      await gateway.close();
      supervisor = undefined;
      gateway = undefined;
      store.close();
      store = new Store(database);
      fixture.store = store;
      await boot();
      assert.equal(store.leases().length, 0);
      await shutdown();
      assert.deepEqual(await readdir(options.root + "/runs"), []);
      assert.deepEqual(errors, []);
      proof.push({
        sdk,
        roles: [10001, 10002],
        reviewer: 10003,
        selective_review: "passed",
        keyed_recovery: "identical",
        unkeyed_recovery: "blocked",
        cancellation: "durable",
        cleanup: "passed",
      });
    }
    return { mcp_writes: "passed", scenarios: proof, cleanup: "passed" };
  } finally {
    await shutdown();
    if (store.db.open) store.close();
    await Promise.all([...servers].map((server) => server.close()));
    upstream.closeAllConnections();
    model.closeAllConnections();
    notifications.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => model.close(resolve));
    await new Promise((resolve) => notifications.close(resolve));
    await remote.close();
  }
}
