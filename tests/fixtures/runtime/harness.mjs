import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { tracingChannel } from "node:diagnostics_channel";
import {
  chmod,
  mkdir,
  readFile,
  readlink,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { loadProtectedConfiguration } from "/opt/orm/app/dist/config/load.js";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";
import {
  cleanEnvironment,
  cleanSource,
  cleanUser,
  deletedFileBytes,
  sourceProcesses,
  spawnAsRole,
  userProcesses,
} from "/opt/orm/app/dist/runtime/process.js";
import { gitCommand } from "/opt/orm/app/dist/services/workspaces/index.js";
import { createPublicationFixture } from "/publication-fixture.ts";

async function until(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    assert(Date.now() < deadline, "runtime condition timed out");
    await delay(20);
  }
}

export async function runRuntimeTests() {
  const base = "/data/orm-runtime-probe";
  await mkdir(base, { mode: 0o755 });
  const root = join(base, "runtime");
  const store = new Store(join(base, "state", "manager.sqlite"));
  const { snapshot, secrets } = await loadProtectedConfiguration();
  const remote = await createPublicationFixture(join(base, "git"));
  remote.state.token = secrets.get("github.token");
  const supervisor = await Supervisor.create(store, snapshot, secrets, {
    root,
    sourceUrl: () => remote.url + "/owner/repo.git",
  });
  let tests = 0,
    storageProbe;
  const errors = [],
    probeOutcomes = [],
    probes = tracingChannel("child_process.spawn").start;
  const observeProbe = ({ process: child }) => {
    if (!child.spawnargs?.[1]?.endsWith("/runtime/storage.js")) return;
    storageProbe = child;
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
      '#include <sys/prctl.h>\n#include <fcntl.h>\n#include <unistd.h>\n#include <stdio.h>\n#include <stdlib.h>\nint main(int c,char **v){int f=open(v[1],O_CREAT|O_RDWR,0600);if(f<0||ftruncate(f,307200)||unlink(v[1])||dup(f)<0||prctl(PR_SET_DUMPABLE,0)||prctl(PR_SET_NAME,"storage ) name"))return 1;puts("ready");fflush(stdout);char b;if(read(0,&b,1)!=1)return 2;int ms=atoi(v[2]);if(ms>=0){usleep(ms*1000);if(prctl(PR_SET_DUMPABLE,1))return 3;}for(;;)pause();}',
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
      unlink(values[1]) || prctl(PR_SET_DUMPABLE, 0) ||
      prctl(PR_SET_NAME, "teardown ) name")) return 1;
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
        const previousProbe = storageProbe,
          started = Date.now(),
          monotonicStarted = performance.now(),
          probe = deletedFileBytes(10001, 1024 ** 2);
        if (!teardown && waits.length > 1)
          await Promise.race([
            until(async () => {
              if (storageProbe === previousProbe || !storageProbe?.pid)
                return false;
              return /^Uid:\s+0\s+10001\s+0\s+10001$/m.test(
                await readFile(`/proc/${storageProbe.pid}/status`, "utf8"),
              );
            }),
            probe.then(() => {
              throw new Error("Storage probe ended before control release");
            }),
          ]);
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
          assert(
            performance.now() - monotonicStarted < 1000,
            "A live unreadable worker used the teardown retry window",
          );
        }
      } finally {
        await cleanUser(10001);
        await Promise.all(controls.map(({ closed }) => closed));
      }
      assert.deepEqual(await userProcesses(10001), []);
      tests++;
    }
    const churnDeadline = Date.now() + 30000,
      churn = Array.from({ length: 4 }, async () => {
        do {
          const child = spawnAsRole(
              "implementation",
              "/opt/orm-runtime/bin/node",
              [
                "-e",
                'process.title="storage ) churn";const memory=Array.from({length:128},()=>Buffer.alloc(1024*1024,1));console.log("ready");setInterval(()=>{},1000)',
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
    for (const uid of [10001, 10002, 10003]) {
      const probe = spawn(
        process.execPath,
        [
          "-e",
          'const uid=Number(process.argv[1]);process.setgroups([]);process.setegid(uid);console.log("gid-ready");process.stdin.once("data",()=>{process.seteuid(uid);console.log("uid-ready")});setInterval(()=>{},1000)',
          String(uid),
        ],
        { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] },
      );
      const probeExited = once(probe, "exit"),
        probeStage = join(root, "private", "sources", `protected-probe-${uid}`);
      probe.stderr.resume();
      try {
        await Promise.race([
          once(probe.stdout, "data", { signal: AbortSignal.timeout(2000) }),
          probeExited.then(() => {
            throw new Error("trusted probe exited");
          }),
        ]);
        const status = await readFile(`/proc/${probe.pid}/status`, "utf8");
        assert.match(status, /^Uid:\s+0\s+0\s+0\s+0$/m);
        assert.match(
          status,
          new RegExp(`^Gid:\\s+0\\s+${uid}\\s+0\\s+${uid}$`, "m"),
        );
        await assert.rejects(readlink(`/proc/${probe.pid}/cwd`), {
          code: "EACCES",
        });
        assert.deepEqual(
          await sourceProcesses("protected-probe", probeStage),
          [],
        );
        const uidReady = once(probe.stdout, "data", {
          signal: AbortSignal.timeout(2000),
        });
        probe.stdin.end("continue");
        await Promise.race([
          uidReady,
          probeExited.then(() => {
            throw new Error("trusted probe exited before its UID transition");
          }),
        ]);
        assert.match(
          await readFile(`/proc/${probe.pid}/status`, "utf8"),
          new RegExp(`^Uid:\\s+0\\s+${uid}\\s+0\\s+${uid}$`, "m"),
        );
        assert.deepEqual(await userProcesses(uid), []);
        assert.deepEqual(
          await sourceProcesses("protected-probe", probeStage),
          [],
        );
      } finally {
        if (probe.exitCode === null && probe.signalCode === null)
          probe.kill("SIGKILL");
        await probeExited;
      }
      tests++;
    }
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
    const unreadableSource = spawn(
        process.execPath,
        ["-e", 'console.log("ready");setInterval(()=>{},1000)'],
        {
          gid: 1,
          env: { PATH: "/usr/bin:/bin", ORM_SOURCE_RUN: cleanupId },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
      unreadableExited = once(unreadableSource, "exit");
    unreadableSource.stderr.resume();
    try {
      await Promise.race([
        once(unreadableSource.stdout, "data", {
          signal: AbortSignal.timeout(2000),
        }),
        unreadableExited.then(() => {
          throw new Error("unreadable source exited before inspection");
        }),
      ]);
      await assert.rejects(readlink(`/proc/${unreadableSource.pid}/cwd`), {
        code: "EACCES",
      });
      await assert.rejects(sourceProcesses(cleanupId, cleanupStage), {
        code: "EACCES",
      });
      await assert.rejects(cleanSource(cleanupId, cleanupStage), {
        code: "EACCES",
      });
    } finally {
      if (
        unreadableSource.exitCode === null &&
        unreadableSource.signalCode === null
      )
        unreadableSource.kill("SIGKILL");
      await unreadableExited;
    }
    tests++;

    store.enroll({
      id: 42,
      full_name: "owner/repo",
      default_branch: "main",
      private: false,
    });
    store.saveSnapshot(snapshot);
    store.applyIssue(
      store.refreshIssue(1),
      {
        id: 1001,
        number: 1,
        state: "open",
        title: "Runtime fixture",
        body: "input",
        updated_at: "2026-10-15T00:00:00Z",
        comments: [],
        source: remote.source,
      },
      snapshot,
    );
    const job = store.job(1);
    const request = supervisor.request(job.id, "audit");
    const branch = `orm-work/${randomUUID()}/${randomUUID()}`;
    const child = remote.commit(
      { ...remote.initial, "app.txt": "audited change\n" },
      remote.source.sha,
    );
    remote.git(["update-ref", "refs/heads/" + branch, child.sha]);
    const signal = AbortSignal.timeout(20000);
    const artifact = await supervisor.captureCandidate(
      request,
      { branch, sha: child.sha },
      remote.source.sha,
      signal,
    );
    assert.equal(store.candidate(artifact).sha, child.sha);
    const verify = supervisor.request(job.id, "audit", undefined, artifact);
    await supervisor.withJobLease(verify, signal, (lease) =>
      supervisor.bootstrapWorkspace(lease, verify, async (prepared) => {
        const options = {
          cwd: prepared.workspace,
          env: cleanEnvironment(prepared.home, prepared.temporary, "audit"),
          signal: lease.signal,
          role: "audit",
        };
        assert.equal(
          (await gitCommand(["rev-parse", "HEAD"], options)).trim(),
          child.sha,
        );
        assert.equal(
          await readFile(join(prepared.workspace, "app.txt"), "utf8"),
          "audited change\n",
        );
        assert.equal(
          (await gitCommand(["rev-parse", "HEAD^"], options)).trim(),
          remote.source.sha,
        );
      }),
    );
    await assert.rejects(
      supervisor.captureCandidate(
        request,
        { branch, sha: remote.source.sha },
        child.sha,
        signal,
      ),
      /source_/,
    );
    assert.equal(store.leases().length, 0);
    assert.deepEqual(await readdir(join(root, "runs")), []);
    tests++;
  } catch (error) {
    errors.push(error);
  } finally {
    probes.unsubscribe(observeProbe);
    const results = await Promise.allSettled([
      supervisor.close(),
      remote.close(),
    ]);
    store.close();
    for (const result of results)
      if (result.status === "rejected") errors.push(result.reason);
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `Runtime verification failed after ${tests} cases. Storage probes ${JSON.stringify(probeOutcomes)}`,
    );
  console.log(JSON.stringify({ runtime: "passed", cleanup: "passed", tests }));
}
