import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { tracingChannel } from "node:diagnostics_channel";
import { lstatSync } from "node:fs";
import { createServer } from "node:http";
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  loadProtectedConfiguration,
  createRunSnapshot,
} from "/opt/orm/app/dist/config/load.js";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";
import { Octokit } from "/opt/orm/app/node_modules/@octokit/rest/dist-src/index.js";
import { OctokitReader } from "/opt/orm/app/dist/adapters/github/reader.js";
import { IntakeService } from "/opt/orm/app/dist/services/intake.js";
import { InvestigationService } from "/opt/orm/app/dist/services/investigation/index.js";
import { ImplementationService } from "/opt/orm/app/dist/services/implementation/index.js";
import { PrMonitorService } from "/opt/orm/app/dist/services/pr-monitor/index.js";
import { createApp } from "/opt/orm/app/dist/http/app.js";
import {
  cleanEnvironment,
  cleanSource,
  cleanUser,
  deletedFileBytes,
  sourceProcesses,
  spawnAsRole,
  userProcesses,
} from "/opt/orm/app/dist/runtime/process.js";
import { treeBytes } from "/opt/orm/app/dist/services/workspaces/files.js";
import { verifyMcp } from "./mcp.mjs";
import { verifyClaude } from "/agent-fixtures/claude.mjs";
import { verifyCodex } from "/agent-fixtures/codex.mjs";

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
    heldSource = false,
    captureObjects = false,
    sourceObjectInode;
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
    if (captureObjects) {
      const run = store.runs().find((run) => run.finished_at === null);
      sourceObjectInode = String(
        lstatSync(
          join(root, "private", "sources", run.id, "source.git", "objects"),
          { bigint: true },
        ).ino,
      );
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
  function sourceWith(files) {
    const entries = {};
    for (const [path, bytes] of Object.entries(files)) {
      const parts = path.split("/");
      let directory = entries;
      for (const part of parts.slice(0, -1)) directory = directory[part] ??= {};
      directory[parts.at(-1)] = bytes;
    }
    const makeTree = (entries) =>
      object(
        "tree",
        Buffer.concat(
          Object.entries(entries)
            .sort(([a, av], [b, bv]) =>
              Buffer.compare(
                Buffer.from(a + (typeof av === "string" ? "" : "/")),
                Buffer.from(b + (typeof bv === "string" ? "" : "/")),
              ),
            )
            .flatMap(([name, value]) => [
              Buffer.from(
                `${typeof value === "string" ? "100644" : "40000"} ${name}\0`,
              ),
              Buffer.from(
                typeof value === "string"
                  ? object("blob", value)
                  : makeTree(value),
                "hex",
              ),
            ]),
        ),
      );
    const tree = makeTree(entries),
      next = object(
        "commit",
        `tree ${tree}\nparent ${sha}\nauthor ${author}\ncommitter ${author}\n\nClaude fixture\n`,
      );
    git([
      "--git-dir",
      sourceGit,
      "update-ref",
      "refs/heads/claude-fixture",
      next,
    ]);
    return { sha: next, tree_sha: tree, default_branch: "main" };
  }
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
  let tests = 0,
    mcpProof,
    claudeProof,
    codexProof;
  const errors = [],
    probeOutcomes = [],
    probes = tracingChannel("child_process.spawn").start;
  const observeProbe = ({ process: child }) => {
    if (!child.spawnargs?.[1]?.endsWith("/runtime/storage.js")) return;
    const started = performance.now();
    let stderr = "";
    child.once("spawn", () =>
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4096);
      }),
    );
    child.once("close", (code, signal) => {
      probeOutcomes.push({
        elapsed_ms: performance.now() - started,
        code,
        signal,
        error: stderr.match(/EACCES|EPERM|ENOENT|ESRCH|monitor_failed/)?.[0],
      });
      if (probeOutcomes.length > 8) probeOutcomes.shift();
    });
  };
  probes.subscribe(observeProbe);
  try {
    const storageControl = join(base, "storage-control");
    await writeFile(
      `${storageControl}.c`,
      '#include <sys/prctl.h>\n#include <fcntl.h>\n#include <unistd.h>\n#include <stdio.h>\n#include <stdlib.h>\nint main(int c,char **v){int f=open(v[1],O_CREAT|O_RDWR,0600);if(f<0||ftruncate(f,307200)||unlink(v[1])||dup(f)<0||prctl(PR_SET_DUMPABLE,0))return 1;puts("ready");fflush(stdout);char b;if(read(0,&b,1)!=1)return 2;int ms=atoi(v[2]);if(ms>=0){usleep(ms*1000);if(prctl(PR_SET_DUMPABLE,1))return 3;}for(;;)pause();}',
    );
    execFileSync("/usr/bin/cc", [`${storageControl}.c`, "-o", storageControl]);
    await chmod(storageControl, 0o555);
    const teardownControl = `${storageControl}-teardown`;
    await writeFile(
      `${teardownControl}.c`,
      `#include <sys/prctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
int descriptor;
void *retain(void *argument) {
  char byte;
  if (read(0, &byte, 1) != 1) _exit(2);
  int wait = atoi(argument);
  if (wait >= 0) {
    usleep(wait * 1000);
    _exit(0);
  }
  for (;;) {
    if (pwrite(descriptor, "x", 1, 0) != 1) _exit(3);
    usleep(10000);
  }
}
int main(int count, char **values) {
  if (count != 3) return 1;
  descriptor = open(values[1], O_CREAT | O_RDWR, 0600);
  if (descriptor < 0 || ftruncate(descriptor, 307200) ||
      unlink(values[1]) || prctl(PR_SET_DUMPABLE, 0)) return 1;
  pthread_t thread;
  if (pthread_create(&thread, NULL, retain, values[2])) return 1;
  puts("ready");
  fflush(stdout);
  pthread_exit(NULL);
}
`,
    );
    execFileSync("/usr/bin/cc", [
      `${teardownControl}.c`,
      "-pthread",
      "-o",
      teardownControl,
    ]);
    await chmod(teardownControl, 0o555);
    for (const [teardown, waits] of [
      [false, [125]],
      [false, [-1]],
      [false, [100, 400]],
      [true, [600]],
      [true, [-1]],
      [true, [700, 1600]],
    ]) {
      const controls = [];
      try {
        for (const wait of waits) {
          const child = spawnAsRole(
              "implementation",
              teardown ? teardownControl : storageControl,
              [
                join("/tmp", `orm-storage-${randomBytes(8).toString("hex")}`),
                String(wait),
              ],
              {
                cwd: "/",
                env: cleanEnvironment("/home/coding", "/tmp", "coding"),
                processes: 128,
              },
            ),
            closed = once(child, "close");
          controls.push({ child, closed });
          child.stderr.resume();
          await Promise.race([
            once(child.stdout, "data", { signal: AbortSignal.timeout(2000) }),
            closed.then(() => {
              throw new Error("storage control exited before readiness");
            }),
          ]);
          child.stdout.resume();
          if (teardown)
            await until(async () => {
              const status = await readFile(
                `/proc/${child.pid}/status`,
                "utf8",
              );
              return (
                /^State:\s+Z\b/m.test(status) && /^Threads:\s+2$/m.test(status)
              );
            });
        }
        const started = Date.now(),
          monotonicStarted = performance.now(),
          probe = deletedFileBytes(10001, 1024 ** 2);
        for (const { child } of controls) child.stdin.end("go");
        if (teardown && waits.length === 1 && waits[0] >= 0) {
          assert.equal(await probe, 0);
          assert(Date.now() - started >= 600);
        } else if (teardown) {
          await assert.rejects(probe, { code: "monitor_failed" });
          const elapsed = performance.now() - monotonicStarted;
          assert(
            elapsed >= 1000,
            `teardown rejection after ${elapsed} ms for waits ${waits.join(",")}`,
          );
          const status = await readFile(
            `/proc/${controls.at(-1).child.pid}/status`,
            "utf8",
          );
          assert.match(status, /^State:\s+Z\b/m);
          assert.match(status, /^Threads:\s+2$/m);
        } else if (waits.length === 1 && waits[0] >= 0) {
          assert.equal(await probe, 300 * 1024);
          await assert.rejects(deletedFileBytes(10001, 300 * 1024 - 1), {
            code: "storage_limit",
          });
        } else {
          await assert.rejects(probe, { code: "monitor_failed" });
          assert(Date.now() - started >= 250);
        }
      } finally {
        await cleanUser(10001);
        await Promise.all(controls.map(({ closed }) => closed));
      }
      assert.deepEqual(await userProcesses(10001), []);
      tests++;
    }
    const churnDeadline = Date.now() + 3000,
      churn = Array.from({ length: 4 }, async () => {
        do {
          const child = spawnAsRole(
              "implementation",
              "/opt/orm-runtime/bin/node",
              [
                "-e",
                'const memory=Array.from({length:128},()=>Buffer.alloc(1024*1024,1));console.log("ready");setInterval(()=>{},1000)',
              ],
              {
                cwd: "/",
                env: cleanEnvironment("/home/coding", "/tmp", "coding"),
                processes: 128,
              },
            ),
            closed = once(child, "close");
          child.stderr.resume();
          try {
            await Promise.race([
              once(child.stdout, "data", { signal: AbortSignal.timeout(2000) }),
              closed.then(() => {
                throw new Error("Node teardown worker exited before readiness");
              }),
            ]);
          } finally {
            child.kill("SIGKILL");
            await closed;
          }
        } while (Date.now() < churnDeadline);
      });
    const churnObserved = Promise.allSettled(churn);
    try {
      do {
        assert.equal(await deletedFileBytes(10001, 1024 ** 2), 0);
      } while (Date.now() < churnDeadline);
    } finally {
      await churnObserved;
      await cleanUser(10001);
    }
    for (const result of await churnObserved)
      if (result.status === "rejected") throw result.reason;
    assert.deepEqual(await userProcesses(10001), []);
    tests++;
    const bootstrap = spawn(
      process.execPath,
      [
        "-e",
        'process.title="runc:[2:INIT]";console.log("ready");setInterval(()=>{},1000)',
      ],
      {
        gid: 1,
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    bootstrap.stderr.resume();
    const bootstrapExited = once(bootstrap, "exit");
    try {
      await Promise.race([
        once(bootstrap.stdout, "data", { signal: AbortSignal.timeout(2000) }),
        bootstrapExited.then(() => {
          throw new Error("bootstrap fixture exited before its probe");
        }),
      ]);
      assert.match(
        await readFile(`/proc/${bootstrap.pid}/status`, "utf8"),
        /^Name:\s+runc:/m,
      );
      await assert.rejects(readlink(`/proc/${bootstrap.pid}/cwd`), {
        code: "EACCES",
      });
      assert.deepEqual(
        await sourceProcesses(
          "bootstrap-probe",
          join(root, "private", "sources", "bootstrap-probe"),
        ),
        [],
      );
    } finally {
      if (bootstrap.exitCode === null && bootstrap.signalCode === null)
        bootstrap.kill("SIGKILL");
      await bootstrapExited;
    }
    const probe = spawn(
      process.execPath,
      [
        "-e",
        'process.setgroups([]);process.setegid(10001);process.seteuid(10001);console.log("ready");setInterval(()=>{},1000)',
      ],
      { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    const probeExited = once(probe, "exit");
    probe.stderr.resume();
    try {
      await Promise.race([
        once(probe.stdout, "data", { signal: AbortSignal.timeout(2000) }),
        probeExited.then(() => {
          throw new Error("trusted probe exited");
        }),
      ]);
      assert.match(
        await readFile(`/proc/${probe.pid}/status`, "utf8"),
        /^Uid:\s+0\s+10001\s+0\s+10001$/m,
      );
      assert.deepEqual(await userProcesses(10001), []);
    } finally {
      if (probe.exitCode === null && probe.signalCode === null)
        probe.kill("SIGKILL");
      await probeExited;
    }
    tests++;
    const cleanupId = "source-cleanup-deadline",
      cleanupStage = join(root, "private", "sources", cleanupId),
      now = performance.now;
    for (const quietScans of [1, 2, 3]) {
      let ticks = 0;
      performance.now = () => (ticks++ < quietScans ? 0 : 3000);
      try {
        const cleanup = cleanSource(cleanupId, cleanupStage);
        if (quietScans < 3)
          await assert.rejects(cleanup, { code: "cleanup_failed" });
        else await cleanup;
      } finally {
        performance.now = now;
      }
    }
    const wallClock = Date.now;
    let wallClockReads = 0;
    Date.now = () => wallClock() + (wallClockReads++ === 0 ? 0 : 5165);
    try {
      await cleanSource(cleanupId, cleanupStage);
    } finally {
      Date.now = wallClock;
    }
    tests++;
    const sourceProbe = spawn(
        process.execPath,
        ["-e", 'console.log("ready");setInterval(()=>{},1000)'],
        {
          env: { PATH: "/usr/bin:/bin", ORM_SOURCE_RUN: cleanupId },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
      sourceExited = once(sourceProbe, "exit");
    sourceProbe.stderr.resume();
    try {
      await Promise.race([
        once(sourceProbe.stdout, "data", {
          signal: AbortSignal.timeout(2000),
        }),
        sourceExited.then(() => {
          throw new Error("source cleanup probe exited before discovery");
        }),
      ]);
      assert.deepEqual(await sourceProcesses(cleanupId, cleanupStage), [
        sourceProbe.pid,
      ]);
      let ticks = 0;
      performance.now = () => (ticks++ === 0 ? 0 : 3000);
      try {
        await assert.rejects(cleanSource(cleanupId, cleanupStage), {
          code: "cleanup_failed",
        });
      } finally {
        performance.now = now;
      }
      const [, signal] = await sourceExited;
      assert.equal(signal, "SIGKILL");
      assert.deepEqual(await sourceProcesses(cleanupId, cleanupStage), []);
    } finally {
      if (sourceProbe.exitCode === null && sourceProbe.signalCode === null)
        sourceProbe.kill("SIGKILL");
      await sourceExited;
    }
    tests++;
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
    for (const target of ["workspace", "transcript", "aggregate"]) {
      const checkpoint = seed({ limits: { worker_storage_bytes: 512 * 1024 } }),
        input = { mode: "checkpoint-storage", target },
        saved = await run(checkpoint, input);
      assert.equal(saved.outcome, "completed");
      const previous = store.sessionRun(
        checkpoint.job.id,
        1,
        "implementation",
        "checkpoint-session",
      );
      const overflow = await run(checkpoint, input, "implementation", {
        resume: { id: "checkpoint-session", binding: saved.result.binding },
      });
      assert.equal(overflow.outcome, "limited");
      assert.equal(overflow.artifact, undefined);
      const failed = store
        .runs()
        .findLast((run) => run.job_id === checkpoint.job.id);
      assert.equal(failed.session_id, null);
      assert.equal(
        store.sessionRun(
          checkpoint.job.id,
          1,
          "implementation",
          "checkpoint-session",
        ).id,
        previous.id,
      );
      await assert.rejects(
        lstat(join(root, "private", "sessions", failed.id, "checkpoint.json")),
      );
      assert.equal((await userProcesses(10001)).length, 0);
      tests++;
    }
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

    const historyBlob = object("blob", randomBytes(320 * 1024)),
      historyTree = object(
        "tree",
        Buffer.concat([
          Buffer.from("100644 history.bin\0"),
          Buffer.from(historyBlob, "hex"),
        ]),
      ),
      historyCommit = object(
        "commit",
        `tree ${historyTree}\nparent ${sha}\nauthor ${author}\ncommitter ${author}\n\nlarge history\n`,
      ),
      compactCommit = object(
        "commit",
        `tree ${tree}\nparent ${historyCommit}\nauthor ${author}\ncommitter ${author}\n\nsmall checkout\n`,
      );
    git([
      "--git-dir",
      sourceGit,
      "update-ref",
      "refs/heads/storage",
      compactCommit,
    ]);
    captureObjects = true;
    try {
      const result = await run(
        seed({
          limits: { worker_storage_bytes: 512 * 1024 },
          source: {
            sha: compactCommit,
            tree_sha: tree,
            default_branch: "main",
          },
        }),
        { mode: "object-storage" },
      );
      assert.equal(result.outcome, "completed");
      assert.equal(result.result.history, 4);
      assert.equal(result.result.inode, sourceObjectInode);
    } finally {
      captureObjects = false;
    }
    tests++;

    requireAuth = false;
    assert.equal((await run(seed(), inspect)).outcome, "completed");
    requireAuth = true;
    assert(authenticated > 0);
    assert(publicReads > 0);
    tests++;

    const preparing = seed({ limits: { worker_storage_bytes: 512 * 1024 } });
    heldSource = false;
    holdSource = true;
    const preparation = collect(
      supervisor.run(
        supervisor.request(preparing.job.id, "implementation", {
          mode: "relay",
        }),
        AbortSignal.timeout(5000),
      ),
    ).then(terminal);
    try {
      await until(() => heldSource);
      const preparingRun = store.runs().find((run) => run.finished_at === null),
        workspace = join(root, "runs", preparingRun.id, "workspace"),
        stage = join(root, "private", "sources", preparingRun.id);
      await mkdir(workspace);
      await writeFile(
        join(workspace, "expanded-checkout"),
        Buffer.alloc(300 * 1024),
      );
      await writeFile(join(stage, "staging-growth"), Buffer.alloc(300 * 1024));
      assert((await treeBytes(stage, 512 * 1024)) < 512 * 1024);
      assert((await treeBytes(workspace, 512 * 1024)) < 512 * 1024);
      assert.equal((await preparation).outcome, "limited");
      assert.equal(store.leases().length, 0);
      assert(!store.runs().some((run) => run.finished_at === null));
    } finally {
      holdSource = false;
    }
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

    for (const outcome of ["limited", "stale"]) {
      const reported = seed(),
        result = await run(reported, { mode: "terminal-outcome", outcome }),
        receipt = store.runs().find((run) => run.job_id === reported.job.id);
      assert.equal(result.outcome, outcome);
      assert.equal(result.artifact, undefined);
      assert.equal(receipt.status, outcome);
      assert.notEqual(receipt.finished_at, null);
      assert.equal(receipt.artifact_digest, null);
      assert.equal(
        store.job(reported.job.issue_number).status,
        reported.job.status,
      );
      assert.equal(store.leases().length, 0);
      assert.deepEqual(await userProcesses(10001), []);
    }
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
      ["unlinked-storage", { worker_storage_bytes: 512 * 1024 }],
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
        await run(seed({ limits: { worker_storage_bytes: 512 * 1024 } }), {
          mode: "unlinked-small",
        })
      ).outcome,
      "completed",
    );
    tests++;
    for (const mode of ["mapped-deleted", "nondumpable", "zombie-leader"]) {
      const mapped = await collect(
        supervisor.run(
          supervisor.request(
            seed({ limits: { worker_storage_bytes: 512 * 1024 } }).job.id,
            "implementation",
            { mode },
          ),
          new globalThis.AbortController().signal,
        ),
      );
      assert(
        mapped.some(
          (event) =>
            event.type === "progress" && event.message === "mapped-ready",
        ),
      );
      assert.equal(terminal(mapped).outcome, "failed");
      assert.equal((await userProcesses(10001)).length, 0);
      assert.equal(store.leases().length, 0);
      tests++;
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
        "UPDATE jobs SET budget_json=json_set(budget_json,'$.active_ms',55000) WHERE id=?",
      )
      .run(timed.job.id);
    const timedIterator = iterate(
      supervisor.run(
        supervisor.request(timed.job.id, "implementation", { mode: "hang" }),
        new globalThis.AbortController().signal,
      ),
    );
    assert.equal((await timedIterator.next()).value.message, "ready");
    assert.equal(terminal(await remaining(timedIterator)).outcome, "limited");
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

    const cleanupFailure = seed({ mcp: true });
    const healthPhases = store
      .jobs()
      .map((job) => ({ id: job.id, phase: job.phase }));
    store.db.prepare("UPDATE jobs SET phase='remote_review'").run();
    let healthSource = { sha, tree_sha: tree };
    const healthServer = createServer((req, res) => {
      const path = new URL(req.url, "http://fixture").pathname;
      const prefix = `/repos/${snapshot.settings.github.repository}`;
      const number = Number(path.slice(`${prefix}/issues/`.length));
      const value =
        path === prefix
          ? {
              id: 42,
              full_name: snapshot.settings.github.repository,
              default_branch: "main",
              private: false,
            }
          : path === `${prefix}/commits/main`
            ? {
                sha: healthSource.sha,
                commit: { tree: { sha: healthSource.tree_sha } },
              }
            : path === `${prefix}/issues` || path.endsWith("/comments")
              ? []
              : store.job(number)
                ? {
                    ...JSON.parse(store.job(number).input_json),
                    updated_at: "2026-10-15T00:00:00Z",
                  }
                : null;
      if (value?.source) healthSource = value.source;
      res.setHeader("content-type", "application/json");
      res.statusCode = value === null ? 404 : 200;
      res.end(JSON.stringify(value));
    });
    const healthUrl = await listen(healthServer),
      healthReader = new OctokitReader(
        snapshot.settings.github.repository,
        new Octokit({ baseUrl: healthUrl }),
      ),
      healthLog = { info() {}, error() {} },
      healthIntake = new IntakeService(
        store,
        healthReader,
        snapshot,
        loaded.secrets,
        healthLog,
      ),
      healthImplementation = new ImplementationService(
        store,
        healthIntake,
        supervisor,
        loaded.secrets,
        healthLog,
      ),
      healthMonitor = new PrMonitorService(
        store,
        healthIntake,
        healthReader,
        healthImplementation,
        supervisor,
        snapshot,
        loaded.secrets,
        healthLog,
      ),
      healthCoordinator = new InvestigationService(
        store,
        healthIntake,
        supervisor,
        loaded.secrets,
        healthLog,
        undefined,
        healthImplementation,
      ),
      healthApp = createApp(
        healthIntake,
        undefined,
        supervisor.notifications,
        supervisor.mcpWrites,
        healthCoordinator,
      );
    await healthIntake.reconcile();
    supervisor.notifications.start();
    healthCoordinator.start();
    healthMonitor.start();
    await healthCoordinator.reconcile();
    await healthMonitor.reconcile();
    try {
      const healthy = await healthApp.inject("/readyz");
      assert.equal(healthy.statusCode, 200, healthy.body);
      const failureParent = iterate(
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
      assert.deepEqual(supervisor.status(), {
        state: "unavailable",
        reason: "cleanup_failed",
      });
      const unhealthy = await healthApp.inject("/readyz");
      assert.equal(unhealthy.statusCode, 503);
      assert.equal(
        unhealthy.json().implementation.runtime.reason,
        "cleanup_failed",
      );
    } finally {
      await healthMonitor.stop();
      await healthCoordinator.stop();
      await healthIntake.stop();
      await healthApp.close();
      await close(healthServer);
      for (const job of healthPhases)
        store.db
          .prepare("UPDATE jobs SET phase=? WHERE id=?")
          .run(job.phase, job.id);
    }
    await assert.rejects(supervisor.close(), /cleanup_failed/);
    closeFault = false;
    supervisor = await Supervisor.create(
      store,
      snapshot,
      loaded.secrets,
      options,
    );
    assert.equal(store.leases().length, 0);
    assert.deepEqual(supervisor.status(), { state: "ready", reason: null });
    assert.equal((await userProcesses(10002)).length, 0);
    assert(!store.runs().some((run) => run.finished_at === null));
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

    for (const credential of ["relay", "mcp"]) {
      for (const event of ["progress", "terminal"]) {
        const fixture = seed({ mcp: true }),
          events = await collect(
            supervisor.run(
              supervisor.request(fixture.job.id, "investigation", {
                mode: "emit-credential",
                credential,
                event,
              }),
              new globalThis.AbortController().signal,
            ),
          );
        assert.deepEqual(events, [{ type: "terminal", outcome: "failed" }]);
        assert.equal(store.leases().length, 0);
        assert.equal((await userProcesses(10001)).length, 0);
        const connection = issued.at(-1);
        assert.equal(
          (
            await fetch(connection.url, {
              headers: { authorization: `Bearer ${connection.authorization}` },
            })
          ).status,
          401,
        );
      }
    }
    tests++;
    for (const credential of ["relay", "mcp"]) {
      const fixture = seed({ mcp: true }),
        stream = iterate(
          supervisor.run(
            supervisor.request(fixture.job.id, "investigation", {
              mode: "emit-credential",
              credential,
              event: "progress",
              split: true,
            }),
            new globalThis.AbortController().signal,
          ),
        );
      try {
        const first = (await stream.next()).value;
        assert.equal(first.type, "progress");
        assert(first.message.length > 0);
        const connection = issued.at(-1);
        assert.equal(
          (
            await fetch(connection.url, {
              headers: { authorization: `Bearer ${connection.authorization}` },
              signal: AbortSignal.timeout(2000),
            })
          ).status,
          200,
        );
        const run = store
          .runs()
          .find(
            (run) => run.job_id === fixture.job.id && run.finished_at === null,
          );
        assert(run);
        await writeFile(
          join(root, "runs", run.id, "tmp", "continue"),
          "continue",
        );
        assert.deepEqual(await remaining(stream), [
          { type: "terminal", outcome: "failed" },
        ]);
        assert.equal(
          (
            await fetch(connection.url, {
              headers: { authorization: `Bearer ${connection.authorization}` },
            })
          ).status,
          401,
        );
        assert.equal(store.leases().length, 0);
        assert.equal((await userProcesses(10001)).length, 0);
      } finally {
        await stream.return?.();
      }
    }
    assert.equal(
      (await run(seed({ mcp: true }), { mode: "mcp" }, "investigation"))
        .outcome,
      "completed",
    );
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
    heldSource = false;
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
    mcpProof = await verifyMcp({
      store,
      worker,
      root,
      sourceUrl,
      source: { sha, tree_sha: tree, default_branch: "main" },
      proxy,
      bundles,
    });
    codexProof = await verifyCodex({
      store,
      root,
      sourceUrl,
      source: { sha, tree_sha: tree, default_branch: "main" },
      sourceWith,
      bundles,
    });
    claudeProof = await verifyClaude({
      store,
      root,
      sourceUrl,
      source: { sha, tree_sha: tree, default_branch: "main" },
      sourceWith,
      bundles,
    });
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
  } catch (error) {
    errors.push(error);
    if (error?.code === "cleanup_failed") {
      try {
        const pending = [];
        for (const run of store
          .runs()
          .filter((run) => run.finished_at === null)) {
          const pids = await sourceProcesses(
            run.id,
            join(root, "private", "sources", run.id),
          );
          const processes = [];
          for (const pid of pids) {
            try {
              const status = await readFile(`/proc/${pid}/status`, "utf8");
              processes.push({
                pid,
                state: status.match(/^State:\s+(\S)/m)?.[1],
              });
            } catch (diagnostic) {
              if (!["ENOENT", "ESRCH"].includes(diagnostic.code))
                throw diagnostic;
            }
          }
          pending.push({
            id: run.id,
            role: run.role,
            elapsed_ms: Date.now() - run.started_at,
            processes,
          });
        }
        errors.push(
          new Error(`Cleanup process diagnostics: ${JSON.stringify(pending)}`),
        );
      } catch (diagnostic) {
        errors.push(diagnostic);
      }
    }
  } finally {
    probes.unsubscribe(observeProbe);
    for (const cleanup of [
      () => supervisor.close(),
      () => store.close(),
      () => close(sourceServer),
      () => close(modelServer),
      () => close(mcpServer),
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
      errors,
      `Runtime verification or cleanup failed after ${tests} completed scenario groups; recent storage probes: ${JSON.stringify(probeOutcomes)}`,
    );
  console.log(
    JSON.stringify({
      runtime: "passed",
      scenario_groups: tests,
      credentials: "isolated",
      history: "full",
      nested_review: "one_lease",
      crash_recovery: "passed",
      mcp_gateway: mcpProof,
      claude_sdk: claudeProof,
      codex_sdk: codexProof,
      cleanup: "passed",
    }),
  );
}
