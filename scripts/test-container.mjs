import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { githubFixtureState, makeIssue } from "../tests/fixtures/github.ts";

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
const network = `${id}-network`;
const github = `${id}-github`;
const bootstrapContainer = `${id}-bootstrap`;
const bootstrapVolume = `${id}-bootstrap-data`;
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

function logs(container) {
  const output = result(["container", "logs", container]);
  assert.equal(output.status, 0, "Container logs unavailable");
  return output.stdout + output.stderr;
}

function request(path, headers = {}, container = runtime) {
  return JSON.parse(
    docker([
      "exec",
      container,
      "/opt/orm-runtime/bin/node",
      "--input-type=module",
      "-e",
      "const response = await fetch('http://127.0.0.1:8080' + process.argv[1], { headers: JSON.parse(process.argv[2]), signal: AbortSignal.timeout(2000) }); console.log(JSON.stringify({ status: response.status, body: await response.json() }));",
      path,
      JSON.stringify(headers),
    ]),
  );
}

async function waitForHealth(container = runtime) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = request("/healthz", {}, container);
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

function stopCleanly(container = runtime) {
  docker(["container", "stop", "--timeout", "15", container]);
  const state = JSON.parse(docker(["container", "inspect", container]))[0]
    .State;
  assert.equal(state.ExitCode, 0, "Application did not shut down cleanly");
  assert.equal(state.OOMKilled, false);
}

function databaseState() {
  return JSON.parse(
    docker([
      "exec",
      runtime,
      "/opt/orm-runtime/bin/node",
      "--input-type=module",
      "-e",
      `
    import Database from 'better-sqlite3';
    const db=new Database('/data/state/manager.sqlite',{readonly:true});
    console.log(JSON.stringify({jobs:db.prepare('SELECT * FROM jobs ORDER BY id').all(),cursor:db.prepare('SELECT page FROM reconciliation').get(),inbox:db.prepare('SELECT * FROM inbox').all()}));
    db.close();
  `,
    ]),
  );
}

function webhook(
  payload,
  event = "issues",
  delivery = randomUUID(),
  valid = true,
) {
  return JSON.parse(
    docker([
      "exec",
      runtime,
      "/opt/orm-runtime/bin/node",
      "--input-type=module",
      "-e",
      `
    import {createHmac} from 'node:crypto';
    import {loadProtectedConfiguration} from './dist/config/load.js';
    const {secrets}=await loadProtectedConfiguration();
    const body=process.argv[1];
    const signature='sha256='+createHmac('sha256',secrets.get('github.webhook_secret')).update(body).digest('hex');
    const response=await fetch('http://127.0.0.1:8080/webhooks/github',{method:'POST',body,headers:{'content-type':'application/json','x-github-event':process.argv[2],'x-github-delivery':process.argv[3],'x-hub-signature-256':process.argv[4]==='true'?signature:'sha256'+'='+'0'.repeat(64)}});
    console.log(JSON.stringify({status:response.status,body:await response.json()}));
  `,
      JSON.stringify(payload),
      event,
      delivery,
      String(valid),
    ]),
  );
}

async function waitUntil(probe, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (probe()) return;
    await delay(200);
  }
  throw new Error(message);
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

  const upstream = join(fixtures, "github");
  await mkdir(upstream, { recursive: true });
  await cp(
    join(root, "tests", "fixtures", "github.ts"),
    join(upstream, "github.mts"),
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=api.github.com",
      "-addext",
      "subjectAltName=DNS:api.github.com,DNS:github.com,DNS:localhost",
      "-days",
      "1",
      "-keyout",
      join(upstream, "key.pem"),
      "-out",
      join(upstream, "ca.pem"),
    ],
    { stdio: "ignore" },
  );
  const upstreamState = githubFixtureState();
  upstreamState.token = `${canary}-github`;
  for (let number = 2; number <= 101; number++)
    upstreamState.issues[number] = {
      ...makeIssue(number),
      ...(number <= 100 ? { pull_request: { url: "ignored" } } : {}),
    };
  upstreamState.hold_page = 2;
  async function saveUpstream() {
    await writeFile(
      join(upstream, "state.next"),
      JSON.stringify(upstreamState),
    );
    await rename(join(upstream, "state.next"), join(upstream, "state.json"));
  }
  await saveUpstream();
  await writeFile(
    join(upstream, "server.mjs"),
    `
    import {createServer} from 'node:https';
    import {readFileSync,writeFileSync} from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    import {githubFixtureRequest} from './github.mts';
    createServer({key:readFileSync('/fixture/key.pem'),cert:readFileSync('/fixture/ca.pem')},async(request,response)=>{
      const url=new URL(request.url,'https://api.github.com');
      let state=JSON.parse(readFileSync('/fixture/state.json','utf8'));
      while(state.hold_page && url.pathname==='/repos/owner/repo/issues' && Number(url.searchParams.get('page'))===state.hold_page) {
        writeFileSync('/fixture/page-received',String(state.hold_page));
        if(request.destroyed)return;
        await delay(50);
        state=JSON.parse(readFileSync('/fixture/state.json','utf8'));
      }
      await githubFixtureRequest(request,response,state);
    }).listen(443,'0.0.0.0');
  `,
  );
  register("network", network);
  docker(["network", "create", "--label", `${label}=${id}`, network]);
  register("container", github);
  docker([
    "run",
    "--detach",
    "--name",
    github,
    "--label",
    `${label}=${id}`,
    "--network",
    network,
    "--network-alias",
    "api.github.com",
    "--mount",
    `type=bind,src=${upstream},dst=/fixture`,
    "--entrypoint",
    "/opt/orm-runtime/bin/node",
    image,
    "/fixture/server.mjs",
  ]);

  for (const directory of ["config", "skills", "prompts", "investigations"])
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
  validConfig.github.repository = "owner/repo";
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
        review_required_tools: [],
        url: "http://fixture.invalid/mcp",
        allow_plain_http: true,
        credential_ref: "service",
        tools: {
          read_item: { effect: "read" },
          write_item: {
            effect: "write",
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
  for (const test of cases) {
    await writeFile(join(fixtures, "config", `${test.name}.yml`), test.source, {
      mode: 0o600,
    });
    await mkdir(join(fixtures, "cases", test.name), { recursive: true });
    await writeFile(
      join(fixtures, "cases", test.name, "config.yml"),
      test.source,
      { mode: 0o600 },
    );
  }
  await mkdir(join(fixtures, "cases", "missing"));
  await mkdir(join(fixtures, "cases", "linked"));
  await writeFile(join(fixtures, "cases", "linked", "real.yml"), validYaml, {
    mode: 0o600,
  });
  await symlink("real.yml", join(fixtures, "cases", "linked", "config.yml"));
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
    `type=bind,src=${fixtures},dst=/fixture`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    "chown 0:0 /fixture/config /fixture/cases /fixture/cases/* && chmod 755 /fixture/config /fixture/cases /fixture/cases/* && find /fixture/config /fixture/cases -type f -exec chown 0:0 {} + -exec chmod 600 {} + && chmod 400 /fixture/config/readonly.yml /fixture/cases/readonly/config.yml && chmod 644 /fixture/config/readable.yml /fixture/cases/readable/config.yml && chown 10001:10001 /fixture/config/worker-owned.yml /fixture/cases/worker-owned/config.yml",
  ]);
  register("volume", volume);
  docker(["volume", "create", "--label", `${label}=${id}`, volume]);
  register("container", runtime);
  const notificationFixtures = join(temporary, "notification-fixtures");
  await mkdir(join(notificationFixtures, "node_modules"), { recursive: true });
  await cp(
    join(root, "tests", "fixtures", "notifications.ts"),
    join(notificationFixtures, "fixture.mts"),
  );
  await cp(
    join(root, "tests", "integration", "notifications", "harness.mjs"),
    join(notificationFixtures, "harness.mjs"),
  );
  for (const dependency of ["smtp-server", "punycode.js", "ipv6-normalize"])
    await cp(
      join(root, "node_modules", dependency),
      join(notificationFixtures, "node_modules", dependency),
      { recursive: true },
    );
  await symlink(
    "/opt/orm/app/node_modules/nodemailer",
    join(notificationFixtures, "node_modules", "nodemailer"),
  );
  const mounts = ["config", "skills", "prompts"].flatMap((directory) => [
    "--mount",
    `type=bind,src=${join(fixtures, directory)},dst=/${directory},readonly`,
  ]);
  mounts.push(
    "--mount",
    `type=bind,src=${notificationFixtures},dst=/notification-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(root, "tests", "fixtures", "runtime")},dst=/runtime-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(root, "tests", "integration", "agents")},dst=/agent-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(root, "tests", "integration", "bootstrap")},dst=/bootstrap-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(root, "tests", "integration", "publication")},dst=/publication-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(root, "tests", "integration", "mcp-writes")},dst=/mcp-write-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(root, "tests", "integration", "investigation")},dst=/investigation-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(root, "tests", "fixtures", "publication.ts")},dst=/publication-fixture.ts,readonly`,
  );
  const connection = [
    "--network",
    network,
    "--mount",
    `type=bind,src=${join(upstream, "ca.pem")},dst=/fixture-ca.pem,readonly`,
    "--mount",
    `type=bind,src=${join(upstream, "key.pem")},dst=/fixture-key.pem,readonly`,
    "--env",
    "NODE_EXTRA_CA_CERTS=/fixture-ca.pem",
  ];
  for (const test of [
    ...cases,
    { name: "missing", expected: 1, code: "config_unreadable" },
    { name: "linked", expected: 1, code: "config_unreadable" },
  ]) {
    const name = `${id}-startup-${test.name}`;
    register("container", name);
    docker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `${label}=${id}`,
      ...connection,
      "--mount",
      `type=bind,src=${join(fixtures, "cases", test.name)},dst=/config,readonly`,
      ...["skills", "prompts"].flatMap((directory) => [
        "--mount",
        `type=bind,src=${join(fixtures, directory)},dst=/${directory},readonly`,
      ]),
      image,
    ]);
    if (test.expected === 0) {
      await waitForHealth(name);
      stopCleanly(name);
    } else {
      assert.equal(
        docker(["container", "wait", name]),
        "1",
        `Startup scenario ${test.name} did not reject its configuration`,
      );
    }
    const output = logs(name);
    assert(
      !output.includes(canary),
      `Startup scenario ${test.name} disclosed credentials`,
    );
    assert(!output.includes("parser-secret-canary"));
    if (test.code) {
      assert(
        output.includes(test.code),
        `Startup scenario ${test.name} omitted its safe error code`,
      );
      assert(!output.includes("HTTP listening"));
    }
  }
  for (const arguments_ of [
    ["config", "validate"],
    ["serve"],
    ["pause"],
    ["--config", "/secret-canary/config.yml"],
  ]) {
    const name = `${id}-removed-command-${randomUUID()}`;
    register("container", name);
    const command = result([
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      `${label}=${id}`,
      ...mounts,
      image,
      ...arguments_,
    ]);
    assert.equal(command.status, 1);
    assert(command.stderr.includes("arguments_invalid"));
    assert(!command.stderr.includes("secret-canary"));
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
    ...connection,
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
  assert.notEqual(
    result(["exec", runtime, "orm", "config", "validate"]).status,
    0,
  );
  await waitUntil(
    () =>
      databaseState().cursor.page === 2 && databaseState().jobs.length === 1,
    "Backfill did not persist its first page",
  );
  const beforeCrash = databaseState();
  docker(["container", "kill", "--signal", "KILL", runtime]);
  assert.equal(inspectRuntime().State.Running, false);
  upstreamState.hold_page = 0;
  await saveUpstream();
  docker(["container", "start", runtime]);
  await waitForHealth();
  await waitUntil(
    () => request("/readyz").body.intake.state === "ready",
    "Backfill did not recover after restart",
  );
  const recovered = databaseState();
  assert.equal(recovered.cursor.page, 1);
  assert.deepEqual(
    recovered.jobs.map((job) => job.issue_number),
    [1, 101],
  );
  assert.equal(recovered.jobs[0].id, beforeCrash.jobs[0].id);
  assert.equal(
    recovered.jobs[0].snapshot_digest,
    beforeCrash.jobs[0].snapshot_digest,
  );
  assert(recovered.jobs.every((job) => job.status === "pending"));
  const delivery = randomUUID();
  const issuePayload = {
    repository: { id: 42 },
    issue: { id: 1001, number: 1 },
  };
  assert.equal(webhook(issuePayload, "issues", delivery).status, 202);
  assert.equal(webhook(issuePayload, "issues", delivery).status, 202);
  assert.equal(
    webhook({ ...issuePayload, repository: { id: 99 } }).status,
    403,
  );
  assert.equal(
    webhook(issuePayload, "issues", randomUUID(), false).status,
    401,
  );
  await waitUntil(
    () =>
      databaseState().inbox.filter((row) => row.delivery_id === delivery)
        .length === 1,
    "Delivery was not persisted",
  );
  assert.equal(databaseState().jobs.length, 2);
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
  assert.equal(ready.body.status, "not_ready");
  assert.equal(ready.body.reason, "automation_not_implemented");
  assert.equal(ready.body.intake.state, "ready");
  assert(
    !logs(runtime).includes(canary),
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
    const deniedDatabase = result([
      "exec",
      "--user",
      user,
      runtime,
      "cat",
      "/data/state/manager.sqlite",
    ]);
    assert.notEqual(deniedDatabase.status, 0);
    assert(deniedDatabase.stderr.includes("Permission denied"));
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

  const runtimeProof = JSON.parse(
    docker(
      [
        "exec",
        runtime,
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        "import {runRuntimeTests} from '/runtime-fixtures/harness.mjs'; await runRuntimeTests();",
      ],
      { timeout: 600_000 },
    ),
  );
  assert.equal(runtimeProof.runtime, "passed");
  assert.equal(runtimeProof.cleanup, "passed");
  assert.equal(runtimeProof.mcp_gateway?.protocol, "streamable_http");
  assert.equal(runtimeProof.mcp_gateway?.cleanup, "passed");
  assert.equal(runtimeProof.claude_sdk?.sdk, "0.3.296");
  assert.equal(runtimeProof.claude_sdk?.cleanup, "passed");
  assert.equal(runtimeProof.codex_sdk?.sdk, "0.162.1");
  assert.equal(runtimeProof.codex_sdk?.protocol, "responses_http_sse");
  assert.equal(runtimeProof.codex_sdk?.cleanup, "passed");

  const publicationProof = JSON.parse(
    docker(
      [
        "exec",
        runtime,
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        "import {runPublicationTests} from '/publication-fixtures/harness.mjs'; console.log(JSON.stringify(await runPublicationTests()));",
      ],
      { timeout: 600_000 },
    ),
  );
  assert.equal(publicationProof.publication, "passed");
  assert.equal(publicationProof.cleanup, "passed");

  const mcpWriteProof = JSON.parse(
    docker(
      [
        "exec",
        runtime,
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        "import {runMcpWriteTests} from '/mcp-write-fixtures/harness.mjs'; console.log(JSON.stringify(await runMcpWriteTests()));",
      ],
      { timeout: 900_000 },
    ),
  );
  assert.equal(mcpWriteProof.mcp_writes, "passed");
  assert.equal(mcpWriteProof.cleanup, "passed");
  assert.equal(request("/readyz").body.mcp_writes.uncertain, 0);

  const notificationProof = JSON.parse(
    docker(
      [
        "exec",
        runtime,
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        "import {runNotificationTests} from '/notification-fixtures/harness.mjs'; console.log(JSON.stringify(await runNotificationTests()));",
      ],
      { timeout: 120000 },
    ),
  );
  assert.equal(notificationProof.notifications, "passed");
  assert.equal(notificationProof.cleanup, "passed");
  assert.equal(request("/readyz").body.notifications.state, "running");

  const investigationProof = JSON.parse(
    docker(
      [
        "exec",
        runtime,
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        "import {runInvestigationTests} from '/investigation-fixtures/harness.mjs'; console.log(JSON.stringify(await runInvestigationTests()));",
      ],
      { timeout: 1200000 },
    ),
  );
  assert.equal(investigationProof.investigation, "passed");
  assert.equal(investigationProof.cleanup, "passed");

  const investigationStartupProof = [];
  for (const sdk of ["codex", "claude"]) {
    const prefix = `${id}-investigation-${sdk}`,
      data = `${prefix}-data`,
      net = `${prefix}-network`,
      upstreamName = `${prefix}-upstream`,
      manager = `${prefix}-manager`;
    const directory = join(fixtures, "investigations", sdk);
    await mkdir(join(directory, "config"), { recursive: true });
    for (const name of ["skills", "prompts"])
      await cp(join(fixtures, name), join(directory, name), {
        recursive: true,
      });
    const prompts = join(directory, "prompts");
    for (const name of ["system.md", "user.md", "investigation.md"])
      await writeFile(
        join(prompts, name),
        (await readFile(join(prompts, name), "utf8")) +
          `\n${name === "system.md" ? "OPERATOR_SYSTEM_CANARY" : "OPERATOR_USER_CANARY"}\n`,
      );
    const skill = join(directory, "skills", "example", "SKILL.md");
    await writeFile(
      skill,
      (await readFile(skill, "utf8")) + "\nOPERATOR_SKILL_CANARY\n",
    );
    const config = globalThis.structuredClone(validConfig);
    config.proxy.url = "http://investigation-fixture:8317/v1";
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
    config.mcp = { credentials: {}, servers: {} };
    config.notifications = {
      discord: { enabled: false },
      smtp: { enabled: false },
      webhook: {
        enabled: true,
        url: "http://investigation-fixture:8317/notify",
        headers: {},
      },
    };
    await writeFile(
      join(directory, "config", "config.yml"),
      stringifyYaml(config),
    );
    await writeFile(
      join(directory, "configuration.json"),
      JSON.stringify(config),
    );
    const caBundle = docker([
      "run",
      "--rm",
      "--name",
      setup,
      "--label",
      `${label}=${id}`,
      "--entrypoint",
      "/bin/cat",
      image,
      "/etc/ssl/certs/ca-certificates.crt",
    ]);
    await writeFile(
      join(directory, "ca-bundle.pem"),
      caBundle + "\n" + (await readFile(join(upstream, "ca.pem"), "utf8")),
    );
    docker([
      "run",
      "--rm",
      "--name",
      setup,
      "--label",
      `${label}=${id}`,
      "--mount",
      `type=bind,src=${directory},dst=/fixture`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      "chown -R 0:0 /fixture && chmod 700 /fixture/config && chmod 600 /fixture/config/config.yml",
    ]);
    register("network", net);
    docker(["network", "create", "--label", `${label}=${id}`, net]);
    register("volume", data);
    docker(["volume", "create", "--label", `${label}=${id}`, data]);
    register("container", upstreamName);
    docker([
      "run",
      "--detach",
      "--name",
      upstreamName,
      "--label",
      `${label}=${id}`,
      "--network",
      net,
      "--network-alias",
      "api.github.com",
      "--network-alias",
      "github.com",
      "--network-alias",
      "investigation-fixture",
      "--mount",
      `type=volume,src=${data},dst=/data,readonly`,
      "--mount",
      `type=bind,src=${directory},dst=/fixture`,
      "--mount",
      `type=bind,src=${join(upstream, "key.pem")},dst=/fixture-key.pem,readonly`,
      "--mount",
      `type=bind,src=${join(upstream, "ca.pem")},dst=/fixture-ca.pem,readonly`,
      ...mounts,
      "--entrypoint",
      "/opt/orm-runtime/bin/node",
      image,
      "/investigation-fixtures/server.mjs",
    ]);
    await waitUntil(
      () =>
        result([
          "exec",
          upstreamName,
          "/opt/orm-runtime/bin/node",
          "-e",
          "fetch('http://localhost:8317/proof').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
        ]).status === 0,
      "Investigation upstream fixture did not start",
    );
    register("container", manager);
    docker([
      "run",
      "--detach",
      "--name",
      manager,
      "--label",
      `${label}=${id}`,
      "--network",
      net,
      "--mount",
      `type=volume,src=${data},dst=/data`,
      "--mount",
      `type=bind,src=${join(directory, "ca-bundle.pem")},dst=/etc/ssl/certs/ca-certificates.crt,readonly`,
      "--env",
      "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
      ...["config", "skills", "prompts"].flatMap((name) => [
        "--mount",
        `type=bind,src=${join(directory, name)},dst=/${name},readonly`,
      ]),
      image,
    ]);
    await waitForHealth(manager);
    await waitUntil(
      () =>
        request("/readyz", {}, manager).body.investigation
          .implementation_queued === 1,
      "Production entrypoint did not automatically investigate a backfilled issue",
      180000,
    );
    docker([
      "exec",
      manager,
      "/opt/orm-runtime/bin/node",
      "--input-type=module",
      "-e",
      `
      import {readFileSync} from 'node:fs'; import {createHmac} from 'node:crypto'; import {parse} from '/opt/orm/app/node_modules/yaml/dist/index.js';
      await fetch('http://investigation-fixture:8317/new',{method:'POST'});
      const config=parse(readFileSync('/config/config.yml','utf8'));
      const body=JSON.stringify({repository:{id:42},issue:{id:1002,number:2}});
      const response=await fetch('http://localhost:8080/webhooks/github',{method:'POST',body,headers:{'content-type':'application/json','x-github-delivery':'investigation-new-issue','x-github-event':'issues','x-hub-signature-256':'sha256='+createHmac('sha256',config.github.webhook_secret).update(body).digest('hex')}});
      if(response.status!==202)throw Error('webhook rejected');
    `,
    ]);
    await waitUntil(
      () =>
        JSON.parse(
          docker([
            "exec",
            manager,
            "/opt/orm-runtime/bin/node",
            "-e",
            "fetch('http://investigation-fixture:8317/proof').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))",
          ]),
        ).comments.some(
          ([number, comments]) =>
            number === 2 &&
            comments[0]?.body.includes("Feature request investigated"),
        ),
      "Production webhook did not trigger investigation",
      180000,
    );
    const evidence = JSON.parse(
      docker([
        "exec",
        manager,
        "/opt/orm-runtime/bin/node",
        "-e",
        "fetch('http://investigation-fixture:8317/proof').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))",
      ]),
    );
    assert.equal(evidence.errors.length, 0, JSON.stringify(evidence.errors));
    assert.equal(evidence.comments.length, 2);
    assert(evidence.comments.every(([, comments]) => comments.length === 1));
    assert(
      evidence.requests.includes("investigation_plan") &&
        evidence.requests.includes("investigation_result") &&
        evidence.requests.includes("external_output_review"),
    );
    assert.equal(request("/readyz", {}, manager).status, 503);
    stopCleanly(manager);
    investigationStartupProof.push({
      sdk,
      production_entrypoint_backfill_and_webhook: "passed",
      one_comment_per_issue: "passed",
    });
  }

  register("volume", bootstrapVolume);
  docker(["volume", "create", "--label", `${label}=${id}`, bootstrapVolume]);
  register("container", bootstrapContainer);
  docker([
    "run",
    "--detach",
    "--name",
    bootstrapContainer,
    "--label",
    `${label}=${id}`,
    "--platform",
    platform,
    "--mount",
    `type=volume,src=${bootstrapVolume},dst=/data`,
    ...mounts,
    image,
  ]);
  await waitForHealth(bootstrapContainer);
  const bootstrapProof = JSON.parse(
    docker(
      [
        "exec",
        bootstrapContainer,
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        "import {runBootstrapTests} from '/bootstrap-fixtures/harness.mjs'; console.log(JSON.stringify(await runBootstrapTests()));",
      ],
      { timeout: 2_400_000 },
    ),
  );
  assert.equal(bootstrapProof.bootstrap, "passed");
  assert.equal(bootstrapProof.cleanup, "passed");
  assert.equal(
    request("/readyz", {}, bootstrapContainer).body.reason,
    "automation_not_implemented",
  );
  stopCleanly(bootstrapContainer);

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
    protected_configuration_and_service_startup: "passed",
    webhook_intake_and_crash_recovery: "passed",
    immutable_secret_free_snapshots: "passed",
    supervised_workers: runtimeProof,
    reviewed_publication: publicationProof,
    selective_mcp_writes: mcpWriteProof,
    issue_investigation: investigationProof,
    investigation_startup: investigationStartupProof,
    durable_notifications: notificationProof,
    repository_bootstrap: bootstrapProof,
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
        `type=bind,src=${fixtures},dst=/fixture`,
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        `find /fixture/config /fixture/cases /fixture/investigations -exec chown -h ${process.getuid()}:${process.getgid()} {} + && chmod 700 /fixture/config /fixture/cases /fixture/cases/*`,
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
        (["volume", "network"].includes(type)
          ? object.Labels
          : object.Config.Labels)?.[label],
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
