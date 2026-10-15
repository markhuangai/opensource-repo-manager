import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  appendFile,
  lstat,
  open,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { setInterval, clearInterval } from "node:timers";

function denied(operation) {
  return operation.then(
    () => false,
    (error) => ["EACCES", "EPERM", "EROFS"].includes(error.code),
  );
}
function detached() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

export async function* run(request, signal) {
  const input = request.input ?? {};
  if (input.mode === "emit-credential") {
    const credential =
      input.credential === "mcp"
        ? request.mcp[0].authorization
        : request.relay.authorization;
    if (input.event === "progress") {
      const messages = input.split
        ? [
            credential.slice(0, Math.ceil(credential.length / 2)),
            credential.slice(Math.ceil(credential.length / 2)),
          ]
        : [credential];
      for (const [index, message] of messages.entries()) {
        yield { type: "progress", message };
        if (input.split && index === 0) {
          const deadline = Date.now() + 5000;
          for (;;) {
            try {
              await access(join(request.temporary, "continue"));
              break;
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            assert(Date.now() < deadline, "progress handshake timed out");
            await delay(10, undefined, { signal });
          }
        }
      }
      await delay(5000, undefined, { signal });
    }
    yield { type: "terminal", outcome: "completed", result: { credential } };
    return;
  }
  if (input.mode === "object-storage") {
    const history = spawnSync("/usr/bin/git", ["rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    });
    assert.equal(history.status, 0);
    yield {
      type: "terminal",
      outcome: "completed",
      result: {
        history: Number(history.stdout.trim()),
        inode: String(
          (
            await lstat(join(request.workspace, ".git", "objects"), {
              bigint: true,
            })
          ).ino,
        ),
      },
    };
    return;
  }
  if (["unlinked-storage", "unlinked-small"].includes(input.mode)) {
    const path = join(request.temporary, "deleted"),
      file = await open(path, "w+");
    let duplicate;
    try {
      await unlink(path);
      await file.write(
        Buffer.alloc(
          input.mode === "unlinked-small" ? 300 * 1024 : 2 * 1024 * 1024,
        ),
      );
      duplicate = await open(`/proc/self/fd/${file.fd}`, "r");
      yield { type: "progress", message: "deleted-ready" };
      await delay(input.mode === "unlinked-small" ? 1800 : 5000, undefined, {
        signal,
      });
      yield { type: "terminal", outcome: "completed" };
    } finally {
      await duplicate?.close();
      await file.close();
    }
    return;
  }
  if (input.mode === "mapped-deleted") {
    const source = join(request.temporary, "mapped.c"),
      binary = join(request.temporary, "mapped");
    await writeFile(
      source,
      '#include <sys/mman.h>\n#include <fcntl.h>\n#include <unistd.h>\n#include <stdio.h>\n#include <string.h>\nint main(int c,char **v){int f=open(v[1],O_CREAT|O_RDWR,0600);if(f<0||ftruncate(f,1048576))return 1;void *m=mmap(0,1048576,PROT_READ|PROT_WRITE,MAP_SHARED,f,0);if(m==MAP_FAILED||unlink(v[1])||close(f))return 2;memset(m,1,1048576);puts("ready");fflush(stdout);pause();}',
    );
    const compiled = spawnSync("/usr/bin/cc", [source, "-o", binary], {
      timeout: 5000,
    });
    assert.equal(compiled.status, 0);
    const child = spawn(binary, [join(request.temporary, "mapped-data")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { once } = await import("node:events"),
      exited = once(child, "exit");
    child.stderr.resume();
    try {
      await Promise.race([
        once(child.stdout, "data"),
        exited.then(() => {
          throw new Error("mapped fixture exited");
        }),
      ]);
      yield { type: "progress", message: "mapped-ready" };
      await delay(5000, undefined, { signal });
      yield { type: "terminal", outcome: "completed" };
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
    return;
  }
  if (input.mode === "inspect") {
    const status = await readFile("/proc/self/status", "utf8");
    const identity = JSON.parse(
      spawnSync(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()}))",
        ],
        { encoding: "utf8" },
      ).stdout,
    );
    assert.equal(identity.uid, process.getuid());
    for (const key of [
      "ORM_TEST_SECRET",
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "GIT_CONFIG_VALUE_2",
    ])
      assert.equal(process.env[key], undefined);
    assert(await denied(readFile("/config/config.yml")));
    assert(await denied(readFile(input.database)));
    assert(await denied(readFile(`/proc/${input.supervisor}/environ`)));
    assert(await denied(access(`/proc/${input.supervisor}/fd/0`)));
    assert(await denied(appendFile(request.prompts.system, "worker mutation")));
    assert(
      await denied(
        writeFile(join(input.artifact_root, "worker-write"), "denied"),
      ),
    );
    const elevation = spawnSync(
      "/usr/bin/setpriv",
      ["--reuid=0", "/usr/bin/id", "-u"],
      { encoding: "utf8" },
    );
    assert.notEqual(elevation.status, 0);
    const su = spawnSync(
      "/usr/bin/su",
      ["-s", "/bin/sh", "root", "-c", "id -u"],
      { encoding: "utf8", input: "", timeout: 1000 },
    );
    assert.notEqual(su.status, 0);
    const history = spawnSync("/usr/bin/git", ["rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    });
    assert.equal(history.status, 0);
    assert.equal(history.stdout.trim(), "2");
    const config = await readFile(
      join(request.workspace, ".git/config"),
      "utf8",
    );
    assert(!/extraheader|x-access-token|source\.git/i.test(config));
    await appendFile(
      join(request.workspace, ".git/config"),
      `\n[core]\nfsmonitor = !touch ${input.hook}\n`,
    );
    await writeFile(join(request.workspace, "app.txt"), "candidate bytes");
    await symlink("app.txt", join(request.workspace, "safe-link"));
    const prompt = await readFile(request.prompts.system, "utf8");
    assert(prompt.length > 0);
    yield { type: "session", id: "session-one" };
    yield { type: "artifact", path: "app.txt" };
    yield {
      type: "terminal",
      outcome: "completed",
      result: {
        uid: process.getuid(),
        gid: process.getgid(),
        status,
        home: request.home,
        workspace: request.workspace,
        history: 2,
        arguments: (await readFile("/proc/self/cmdline", "utf8")).split("\0"),
        binding: request.binding,
        resumed: request.resume?.id ?? null,
      },
    };
    return;
  }
  if (input.mode === "relay") {
    const route = request.profile.sdk === "claude" ? "/messages" : "/responses";
    const response = await fetch(request.relay.url + route, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.relay.authorization}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: request.profile.model, stream: true }),
      signal,
    });
    assert.equal(response.status, 200);
    assert((await response.text()).includes("fixture_done"));
    yield { type: "terminal", outcome: "completed" };
    return;
  }
  if (input.mode === "mcp" || input.mode === "mcp-hang") {
    assert.equal(request.mcp.length, 1);
    const connection = request.mcp[0];
    assert.deepEqual(connection.tools, ["read"]);
    const response = await fetch(connection.url, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.authorization}` },
      body: "read",
      signal,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).role, request.role);
    yield { type: "session", id: "mcp-session" };
    if (input.mode === "mcp") {
      yield {
        type: "terminal",
        outcome: "completed",
        result: { binding: request.binding },
      };
      return;
    }
  }
  if (input.mode === "review") {
    assert.equal(request.mcp.length, 0);
    if (input.peer) assert(await denied(readFile(input.peer)));
    if (input.peer) yield { type: "progress", message: "peer-denied" };
    yield { type: "progress", message: "review-start" };
    if (input.expectCandidate)
      assert.equal(
        await readFile(join(request.workspace, "safe-link"), "utf8"),
        "candidate bytes",
      );
    await delay(input.hang ? 60000 : 200, undefined, { signal });
    yield {
      type: "terminal",
      outcome: "completed",
      result: { uid: process.getuid(), home: request.home },
    };
    return;
  }
  if (input.mode === "fork") {
    let failed = false,
      count = 0;
    for (let index = 0; index < 96; index++) {
      const child = spawn("/usr/bin/sleep", ["60"], { stdio: "ignore" });
      const started = await new Promise((resolve) => {
        child.once("spawn", () => resolve(true));
        child.once("error", (error) => {
          assert.equal(error.code, "EAGAIN");
          resolve(false);
        });
      });
      if (!started) {
        failed = true;
        break;
      }
      count++;
      child.unref();
    }
    assert(failed);
    assert(count < 48);
    yield { type: "terminal", outcome: "completed", result: { count, failed } };
    return;
  }
  if (input.mode === "forge") {
    const { writeSync } = await import("node:fs");
    writeSync(
      3,
      JSON.stringify({
        run_id: "00000000-0000-4000-8000-000000000000",
        job_id: request.job_id,
        revision: request.revision,
        event: { type: "terminal", outcome: "completed" },
      }) + "\n",
    );
    await delay(5000);
    return;
  }
  if (input.mode === "escape") {
    await symlink("/config/config.yml", join(request.workspace, "escape"));
    yield { type: "terminal", outcome: "completed" };
    return;
  }
  if (input.mode === "overflow")
    process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120));
  if (input.mode === "storage")
    await writeFile(
      join(request.workspace, "large"),
      Buffer.alloc(2 * 1024 * 1024),
    );
  if (input.mode === "shared-temp")
    await writeFile(
      `/tmp/orm-worker-${request.run_id}`,
      Buffer.alloc(2 * 1024 * 1024),
    );
  const pid = detached();
  assert(pid > 0);
  if (input.mode === "detach-complete") {
    yield { type: "terminal", outcome: "completed", result: { pid } };
    return;
  }
  const heartbeat = join(request.workspace, "heartbeat");
  if (input.mode === "nested")
    process.once("SIGCONT", () => {
      void fetch(request.relay.url + "/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.relay.authorization}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: request.profile.model }),
      }).then(
        async (response) => {
          await response.text();
          await writeFile(
            join(request.workspace, "relay-resumed"),
            String(response.status),
          );
        },
        () => writeFile(join(request.workspace, "relay-resumed"), "error"),
      );
    });
  const timer = setInterval(() => {
    void appendFile(heartbeat, ".");
  }, 30);
  yield { type: "progress", message: "ready" };
  try {
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
  } finally {
    clearInterval(timer);
  }
  yield { type: "terminal", outcome: "cancelled" };
}
