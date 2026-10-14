import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 2 && args[0] === "--platform"),
  "Usage: npm run test:container -- --platform linux/amd64|linux/arm64",
);
const platform =
  args[1] ?? `linux/${process.arch === "x64" ? "amd64" : process.arch}`;
assert(
  ["linux/amd64", "linux/arm64"].includes(platform),
  "Unsupported test platform",
);

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "orm-container-"));
const context = join(temporary, "context");
const config = join(temporary, "docker-client");
const fixtures = join(temporary, "fixtures");
const id = `orm-test-${randomUUID()}`;
const label = "org.opensource-repo-manager.test-run";
const image = `${id}:app`;
const probeImage = `${id}:context`;
const runtime = `${id}-runtime`;
const probe = `${id}-probe`;
const setup = `${id}-setup`;
const volume = `${id}-data`;
const canary = `orm-secret-canary-${randomUUID()}`;
const resources = [];
const cleanupErrors = [];
let failure;
let receipt;

let daemon;

function result(command, { inherit = false, timeout = 30_000 } = {}) {
  const output = spawnSync(
    "docker",
    ["--config", config, "--host", daemon, ...command],
    {
      encoding: "utf8",
      stdio: inherit ? "inherit" : "pipe",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (output.error) throw output.error;
  return output;
}

function docker(command, options) {
  const output = result(command, options);
  assert.equal(
    output.status,
    0,
    output.stderr || output.stdout || `Docker ${command[0]} failed`,
  );
  return output.stdout?.trim() ?? "";
}

function register(type, name) {
  resources.push({ type, name });
}

function request(path, headers = {}) {
  return JSON.parse(
    docker([
      "exec",
      runtime,
      "/opt/orm-runtime/bin/node",
      "--input-type=module",
      "-e",
      "const response = await fetch('http://127.0.0.1:8080' + process.argv[1], { headers: JSON.parse(process.argv[2]), signal: AbortSignal.timeout(2000) }); console.log(JSON.stringify({ status: response.status, body: await response.json() }));",
      path,
      JSON.stringify(headers),
    ]),
  );
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = request("/healthz");
      if (response.status === 200) return;
      lastError = new Error(`Liveness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error("Container did not become live within 30 seconds", {
    cause: lastError,
  });
}

function inspectRuntime() {
  return JSON.parse(docker(["container", "inspect", runtime]))[0];
}

function stopCleanly() {
  docker(["container", "stop", "--timeout", "15", runtime]);
  const state = inspectRuntime().State;
  assert.equal(state.ExitCode, 0, "Application did not shut down cleanly");
  assert.equal(state.OOMKilled, false);
}

try {
  const [dockerContext] = JSON.parse(
    execFileSync("docker", ["context", "inspect"], { encoding: "utf8" }),
  );
  daemon = process.env.DOCKER_HOST ?? dockerContext.Endpoints.docker.Host;
  assert(
    daemon.startsWith("unix://"),
    "Container tests require a local Unix-socket Docker daemon",
  );
  await mkdir(join(config, "cli-plugins"), { recursive: true });
  await writeFile(join(config, "config.json"), JSON.stringify({ auths: {} }));
  const plugins = JSON.parse(
    execFileSync(
      "docker",
      ["info", "--format", "{{json .ClientInfo.Plugins}}"],
      { encoding: "utf8" },
    ),
  );
  const buildx = plugins.find((plugin) => plugin.Name === "buildx");
  assert(buildx?.Path, "Docker Buildx is required");
  await symlink(buildx.Path, join(config, "cli-plugins", "docker-buildx"));
  await mkdir(context);
  for (const file of [
    "Dockerfile",
    ".dockerignore",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "src",
  ]) {
    await cp(join(root, file), join(context, file), { recursive: true });
  }
  for (const directory of [".codex", "config", "data", "workspaces"]) {
    await mkdir(join(context, directory));
    await writeFile(join(context, directory, "secret-canary"), canary);
  }
  await writeFile(join(context, ".env"), canary);
  const probeDockerfile = join(temporary, "context-probe.Dockerfile");
  await writeFile(probeDockerfile, "FROM scratch\nCOPY . /\n");

  console.log(`Verifying Docker context exclusion for ${platform}`);
  register("image", probeImage);
  docker(
    [
      "build",
      "--builder",
      "default",
      "--platform",
      platform,
      "--label",
      `${label}=${id}`,
      "--tag",
      probeImage,
      "--file",
      probeDockerfile,
      context,
    ],
    { inherit: true, timeout: 120_000 },
  );
  register("container", probe);
  docker([
    "container",
    "create",
    "--name",
    probe,
    "--label",
    `${label}=${id}`,
    "--entrypoint",
    "/not-executed",
    probeImage,
  ]);
  const archive = join(temporary, "context.tar");
  docker(["container", "export", "--output", archive, probe]);
  assert(
    !(await readFile(archive)).includes(Buffer.from(canary)),
    "A secret canary entered the Docker build context",
  );

  console.log(`Building the production image for ${platform}`);
  register("image", image);
  docker(
    [
      "build",
      "--builder",
      "default",
      "--platform",
      platform,
      "--label",
      `${label}=${id}`,
      "--tag",
      image,
      "--file",
      join(context, "Dockerfile"),
      context,
    ],
    { inherit: true, timeout: 1_200_000 },
  );

  for (const directory of ["config", "skills", "prompts"])
    await mkdir(join(fixtures, directory), { recursive: true });
  await writeFile(join(fixtures, "config", "config.yml"), "{}\n", {
    mode: 0o600,
  });
  await writeFile(
    join(fixtures, "skills", "fixture.md"),
    "trusted skill fixture\n",
  );
  await writeFile(
    join(fixtures, "prompts", "fixture.md"),
    "trusted prompt fixture\n",
  );
  register("container", setup);
  docker([
    "run",
    "--rm",
    "--name",
    setup,
    "--label",
    `${label}=${id}`,
    "--mount",
    `type=bind,src=${join(fixtures, "config")},dst=/fixture`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    "chown 0:0 /fixture/config.yml && chmod 600 /fixture/config.yml",
  ]);
  register("volume", volume);
  docker(["volume", "create", "--label", `${label}=${id}`, volume]);
  register("container", runtime);
  const mounts = ["config", "skills", "prompts"].flatMap((directory) => [
    "--mount",
    `type=bind,src=${join(fixtures, directory)},dst=/${directory},readonly`,
  ]);
  docker([
    "run",
    "--detach",
    "--name",
    runtime,
    "--label",
    `${label}=${id}`,
    "--platform",
    platform,
    "--publish",
    "127.0.0.1::8080",
    "--mount",
    `type=volume,src=${volume},dst=/data`,
    ...mounts,
    "--env",
    `ORM_TEST_SECRET=${canary}`,
    image,
  ]);
  const binding = inspectRuntime().NetworkSettings.Ports["8080/tcp"][0];
  assert.equal(binding.HostIp, "127.0.0.1");
  assert(Number(binding.HostPort) > 0);
  await waitForHealth();

  const live = request("/healthz", { authorization: `Bearer ${canary}` });
  assert.equal(live.status, 200);
  assert.deepEqual(live.body, { status: "ok" });
  const ready = request("/readyz");
  assert.equal(ready.status, 503);
  assert.deepEqual(ready.body, {
    status: "not_ready",
    reason: "automation_not_implemented",
  });
  assert(
    !docker(["container", "logs", runtime]).includes(canary),
    "HTTP handling leaked a secret canary",
  );

  const inspection = inspectRuntime();
  for (const directory of ["/config", "/skills", "/prompts"]) {
    assert.equal(
      inspection.Mounts.find((mount) => mount.Destination === directory).RW,
      false,
    );
  }
  assert.equal(
    inspection.Mounts.find((mount) => mount.Destination === "/data").RW,
    true,
  );
  assert.equal(inspection.HostConfig.Privileged, false);
  assert(!inspection.HostConfig.CapAdd?.includes("NET_ADMIN"));
  assert(
    !inspection.Mounts.some((mount) =>
      mount.Destination.includes("docker.sock"),
    ),
  );
  assert.equal(
    docker(["exec", runtime, "/opt/orm-runtime/bin/node", "--version"]),
    "v24.18.0",
  );
  assert.equal(
    docker([
      "exec",
      runtime,
      "stat",
      "-c",
      "%u:%a",
      "/opt/orm-runtime/bin/node",
    ]),
    "0:555",
  );
  assert(inspection.Config.Entrypoint.includes("/opt/orm-runtime/bin/node"));
  const users = ["coding", "audit", "output-review"].map((user) =>
    Number(docker(["exec", "--user", user, runtime, "id", "-u"])),
  );
  assert(users.every((uid) => uid > 0));
  assert.equal(new Set(users).size, 3);
  for (const tool of ["git", "cc", "make", "setpriv", "tini"])
    docker(["exec", runtime, "/bin/sh", "-c", `command -v ${tool}`]);
  const deniedRead = result([
    "exec",
    "--user",
    "coding",
    runtime,
    "cat",
    "/config/config.yml",
  ]);
  assert.notEqual(deniedRead.status, 0);
  assert(deniedRead.stderr.includes("Permission denied"));
  const deniedWrite = result([
    "exec",
    runtime,
    "touch",
    "/prompts/write-probe",
  ]);
  assert.notEqual(deniedWrite.status, 0);
  assert(deniedWrite.stderr.includes("Read-only file system"));

  const healthyDeadline = Date.now() + 30_000;
  while (
    inspectRuntime().State.Health.Status === "starting" &&
    Date.now() < healthyDeadline
  )
    await delay(200);
  assert.equal(inspectRuntime().State.Health.Status, "healthy");
  docker([
    "exec",
    runtime,
    "/bin/sh",
    "-c",
    "printf durable > /data/persistence-probe",
  ]);
  stopCleanly();
  docker(["container", "start", runtime]);
  await waitForHealth();
  assert.equal(
    docker(["exec", runtime, "cat", "/data/persistence-probe"]),
    "durable",
  );
  stopCleanly();
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  receipt = {
    platform,
    source_sha: sourceSha,
    image_id: imageId,
    http: "passed",
    users_and_mounts: "passed",
    context_exclusion: "passed",
    shutdown_and_persistence: "passed",
  };
} catch (error) {
  failure = error;
} finally {
  for (const { type, name } of resources.reverse()) {
    try {
      const inspection = result([type, "inspect", name]);
      if (inspection.status !== 0) {
        assert(/no such|not found/i.test(inspection.stderr), inspection.stderr);
        continue;
      }
      const [object] = JSON.parse(inspection.stdout);
      assert.equal(
        (type === "volume" ? object.Labels : object.Config.Labels)?.[label],
        id,
        `Refusing cleanup of unowned ${type} ${name}`,
      );
      docker([type, "rm", ...(type === "container" ? ["--force"] : []), name]);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await rm(temporary, { recursive: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
}

if (failure || cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors],
    "Container verification or scoped cleanup failed",
  );
console.log(
  JSON.stringify({
    ...receipt,
    cleanup: "passed",
    resources_removed: resources.map(({ type, name }) => ({ type, name })),
  }),
);
