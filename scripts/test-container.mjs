import { runActionsTests } from "../tests/integration/actions/harness.mjs";
import assert from "node:assert/strict";
import { waitForContainer } from "./container-wait.mjs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { cpus, freemem, totalmem, tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { githubFixtureState, makeIssue } from "../tests/fixtures/github.ts";
import {
  selectContainerSuites,
  implementationScenarios,
  implementationSdks,
  verifyImplementationReceipts,
  runActionsChains,
  verifyActionsReceipts,
  selectActionsCpuSet,
} from "./container-suites.mjs";

const {
  platform,
  suites,
  actionsConcurrency = 4,
  actionsSdk,
  actionsGroup,
} = selectContainerSuites(process.argv.slice(2));
const root = fileURLToPath(new URL("../", import.meta.url));
if (suites.length > 1) {
  for (const suite of suites) {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--platform",
        platform,
        "--suite",
        suite,
      ],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    if (child.error) throw child.error;
    assert.equal(child.status, 0, `Container suite ${suite} failed`);
  }
  process.exit(0);
}
const [suite] = suites;
async function sourceInputDigest() {
  const hash = createHash("sha256");
  async function visit(path) {
    const info = await lstat(path);
    assert(!info.isSymbolicLink(), "Test source must not contain symlinks");
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await visit(join(path, name));
    } else {
      assert(info.isFile(), "Unsupported test input");
      hash
        .update(relative(root, path))
        .update("\0")
        .update(await readFile(path))
        .update("\0");
    }
  }
  for (const path of [
    "Dockerfile",
    ".dockerignore",
    "package.json",
    "package-lock.json",
    "config.example.yml",
    "tsconfig.json",
    "tsconfig.build.json",
    "src",
    "examples/workflow",
    "tests",
    "scripts",
  ])
    await visit(join(root, path));
  return hash.digest("hex");
}
const inputDigest = await sourceInputDigest();
const sourceSha = execFileSync(
  "git",
  ["--no-optional-locks", "rev-parse", "HEAD"],
  { cwd: root, encoding: "utf8" },
).trim();
const dirtyWorktree =
  execFileSync(
    "git",
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  ).trim() !== "";
const prHeadSha = process.env.TEST_PR_HEAD_SHA || null;
assert(
  prHeadSha === null || /^[a-f0-9]{40}$/.test(prHeadSha),
  "Invalid PR head SHA",
);

const timings = [];
let activePhase;
function phase(name) {
  const now = performance.now();
  if (activePhase)
    timings.push({
      phase: activePhase.name,
      started_at: activePhase.started_at,
      duration_ms: now - activePhase.start,
    });
  activePhase = name
    ? { name, start: now, started_at: new Date().toISOString() }
    : undefined;
  if (name) console.log(`[${suite}] ${name}`);
}
phase("setup");
const temporary = await mkdtemp(
  join(process.env.ORM_TEST_TEMP_PARENT ?? tmpdir(), "orm-container-"),
);
const context = join(temporary, "context");
const config = join(temporary, "docker-client");
const fixtures = join(temporary, "fixtures");
const testInputs = join(temporary, "test-inputs");
const reusedImage = process.env.ORM_TEST_IMAGE;
const imageOwner = reusedImage ? process.env.ORM_TEST_IMAGE_OWNER : undefined;
assert(
  !reusedImage ||
    (actionsSdk &&
      actionsGroup &&
      /^orm-test-[a-f0-9-]{36}$/.test(imageOwner ?? "") &&
      /^sha256:[a-f0-9]{64}$/.test(process.env.ORM_TEST_IMAGE_ID ?? "")),
  "Invalid parent image receipt",
);
const id = reusedImage
  ? `${imageOwner}-lane-${actionsSdk}-${actionsGroup}`
  : `orm-test-${randomUUID()}`;
const label = "org.opensource-repo-manager.test-run";
const image = reusedImage ?? `${id}:app`;
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
let runtimeProof,
  publicationProof,
  mcpWriteProof,
  notificationProof,
  investigationProof,
  implementationProof,
  bootstrapProof;
const investigationStartupProof = [];
const actionsProof = [];
const actionsLaneReceipts = [];
const laneOwners = [];
let protectedFixtures = false;
let actionsCpuSet;

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

function register(type, name, owner = id) {
  resources.push({ type, name, owner });
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
  throw new Error(typeof message === "function" ? message() : message);
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
  await mkdir(join(context, "examples"));
  await cp(join(root, "tests"), join(testInputs, "tests"), { recursive: true });
  await cp(
    join(root, "scripts", "container-suites.mjs"),
    join(testInputs, "container-suites.mjs"),
  );
  for (const file of [
    "Dockerfile",
    ".dockerignore",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "src",
    "examples/workflow",
  ]) {
    await cp(join(root, file), join(context, file), { recursive: true });
  }
  for (const directory of [
    ".codex",
    "config",
    "data",
    "workspaces",
    "examples/actions",
  ]) {
    await mkdir(join(context, directory));
    await writeFile(join(context, directory, "secret-canary"), canary);
  }
  await writeFile(join(context, ".env"), canary);
  const probeDockerfile = join(temporary, "context-probe.Dockerfile");
  await writeFile(probeDockerfile, "FROM scratch\nCOPY . /\n");

  phase("context-exclusion");
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

  if (reusedImage) {
    phase("image-reuse");
    const [parentImage] = JSON.parse(docker(["image", "inspect", image]));
    assert.equal(parentImage.Id, process.env.ORM_TEST_IMAGE_ID);
    assert.equal(parentImage.Config.Labels?.[label], imageOwner);
    assert.equal(parentImage.Config.Labels?.[`${label}.inputs`], inputDigest);
    assert.equal(parentImage.Config.Labels?.[`${label}.source`], sourceSha);
  } else {
    phase("image-build");
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
        "--label",
        `${label}.inputs=${inputDigest}`,
        "--label",
        `${label}.source=${sourceSha}`,
        "--tag",
        image,
        "--file",
        join(context, "Dockerfile"),
        context,
      ],
      { inherit: true, timeout: 1_200_000 },
    );
  }

  phase("production-startup");
  await mkdir(join(fixtures, "investigations"), { recursive: true });
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
      "subjectAltName=DNS:api.github.com,DNS:github.com,DNS:localhost,DNS:results-receiver.actions.githubusercontent.com",
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
    `type=bind,src=${join(testInputs, "container-suites.mjs")},dst=/container-suites.mjs,readonly`,
    "--mount",
    `type=bind,src=${notificationFixtures},dst=/notification-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(testInputs, "tests", "fixtures", "runtime")},dst=/runtime-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(testInputs, "tests", "integration", "agents")},dst=/agent-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(testInputs, "tests", "integration", "bootstrap")},dst=/bootstrap-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(testInputs, "tests", "integration", "publication")},dst=/publication-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(testInputs, "tests", "integration", "mcp-writes")},dst=/mcp-write-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(testInputs, "tests", "integration", "investigation")},dst=/investigation-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(testInputs, "tests", "integration", "actions")},dst=/actions-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(testInputs, "tests", "integration", "implementation")},dst=/implementation-fixtures,readonly`,
    "--mount",
    `type=bind,src=${join(testInputs, "tests", "fixtures", "publication.ts")},dst=/publication-fixture.ts,readonly`,
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
  if (!reusedImage) {
    for (const mode of ["exited", "timeout", "sampler-failure"]) {
      const name = `${id}-wait-${mode}`;
      register("container", name);
      docker([
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        `${label}=${id}`,
        "--network",
        "none",
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        mode === "exited" ? "exit 7" : "sleep 30",
      ]);
      const boundary = ["--config", config, "--host", daemon];
      if (mode === "exited") {
        assert.equal(docker(["container", "wait", name]), "7");
        assert.equal(await waitForContainer(boundary, name), 7);
      } else {
        const options =
          mode === "timeout"
            ? { timeout: 50 }
            : {
                sample: () => {
                  throw new Error("resource sampler failed");
                },
              };
        await assert.rejects(
          waitForContainer(boundary, name, options),
          mode === "timeout"
            ? /did not exit within 50ms/
            : /resource sampler failed/,
        );
        docker(["container", "kill", name]);
      }
    }
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
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, "ready");
  assert.equal(ready.body.reason, null);
  assert.equal(ready.body.implementation.runtime.state, "ready");
  assert.equal(ready.body.pr_monitor.state, "running");
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

  if (suite === "core") {
    console.log("Verifying supervised runtime workers");
    phase("supervised-workers");
    runtimeProof = JSON.parse(
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

    console.log("Verifying reviewed GitHub publication");
    phase("publication");
    publicationProof = JSON.parse(
      docker(
        [
          "exec",
          runtime,
          "/opt/orm-runtime/bin/node",
          "--input-type=module",
          "-e",
          "import {runPublicationTests} from '/publication-fixtures/harness.mjs'; console.log(JSON.stringify(await runPublicationTests()));",
        ],
        { timeout: 1_200_000 },
      ),
    );
    assert.equal(publicationProof.publication, "passed");
    assert.equal(publicationProof.cleanup, "passed");

    console.log("Verifying scoped MCP writes");
    phase("mcp-writes");
    mcpWriteProof = JSON.parse(
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

    console.log("Verifying durable notifications");
    phase("notifications");
    notificationProof = JSON.parse(
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
  }
  if (suite === "investigation") {
    console.log("Verifying issue investigation");
    phase("investigation");
    investigationProof = JSON.parse(
      docker(
        [
          "exec",
          runtime,
          "/opt/orm-runtime/bin/node",
          "--input-type=module",
          "-e",
          "import {runInvestigationTests} from '/investigation-fixtures/harness.mjs'; console.log(JSON.stringify(await runInvestigationTests()));",
        ],
        { timeout: 2400000 },
      ),
    );
    assert.equal(investigationProof.investigation, "passed");
    assert.equal(investigationProof.cleanup, "passed");
  }
  if (Object.hasOwn(implementationScenarios, suite)) {
    console.log("Verifying maintenance implementation through both SDKs");
    phase("implementation");
    const implementationContainers = implementationSdks.map((sdk) => {
      const started = performance.now();
      const started_at = new Date().toISOString();
      const name = `${id}-implementation-${sdk}`,
        data = `${name}-data`;
      register("volume", data);
      docker(["volume", "create", "--label", `${label}=${id}`, data]);
      register("container", name);
      docker([
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        `${label}=${id}`,
        "--platform",
        platform,
        "--mount",
        `type=volume,src=${data},dst=/data`,
        ...mounts,
        "--entrypoint",
        "/usr/bin/tini",
        image,
        "--",
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        `import {runImplementationTests} from '/implementation-fixtures/harness.mjs'; console.log(JSON.stringify(await runImplementationTests([${JSON.stringify(sdk)}], ${JSON.stringify(suite)})));`,
      ]);
      return { sdk, name, started, started_at };
    });
    const finishedSdks = new Set();
    const implementationDeadline = Date.now() + 120 * 60000;
    for (;;) {
      const states = JSON.parse(
        docker([
          "container",
          "inspect",
          ...implementationContainers.map(({ name }) => name),
        ]),
      );
      for (const state of states) {
        assert.equal(state.Config.Labels[label], id);
        assert(["", "private"].includes(state.HostConfig.PidMode));
        const execution = implementationContainers.find(
          ({ name }) => state.Name === `/${name}`,
        );
        if (!state.State.Running && !finishedSdks.has(execution.sdk)) {
          timings.push({
            phase: `implementation-${execution.sdk}`,
            started_at: execution.started_at,
            duration_ms: performance.now() - execution.started,
          });
          finishedSdks.add(execution.sdk);
        }
        if (!state.State.Running && state.State.ExitCode !== 0)
          assert.fail(`${state.Name.slice(1)}: ${logs(state.Name.slice(1))}`);
      }
      if (states.every((state) => !state.State.Running)) break;
      assert(
        Date.now() < implementationDeadline,
        "Maintenance SDK tests timed out",
      );
      await delay(1000);
    }
    const implementationReceipts = implementationContainers.map(
      ({ sdk, name }) => {
        const output = result(["container", "logs", name]);
        assert.equal(output.status, 0, output.stderr);
        const proof = JSON.parse(output.stdout);
        assert.equal(proof.implementation, "passed");
        assert.equal(proof.cleanup, "passed");
        assert(proof.scenarios.length > 0);
        assert(proof.scenarios.every((scenario) => scenario.sdk === sdk));
        return proof;
      },
    );
    verifyImplementationReceipts(suite, implementationReceipts);
    implementationProof = {
      implementation: "passed",
      receipts: implementationReceipts,
      scenarios: implementationReceipts.flatMap((proof) => proof.scenarios),
      cleanup: "passed",
    };
  }
  if (suite === "actions") {
    const status = docker(["exec", runtime, "cat", "/proc/self/status"]);
    actionsCpuSet = selectActionsCpuSet(
      /^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1],
    );
  }
  if (suite === "actions" && !actionsGroup) {
    phase("actions-pool");
    const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
    await runActionsChains(actionsConcurrency, async ({ sdk, group }) => {
      laneOwners.push(`${id}-lane-${sdk}-${group}`);
      const logPath = join(temporary, `actions-${sdk}-${group}.log`);
      const started = performance.now();
      const startedAt = new Date().toISOString();
      console.log(`[actions] starting ${sdk}/${group}`);
      const childReceipt = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(import.meta.url),
            "--platform",
            platform,
            "--suite",
            "actions",
            "--actions-sdk",
            sdk,
            "--actions-group",
            group,
            "--actions-concurrency",
            "1",
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              ORM_TEST_IMAGE: image,
              ORM_TEST_IMAGE_OWNER: id,
              ORM_TEST_IMAGE_ID: imageId,
              ORM_TEST_TEMP_PARENT: temporary,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (bytes) => {
          stdout += bytes;
        });
        child.stderr.on("data", (bytes) => {
          stderr += bytes;
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
          void writeFile(logPath, stdout + stderr).then(() => {
            if (code !== 0)
              return reject(
                new Error(
                  `${sdk}/${group} exited ${code ?? signal}: ${stdout.slice(-4000)}${stderr.slice(-8000)}`,
                ),
              );
            try {
              resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
            } catch (error) {
              reject(error);
            }
          }, reject);
        });
      });
      actionsLaneReceipts.push(childReceipt);
      timings.push({
        phase: `actions-${sdk}-${group}`,
        started_at: startedAt,
        duration_ms: performance.now() - started,
      });
      console.log(`[actions] completed ${sdk}/${group}`);
    });
    verifyActionsReceipts(actionsLaneReceipts, {
      source_sha: sourceSha,
      pr_head_sha: prHeadSha,
      platform,
      image_id: imageId,
      input_digest: inputDigest,
      dirty_worktree: dirtyWorktree,
      actions_cpu_set: actionsCpuSet,
    });
    actionsProof.push(
      ...actionsLaneReceipts.flatMap((row) => row.bounded_actions),
    );
  }
  if (suite === "investigation" || (suite === "actions" && actionsGroup)) {
    for (const sdk of actionsSdk ? [actionsSdk] : ["codex", "claude"]) {
      phase(`production-startup-${sdk}`);
      console.log(`Verifying production startup through ${sdk}`);
      const prefix = `${id}-investigation-${sdk}`,
        data = `${prefix}-data`,
        freshData = `${prefix}-fresh-data`,
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
      if (suite === "actions") {
        await cp(prompts, join(directory, "prompts-incompatible"), {
          recursive: true,
        });
        await appendFile(
          join(directory, "prompts-incompatible", "user.md"),
          "\nChanged protected prompt snapshot.\n",
        );
      }
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
      config.notifications = {
        discord: {
          enabled: true,
          webhook_url: "http://investigation-fixture:8317/discord",
        },
        smtp: {
          enabled: true,
          host: "api.github.com",
          port: 8465,
          secure: true,
          username: "fixture-smtp-user",
          password: "fixture-smtp-password",
          from: "manager@example.invalid",
          to: ["first@example.invalid"],
        },
        webhook: {
          enabled: true,
          url: "http://investigation-fixture:8317/notify",
          headers: {},
        },
      };
      const configName = suite === "actions" ? "actions.yml" : "config.yml";
      if (suite === "actions") {
        delete config.github.webhook_secret;
        delete config.notifications;
        delete config.mcp;
        for (const role of Object.values(config.roles)) delete role.mcp;
      }
      await writeFile(
        join(directory, "config", configName),
        stringifyYaml(config),
      );
      await writeFile(
        join(directory, "configuration.json"),
        JSON.stringify({
          ...config,
          ...(suite === "actions"
            ? {
                session_key: randomBytes(32).toString("base64"),
                artifact_tokens: Object.fromEntries(
                  [100, 101].map((run) => [
                    run,
                    `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ scp: `Actions.Results:00000000-0000-4000-8000-${String(run).padStart(12, "0")}:11111111-1111-4111-8111-111111111111` })).toString("base64url")}.fixture-signature`,
                  ]),
                ),
              }
            : {}),
        }),
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
        `chown -R 0:0 /fixture && chmod 700 /fixture/config && chmod 600 /fixture/config/${configName}`,
      ]);
      if (suite === "actions") {
        phase(`actions-toolchain-cache-${sdk}`);
        docker(
          [
            "run",
            "--rm",
            "--name",
            setup,
            "--label",
            `${label}=${id}`,
            "--no-healthcheck",
            "--mount",
            `type=bind,src=${directory},dst=/fixture`,
            ...mounts,
            "--entrypoint",
            "/opt/orm-runtime/bin/node",
            image,
            "/actions-fixtures/toolchain-cache.mjs",
            "prepare",
          ],
          { timeout: 300000 },
        );
        phase(`actions-fixture-startup-${sdk}`);
      }
      register("network", net);
      docker(["network", "create", "--label", `${label}=${id}`, net]);
      register("volume", data);
      docker(["volume", "create", "--label", `${label}=${id}`, data]);
      if (suite === "actions") {
        register("volume", freshData);
        docker(["volume", "create", "--label", `${label}=${id}`, freshData]);
      }
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
        "--network-alias",
        "results-receiver.actions.githubusercontent.com",
        "--mount",
        `type=volume,src=${data},dst=/data,readonly`,
        ...(suite === "actions"
          ? ["--mount", `type=volume,src=${freshData},dst=/fresh-data,readonly`]
          : []),
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
        ...(suite === "actions" ? ["--actions"] : []),
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
      if (suite === "actions") {
        phase(`actions-scenarios-${sdk}-${actionsGroup}`);
        actionsProof.push(
          await runActionsTests({
            sdk,
            group: actionsGroup,
            cpuSet: actionsCpuSet,
            manager,
            upstreamName,
            data,
            freshData,
            directory,
            image,
            net,
            label,
            id,
            docker,
            result,
            register,
            waitUntil,
            waitForContainer: (name, options) =>
              waitForContainer(
                ["--config", config, "--host", daemon],
                name,
                options,
              ),
            sessionFixtures: join(
              testInputs,
              "tests",
              "integration",
              "actions",
            ),
          }),
        );
        continue;
      }
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
          request("/readyz", {}, manager).body.implementation
            .awaiting_remote_validation === 1,
        "Production entrypoint did not automatically implement a backfilled maintenance issue",
        300000,
      );
      await waitUntil(() => {
        const readiness = request("/readyz", {}, manager);
        return (
          readiness.status === 200 && readiness.body.pr_monitor.waiting === 1
        );
      }, "Waiting for PR CI incorrectly made the service unavailable");
      const firstHead = JSON.parse(
        docker([
          "exec",
          manager,
          "/opt/orm-runtime/bin/node",
          "-e",
          "fetch('http://investigation-fixture:8317/proof').then(r=>r.json()).then(x=>console.log(JSON.stringify(x.heads[0])))",
        ]),
      );
      docker([
        "exec",
        manager,
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        `
      import {readFileSync} from 'node:fs'; import {createHmac} from 'node:crypto'; import {parse} from '/opt/orm/app/node_modules/yaml/dist/index.js';
      const state=await fetch('http://investigation-fixture:8317/review',{method:'POST'}).then(r=>r.json());
      const config=parse(readFileSync('/config/config.yml','utf8'));
      const body=JSON.stringify({repository:{id:42},pull_request:{id:state.pull_id,number:state.pull_number},review:{id:20000}});
      const response=await fetch('http://localhost:8080/webhooks/github',{method:'POST',body,headers:{'content-type':'application/json','x-github-delivery':'monitor-review-feedback','x-github-event':'pull_request_review','x-hub-signature-256':'sha256='+createHmac('sha256',config.github.webhook_secret).update(body).digest('hex')}});
      if(response.status!==202)throw Error('review webhook rejected');
    `,
      ]);
      await waitUntil(
        () => {
          const proof = JSON.parse(
            docker([
              "exec",
              manager,
              "/opt/orm-runtime/bin/node",
              "-e",
              "fetch('http://investigation-fixture:8317/proof').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))",
            ]),
          );
          return (
            proof.heads[0].head !== firstHead.head &&
            proof.threads[0]?.[1][0].isResolved
          );
        },
        "Production review feedback did not publish and reconcile the tested repair",
        300000,
      );
      const beforeChecks = JSON.parse(
        docker([
          "exec",
          manager,
          "/opt/orm-runtime/bin/node",
          "-e",
          "fetch('http://investigation-fixture:8317/proof').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))",
        ]),
      );
      assert(
        !beforeChecks.notifications.some(
          (event) => event.outcome === "ready_for_review",
        ),
      );
      assert(
        beforeChecks.monitors.some(
          (record) => record.expected_head !== firstHead.head,
        ),
      );
      stopCleanly(manager);
      docker(["container", "start", manager]);
      await waitForHealth(manager);
      docker([
        "exec",
        manager,
        "/opt/orm-runtime/bin/node",
        "--input-type=module",
        "-e",
        `
      import {readFileSync} from 'node:fs'; import {createHmac} from 'node:crypto'; import {parse} from '/opt/orm/app/node_modules/yaml/dist/index.js';
      const state=await fetch('http://investigation-fixture:8317/checks',{method:'POST'}).then(r=>r.json());
      const config=parse(readFileSync('/config/config.yml','utf8'));
      const body=JSON.stringify({repository:{id:42},check_run:{head_sha:state.head,pull_requests:[{id:state.pull_id,number:state.pull_number}]}});
      const response=await fetch('http://localhost:8080/webhooks/github',{method:'POST',body,headers:{'content-type':'application/json','x-github-delivery':'monitor-new-head-checks','x-github-event':'check_run','x-hub-signature-256':'sha256='+createHmac('sha256',config.github.webhook_secret).update(body).digest('hex')}});
      if(response.status!==202)throw Error('check webhook rejected');
    `,
      ]);
      let notificationProof;
      await waitUntil(
        () => {
          const proof = JSON.parse(
            docker([
              "exec",
              manager,
              "/opt/orm-runtime/bin/node",
              "-e",
              "fetch('http://investigation-fixture:8317/proof').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))",
            ]),
          );
          notificationProof = {
            workflow: proof.workflow,
            runs: proof.runs.slice(-8),
            requests: proof.requests.slice(-8),
            deliveries: proof.deliveries,
            counts: {
              webhook: proof.notifications.length,
              discord: proof.discord.length,
              smtp: proof.smtp.length,
            },
          };
          return (
            proof.notifications.some(
              (event) => event.outcome === "ready_for_review",
            ) &&
            proof.discord.some((event) =>
              event.content.includes("ready for human review"),
            ) &&
            proof.smtp.some((event) =>
              event.raw.includes("ready for human review"),
            )
          );
        },
        () =>
          `Production pipeline did not deliver all ready notification channels: ${JSON.stringify(notificationProof)}`,
        120000,
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
      assert.equal(evidence.pulls.length, 1);
      assert.equal(evidence.pulls[0].draft, false);
      assert(evidence.comments.every(([, comments]) => comments.length === 1));
      assert(
        evidence.requests.includes("investigation_plan") &&
          evidence.requests.includes("investigation_result") &&
          evidence.requests.includes("external_output_review") &&
          evidence.requests.includes("implementation_change") &&
          evidence.requests.includes("implementation_audit"),
      );
      assert.equal(request("/readyz", {}, manager).status, 200);
      assert.equal(
        evidence.notifications.filter(
          (event) => event.outcome === "ready_for_review",
        ).length,
        1,
      );
      assert.equal(
        evidence.notifications.find(
          (event) => event.outcome === "ready_for_review",
        ).pull.head_sha,
        evidence.heads[0].head,
      );
      assert.equal(
        evidence.mutations.filter((kind) => kind === "branch").length,
        2,
      );
      stopCleanly(manager);
      investigationStartupProof.push({
        sdk,
        production_entrypoint_backfill_and_webhook: "passed",
        one_comment_per_issue: "passed",
        reviewed_repair_and_new_head_gates: "passed",
        readiness_notifications_all_channels: "passed",
        restart_while_waiting: "passed",
      });
    }
  }
  if (suite === "bootstrap") {
    console.log("Verifying repository bootstrap");
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
    phase("bootstrap");
    bootstrapProof = JSON.parse(
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
      "service_unavailable",
    );
    stopCleanly(bootstrapContainer);
  }
  phase("shutdown-and-persistence");
  console.log("Verifying shutdown and persistence");
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
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  assert.equal(
    await sourceInputDigest(),
    inputDigest,
    "Source changed during container verification",
  );
  receipt = {
    suite,
    platform,
    pr_head_sha: prHeadSha,
    dirty_worktree: dirtyWorktree,
    source_sha: sourceSha,
    image_id: imageId,
    input_digest: inputDigest,
    actions_cpu_set: actionsCpuSet,
    runner_resources: {
      cpus: cpus().length,
      memory_total_bytes: totalmem(),
      memory_available_bytes: freemem(),
    },
    http: "passed",
    users_and_mounts: "passed",
    context_exclusion: "passed",
    shutdown_and_persistence: "passed",
    protected_configuration_and_service_startup: reusedImage
      ? "parent-image-verified"
      : "passed",
    webhook_intake_and_crash_recovery: "passed",
    immutable_secret_free_snapshots: "passed",
    supervised_workers: runtimeProof,
    reviewed_publication: publicationProof,
    selective_mcp_writes: mcpWriteProof,
    issue_investigation: investigationProof,
    maintenance_implementation: implementationProof,
    investigation_startup:
      suite === "investigation" ? investigationStartupProof : undefined,
    bounded_actions: suite === "actions" ? actionsProof : undefined,
    actions_lane_receipts: actionsLaneReceipts.map((row) => ({
      source_sha: row.source_sha,
      pr_head_sha: row.pr_head_sha,
      image_id: row.image_id,
      input_digest: row.input_digest,
      sdk: row.bounded_actions[0].sdk,
      group: row.bounded_actions[0].group,
      timings: row.timings,
      generic_startup: row.protected_configuration_and_service_startup,
      cleanup: row.cleanup,
      resources_removed: row.resources_removed,
    })),
    durable_notifications: notificationProof,
    repository_bootstrap: bootstrapProof,
  };
} catch (error) {
  failure = error;
} finally {
  phase("cleanup");
  console.log("Cleaning owned test resources");
  for (const owner of laneOwners)
    for (const type of ["image", "network", "volume", "container"]) {
      try {
        const names = docker([
          type,
          "ls",
          ...(type === "container" ? ["--all"] : []),
          "--filter",
          `label=${label}=${owner}`,
          "--format",
          type === "container"
            ? "{{.Names}}"
            : type === "image"
              ? "{{.ID}}"
              : "{{.Name}}",
        ]);
        for (const name of names.split("\n").filter(Boolean))
          register(type, name, owner);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  if (protectedFixtures) {
    try {
      const [inspection] = JSON.parse(docker(["image", "inspect", image]));
      assert.equal(inspection.Config.Labels?.[label], imageOwner ?? id);
      docker([
        "run",
        "--rm",
        "--name",
        setup,
        "--label",
        `${label}=${id}`,
        "--mount",
        `type=bind,src=${temporary},dst=/fixture`,
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        `find /fixture -exec chown -h ${process.getuid()}:${process.getgid()} {} + && find /fixture -type d -exec chmod u+rwx {} +`,
      ]);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const { type, name, owner } of resources.reverse()) {
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
        owner,
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

phase();
if (failure || cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors],
    "Container verification or scoped cleanup failed",
  );
receipt = {
  ...receipt,
  timings,
  cleanup: "passed",
  resources_removed: resources.map(({ type, name }) => ({ type, name })),
};
console.log(JSON.stringify(receipt));
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### ${suite} (${platform})\n\nPR head: ${receipt.pr_head_sha ?? "not applicable"}; tested commit: ${receipt.source_sha}; dirty: ${receipt.dirty_worktree}.\n\nImage: ${receipt.image_id}; cleanup: ${receipt.cleanup}.\n\n| Phase | Seconds |\n| --- | ---: |\n` +
      receipt.timings
        .map(
          (item) =>
            `| ${item.phase} | ${(item.duration_ms / 1000).toFixed(2)} |`,
        )
        .join("\n") +
      "\n\n",
  );
}
