import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";
import {
  sourceProcesses,
  userProcesses,
} from "/opt/orm/app/dist/runtime/process.js";
import {
  loadProtectedConfiguration,
  createRunSnapshot,
} from "/opt/orm/app/dist/config/load.js";
import { separateSecrets } from "/opt/orm/app/dist/config/secrets.js";
import { parseConfiguration } from "/opt/orm/app/dist/config/schema.js";
import { digest } from "/opt/orm/app/dist/domain/agents.js";
import { respond as codex } from "/agent-fixtures/codex.mjs";
import { respond as claude } from "/agent-fixtures/claude.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function files(directory, prefix = "") {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".yarn", ".venv"].includes(entry.name)) continue;
    const name = prefix + entry.name;
    if (entry.isDirectory())
      Object.assign(
        result,
        await files(join(directory, entry.name), name + "/"),
      );
    else result[name] = await readFile(join(directory, entry.name), "utf8");
  }
  return result;
}

export async function runBootstrapTests() {
  const timingStarted = performance.now(),
    timings = [];
  const root = "/data/bootstrap-proof",
    gitRoot = join(root, "git"),
    sourceGit = join(gitRoot, "owner", "repo.git");
  await mkdir(join(gitRoot, "owner"), { recursive: true });
  const git = (argv, input) =>
    execFileSync("/usr/bin/git", argv, {
      input,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  git(["init", "--bare", sourceGit]);
  const object = (type, data) =>
    git(
      ["--git-dir", sourceGit, "hash-object", "-t", type, "-w", "--stdin"],
      data,
    );
  const sourceWith = (files) => {
    const entries = {};
    for (const [path, data] of Object.entries(files)) {
      const parts = path.split("/");
      let directory = entries;
      for (const part of parts.slice(0, -1)) directory = directory[part] ??= {};
      directory[parts.at(-1)] = data;
    }
    const treeFor = (entries) =>
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
                  : treeFor(value),
                "hex",
              ),
            ]),
        ),
      );
    const tree = treeFor(entries),
      author = "Bootstrap fixture <fixture@example.invalid> 1700000000 +0000";
    const sha = object(
      "commit",
      `tree ${tree}\nauthor ${author}\ncommitter ${author}\n\nbootstrap fixture\n`,
    );
    git(["--git-dir", sourceGit, "update-ref", "refs/heads/fixture", sha]);
    return { default_branch: "main", sha, tree_sha: tree };
  };
  const sourceServer = createServer((req, res) => {
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
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      for (const line of pending.subarray(0, end).toString().split("\r\n")) {
        const colon = line.indexOf(":"),
          name = line.slice(0, colon),
          value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status")
          res.statusCode = Number(value.split(" ")[0]);
        else res.setHeader(name, value);
      }
      headers = true;
      res.write(pending.subarray(end + 4));
      pending = Buffer.alloc(0);
    });
    child.stderr.resume();
    child.on("error", () => res.destroy());
    child.on("close", (code) => (code === 0 ? res.end() : res.destroy()));
    child.stdin.on("error", () => res.destroy());
    req.pipe(child.stdin);
  });
  const endpoint = await listen(sourceServer);
  const loaded = await loadProtectedConfiguration(),
    store = new Store(join(root, "state", "manager.sqlite"));
  store.enroll({
    id: 42,
    full_name: "owner/repo",
    default_branch: "main",
    private: false,
  });
  const versions = JSON.parse(
    await readFile("/bootstrap-fixtures/versions.json", "utf8"),
  );
  const proof = [],
    errors = [],
    requests = [],
    histories = new Map();
  let currentPlan,
    currentSdk = "codex",
    rejectAudit = false,
    supervisor,
    fixture;
  const markPhase = (phase) => {
    const timing = {
      sdk: currentSdk,
      phase,
      elapsed_ms: performance.now() - timingStarted,
    };
    timings.push(timing);
    appendFileSync(join(root, "timings.jsonl"), JSON.stringify(timing) + "\n");
  };
  const modelServer = createServer((req, res) =>
    (currentSdk === "codex" ? codex : claude)(req, res, fixture),
  );
  const proxy = (await listen(modelServer)) + "/v1";
  const profiles = {
    codex: { sdk: "codex", model: "gpt-5.5", effort: "xhigh" },
    claude: {
      sdk: "claude",
      model: "auto",
      behaves_as: "claude-opus-4-8",
      effort: "xhigh",
    },
  };
  let number = 5000;
  const seed = (snapshot, source) => {
    store.saveSnapshot(snapshot);
    store.discover([++number], 1, true);
    store.applyIssue(
      store.nextDirty(),
      {
        id: number + 10000,
        number,
        state: "open",
        title: "Bootstrap fixture",
        body: "fixture",
        updated_at: "2026-10-18T00:00:00Z",
        comments: [],
        source,
      },
      snapshot,
    );
    return store.job(number);
  };
  const events = async (stream) => {
    const result = [];
    for await (const event of stream) result.push(event);
    return result;
  };
  const makePlan = (languages, manager) => ({
    version: 1,
    toolchains: languages.map((language) => ({
      language,
      version: versions.toolchains[language],
    })),
    system_packages: languages.includes("go")
      ? ["libsqlite3-dev", "pkg-config"]
      : [],
    package_managers: manager
      ? [
          {
            name: manager.startsWith("yarn") ? "yarn" : manager,
            version: versions.managers[manager],
            cwd: ".",
          },
        ]
      : [],
    setup_commands: [
      ...(languages.includes("go")
        ? [{ cwd: ".", argv: ["go", "mod", "download"] }]
        : []),
      {
        cwd: ".",
        argv: [
          "/bin/sh",
          "-c",
          'test ! -r /config/config.yml && test "$(id -u)" != 0 && test ! -e "$HOME/bootstrap-canary" && printf \'%s\' "$(id -u)" > "$HOME/bootstrap-canary"',
        ],
      },
    ],
    test_commands: [
      {
        cwd: ".",
        argv: languages.includes("go")
          ? ["go", "test", "./..."]
          : languages.includes("node")
            ? ["npm", "test"]
            : ["python", "test.py"],
        execution: "local",
        platform: "linux",
      },
      {
        cwd: ".",
        argv: ["go", "test", "./..."],
        execution: "remote",
        platform: "windows",
      },
    ],
  });
  try {
    for (const sdk of ["claude", "codex"]) {
      currentSdk = sdk;
      markPhase("sdk:start");
      const config = parseConfiguration(
        await readFile("/config/config.yml", "utf8"),
      );
      config.github.repository = "owner/repo";
      config.proxy.url = proxy;
      config.mcp = { ...config.mcp, servers: {}, credentials: {} };
      for (const role of Object.keys(config.roles)) {
        config.profiles[role] = profiles[sdk];
        config.roles[role].profile = role;
        config.roles[role].mcp = {};
      }
      const bundles = globalThis.structuredClone(
        Object.fromEntries(
          Object.entries(loaded.snapshot.roles).map(([role, value]) => [
            role,
            value.bundle,
          ]),
        ),
      );
      for (const bundle of Object.values(bundles)) {
        bundle.system += "\nOPERATOR_SYSTEM_CANARY";
        bundle.user += "\nOPERATOR_USER_CANARY";
        for (const skill of bundle.skills.filter((file) =>
          file.path.endsWith("/SKILL.md"),
        )) {
          const bytes = Buffer.concat([
            Buffer.from(skill.content_base64, "base64"),
            Buffer.from("\nOPERATOR_SKILL_CANARY"),
          ]);
          skill.content_base64 = bytes.toString("base64");
          skill.sha256 = createHash("sha256").update(bytes).digest("hex");
        }
      }
      const { settings, secrets } = separateSecrets(config),
        snapshot = createRunSnapshot(settings, bundles, secrets);
      supervisor = await Supervisor.create(store, snapshot, secrets, {
        root: join(root, "runtime"),
        sourceUrl: () => endpoint + "/owner/repo.git",
        workers: { [sdk]: `/opt/orm/app/dist/adapters/agents/${sdk}.js` },
      });
      fixture = {
        config,
        store,
        root: join(root, "runtime"),
        errors,
        requests,
        histories,
        mcpCredential: "bootstrap-mcp-unused",
        bootstrap(scenario, text) {
          if (scenario === "bootstrap_plan") return currentPlan;
          return {
            approved: !rejectAudit,
            source_digest: /"source_digest":"([a-f0-9]{64})"/.exec(text)[1],
            plan_digest: /"plan_digest":"([a-f0-9]{64})"/.exec(text)[1],
            findings: rejectAudit ? ["fixture rejection"] : [],
          };
        },
      };
      const cases =
        sdk === "codex"
          ? [
              "npm",
              "pnpm",
              "yarn-classic",
              "yarn-modern",
              "pip",
              "poetry",
              "uv",
              "go-cgo",
              "mixed",
            ]
          : ["npm"];
      let lastReceipt;
      const runCase = async (name) => {
        markPhase(`${name}:start`);
        const python = ["pip", "poetry", "uv"].includes(name),
          go = ["go-cgo", "mixed"].includes(name);
        const sourceFiles = await files(
          `/bootstrap-fixtures/projects/${python ? "python-" + name : name === "mixed" ? "npm" : name}`,
        );
        if (sdk === "codex" && name === "npm")
          Object.assign(
            sourceFiles,
            await files("/bootstrap-fixtures/projects/npm-workspace"),
          );
        if (name === "pip")
          Object.assign(
            sourceFiles,
            await files("/bootstrap-fixtures/projects/python-projects"),
          );
        if (name === "mixed")
          Object.assign(
            sourceFiles,
            await files("/bootstrap-fixtures/projects/go-cgo"),
          );
        sourceFiles["mise.toml"] =
          '[hooks]\npostinstall="touch /root/BOOTSTRAP_INJECTION"\n[settings]\nnode.verify=false\n';
        currentPlan = makePlan(
          python
            ? ["python"]
            : go
              ? name === "mixed"
                ? ["go", "node"]
                : ["go"]
              : ["node"],
          go && name !== "mixed" ? undefined : name === "mixed" ? "npm" : name,
        );
        if (name === "pip") {
          currentPlan.toolchains.push({
            language: "node",
            version: versions.toolchains.node,
          });
          currentPlan.package_managers.push({
            name: "pip",
            version: versions.managers.pip,
            cwd: "nested",
          });
          currentPlan.package_managers.push({
            name: "npm",
            version: versions.managers.npm,
            cwd: ".",
          });
          for (const [cwd, version] of [
            [".", "25.0"],
            ["nested", "24.2"],
            ["nested/deep", "24.2"],
            ["nested-other", "25.0"],
          ])
            currentPlan.setup_commands.push({
              cwd,
              argv: [
                "/bin/sh",
                "-c",
                `python -c 'import os, sys, packaging; assert packaging.__version__ == "${version}"; assert sys.prefix == os.environ["VIRTUAL_ENV"]' && test "$(pip --version)" = "$(python3 -m pip --version)"`,
              ],
            });
          for (const [cwd, version] of [
            [".", "25.0"],
            ["nested", "24.2"],
          ]) {
            currentPlan.setup_commands.push({
              cwd,
              argv: [
                "/bin/sh",
                "-c",
                `python ${cwd === "." ? "create-command.py" : "../create-command.py"} && test "$(project-version)" = ${version}`,
              ],
            });
            currentPlan.setup_commands.push({
              cwd,
              argv: ["project-version"],
            });
          }
          currentPlan.setup_commands.push({
            cwd: ".",
            argv: [
              "/bin/sh",
              "-c",
              'test "$(project-version)" = 25.0 && (cd nested/deep && test "$(project-version)" = 24.2) && (cd nested-other && test "$(project-version)" = 25.0) && test "$(cat .lifecycle-ran)" = passed',
            ],
          });
          currentPlan.test_commands.push({
            cwd: "nested",
            argv: ["python", "test.py"],
            execution: "local",
            platform: "linux",
          });
          currentPlan.setup_commands.push({
            cwd: ".",
            argv: [
              "/bin/sh",
              "-c",
              `cd "$HOME" && python -c 'import os, sys; assert sys.prefix == sys.base_prefix; assert "VIRTUAL_ENV" not in os.environ; assert "UV_PROJECT_ENVIRONMENT" not in os.environ'`,
            ],
          });
        }
        if (name === "npm") {
          sourceFiles[".github/workflows/ci.yml"] =
            'on: push\njobs:\n  test:\n    runs-on: ${{ matrix.os }}\n    steps:\n      - uses: actions/setup-node@v7\n        with:\n          node-version: "24.18.0"\n';
          sourceFiles[".yarn/cache/tracked.txt"] =
            "pre-existing dependency-directory source\n";
          currentPlan.setup_commands.push({
            cwd: ".",
            argv: [
              "/bin/sh",
              "-c",
              "printf generated > .yarn/cache/generated.txt",
            ],
          });
        }
        if (python) {
          sourceFiles["cache_probe.py"] = "ok = True\n";
          currentPlan.setup_commands.push({
            cwd: ".",
            argv: [
              "python",
              "-c",
              'from pathlib import Path; import cache_probe; assert cache_probe.ok; assert not Path("__pycache__").exists()',
            ],
          });
        }
        const source = sourceWith(sourceFiles),
          job = seed(snapshot, source),
          request = supervisor.request(job.id, "bootstrap");
        const receipt = await supervisor.bootstrap.prepare(
          request,
          new globalThis.AbortController().signal,
        );
        lastReceipt = receipt;
        assert.equal(receipt.status, "ready");
        assert.equal(receipt.plan_digest, digest(currentPlan));
        assert.equal(receipt.audit.result.approved, true);
        const commandReceipts = store.bootstrapCommands(receipt.id);
        if (python)
          for (const uid of [10001, 10002])
            assert(
              commandReceipts.some(
                (command) =>
                  command.uid === uid &&
                  command.argv[0] === "python" &&
                  command.argv[2]?.includes("import cache_probe") &&
                  command.outcome === "completed",
              ),
            );
        assert(
          commandReceipts.some(
            (command) => command.operation === "environment-files",
          ),
        );
        assert(
          commandReceipts
            .filter((command) => command.operation === "environment-files")
            .every((command) => [10001, 10002].includes(command.uid)),
        );
        assert(
          commandReceipts.some(
            (command) =>
              command.operation === "project-setup" && command.uid === 10001,
          ),
        );
        assert(
          commandReceipts.some(
            (command) =>
              command.operation === "project-setup" && command.uid === 10002,
          ),
        );
        assert(
          commandReceipts
            .filter((command) => command.operation === "project-setup")
            .every((command) => command.outcome === "completed"),
        );
        assert(
          !commandReceipts.some((command) =>
            ["test.py", "test"].includes(command.argv[1]),
          ),
          "Bootstrap executed proposed project tests",
        );
        const manager = name.startsWith("yarn") ? "yarn" : name;
        fixture.environmentCommand = python
          ? "python test.py" +
            (name === "pip"
              ? ` && test "$(project-version)" = 25.0 && (cd nested && python test.py && test "$(project-version)" = 24.2) && (cd nested/deep && python probe.py) && (cd nested-other && python probe.py) && (cd "$HOME" && python -c 'import os, sys; assert sys.prefix == sys.base_prefix; assert "VIRTUAL_ENV" not in os.environ')`
              : "")
          : go
            ? `go test ./...${name === "mixed" ? " && npm test" : ""}`
            : `${manager} test`;
        const probes = receipt.environment.tools
          .map((tool) => {
            if (tool.language === "node")
              return `test "$(node -p process.execPath)" = '${tool.path}/bin/node'`;
            if (tool.language === "go")
              return `test "$(go env GOROOT)" = '${tool.path}'`;
            return `python -c 'import sys; assert sys.base_prefix == "${tool.path}"'`;
          })
          .join("\n");
        fixture.environmentCommand =
          "set -eu\n" +
          (name === "npm" ? "test ! -e .yarn/cache/late.zip\n" : "") +
          probes +
          "\n" +
          fixture.environmentCommand +
          (name === "npm"
            ? "\nprintf SDK-generated > .yarn/cache/late.zip\n"
            : "") +
          '\ntest ! -r /config/config.yml\ntest "$(id -u)" = 10001\nprintf "\\nBOOTSTRAP_TESTS_PASSED\\n"\n';
        const result = await events(
          supervisor.run(
            {
              ...supervisor.request(job.id, "implementation", {
                task: "bootstrap_environment",
              }),
              bootstrap_receipt: receipt.id,
            },
            new globalThis.AbortController().signal,
          ),
        );
        const terminal = result.at(-1);
        assert.equal(
          terminal.outcome,
          "completed",
          JSON.stringify({
            name,
            result,
            errors: errors.map((error) => error.message),
          }),
        );
        const artifact = store.artifact(
          terminal.artifact,
          job.id,
          job.revision,
        );
        assert(
          artifact.files.some(
            (file) =>
              file.path ===
              (go && name !== "mixed" ? ".tests-ran-go" : ".tests-ran"),
          ),
          JSON.stringify({
            name,
            files: artifact.files.map((file) => file.path),
          }),
        );
        assert(
          !artifact.files.some((file) =>
            file.path.split("/").includes("node_modules"),
          ),
        );
        if (name === "pip") {
          assert(
            artifact.files.some((file) => file.path === "nested/.tests-ran"),
          );
          assert(artifact.files.some((file) => file.path === ".lifecycle-ran"));
        }
        if (name === "npm") {
          assert(
            artifact.files.some(
              (file) => file.path === ".yarn/cache/tracked.txt",
            ),
          );
          assert(
            !artifact.files.some(
              (file) => file.path === ".yarn/cache/generated.txt",
            ),
          );
          assert(
            !artifact.files.some(
              (file) => file.path === ".yarn/cache/late.zip",
            ),
          );
          const bound = {
            ...supervisor.request(job.id, "implementation", {
              task: "bootstrap_environment",
            }),
            bootstrap_receipt: receipt.id,
          };
          const sessionId = result.find(
            (event) => event.type === "session",
          )?.id;
          const saved = store
            .runs()
            .find(
              (run) =>
                run.job_id === job.id &&
                run.session_id === sessionId &&
                run.role === "implementation",
            );
          assert(sessionId && saved);
          const checkpoint = JSON.parse(
            await readFile(
              join(
                root,
                "runtime",
                "private",
                "sessions",
                saved.id,
                "checkpoint.json",
              ),
              "utf8",
            ),
          ).checkpoint;
          assert(
            checkpoint.workspace.files.some(
              (file) => file.path === ".yarn/cache/tracked.txt",
            ),
          );
          assert(
            !checkpoint.workspace.files.some(
              (file) => file.path === ".yarn/cache/late.zip",
            ),
          );
          const resume = {
            id: sessionId,
            binding: JSON.parse(saved.binding_json).binding,
          };
          const resumed = await events(
            supervisor.run(
              { ...bound, resume },
              new globalThis.AbortController().signal,
            ),
          );
          assert.equal(resumed.at(-1).outcome, "completed");
          currentPlan.test_commands.push({
            cwd: ".",
            argv: ["/bin/true"],
            execution: "local",
            platform: "linux",
          });
          const changedPlan = await supervisor.bootstrap.prepare(
            request,
            new globalThis.AbortController().signal,
          );
          assert.notEqual(changedPlan.plan_digest, receipt.plan_digest);
          assert.deepEqual(changedPlan.environment, receipt.environment);
          assert.deepEqual(changedPlan.manager_locks, receipt.manager_locks);
          const planMismatch = await events(
            supervisor.run(
              { ...bound, bootstrap_receipt: changedPlan.id, resume },
              new globalThis.AbortController().signal,
            ),
          );
          assert.equal(planMismatch.at(-1).outcome, "failed");
          currentPlan.test_commands.pop();
          await supervisor.withBootstrapLease(
            request,
            new globalThis.AbortController().signal,
            (lease) =>
              supervisor.bootstrapWorkspace(
                lease,
                request,
                async (workspace, runId) => {
                  await writeFile(
                    join(workspace.workspace, "package.json"),
                    sourceFiles["package.json"] + "\n",
                  );
                  await assert.rejects(
                    supervisor.bootstrap.materialize(
                      bound,
                      workspace,
                      runId,
                      lease.signal,
                      (argv, cwd, environment, operation) =>
                        supervisor.bootstrapCommand(
                          lease,
                          request,
                          workspace,
                          receipt.id,
                          runId,
                          argv,
                          cwd,
                          environment,
                          operation,
                        ),
                    ),
                    /bootstrap_source_changed/,
                  );
                },
              ),
          );
          const changed = globalThis.structuredClone(receipt);
          changed.id = randomUUID();
          changed.manager_locks[`npm@${versions.managers.npm}`][
            "package-lock.json"
          ] += "\n";
          const token = store.acquireLease(job.id, job.revision);
          store.startRuntimeLease(
            token,
            snapshot.settings.limits.active_minutes * 60_000,
          );
          store.saveBootstrap(changed, token);
          assert(store.releaseLease(token));
          const mismatch = await events(
            supervisor.run(
              { ...bound, bootstrap_receipt: changed.id, resume },
              new globalThis.AbortController().signal,
            ),
          );
          assert.equal(mismatch.at(-1).outcome, "failed");
          const artifactMismatch = await events(
            supervisor.run(
              {
                ...bound,
                workspace: { ...bound.workspace, artifact: terminal.artifact },
              },
              new globalThis.AbortController().signal,
            ),
          );
          assert.equal(artifactMismatch.at(-1).outcome, "failed");
        }
        for (const uid of [10001, 10002])
          assert.equal((await userProcesses(uid)).length, 0);
        assert.equal(store.leases().length, 0);
        proof.push({
          sdk,
          fixture: name,
          receipt: receipt.id,
          source_sha: source.sha,
          tool_versions: receipt.environment.tools.map(
            ({ language, version }) => ({ language, version }),
          ),
          commands: store.bootstrapCommands(receipt.id).length,
        });
        markPhase(`${name}:complete`);
      };
      // Defer the Go tree until fixtures that repeatedly scan shared tool storage finish.
      for (const name of cases.filter(
        (name) => !["go-cgo", "mixed"].includes(name),
      ))
        await runCase(name);
      markPhase("audit-rejection:start");
      currentPlan = makePlan(["node"], "npm");
      const source = sourceWith(
        await files("/bootstrap-fixtures/projects/npm"),
      );
      const job = seed(snapshot, source);
      rejectAudit = true;
      const before = store.db
        .prepare("SELECT count(*) AS n FROM bootstrap_commands")
        .get().n;
      await assert.rejects(
        supervisor.bootstrap.prepare(
          supervisor.request(job.id, "bootstrap"),
          new globalThis.AbortController().signal,
        ),
        /bootstrap_audit_rejected/,
      );
      assert.equal(
        store.db.prepare("SELECT count(*) AS n FROM bootstrap_commands").get()
          .n,
        before,
      );
      rejectAudit = false;
      markPhase("audit-rejection:complete");
      if (sdk === "codex") {
        markPhase("negative-and-recovery:start");
        const npmFiles = await files("/bootstrap-fixtures/projects/npm");
        const fails = async (label, files, change, pattern) => {
          markPhase(`${label}:start`);
          currentPlan = makePlan(["node"], "npm");
          change(currentPlan);
          const failed = seed(snapshot, sourceWith(files));
          await assert.rejects(
            supervisor.bootstrap.prepare(
              supervisor.request(failed.id, "bootstrap"),
              new globalThis.AbortController().signal,
            ),
            pattern,
          );
          const row = store.db
            .prepare(
              "SELECT receipt_json FROM bootstrap_attempts WHERE job_id=?",
            )
            .get(failed.id);
          assert.equal(JSON.parse(row.receipt_json).status, "blocked");
          assert.equal(store.leases().length, 0);
          proof.push({ fixture: label, outcome: "blocked" });
          markPhase(`${label}:complete`);
          return JSON.parse(row.receipt_json).id;
        };
        const sourceConflict = await fails(
          "tracked-node-modules",
          {
            ...npmFiles,
            "node_modules/tracked.js": "tracked source sentinel\n",
          },
          () => {},
          /dependency_source_conflict/,
        );
        assert.equal(store.bootstrapCommands(sourceConflict).length, 0);
        const pnpmFiles = await files("/bootstrap-fixtures/projects/pnpm");
        for (const attack of ["directory", "lock"]) {
          const sentinel = join(root, `manager-symlink-${attack}`),
            sentinelFile = join(sentinel, "package.json"),
            sentinelBytes = '{"root_owned_sentinel":true}\n';
          await mkdir(sentinel, { mode: 0o555 });
          await writeFile(sentinelFile, sentinelBytes, { mode: 0o444 });
          const planted = {
            ...npmFiles,
            ...Object.fromEntries(
              Object.entries(pnpmFiles).map(([name, value]) => [
                `second/${name}`,
                value,
              ]),
            ),
            "setup.mjs":
              npmFiles["setup.mjs"] +
              `\nif (process.getuid() === 10002) {
  const directory = process.env.HOME + '/managers/pnpm@${versions.managers.pnpm}';
  fs.mkdirSync(process.env.HOME + '/managers', { recursive: true });
  if (${JSON.stringify(attack)} === 'directory')
    fs.symlinkSync(${JSON.stringify(sentinel)}, directory);
  else {
    fs.mkdirSync(directory, { recursive: true });
    fs.symlinkSync(${JSON.stringify(sentinelFile)}, directory + '/package.json');
  }
}\n`,
          };
          const attempt = await fails(
            `manager-${attack}-symlink`,
            planted,
            (plan) => {
              plan.package_managers.push({
                name: "pnpm",
                version: versions.managers.pnpm,
                cwd: "second",
              });
            },
            /bootstrap_command_failed/,
          );
          const blockedFiles = store.db
            .prepare(
              "SELECT receipt_json FROM bootstrap_commands WHERE attempt_id=? AND json_extract(receipt_json,'$.operation')='environment-files' AND json_extract(receipt_json,'$.outcome')='failed'",
            )
            .all(attempt)
            .map((row) => JSON.parse(row.receipt_json));
          assert(
            blockedFiles.some(
              (command) =>
                command.uid === 10002 &&
                command.argv
                  .at(-2)
                  .endsWith(`/managers/pnpm@${versions.managers.pnpm}`),
            ),
          );
          assert.equal((await lstat(sentinel)).uid, 0);
          assert.equal((await lstat(sentinel)).mode & 0o777, 0o555);
          assert.equal((await lstat(sentinelFile)).uid, 0);
          assert.equal((await lstat(sentinelFile)).mode & 0o777, 0o444);
          assert.equal(await readFile(sentinelFile, "utf8"), sentinelBytes);
        }
        await fails(
          "private-registry",
          {
            ...npmFiles,
            ".npmrc": "registry=https://private.example.invalid\n",
          },
          () => {},
          /dependency_source_unsupported/,
        );
        const unlocked = { ...npmFiles };
        delete unlocked["package-lock.json"];
        await fails(
          "missing-lock",
          unlocked,
          () => {},
          /dependency_lock_required/,
        );
        await fails(
          "root-script",
          npmFiles,
          (plan) => {
            plan.root_script = "touch /root/forbidden";
          },
          /bootstrap_plan_invalid|bootstrap_agent_failed/,
        );
        await fails(
          "package-unavailable",
          npmFiles,
          (plan) => {
            plan.system_packages = ["orm-bootstrap-package-does-not-exist"];
          },
          /system_package_unavailable/,
        );
        await fails(
          "toolchain-unavailable",
          npmFiles,
          (plan) => {
            plan.toolchains[0].version = "99.0.0";
          },
          /bootstrap_command_failed/,
        );
        await fails(
          "lock-mutation",
          npmFiles,
          (plan) => {
            plan.setup_commands.push({
              cwd: ".",
              argv: ["/bin/sh", "-c", "printf '\\n' >> package-lock.json"],
            });
          },
          /bootstrap_lock_mutated/,
        );
        markPhase("stale-lock:start");
        const pythonFiles = await files(
          "/bootstrap-fixtures/projects/python-poetry",
        );
        pythonFiles["pyproject.toml"] = pythonFiles["pyproject.toml"].replace(
          "packaging==25.0",
          "packaging==24.0",
        );
        currentPlan = makePlan(["python"], "poetry");
        const staleLockJob = seed(snapshot, sourceWith(pythonFiles));
        await assert.rejects(
          supervisor.bootstrap.prepare(
            supervisor.request(staleLockJob.id, "bootstrap"),
            new globalThis.AbortController().signal,
          ),
          /bootstrap_command_failed/,
        );
        proof.push({ fixture: "stale-lock", outcome: "blocked" });
        markPhase("stale-lock:complete");
        markPhase("nested-pins-mutation:start");
        const nestedPins = await files(
          "/bootstrap-fixtures/projects/python-pip",
        );
        currentPlan = makePlan(["python"], "pip");
        currentPlan.setup_commands.push({
          cwd: ".",
          argv: ["/bin/sh", "-c", "printf '\\n' >> pins/dependencies.in"],
        });
        const nestedMutation = seed(snapshot, sourceWith(nestedPins));
        await assert.rejects(
          supervisor.bootstrap.prepare(
            supervisor.request(nestedMutation.id, "bootstrap"),
            new globalThis.AbortController().signal,
          ),
          /bootstrap_lock_mutated/,
        );
        proof.push({ fixture: "nested-pins-mutation", outcome: "blocked" });
        markPhase("nested-pins-mutation:complete");
        currentPlan = makePlan(["node"], "npm");
        currentPlan.setup_commands.push({
          cwd: ".",
          argv: ["/bin/sh", "-c", "sleep 100"],
        });
        for (const mode of ["cancelled", "stale"]) {
          markPhase(`${mode}:start`);
          const staleSource = sourceWith(npmFiles);
          const cancelled = seed(snapshot, staleSource),
            controller = new globalThis.AbortController();
          let settled;
          const pending = supervisor.bootstrap
            .prepare(
              supervisor.request(cancelled.id, "bootstrap"),
              controller.signal,
            )
            .then(
              (result) => {
                settled = { result };
              },
              (error) => {
                settled = { error };
              },
            );
          const until = Date.now() + 120000;
          while (
            !store.db
              .prepare(
                "SELECT 1 FROM bootstrap_commands JOIN bootstrap_attempts ON bootstrap_attempts.id=bootstrap_commands.attempt_id WHERE bootstrap_attempts.job_id=? AND json_extract(bootstrap_commands.receipt_json,'$.argv[2]')='sleep 100' AND json_extract(bootstrap_commands.receipt_json,'$.outcome')='running'",
              )
              .get(cancelled.id)
          ) {
            if (settled)
              throw (
                settled.error ??
                new Error("Cancellation setup finished without waiting")
              );
            assert(Date.now() < until, "Cancellation setup did not start");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await assert.rejects(
            supervisor.bootstrap.prepare(
              supervisor.request(cancelled.id, "bootstrap"),
              new globalThis.AbortController().signal,
            ),
            /lease_busy/,
          );
          const interruptedAt = Date.now();
          if (mode === "cancelled") controller.abort();
          else {
            store.accept(
              `bootstrap-stale-${randomUUID()}`,
              "digest",
              "issues",
              [{ kind: "issue", number: cancelled.issue_number }],
            );
            store.applyIssue(
              store.nextDirty(),
              {
                id: cancelled.issue_number + 10000,
                number: cancelled.issue_number,
                state: "open",
                title: "Bootstrap fixture",
                body: "new revision",
                updated_at: "2026-10-18T00:01:00Z",
                comments: [],
                source: staleSource,
              },
              snapshot,
            );
          }
          await pending;
          assert(
            Date.now() - interruptedAt < 10000,
            "Interrupted setup cleanup exceeded 10 seconds",
          );
          assert(settled.error);
          if (mode === "stale")
            assert.equal(settled.error.code, "revision_stale");
          assert.equal(store.leases().length, 0);
          for (const uid of [10001, 10002])
            assert.equal((await userProcesses(uid)).length, 0);
          proof.push({
            fixture:
              mode === "cancelled"
                ? "cancellation-and-concurrency"
                : "stale-revision",
            outcome: "passed",
          });
          markPhase(`${mode}:complete`);
        }
        markPhase("cache-tampering:start");
        const tamper = join(
          lastReceipt.environment.tools[0].path,
          "cache-tamper-proof",
        );
        await writeFile(tamper, "tampered", { mode: 0o444 });
        try {
          await assert.rejects(
            supervisor.bootstrap.toolchains.verify(
              lastReceipt.environment,
              new globalThis.AbortController().signal,
              () => {},
              { output: 16 * 1024 * 1024, storage: 4 * 1024 ** 3 },
            ),
            /toolchain_integrity_mismatch/,
          );
        } finally {
          await unlink(tamper);
        }
        proof.push({ fixture: "cache-tampering", outcome: "blocked" });
        markPhase("cache-tampering:complete");
        markPhase("installer-limits:start");
        const limitedCommands = [];
        await assert.rejects(
          supervisor.bootstrap.toolchains.verify(
            lastReceipt.environment,
            new globalThis.AbortController().signal,
            (command) => limitedCommands.push({ ...command }),
            { output: 1, storage: 4 * 1024 ** 3 },
          ),
          /output_limit/,
        );
        assert.equal(limitedCommands.at(-1).outcome, "failed");
        await supervisor.bootstrap.toolchains.verify(
          lastReceipt.environment,
          new globalThis.AbortController().signal,
          () => {},
          { output: 16 * 1024 * 1024, storage: 1 },
        );
        const limitedVersion = "24.17.0",
          growthCommands = [];
        await assert.rejects(
          supervisor.bootstrap.toolchains.ensure(
            {
              version: 1,
              toolchains: [{ language: "node", version: limitedVersion }],
              system_packages: [],
              package_managers: [],
              setup_commands: [],
              test_commands: [],
            },
            new globalThis.AbortController().signal,
            (command) => growthCommands.push({ ...command }),
            { output: 16 * 1024 * 1024, storage: 1 },
          ),
          /storage_limit/,
        );
        assert(
          growthCommands.some(
            (command) =>
              command.uid === 0 &&
              command.argv.includes(`node@${limitedVersion}`),
          ),
        );
        proof.push({ fixture: "installer-limits", outcome: "blocked" });
        markPhase("installer-limits:complete");
        const partialVersion = "24.18.1";
        await mkdir(
          join(
            supervisor.bootstrap.toolchains.installs,
            "node",
            partialVersion,
          ),
          { recursive: true, mode: 0o555 },
        );
        await fails(
          "partial-install",
          npmFiles,
          (plan) => {
            plan.toolchains[0].version = partialVersion;
          },
          /toolchain_install_incomplete/,
        );
        markPhase("restart-recovery:start");
        const interruptedId = randomUUID(),
          interruptedCommand = randomUUID();
        const token = store.acquireLease(
          lastReceipt.job_id,
          lastReceipt.revision,
        );
        assert(token);
        store.startRuntimeLease(
          token,
          snapshot.settings.limits.active_minutes * 60_000,
        );
        store.saveBootstrap(
          {
            ...lastReceipt,
            id: interruptedId,
            status: "installing",
            finished_at: null,
          },
          token,
        );
        store.recordBootstrapCommand(interruptedId, null, {
          id: interruptedCommand,
          operation: "install",
          argv: ["/usr/bin/apt-get", "install"],
          cwd: "/",
          uid: 0,
          started_at: Date.now(),
          finished_at: null,
          exit_code: null,
          output_digest: null,
          output_bytes: 0,
          outcome: "running",
        });
        assert(store.releaseLease(token));
        await supervisor.close();
        supervisor = await Supervisor.create(store, snapshot, secrets, {
          root: join(root, "runtime"),
          sourceUrl: () => endpoint + "/owner/repo.git",
          workers: { [sdk]: `/opt/orm/app/dist/adapters/agents/${sdk}.js` },
        });
        assert.equal(store.bootstrap(interruptedId).status, "interrupted");
        assert.equal(
          store.bootstrapCommands(interruptedId)[0].outcome,
          "interrupted",
        );
        assert.equal(store.bootstrap(lastReceipt.id).status, "ready");
        proof.push({ fixture: "restart-recovery", outcome: "passed" });
        markPhase("restart-recovery:complete");
        markPhase("negative-and-recovery:complete");
      }
      for (const name of cases.filter((name) =>
        ["go-cgo", "mixed"].includes(name),
      ))
        await runCase(name);
      markPhase("sdk:complete");
      await supervisor.close();
      supervisor = undefined;
    }
    await assert.rejects(readFile("/root/BOOTSTRAP_INJECTION"), {
      code: "ENOENT",
    });
    assert.deepEqual(errors, []);
  } catch (error) {
    errors.push(error);
    try {
      const pending = [];
      for (const run of store.runs().filter((run) => run.finished_at === null))
        pending.push({
          id: run.id,
          role: run.role,
          workers: await userProcesses(run.uid),
          source_pids: await sourceProcesses(
            run.id,
            join(supervisor.workspaces.privateRoot, "sources", run.id),
          ),
        });
      if (pending.length)
        errors.push(
          new Error(`Cleanup process diagnostics: ${JSON.stringify(pending)}`),
        );
    } catch (diagnostic) {
      errors.push(diagnostic);
    }
  } finally {
    for (const cleanup of [
      () => markPhase("cleanup:start"),
      () => supervisor?.close(),
      () => store.close(),
      () => close(modelServer),
      () => close(sourceServer),
      async () => {
        await writeFile(join(root, "complete"), "bootstrap fixture finished");
        await chmod(join(root, "complete"), 0o400);
      },
      () => markPhase("cleanup:complete"),
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
      `Bootstrap verification or cleanup failed after ${proof.length} completed scenario groups`,
    );
  return {
    bootstrap: "passed",
    cases: proof,
    timings,
    audit_rejection: "passed",
    malicious_mise: "passed",
    cleanup: "passed",
  };
}
