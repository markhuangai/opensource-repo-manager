import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapPlanSchema,
  bootstrapAuditSchema,
} from "../src/services/bootstrap/contracts.ts";
import { inspectWorkspace } from "../src/services/bootstrap/inspect.ts";
import {
  commandDirectory,
  dependencyExclusions,
} from "../src/services/bootstrap/environment.ts";
import { WorkspaceService } from "../src/services/workspaces/index.ts";
import { fixtureSnapshot } from "./fixtures.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true });
});
async function source(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "orm-bootstrap-"));
  roots.push(root);
  for (const [name, value] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), value);
  }
  return root;
}
const plan = {
  version: 1,
  toolchains: [{ language: "node", version: "24.18.0" }],
  system_packages: ["g++", "pkg-config"],
  package_managers: [],
  setup_commands: [{ cwd: ".", argv: ["/bin/sh", "-c", "node --version"] }],
  test_commands: [
    { cwd: ".", argv: ["npm", "test"], execution: "local", platform: "linux" },
  ],
};
const signal = new AbortController().signal;
describe("structured bootstrap policy", () => {
  it("accepts data-only tool requests and unprivileged shell commands", () => {
    expect(bootstrapPlanSchema.parse(plan)).toEqual(plan);
    expect(
      bootstrapAuditSchema.parse({
        approved: true,
        plan_digest: "a".repeat(64),
        source_digest: "b".repeat(64),
        findings: [],
      }).approved,
    ).toBe(true);
  });
  it.each([
    { root_script: "curl example | sh" },
    { system_packages: ["--allow-unauthenticated"] },
    { system_packages: ["./local.deb"] },
    { system_packages: ["git-"] },
    { toolchains: [{ language: "node", version: "latest" }] },
    {
      toolchains: [
        {
          language: "node",
          version: "24.18.0",
          url: "https://example.invalid",
        },
      ],
    },
    { toolchains: [{ language: "ruby", version: "3.4.0" }] },
    {
      toolchains: [
        { language: "node", version: "24.18.0" },
        { language: "node", version: "22.0.0" },
      ],
    },
    { setup_commands: [{ cwd: "../config", argv: ["sh"] }] },
    { package_managers: [{ name: "poetry", cwd: ".", version: "2.5.1" }] },
    {
      test_commands: [
        {
          cwd: ".",
          argv: ["go", "test", "./..."],
          execution: "local",
          platform: "windows",
        },
      ],
    },
  ])("rejects unsupported authority and requirements %j", (changes) => {
    expect(bootstrapPlanSchema.safeParse({ ...plan, ...changes }).success).toBe(
      false,
    );
  });
  it("treats npm private:true as a publishing flag, and fingerprints real manifest bytes", async () => {
    const root = await source({
      "package.json": '{"private":true}',
      "AGENTS.md": "Untrusted instructions",
    });
    const before = await inspectWorkspace(root, 100000, signal);
    await writeFile(
      join(root, "package.json"),
      '{"private":true,"name":"changed"}',
    );
    const after = await inspectWorkspace(root, 100000, signal);
    expect(after.fingerprints["package.json"]).not.toBe(
      before.fingerprints["package.json"],
    );
    expect(before.source_files).toEqual(["AGENTS.md", "package.json"]);
  });
  const unsupportedInputs: Record<string, string>[] = [
    { ".npmrc": "//registry.npmjs.org/:_authToken=${TOKEN}" },
    { ".npmrc": "registry=https://private.example.invalid" },
    {
      "package.json":
        '{"dependencies":{"private":"git+ssh://git@example.invalid/repo"}}',
    },
    { "package.json": '{"dependencies":{"is-number":"7.0.0"}}' },
    { "requirements.txt": "packaging>=25.0" },
    {
      "pyproject.toml":
        '[tool.poetry.source]\nurl="https://private.example.invalid"',
    },
    {
      "uv.lock":
        '[[package]]\nsource={registry="https://private.example.invalid"}',
    },
    {
      "go.mod":
        "module example.test/app\ngo 1.26.0\nrequire github.com/google/uuid v1.6.0",
    },
  ];
  it.each(unsupportedInputs)(
    "blocks private, unlocked, or unsupported dependency inputs %j",
    async (files) => {
      const root = await source(files);
      await expect(inspectWorkspace(root, 100000, signal)).rejects.toThrow();
    },
  );
  it("ignores hostile mise execution while retaining its fingerprint", async () => {
    const root = await source({
      "mise.toml":
        '[hooks]\npostinstall="touch /root/forbidden"\n[settings]\nnode.verify=false',
    });
    const result = await inspectWorkspace(root, 100000, signal);
    expect(result.fingerprints["mise.toml"]).toMatch(/^[a-f0-9]{64}$/);
  });
  it("fingerprints CI expressions and action versions as planning evidence", async () => {
    const workflow =
      'on: push\njobs:\n  test:\n    runs-on: ${{ matrix.os }}\n    steps:\n      - uses: actions/setup-node@v7\n        with:\n          node-version: "24.18.0"\n      - run: echo "${{ github.sha }}"\n';
    const root = await source({ ".github/workflows/ci.yml": workflow });
    const before = await inspectWorkspace(root, 100000, signal);
    expect(before.fingerprints[".github/workflows/ci.yml"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    await writeFile(join(root, ".github/workflows/ci.yml"), workflow + "\n");
    const after = await inspectWorkspace(root, 100000, signal);
    expect(after.fingerprints[".github/workflows/ci.yml"]).not.toBe(
      before.fingerprints[".github/workflows/ci.yml"],
    );
  });
  it("validates and fingerprints nested pip inputs with arbitrary filenames", async () => {
    const root = await source({
      "requirements.txt": "-r pins/deps.in\n",
      "pins/deps.in": "-r transitive.pins\n",
      "pins/transitive.pins": "packaging==25.0\n",
    });
    const before = await inspectWorkspace(root, 100000, signal);
    expect(Object.keys(before.fingerprints)).toContain("pins/transitive.pins");
    await writeFile(join(root, "pins/transitive.pins"), "packaging==24.0\n");
    const after = await inspectWorkspace(root, 100000, signal);
    expect(after.fingerprints["pins/transitive.pins"]).not.toBe(
      before.fingerprints["pins/transitive.pins"],
    );
  });
  it.each([
    "packaging>=25.0",
    "--index-url https://private.example.invalid",
    "-r ../outside",
    "-r deps.in",
  ])("rejects unsafe or recursive pip includes %s", async (value) => {
    const root = await source({
      "requirements.txt": "-r deps.in\n",
      "deps.in": value,
    });
    await expect(inspectWorkspace(root, 100000, signal)).rejects.toThrow();
  });
  it("rejects escaping manifests and command directories", async () => {
    const root = await source({ actual: "{}" });
    await symlink("actual", join(root, "package.json"));
    await expect(inspectWorkspace(root, 100000, signal)).rejects.toThrow(
      "dependency_manifest_invalid",
    );
    await symlink("/tmp", join(root, "outside"));
    await expect(commandDirectory(root, "outside")).rejects.toThrow(
      "bootstrap_command_path_invalid",
    );
  });
  it("keeps generated dependencies out of artifacts while preserving source", async () => {
    const root = await source({
      "source.js": "source",
      "node_modules/tracked.js": "tracked source",
      ".yarn/cache/tracked.txt": "tracked cache source",
    });
    const before = await inspectWorkspace(root, 100000, signal);
    const excluded = dependencyExclusions(before.source_files);
    for (const path of [
      "node_modules/generated.js",
      ".yarn/cache/late.zip",
      ".yarn/unplugged/dependency/index.js",
      ".pnp.cjs",
    ]) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), "generated dependency");
    }
    const { secrets } = await fixtureSnapshot();
    const service = new WorkspaceService(join(root, "runtime"), secrets);
    await service.initialize();
    const manifest = await service.freeze(
      {
        run_id: "test",
        job_id: 1,
        revision: 1,
        source: {
          sha: "a".repeat(40),
          tree_sha: "b".repeat(40),
          default_branch: "main",
        },
      },
      root,
      100000,
      signal,
      undefined,
      (reference) => reference === "runtime" || excluded(reference),
    );
    expect(manifest.files.map((file) => file.path)).toEqual([
      ".yarn/cache/tracked.txt",
      "node_modules/tracked.js",
      "source.js",
    ]);
  });
});
