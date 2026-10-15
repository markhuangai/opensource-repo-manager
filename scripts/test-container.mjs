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
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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
let protectedFixtures = false;

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
  await cp(
    join(root, "examples", "workflow", "skills"),
    join(fixtures, "skills"),
    { recursive: true },
  );
  await cp(
    join(root, "examples", "workflow", "prompts"),
    join(fixtures, "prompts"),
    { recursive: true },
  );
  const validConfig = parseYaml(
    await readFile(join(root, "config.example.yml"), "utf8"),
  );
  validConfig.github.token = `${canary}-github`;
  validConfig.github.webhook_secret = `${canary}-webhook`;
  validConfig.proxy.key = `${canary}-proxy`;
  validConfig.notifications.webhook.headers.Authorization = `Bearer ${canary}-notification`;
  const validYaml = stringifyYaml(validConfig);
  const invalidUtf8 = Buffer.from(validYaml);
  invalidUtf8[invalidUtf8.indexOf(`${canary}-github`)] = 0xff;
  const cases = [
    { name: "config", source: validYaml, expected: 0 },
    { name: "readonly", source: validYaml, mode: "400", expected: 0 },
    {
      name: "readable",
      source: validYaml,
      mode: "644",
      expected: 1,
      code: "config_permissions",
    },
    {
      name: "worker-owned",
      source: validYaml,
      owner: "10001:10001",
      expected: 1,
      code: "config_permissions",
    },
    {
      name: "malformed",
      source: `${validYaml}\nmalformed: [${canary}\n`,
      expected: 1,
      code: "yaml_invalid",
    },
    {
      name: "invalid-utf8",
      source: invalidUtf8,
      expected: 1,
      code: "yaml_invalid",
    },
    {
      name: "query-credential",
      source: stringifyYaml({
        ...validConfig,
        proxy: {
          ...validConfig.proxy,
          url: `https://fixture.invalid/v1?client_secret=${canary}`,
        },
      }),
      expected: 1,
      code: "schema_invalid",
    },
    {
      name: "ordinary-query",
      source: stringifyYaml({
        ...validConfig,
        proxy: {
          ...validConfig.proxy,
          url: "https://fixture.invalid/v1?api-version=1",
        },
      }),
      expected: 1,
      code: "schema_invalid",
    },
    {
      name: "collection-key",
      source: `${validYaml}\n? [parser-secret-canary]\n: true\n`,
      expected: 1,
      code: "schema_invalid",
    },
    {
      name: "multiple-documents",
      source: `${validYaml}\n---\nversion: 1\n`,
      expected: 1,
      code: "yaml_invalid",
    },
    {
      name: "unknown",
      source: `${validYaml}\n${canary}: true\n`,
      expected: 1,
      code: "schema_invalid",
    },
    {
      name: "escaping",
      source: stringifyYaml({
        ...validConfig,
        roles: {
          ...validConfig.roles,
          audit: {
            ...validConfig.roles.audit,
            prompts: { system: "../config/config.yml", user: "user.md" },
          },
        },
      }),
      expected: 1,
      code: "schema_invalid",
    },
    {
      name: "missing-prompt",
      source: stringifyYaml({
        ...validConfig,
        roles: {
          ...validConfig.roles,
          audit: {
            ...validConfig.roles.audit,
            prompts: { system: "missing.md", user: "user.md" },
          },
        },
      }),
      expected: 1,
      code: "bundle_invalid",
    },
    {
      name: "linked-prompt",
      source: stringifyYaml({
        ...validConfig,
        roles: {
          ...validConfig.roles,
          audit: {
            ...validConfig.roles.audit,
            prompts: { system: "linked.md", user: "user.md" },
          },
        },
      }),
      expected: 1,
      code: "bundle_invalid",
    },
    {
      name: "secret-prompt",
      source: stringifyYaml({
        ...validConfig,
        roles: {
          ...validConfig.roles,
          audit: {
            ...validConfig.roles.audit,
            prompts: { system: "secret.md", user: "user.md" },
          },
        },
      }),
      expected: 1,
      code: "secret_in_snapshot",
    },
  ];
  const mcpConfig = parseYaml(validYaml);
  mcpConfig.mcp = {
    credentials: {
      service: { headers: { Authorization: `Bearer ${canary}-mcp` } },
    },
    servers: {
      fixture: {
        transport: "streamable_http",
        url: "http://fixture.invalid/mcp",
        allow_plain_http: true,
        credential_ref: "service",
        tools: {
          read_item: { effect: "read" },
          write_item: {
            effect: "reviewed_write",
            idempotency_argument: "operation_key",
          },
        },
      },
    },
  };
  mcpConfig.roles.investigation.mcp = {
    fixture: { tools: ["read_item", "write_item"] },
  };
  cases.push({ name: "mcp", source: stringifyYaml(mcpConfig), expected: 0 });
  for (const [name, change] of [
    [
      "mcp-plain-http",
      (config) => {
        config.mcp.servers.fixture.allow_plain_http = false;
      },
    ],
    [
      "mcp-reviewer",
      (config) => {
        config.roles.output_review.mcp = { fixture: { tools: ["read_item"] } };
      },
    ],
    [
      "mcp-size",
      (config) => {
        config.mcp.max_response_bytes = 1048577;
      },
    ],
    [
      "mcp-timeout",
      (config) => {
        config.mcp.call_timeout_seconds = 0;
      },
    ],
  ]) {
    const changed = parseYaml(stringifyYaml(mcpConfig));
    change(changed);
    cases.push({
      name,
      source: stringifyYaml(changed),
      expected: 1,
      code: "schema_invalid",
    });
  }
  for (const test of cases)
    await writeFile(join(fixtures, "config", `${test.name}.yml`), test.source, {
      mode: 0o600,
    });
  await writeFile(join(fixtures, "prompts", "secret.md"), `${canary}-github\n`);
  await symlink("/config/config.yml", join(fixtures, "prompts", "linked.md"));
  await symlink("config.yml", join(fixtures, "config", "linked.yml"));
  register("container", setup);
  protectedFixtures = true;
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
    "chown 0:0 /fixture && chmod 755 /fixture && chown 0:0 /fixture/*.yml && chmod 600 /fixture/*.yml && chmod 400 /fixture/readonly.yml && chmod 644 /fixture/readable.yml && chown 10001:10001 /fixture/worker-owned.yml",
  ]);
  register("volume", volume);
  docker(["volume", "create", "--label", `${label}=${id}`, volume]);
  register("container", runtime);
  const mounts = ["config", "skills", "prompts"].flatMap((directory) => [
    "--mount",
    `type=bind,src=${join(fixtures, directory)},dst=/${directory},readonly`,
  ]);
  for (const test of [
    ...cases,
    { name: "missing", expected: 1, code: "config_unreadable" },
    { name: "linked", expected: 1, code: "config_unreadable" },
  ]) {
    const name = `${id}-validate-${test.name}`;
    register("container", name);
    const validation = result([
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      `${label}=${id}`,
      ...mounts,
      image,
      "config",
      "validate",
      "--config",
      `/config/${test.name}.yml`,
    ]);
    assert.equal(
      validation.status,
      test.expected,
      `Validation scenario ${test.name} failed: ${validation.stderr}`,
    );
    assert(
      !(validation.stdout + validation.stderr).includes(canary),
      `Validation scenario ${test.name} disclosed a credential`,
    );
    assert(
      !(validation.stdout + validation.stderr).includes("parser-secret-canary"),
      `Validation scenario ${test.name} disclosed a collection key`,
    );
    if (test.code)
      assert(
        validation.stderr.includes(test.code),
        `Validation scenario ${test.name} did not report its safe error code`,
      );
    else
      assert(
        validation.stdout.includes(
          "Configuration and workflow bundles are valid.",
        ),
      );
  }
  for (const scenario of ["malformed", "collection-key", "invalid-utf8"]) {
    const invalidName = `${id}-invalid-startup-${scenario}`;
    register("container", invalidName);
    const invalidStartup = result([
      "run",
      "--rm",
      "--name",
      invalidName,
      "--label",
      `${label}=${id}`,
      ...mounts,
      image,
      "--config",
      `/config/${scenario}.yml`,
    ]);
    assert.equal(invalidStartup.status, 1);
    assert(!invalidStartup.stdout.includes("HTTP listening"));
    assert(invalidStartup.stderr.includes("Configuration rejected"));
    assert(!invalidStartup.stderr.includes(canary));
    assert(!invalidStartup.stderr.includes("parser-secret-canary"));
  }
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
  assert(
    docker(["exec", runtime, "orm", "config", "validate"]).includes(
      "Configuration and workflow bundles are valid.",
    ),
  );
  const snapshotProof = JSON.parse(
    docker([
      "exec",
      runtime,
      "/opt/orm-runtime/bin/node",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { loadProtectedConfiguration } from '/opt/orm/app/dist/config/load.js';
    const { snapshot, secrets } = await loadProtectedConfiguration('/config/mcp.yml');
    assert(Object.isFrozen(snapshot.roles.audit.profile));
    assert.throws(() => { snapshot.roles.audit.profile.model = 'changed'; });
    assert.throws(() => { snapshot.settings.roles.investigation.mcp.fixture.tools.push('forbidden'); });
    assert(!secrets.contains(snapshot));
    console.log(JSON.stringify({ worker: snapshot.roles, digest: snapshot.digest }));
  `,
    ]),
  );
  assert(!JSON.stringify(snapshotProof).includes(canary));
  assert(!JSON.stringify(snapshotProof.worker).includes("fixture.invalid"));
  assert(!JSON.stringify(snapshotProof.worker).includes("cpa:8317"));

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
  for (const user of ["coding", "audit", "output-review"]) {
    const deniedRead = result([
      "exec",
      "--user",
      user,
      runtime,
      "cat",
      "/config/config.yml",
    ]);
    assert.notEqual(deniedRead.status, 0);
    assert(deniedRead.stderr.includes("Permission denied"));
    const deniedWorkerWrite = result([
      "exec",
      "--user",
      user,
      runtime,
      "touch",
      "/skills/example/worker-write-probe",
    ]);
    assert.notEqual(deniedWorkerWrite.status, 0);
    assert(
      /Permission denied|Read-only file system/.test(deniedWorkerWrite.stderr),
    );
  }
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
    protected_configuration_and_cli: "passed",
    immutable_secret_free_snapshots: "passed",
  };
} catch (error) {
  failure = error;
} finally {
  if (protectedFixtures) {
    try {
      const [inspection] = JSON.parse(docker(["image", "inspect", image]));
      assert.equal(inspection.Config.Labels?.[label], id);
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
        `chown ${process.getuid()}:${process.getgid()} /fixture && chmod 700 /fixture`,
      ]);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
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
