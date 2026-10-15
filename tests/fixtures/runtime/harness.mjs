import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  loadProtectedConfiguration,
  createRunSnapshot,
} from "/opt/orm/app/dist/config/load.js";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";
import {
  sourceProcesses,
  userProcesses,
} from "/opt/orm/app/dist/runtime/process.js";

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}
function iterate(iterable) {
  return iterable[Symbol.asyncIterator]();
}
async function remaining(iterator) {
  const events = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return events;
    events.push(next.value);
  }
}
function terminal(events) {
  const event = events.at(-1);
  assert.equal(event?.type, "terminal");
  return event;
}
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    assert(Date.now() < deadline, "runtime condition timed out");
    await delay(20);
  }
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function runRuntimeTests() {
  const base = "/data/orm-runtime-probe";
  await mkdir(base, { mode: 0o755 });
  const code = join(base, "code");
  await cp("/runtime-fixtures", code, { recursive: true });
  for (const name of await readdir(code)) {
    const path = join(code, name);
    assert((await lstat(path)).isFile());
    await chown(path, 0, 0);
    await chmod(path, 0o444);
  }
  await chmod(code, 0o555);
  const worker = join(code, "worker.mjs"),
    database = join(base, "state", "manager.sqlite"),
    driverFile = join(base, "state", "driver.json"),
    root = join(base, "runtime");
  const loaded = await loadProtectedConfiguration(),
    store = new Store(database),
    bundles = Object.fromEntries(
      Object.entries(loaded.snapshot.roles).map(([role, value]) => [
        role,
        value.bundle,
      ]),
    );
  const gitRoot = join(base, "git");
  await mkdir(join(gitRoot, "owner"), { recursive: true });
  const sourceGit = join(gitRoot, "owner", "repo.git");
  const git = (args, input) =>
    execFileSync("/usr/bin/git", args, {
      encoding: "utf8",
      input,
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        HOME: base,
      },
    }).trim();
  git(["init", "--bare", sourceGit]);
  const object = (type, content) =>
    git(
      ["--git-dir", sourceGit, "hash-object", "-t", type, "-w", "--stdin"],
      content,
    );
  const blob = object("blob", "base source\n"),
    tree = object(
      "tree",
      Buffer.concat([
        Buffer.from("100644 app.txt\0"),
        Buffer.from(blob, "hex"),
      ]),
    );
  const author = "Fixture <fixture@example.invalid> 1700000000 +0000";
  const first = object(
    "commit",
    `tree ${tree}\nauthor ${author}\ncommitter ${author}\n\nfirst\n`,
  );
  const sha = object(
    "commit",
    `tree ${tree}\nparent ${first}\nauthor ${author}\ncommitter ${author}\n\nsecond\n`,
  );
  git(["--git-dir", sourceGit, "update-ref", "refs/heads/main", sha]);
  await writeFile(join(sourceGit, "HEAD"), "ref: refs/heads/main\n");
  let authenticated = 0,
    publicReads = 0,
    requireAuth = true,
    holdSource = false,
    heldSource = false;
  const sourceServer = createServer((req, res) => {
    const expected = `Basic ${Buffer.from(`x-access-token:${loaded.secrets.get("github.token")}`).toString("base64")}`;
    if (requireAuth && req.headers.authorization !== expected) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (requireAuth) authenticated++;
    else publicReads++;
    if (holdSource) {
      heldSource = true;
      return;
    }
    const url = new URL(req.url, "http://fixture");
    const child = spawn("/usr/lib/git-core/git-http-backend", [], {
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_PROJECT_ROOT: gitRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "fixture",
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.slice(1),
        PATH_INFO: url.pathname,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let pending = Buffer.alloc(0),
      headers = false;
    child.stdout.on("data", (chunk) => {
      if (headers) {
        res.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const index = pending.indexOf("\r\n\r\n");
      if (index < 0) return;
      const lines = pending.subarray(0, index).toString().split("\r\n");
      for (const line of lines) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon),
          value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status")
          res.statusCode = Number(value.split(" ")[0]);
        else res.setHeader(name, value);
      }
      headers = true;
      res.write(pending.subarray(index + 4));
      pending = Buffer.alloc(0);
    });
    child.stderr.resume();
    child.on("error", () => res.destroy());
    child.on("close", (code) => {
      if (code !== 0) res.destroy();
      else res.end();
    });
    req.pipe(child.stdin);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") res.destroy(error);
    });
  });
  const sourceUrl = (await listen(sourceServer)) + "/owner/repo.git";
  const modelRequests = [];
  const modelServer = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    modelRequests.push({
      authorization: req.headers.authorization,
      path: req.url,
      body: JSON.parse(data),
    });
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"type":"fixture_start"}\n\n');
    res.end('data: {"type":"fixture_done"}\n\n');
  });
  const proxy = (await listen(modelServer)) + "/v1";
  const tokens = new Map(),
    issued = [];
  let descriptorFault = "",
    closeFault = false;
  let catalog = "catalog-one",
    closedSessions = 0;
  const mcpServer = createServer((req, res) => {
    const connection = tokens.get(req.headers.authorization);
    if (!connection) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ role: connection.role }));
  });
  const gateway = (await listen(mcpServer)) + "/mcp";
  const provider = {
    async open(request) {
      const authorization = randomBytes(32).toString("base64url"),
        key = `Bearer ${authorization}`;
      tokens.set(key, request);
      const connection = {
        alias: "fixture",
        url: gateway,
        authorization,
        tools: ["read"],
        deadline: request.deadline,
      };
      if (descriptorFault === "upstream")
        connection.url = "https://upstream-mcp.example.invalid/mcp";
      if (descriptorFault === "extra")
        connection.upstream_key = "not-a-worker-field";
      issued.push(connection);
      return {
        connections: [connection],
        policy_identity: "policy-one",
        catalog_identity: catalog,
        async close() {
          tokens.delete(key);
          closedSessions++;
          if (closeFault && request.role === "audit")
            throw new Error("fixture close failure");
        },
      };
    },
  };
  const hook = join(base, "root-hook-ran"),
    inspect = {
      mode: "inspect",
      database,
      supervisor: process.pid,
      artifact_root: join(root, "private", "manifests"),
      hook,
    };
  function snapshotFor(limits = {}, mcp = false) {
    const settings = globalThis.structuredClone(loaded.snapshot.settings);
    settings.proxy.url = proxy;
    Object.assign(settings.limits, limits);
    if (mcp) {
      settings.mcp.servers.fixture = {
        transport: "streamable_http",
        url: "https://upstream-mcp.example.invalid/mcp",
        allow_plain_http: false,
        tools: { read: { effect: "read" } },
      };
      settings.roles.investigation.mcp = { fixture: { tools: ["read"] } };
      settings.roles.audit.mcp = { fixture: { tools: ["read"] } };
    }
    return createRunSnapshot(settings, bundles, loaded.secrets);
  }
  const snapshot = snapshotFor(),
    options = {
      root,
      workers: { claude: worker, codex: worker },
      sourceUrl: () => sourceUrl,
      mcp: provider,
    };
  let supervisor = await Supervisor.create(
      store,
      snapshot,
      loaded.secrets,
      options,
    ),
    number = 0;
  function seed({
    limits = {},
    mcp = false,
    source = { sha, tree_sha: tree, default_branch: "main" },
  } = {}) {
    number++;
    const selected = snapshotFor(limits, mcp);
    store.saveSnapshot(selected);
    const context = {
      id: 1000 + number,
      number,
      state: "open",
      title: "runtime fixture",
      body: "input",
      updated_at: "2026-10-15T00:00:00Z",
      comments: [],
      source,
    };
    store.discover([number], 1, true);
    store.applyIssue(store.nextDirty(), context, selected);
    return { job: store.job(number), context, snapshot: selected };
  }
  const run = async (fixture, mode, role = "implementation", extra = {}) =>
    terminal(
      await collect(
        supervisor.run(
          { ...supervisor.request(fixture.job.id, role, mode), ...extra },
          new globalThis.AbortController().signal,
        ),
      ),
    );
  let tests = 0;
  try {
    const fixture = seed();
    const firstRun = await run(fixture, inspect);
    assert.equal(firstRun.outcome, "completed");
    assert.equal(firstRun.result.uid, 10001);
    assert(firstRun.artifact);
    assert.match(firstRun.result.status, /NoNewPrivs:\s+1/);
    assert.match(firstRun.result.status, /CapBnd:\s+0+/);
    for (const secret of [
      loaded.secrets.get("github.token"),
      loaded.secrets.get("proxy.key"),
    ])
      assert(
        !firstRun.result.arguments.join(" ").includes(secret),
        "worker arguments expose credentials",
      );
    const manifest = store.artifact(firstRun.artifact, fixture.job.id, 1),
      entry = manifest.files.find((file) => file.path === "app.txt");
    assert.equal(
      await readFile(join(root, "private", "blobs", entry.digest), "utf8"),
      "candidate bytes",
    );
    assert.equal(
      (await lstat(join(root, "private", "blobs", entry.digest))).uid,
      0,
    );
    await assert.rejects(lstat(firstRun.result.home));
    await assert.rejects(lstat(hook));
    const secondRun = await run(fixture, inspect, "implementation", {
      resume: { id: "session-one", binding: firstRun.result.binding },
    });
    assert.equal(secondRun.outcome, "completed");
    assert.equal(secondRun.result.resumed, "session-one");
    assert.notEqual(secondRun.result.home, firstRun.result.home);
    const invalidResume = await run(fixture, inspect, "implementation", {
      resume: { id: "session-one", binding: "changed" },
    });
    assert.equal(invalidResume.outcome, "failed");
    const reviewed = terminal(
      await collect(
        supervisor.run(
          supervisor.request(
            fixture.job.id,
            "output_review",
            { mode: "review", expectCandidate: true },
            firstRun.artifact,
          ),
          new globalThis.AbortController().signal,
        ),
      ),
    );
    assert.equal(reviewed.outcome, "completed");
    assert.equal(reviewed.result.uid, 10003);
    tests++;

    requireAuth = false;
    assert.equal((await run(seed(), inspect)).outcome, "completed");
    requireAuth = true;
    assert(authenticated > 0);
    assert(publicReads > 0);
    tests++;
    for (const role of ["implementation", "audit", "output_review"]) {
      const result = await run(seed(), { mode: "relay" }, role);
      assert.equal(result.outcome, "completed");
    }
    assert(
      modelRequests.every(
        (request) =>
          request.authorization === `Bearer ${loaded.secrets.get("proxy.key")}`,
      ),
    );
    tests++;

    for (const mode of ["escape", "forge"]) {
      const result = await run(seed(), { mode });
      assert.equal(result.outcome, "failed");
      assert.equal(result.artifact, undefined);
    }
    assert.equal(
      (
        await run(
          seed({
            source: { sha, tree_sha: "f".repeat(40), default_branch: "main" },
          }),
          { mode: "relay" },
        )
      ).outcome,
      "failed",
    );
    tests++;
    for (const [mode, limits] of [
      ["overflow", { worker_output_bytes: 1024 }],
      ["storage", { worker_storage_bytes: 512 * 1024 }],
      ["shared-temp", { worker_storage_bytes: 512 * 1024 }],
    ]) {
      const result = await run(seed({ limits }), { mode });
      assert.equal(
        result.outcome,
        "limited",
        `${mode} must exhaust its real limit`,
      );
      assert.equal(result.artifact, undefined);
      assert.equal((await userProcesses(10001)).length, 0);
    }
    assert.equal(
      (
        await run(seed({ limits: { worker_storage_bytes: 1 } }), {
          mode: "relay",
        })
      ).outcome,
      "limited",
    );
    assert(
      !(await readdir("/tmp")).some((name) => name.startsWith("orm-worker-")),
    );
    const forked = await run(seed({ limits: { worker_processes: 48 } }), {
      mode: "fork",
    });
    assert.equal(forked.outcome, "completed");
    assert(forked.result.failed);
    tests++;

    const active = seed(),
      abort = new globalThis.AbortController(),
      iterator = iterate(
        supervisor.run(
          supervisor.request(active.job.id, "implementation", { mode: "hang" }),
          abort.signal,
        ),
      );
    assert.equal((await iterator.next()).value.message, "ready");
    assert((await userProcesses(10001)).length >= 2);
    abort.abort();
    assert.equal(terminal(await remaining(iterator)).outcome, "cancelled");
    assert.equal((await userProcesses(10001)).length, 0);
    assert.equal(store.leases().length, 0);
    const detached = await run(seed(), { mode: "detach-complete" });
    assert.equal(detached.outcome, "completed");
    assert.equal((await userProcesses(10001)).length, 0);
    tests++;

    const stale = seed(),
      staleIterator = iterate(
        supervisor.run(
          supervisor.request(stale.job.id, "implementation", { mode: "hang" }),
          new globalThis.AbortController().signal,
        ),
      );
    await staleIterator.next();
    store.accept("new-runtime-generation", "digest", "issues", [
      { kind: "issue", number: stale.job.issue_number },
    ]);
    store.applyIssue(
      store.nextDirty(),
      { ...stale.context, body: "new revision" },
      stale.snapshot,
    );
    const staleResult = terminal(await remaining(staleIterator));
    assert.equal(staleResult.outcome, "stale");
    assert.equal(staleResult.artifact, undefined);
    tests++;

    const timed = seed({ limits: { active_minutes: 1 } });
    store.db
      .prepare(
        "UPDATE jobs SET budget_json=json_set(budget_json,'$.active_ms',59000) WHERE id=?",
      )
      .run(timed.job.id);
    assert.equal((await run(timed, { mode: "hang" })).outcome, "limited");
    assert.equal(
      JSON.parse(store.jobById(timed.job.id).budget_json).active_ms,
      60000,
    );
    tests++;

    const parent = seed(),
      parentAbort = new globalThis.AbortController(),
      parentIterator = iterate(
        supervisor.run(
          supervisor.request(parent.job.id, "implementation", {
            mode: "nested",
          }),
          parentAbort.signal,
        ),
      );
    await parentIterator.next();
    await delay(80);
    const parentRun = store.runs().find((run) => run.finished_at === null),
      heartbeat = join(root, "runs", parentRun.id, "workspace", "heartbeat");
    const nested = iterate(
      supervisor.runReview(
        parentRun.id,
        supervisor.request(parent.job.id, "output_review", {
          mode: "review",
          peer: heartbeat,
        }),
        new globalThis.AbortController().signal,
      ),
    );
    assert.equal((await nested.next()).value.message, "peer-denied");
    assert.equal((await nested.next()).value.message, "review-start");
    const paused = await readFile(heartbeat, "utf8");
    await delay(80);
    assert.equal(await readFile(heartbeat, "utf8"), paused);
    assert.equal(store.leases().length, 1);
    assert.equal(
      store.runs().filter((run) => run.finished_at === null).length,
      2,
    );
    assert(
      (await userProcesses(10001)).every((process) =>
        ["T", "t", "Z"].includes(process.state),
      ),
    );
    const blocked = seed();
    await assert.rejects(
      collect(
        supervisor.run(
          supervisor.request(blocked.job.id, "implementation", {
            mode: "relay",
          }),
          new globalThis.AbortController().signal,
        ),
      ),
      /lease_busy/,
    );
    assert.equal(terminal(await remaining(nested)).outcome, "completed");
    await until(async () => {
      try {
        return (
          (await readFile(
            join(root, "runs", parentRun.id, "workspace", "relay-resumed"),
            "utf8",
          )) === "200"
        );
      } catch {
        return false;
      }
    });
    parentAbort.abort();
    assert.equal(
      terminal(await remaining(parentIterator)).outcome,
      "cancelled",
    );
    tests++;

    const cancellingParent = seed(),
      cancellingAbort = new globalThis.AbortController(),
      cancellingIterator = iterate(
        supervisor.run(
          supervisor.request(cancellingParent.job.id, "implementation", {
            mode: "nested",
          }),
          cancellingAbort.signal,
        ),
      );
    await cancellingIterator.next();
    const cancellingRun = store.runs().find((run) => run.finished_at === null),
      cancellingReview = iterate(
        supervisor.runReview(
          cancellingRun.id,
          supervisor.request(cancellingParent.job.id, "output_review", {
            mode: "review",
            hang: true,
          }),
          new globalThis.AbortController().signal,
        ),
      );
    assert.equal((await cancellingReview.next()).value.message, "review-start");
    assert((await userProcesses(10003)).length > 0);
    cancellingAbort.abort();
    assert.equal(store.leases().length, 1);
    const parentRemainder = remaining(cancellingIterator);
    await until(async () => {
      if (!store.leases().length) return true;
      assert.equal(store.leases().length, 1);
      assert.equal(
        store.acquireLease(blocked.job.id, blocked.job.revision),
        undefined,
      );
      return false;
    });
    assert.equal((await userProcesses(10001)).length, 0);
    assert.equal((await userProcesses(10003)).length, 0);
    assert.equal(terminal(await parentRemainder).outcome, "cancelled");
    assert.equal(
      terminal(await remaining(cancellingReview)).outcome,
      "cancelled",
    );
    assert(!store.runs().some((run) => run.finished_at === null));
    tests++;

    const cleanupFailure = seed({ mcp: true }),
      failureParent = iterate(
        supervisor.run(
          supervisor.request(cleanupFailure.job.id, "implementation", {
            mode: "nested",
          }),
          new globalThis.AbortController().signal,
        ),
      );
    await failureParent.next();
    const failureRun = store.runs().find((run) => run.finished_at === null),
      failureAbort = new globalThis.AbortController(),
      failureReview = iterate(
        supervisor.runReview(
          failureRun.id,
          supervisor.request(cleanupFailure.job.id, "audit", {
            mode: "mcp-hang",
          }),
          failureAbort.signal,
        ),
      );
    let failureEvent;
    do {
      failureEvent = (await failureReview.next()).value;
    } while (failureEvent?.type !== "progress");
    closeFault = true;
    const rejectedParent = assert.rejects(
        remaining(failureParent),
        /cleanup_failed/,
      ),
      rejectedReview = assert.rejects(
        remaining(failureReview),
        /cleanup_failed/,
      );
    failureAbort.abort();
    await Promise.all([rejectedParent, rejectedReview]);
    assert.equal(store.leases().length, 1);
    assert.equal(
      store.acquireLease(blocked.job.id, blocked.job.revision),
      undefined,
    );
    assert.equal((await userProcesses(10001)).length, 0);
    await assert.rejects(supervisor.close(), /cleanup_failed/);
    closeFault = false;
    supervisor = await Supervisor.create(
      store,
      snapshot,
      loaded.secrets,
      options,
    );
    assert.equal(store.leases().length, 0);
    assert.equal((await userProcesses(10003)).length, 0);
    tests++;

    const unavailable = seed({ mcp: true }),
      withoutProvider = await Supervisor.create(
        store,
        snapshot,
        loaded.secrets,
        { ...options, mcp: undefined },
      );
    await assert.rejects(
      collect(
        withoutProvider.run(
          withoutProvider.request(unavailable.job.id, "investigation", {
            mode: "mcp",
          }),
          new globalThis.AbortController().signal,
        ),
      ),
      /mcp_unavailable/,
    );
    await withoutProvider.close();
    for (const fault of ["upstream", "extra"]) {
      descriptorFault = fault;
      assert.equal(
        (await run(seed({ mcp: true }), { mode: "mcp" }, "investigation"))
          .outcome,
        "failed",
      );
    }
    descriptorFault = "";
    const mcpFixture = seed({ mcp: true }),
      mcpResult = await run(mcpFixture, { mode: "mcp" }, "investigation");
    assert.equal(mcpResult.outcome, "completed");
    const old = issued.at(-1);
    assert.equal(
      (
        await fetch(old.url, {
          headers: { authorization: `Bearer ${old.authorization}` },
        })
      ).status,
      401,
    );
    catalog = "catalog-two";
    assert.equal(
      (
        await run(mcpFixture, { mode: "mcp" }, "investigation", {
          resume: { id: "mcp-session", binding: mcpResult.result.binding },
        })
      ).outcome,
      "failed",
    );
    for (const mode of ["cancel", "stale"]) {
      const bound = seed({ mcp: true }),
        cancel = new globalThis.AbortController(),
        stream = iterate(
          supervisor.run(
            supervisor.request(bound.job.id, "investigation", {
              mode: "mcp-hang",
            }),
            cancel.signal,
          ),
        );
      let event;
      do {
        event = (await stream.next()).value;
      } while (event.type !== "progress");
      const connection = issued.at(-1);
      if (mode === "cancel") cancel.abort();
      else {
        store.discover([bound.job.issue_number], 1, true);
        store.applyIssue(
          store.nextDirty(),
          { ...bound.context, body: "changed" },
          bound.snapshot,
        );
      }
      assert.equal(
        terminal(await remaining(stream)).outcome,
        mode === "cancel" ? "cancelled" : "stale",
      );
      assert.equal(
        (
          await fetch(connection.url, {
            headers: { authorization: `Bearer ${connection.authorization}` },
          })
        ).status,
        401,
      );
    }
    assert(closedSessions >= 4);
    tests++;

    const shutdown = seed(),
      shutdownIterator = iterate(
        supervisor.run(
          supervisor.request(shutdown.job.id, "implementation", {
            mode: "hang",
          }),
          new globalThis.AbortController().signal,
        ),
      );
    await shutdownIterator.next();
    await supervisor.close();
    const fetchCrash = seed();
    await writeFile(
      driverFile,
      JSON.stringify({
        database,
        job: fetchCrash.job.id,
        root,
        worker,
        source: sourceUrl,
      }),
      { mode: 0o600 },
    );
    holdSource = true;
    const fetchDriver = spawn(
        process.execPath,
        [join(code, "crash.mjs"), driverFile],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
      fetchExited = once(fetchDriver, "exit");
    fetchDriver.stdout.resume();
    fetchDriver.stderr.resume();
    try {
      await until(() => heldSource);
      const fetchRun = store.runs().find((run) => run.finished_at === null),
        staging = join(root, "private", "sources", fetchRun.id),
        sourcePids = await sourceProcesses(fetchRun.id, staging);
      assert(sourcePids.length > 0);
      for (const pid of sourcePids) {
        const args = await readFile(`/proc/${pid}/cmdline`, "utf8");
        for (const credential of [
          loaded.secrets.get("github.token"),
          Buffer.from(
            `x-access-token:${loaded.secrets.get("github.token")}`,
          ).toString("base64"),
        ])
          assert(
            !args.includes(credential),
            "source-fetch arguments expose credentials",
          );
      }
      fetchDriver.kill("SIGKILL");
      await fetchExited;
      assert((await sourceProcesses(fetchRun.id, staging)).length > 0);
      assert(store.leases().length === 1);
      supervisor = await Supervisor.create(
        store,
        snapshot,
        loaded.secrets,
        options,
      );
      assert.equal((await sourceProcesses(fetchRun.id, staging)).length, 0);
      await assert.rejects(lstat(staging));
      assert.equal(store.leases().length, 0);
      assert.equal(
        store.runs().find((run) => run.id === fetchRun.id).status,
        "interrupted",
      );
      tests++;
    } finally {
      holdSource = false;
      if (fetchDriver.exitCode === null && fetchDriver.signalCode === null) {
        fetchDriver.kill("SIGKILL");
        await fetchExited;
      }
    }
    await supervisor.close();
    assert.equal(
      terminal(await remaining(shutdownIterator)).outcome,
      "cancelled",
    );
    assert.equal((await userProcesses(10001)).length, 0);
    tests++;

    const crash = seed();
    await writeFile(
      driverFile,
      JSON.stringify({
        database,
        job: crash.job.id,
        root,
        worker,
        source: sourceUrl,
      }),
      { mode: 0o600 },
    );
    const driver = spawn(
      process.execPath,
      [join(code, "crash.mjs"), driverFile],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let driverOutput = "";
    driver.stdout.on("data", (chunk) => {
      driverOutput += chunk;
    });
    driver.stderr.resume();
    const exited = once(driver, "exit");
    try {
      await until(() => {
        assert.equal(
          driver.exitCode,
          null,
          "crash fixture exited before worker launch",
        );
        return driverOutput.includes("ready");
      });
      assert(store.leases().length === 1);
      assert((await userProcesses(10001)).length >= 2);
      driver.kill("SIGKILL");
      await exited;
      assert((await userProcesses(10001)).length >= 2);
      supervisor = await Supervisor.create(
        store,
        snapshot,
        loaded.secrets,
        options,
      );
      assert.equal(store.leases().length, 0);
      assert.equal((await userProcesses(10001)).length, 0);
      assert(
        store
          .runs()
          .some(
            (run) =>
              run.job_id === crash.job.id && run.status === "interrupted",
          ),
      );
      assert(JSON.parse(store.jobById(crash.job.id).budget_json).active_ms > 0);
      assert.equal((await run(seed(), { mode: "relay" })).outcome, "completed");
      tests++;
    } finally {
      if (driver.exitCode === null && driver.signalCode === null) {
        driver.kill("SIGKILL");
        await exited;
      }
    }
    await supervisor.close();
    assert.equal(
      store.runs().filter((run) => run.finished_at === null).length,
      0,
    );
    assert.equal(store.leases().length, 0);
    for (const uid of [10001, 10002, 10003])
      assert.equal((await userProcesses(uid)).length, 0);
    assert.deepEqual(await readdir(join(root, "runs")), []);
    console.log(
      JSON.stringify({
        runtime: "passed",
        scenario_groups: tests,
        credentials: "isolated",
        history: "full",
        nested_review: "one_lease",
        crash_recovery: "passed",
        cleanup: "passed",
      }),
    );
  } finally {
    await supervisor.close();
    store.close();
    await close(sourceServer);
    await close(modelServer);
    await close(mcpServer);
  }
}
