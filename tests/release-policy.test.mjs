import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { nextCandidate, parseVersion } from "../scripts/release-policy.mjs";

const repository = "markhuangai/opensource-repo-manager";
const image = `ghcr.io/${repository}`;
const source = "a".repeat(40);
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const workflow = parse(
  await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  ),
);
const promotion = parse(
  await readFile(
    new URL("../.github/workflows/promote-release.yml", import.meta.url),
    "utf8",
  ),
);
const script = (job, name) =>
  job.steps.find((step) => step.name === name).with.script;
const scripts = {
  resolve: script(workflow.jobs.resolve, "Resolve and reserve candidate"),
  publish: script(workflow.jobs.publish, "Publish verified candidate"),
  promote: script(promotion.jobs.promote, "Promote exact verified candidate"),
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

function fixture() {
  const state = {
    releases: [],
    refs: new Map(),
    tags: new Map(),
    assets: new Map(),
    manifests: new Map(),
    writes: [],
    logs: [],
    outputs: {},
    main: source,
    packageVersion: "1.0.0",
    packageVersions: new Map([[source, "1.0.0"]]),
    ci: {},
    comparisons: new Map(),
    failure: undefined,
  };
  const context = {
    repo: { owner: "markhuangai", repo: "opensource-repo-manager" },
    runId: 123,
    serverUrl: "https://github.com",
    eventName: "workflow_run",
    ref: "refs/heads/main",
    payload: {
      repository: { id: 1 },
      workflow_run: {
        head_sha: source,
        head_branch: "main",
        head_repository: { id: 1, full_name: repository },
        event: "push",
        conclusion: "success",
      },
    },
  };
  state.context = context;
  state.seed = (tag, sha = source, prerelease = true, draft = false) => {
    const release = {
      id: state.releases.length + 42,
      tag_name: tag,
      draft,
      prerelease,
      published_at: draft ? null : "2026-11-03T00:00:00Z",
    };
    state.releases.push(release);
    state.refs.set(`tags/${tag}`, {
      ref: `refs/tags/${tag}`,
      object: { type: "commit", sha },
    });
    return release;
  };
  const write = (operation, args) => {
    state.writes.push({ operation, ...args });
    if (state.failure === operation) {
      state.failure = undefined;
      throw Object.assign(new Error(`Provider interrupted ${operation}`), {
        status: 503,
      });
    }
  };
  const readProvider = (operation, args) => {
    const failure = state.readFailure;
    if (
      failure?.operation === operation &&
      (!failure.ref || failure.ref === args.ref) &&
      (!failure.after ||
        state.writes.some((write) => write.operation === failure.after))
    ) {
      state.readFailure = undefined;
      throw Object.assign(new Error(`Provider read failed: ${operation}`), {
        status: 503,
      });
    }
  };
  const commit = (ref) => {
    const object = state.refs.get(ref)?.object;
    if (!object) throw notFound();
    return object.type === "tag"
      ? state.tags.get(object.sha).object.sha
      : object.sha;
  };
  const github = {
    rest: {
      repos: {
        listReleases: "releases",
        listReleaseAssets: "assets",
        getBranch: async () => ({ data: { commit: { sha: state.main } } }),
        compareCommits: async ({ base, head }) => ({
          data: {
            status:
              state.comparisons.get(`${base}:${head}`) ??
              (base === head ? "identical" : "ahead"),
          },
        }),
        getCommit: async ({ ref }) => ({ data: { sha: commit(ref) } }),
        getContent: async (args) => {
          expect(args.ref).toMatch(/^[a-f0-9]{40}$/);
          if (args.ref === state.main)
            state.packageVersions.set(args.ref, state.packageVersion);
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(
                JSON.stringify({
                  version: state.packageVersions.get(args.ref),
                }),
              ).toString("base64"),
            },
          };
        },
        getReleaseByTag: async ({ tag }) => {
          const release = state.releases.find(
            (release) => release.tag_name === tag && !release.draft,
          );
          if (!release) throw notFound();
          return { data: globalThis.structuredClone(release) };
        },
        createRelease: async (args) => {
          write("createRelease", args);
          const release = {
            ...args,
            id: state.releases.length + 42,
            published_at: null,
          };
          state.releases.push(release);
          return { data: globalThis.structuredClone(release) };
        },
        updateRelease: async (args) => {
          write("updateRelease", args);
          const release = state.releases.find(
            (release) => release.id === args.release_id,
          );
          Object.assign(release, args, {
            published_at: "2026-11-03T00:00:00Z",
          });
          return { data: globalThis.structuredClone(release) };
        },
        uploadReleaseAsset: async (args) => {
          write("uploadReleaseAsset", {
            release_id: args.release_id,
            name: args.name,
          });
          const asset = {
            id: state.assets.size + 1,
            release_id: args.release_id,
            name: args.name,
            data: args.data,
          };
          state.assets.set(asset.id, asset);
          return { data: asset };
        },
        getReleaseAsset: async ({ asset_id }) => ({
          data: state.assets.get(asset_id).data,
        }),
      },
      git: {
        listMatchingRefs: "refs",
        getRef: async ({ ref }) => {
          readProvider("getRef", { ref });
          if (!state.refs.has(ref)) throw notFound();
          return { data: globalThis.structuredClone(state.refs.get(ref)) };
        },
        createRef: async (args) => {
          write("createRef", args);
          const key = args.ref.replace(/^refs\//, "");
          assert(!state.refs.has(key), "Reference already exists");
          const ref = {
            ref: args.ref,
            object: {
              type: state.tags.has(args.sha) ? "tag" : "commit",
              sha: args.sha,
            },
          };
          state.refs.set(key, ref);
          return { data: ref };
        },
        createTag: async (args) => {
          write("createTag", args);
          const sha = hash(args).slice(0, 40);
          const tag = {
            tag: args.tag,
            message: args.message,
            object: { type: args.type, sha: args.object },
            sha,
          };
          state.tags.set(sha, tag);
          return { data: tag };
        },
        getTag: async ({ tag_sha }) => ({
          data: globalThis.structuredClone(state.tags.get(tag_sha)),
        }),
        updateRef: async (args) => {
          write("updateRef", args);
          state.refs.set(args.ref, {
            ref: `refs/${args.ref}`,
            object: { type: "tag", sha: args.sha },
          });
          return { data: state.refs.get(args.ref) };
        },
      },
      actions: {
        listWorkflowRuns: async (args) => {
          readProvider("listWorkflowRuns", args);
          return {
            data: {
              workflow_runs: state.ci[args.workflow_id] ?? [
                {
                  head_sha: args.head_sha,
                  head_branch: "main",
                  head_repository: { full_name: repository },
                  event: "push",
                  status: "completed",
                  conclusion: "success",
                  run_attempt: 2,
                  html_url: `https://github.com/${repository}/actions/runs/456`,
                },
              ],
            },
          };
        },
      },
    },
    paginate: async (route, args) => {
      expect(args.per_page).toBe(100);
      if (route === "releases") {
        readProvider("listReleases", args);
        return globalThis.structuredClone(state.releases);
      }
      if (route === "refs")
        return globalThis.structuredClone([...state.refs.values()]);
      if (route === "assets")
        return [...state.assets.values()]
          .filter((asset) => asset.release_id === args.release_id)
          .map(({ id, name }) => ({ id, name }));
      throw new Error(`Unexpected paginated route ${route}`);
    },
  };
  const exec = {
    getExecOutput: async (command, args) => {
      expect(command).toBe("docker");
      expect(args.slice(0, 3)).toEqual(["buildx", "imagetools", "inspect"]);
      const manifest = state.manifests.get(args[3]);
      return manifest
        ? { exitCode: 0, stdout: JSON.stringify(manifest), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "manifest unknown: 404" };
    },
    exec: async (command, args) => {
      expect(command).toBe("docker");
      expect(args.slice(0, 3)).toEqual(["buildx", "imagetools", "create"]);
      write("registry", { args });
      const tags = [],
        sources = [];
      let annotations;
      for (let index = 3; index < args.length; index++) {
        if (args[index] === "--tag") tags.push(args[++index]);
        else if (args[index] === "--annotation") {
          const value = args[++index].slice("index:".length);
          annotations = {
            [value.slice(0, value.indexOf("="))]: value.slice(
              value.indexOf("=") + 1,
            ),
          };
        } else sources.push(args[index]);
      }
      const manifest = annotations
        ? {
            annotations,
            manifests: sources.flatMap(
              (ref) => state.manifests.get(ref).manifests,
            ),
          }
        : globalThis.structuredClone(state.manifests.get(sources[0]));
      manifest.digest ??= `sha256:${hash(manifest)}`;
      state.manifests.set(`${image}@${manifest.digest}`, manifest);
      for (const tag of tags) state.manifests.set(tag, manifest);
    },
  };
  const summary = {
    addHeading: () => summary,
    addCodeBlock: () => summary,
    write: async () => {},
  };
  const core = {
    summary,
    setOutput: (key, value) => {
      state.outputs[key] = value;
    },
    info: (value) => state.logs.push({ level: "info", ...JSON.parse(value) }),
    warning: (value) =>
      state.logs.push({ level: "warning", ...JSON.parse(value) }),
    error: (value) => state.logs.push({ level: "error", ...JSON.parse(value) }),
  };
  state.invoke = async (stage, env = {}) => {
    await new AsyncFunction(
      "github",
      "context",
      "core",
      "exec",
      "process",
      "require",
      scripts[stage],
    )(
      github,
      stage === "promote"
        ? { ...context, eventName: "workflow_dispatch" }
        : context,
      core,
      exec,
      {
        env: {
          IMAGE: image,
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_WORKSPACE: fileURLToPath(new URL("../", import.meta.url)),
          VERSION: state.outputs.version,
          SOURCE_SHA: state.outputs.source_sha,
          RELEASE_ID: state.outputs.release_id,
          ...env,
        },
      },
      createRequire(import.meta.url),
    );
  };
  state.publish = async () => {
    const directory = await mkdtemp(join(tmpdir(), "orm-release-regression-"));
    try {
      for (const [index, arch] of ["amd64", "arm64"].entries()) {
        const item = {
          source_sha: state.outputs.source_sha,
          version: state.outputs.version,
          platform: `linux/${arch}`,
          digest: digest(index ? "b" : "a"),
          platform_digest: digest(index ? "d" : "c"),
          smoke: "passed",
        };
        await writeFile(
          join(directory, `image-${arch}.json`),
          JSON.stringify(item),
        );
        state.manifests.set(`${image}@${item.digest}`, {
          digest: item.digest,
          manifests: [
            {
              digest: item.platform_digest,
              platform: { os: "linux", architecture: arch },
            },
            {
              digest: digest(index ? "f" : "e"),
              platform: { os: "unknown", architecture: "unknown" },
              annotations: {
                "vnd.docker.reference.type": "attestation-manifest",
                "vnd.docker.reference.digest": item.platform_digest,
              },
            },
          ],
        });
      }
      await state.invoke("publish", { RECEIPTS: directory });
    } finally {
      await rm(directory, { recursive: true });
    }
  };
  state.candidate = async () => {
    await state.invoke("resolve");
    await state.publish();
  };
  return state;
}

describe("candidate numbering", () => {
  it("starts version one and increments RCs, then patch, minor and major bases", () => {
    expect(nextCandidate("1.0.0", [], [], source).tag).toBe("v1.0.0-rc.1");
    const state = fixture();
    state.seed("v0.0.1", "b".repeat(40), false);
    state.seed("v1.0.0-rc.2", "c".repeat(40));
    expect(
      nextCandidate("1.0.0", state.releases, [...state.refs.values()], source)
        .tag,
    ).toBe("v1.0.0-rc.3");
    state.seed("v1.0.0", "c".repeat(40), false);
    expect(
      nextCandidate("1.0.0", state.releases, [...state.refs.values()], source)
        .tag,
    ).toBe("v1.0.1-rc.1");
    expect(
      nextCandidate("1.1.0", state.releases, [...state.refs.values()], source)
        .tag,
    ).toBe("v1.1.0-rc.1");
    expect(
      nextCandidate("2.0.0", state.releases, [...state.refs.values()], source)
        .tag,
    ).toBe("v2.0.0-rc.1");
  });
  it("resumes an orphaned tag without reusing a different source's reservation", () => {
    const state = fixture();
    state.seed("v1.0.0-rc.4", source, true, true);
    expect(
      nextCandidate("1.0.0", [], [...state.refs.values()], source).tag,
    ).toBe("v1.0.0-rc.4");
    expect(
      nextCandidate("1.0.0", [], [...state.refs.values()], "f".repeat(40)).tag,
    ).toBe("v1.0.0-rc.5");
  });
  for (const tag of [
    "v01.0.0",
    "v1.0.0-rc.0",
    "v1.0.0-rc.01",
    "v1.0.0+build",
    "v1.0.0; echo unsafe",
    "v1.0.0\n",
    "v9007199254740992.0.0",
  ])
    it(`rejects malformed version ${JSON.stringify(tag)}`, () => {
      expect(parseVersion(tag)).toBeUndefined();
    });
  it("rejects rollback into a superseded release base", () => {
    const state = fixture();
    state.seed("v2.0.0-rc.1");
    expect(() => nextCandidate("1.0.0", state.releases, [], source)).toThrow(
      "superseded",
    );
  });
});

describe("actual candidate workflow scripts", () => {
  it("repairs a completed prerelease alias after main advances to a later major", async () => {
    const state = fixture();
    state.failure = "createTag";
    await expect(state.candidate()).rejects.toThrow(
      "Provider interrupted createTag",
    );
    state.main = "b".repeat(40);
    state.packageVersion = "2.0.0";
    state.context.payload.workflow_run.head_sha = state.main;
    await state.candidate();
    const majorTwo = state.refs.get("tags/v2-prerelease").object.sha;
    state.context.payload.workflow_run.head_sha = source;
    state.outputs = {};
    await state.invoke("resolve");
    expect(state.outputs).toMatchObject({
      version: "1.0.0-rc.1",
      build_required: "false",
    });
    await state.invoke("publish");
    const repaired = state.tags.get(
      state.refs.get("tags/v1-prerelease").object.sha,
    );
    expect(repaired).toMatchObject({
      message: "v1.0.0-rc.1",
      object: { sha: source },
    });
    expect(state.refs.get("tags/v2-prerelease").object.sha).toBe(majorTwo);
  });
  it("does not roll a major prerelease alias backward when an older completed run is replayed", async () => {
    const state = fixture();
    await state.candidate();
    state.main = "b".repeat(40);
    state.context.payload.workflow_run.head_sha = state.main;
    await state.candidate();
    const newer = state.refs.get("tags/v1-prerelease").object.sha,
      before = state.writes.length;
    state.context.payload.workflow_run.head_sha = source;
    state.outputs = {};
    await state.invoke("resolve");
    await state.invoke("publish");
    expect(state.refs.get("tags/v1-prerelease").object.sha).toBe(newer);
    expect(state.writes).toHaveLength(before);
    expect(state.logs.at(-1).outcome).toBe("superseded");
  });
  it("identifies an initial CI provider read failure without claiming a write failed", async () => {
    const state = fixture();
    state.readFailure = { operation: "listWorkflowRuns" };
    await expect(state.invoke("resolve")).rejects.toThrow(
      "Provider read failed: listWorkflowRuns",
    );
    expect(state.writes).toEqual([]);
    expect(
      state.logs.findLast((log) => log.event === "release.failed"),
    ).toMatchObject({
      operation: "github.listWorkflowRuns",
      provider_status: 503,
      completed_stage: "read_only_validation",
      target: {
        workflow_id: "ci.yml",
        head_sha: source,
        branch: "main",
        event: "push",
      },
    });
    expect(
      state.logs.findLast((log) => log.event === "release.read"),
    ).toMatchObject({
      operation: "github.listWorkflowRuns",
      target: { workflow_id: "ci.yml" },
    });
  });
  it("distinguishes failed alias readback from the completed reference update", async () => {
    const state = fixture();
    await state.candidate();
    state.main = "b".repeat(40);
    state.context.payload.workflow_run.head_sha = state.main;
    state.readFailure = {
      operation: "getRef",
      ref: "tags/v1-prerelease",
      after: "updateRef",
    };
    await expect(state.candidate()).rejects.toThrow(
      "Provider read failed: getRef",
    );
    expect(
      state.logs.findLast((log) => log.event === "release.failed"),
    ).toMatchObject({
      operation: "github.getRef",
      provider_status: 503,
      target: { ref: "tags/v1-prerelease" },
      completed_stage: "github.updateRef",
      last_completed_mutation: {
        operation: "github.updateRef",
        desired: { ref: "tags/v1-prerelease" },
      },
    });
  });
  it("publishes both native platforms with provenance attestations, durable receipt and matching aliases", async () => {
    const state = fixture();
    await state.candidate();
    const release = state.releases[0];
    expect(release).toMatchObject({
      tag_name: "v1.0.0-rc.1",
      draft: false,
      prerelease: true,
    });
    expect(state.assets.size).toBe(1);
    const receipt = JSON.parse([...state.assets.values()][0].data);
    expect(receipt.platforms.map((item) => item.platform)).toEqual([
      "linux/amd64",
      "linux/arm64",
    ]);
    const manifest = state.manifests.get(`${image}@${receipt.digest}`);
    expect(manifest.manifests).toHaveLength(4);
    expect(
      manifest.manifests
        .filter(
          (item) =>
            item.annotations?.["vnd.docker.reference.type"] ===
            "attestation-manifest",
        )
        .map((item) => item.annotations["vnd.docker.reference.digest"]),
    ).toEqual(receipt.platforms.map((item) => item.platform_digest));
    for (const tag of ["1.0.0-rc.1", "1-prerelease", `sha-${source}`])
      expect(state.manifests.get(`${image}:${tag}`).digest).toBe(
        receipt.digest,
      );
    expect([...state.refs.keys()]).toEqual([
      "tags/v1.0.0-rc.1",
      "tags/v1-prerelease",
    ]);
    expect(state.manifests.has(`${image}:latest`)).toBe(false);
  });
  it("uses the entire paginated history rather than only its first hundred entries", async () => {
    const state = fixture();
    state.releases.push(
      ...Array.from({ length: 105 }, (_, id) => ({
        id,
        tag_name: `unrelated-${id}`,
        draft: false,
      })),
    );
    state.seed("v1.0.0-rc.9", "b".repeat(40));
    await state.invoke("resolve");
    expect(state.outputs.version).toBe("1.0.0-rc.10");
  });
  it("recovers a draft reservation beyond the first release page without creating a duplicate", async () => {
    const state = fixture();
    state.releases.push(
      ...Array.from({ length: 105 }, (_, id) => ({
        id,
        tag_name: `unrelated-${id}`,
        draft: false,
      })),
    );
    await state.invoke("resolve");
    const reservation = state.releases.at(-1);
    expect(reservation.draft).toBe(true);
    const before = state.writes.length;
    await state.invoke("resolve");
    expect(state.writes).toHaveLength(before);
    expect(state.outputs.release_id).toBe(String(reservation.id));
    await state.publish();
    expect(reservation.draft).toBe(false);
    expect(
      state.writes.filter((write) => write.operation === "createRelease"),
    ).toHaveLength(1);
  });
  it("rejects conflicting release reservations before publishing images", async () => {
    const state = fixture();
    await state.invoke("resolve");
    state.releases.push({ ...state.releases[0], id: 999 });
    const before = state.writes.length;
    await expect(state.invoke("publish")).rejects.toThrow(
      "Conflicting releases for v1.0.0-rc.1",
    );
    expect(state.writes).toHaveLength(before);
  });
  for (const interruption of ["publication", "readback"])
    it(`keeps prerelease aliases on the prior publication after failed ${interruption} and repairs them on retry`, async () => {
      const state = fixture();
      await state.candidate();
      const priorDigest = state.manifests.get(`${image}:1-prerelease`).digest;
      const priorRef = state.refs.get("tags/v1-prerelease").object.sha;
      state.main = "b".repeat(40);
      state.context.payload.workflow_run.head_sha = state.main;
      state.writes = [];
      if (interruption === "publication") state.failure = "updateRelease";
      else
        state.readFailure = {
          operation: "listReleases",
          after: "updateRelease",
        };
      await expect(state.candidate()).rejects.toThrow(
        interruption === "publication"
          ? "Provider interrupted updateRelease"
          : "Provider read failed: listReleases",
      );
      const reservedDigest = state.manifests.get(`${image}:1.0.0-rc.2`).digest;
      expect(state.releases.at(-1).draft).toBe(interruption === "publication");
      expect(state.manifests.get(`${image}:1-prerelease`).digest).toBe(
        priorDigest,
      );
      expect(state.refs.get("tags/v1-prerelease").object.sha).toBe(priorRef);
      const before = state.writes.length;
      await state.invoke("resolve");
      expect(state.outputs.build_required).toBe("false");
      await state.invoke("publish");
      expect(state.releases.at(-1).draft).toBe(false);
      expect(state.manifests.get(`${image}:1-prerelease`).digest).toBe(
        reservedDigest,
      );
      expect(state.manifests.get(`${image}:1.0.0-rc.2`).digest).toBe(
        reservedDigest,
      );
      expect(state.refs.get("tags/v1-prerelease").object.sha).not.toBe(
        priorRef,
      );
      expect(
        state.writes
          .slice(before)
          .some(
            (write) =>
              write.operation === "registry" &&
              write.args.includes("--annotation"),
          ),
      ).toBe(false);
    });
  it("reuses completed publication on duplicate events without rebuilding or replacing the version", async () => {
    const state = fixture();
    await state.candidate();
    const before = state.writes.length;
    await state.invoke("resolve");
    expect(state.outputs.build_required).toBe("false");
    await state.invoke("publish");
    expect(state.releases).toHaveLength(1);
    expect(
      state.writes
        .slice(before)
        .every(
          (write) =>
            write.operation === "registry" &&
            !write.args.includes(`${image}:1.0.0-rc.1`),
        ),
    ).toBe(true);
  });
  for (const operation of [
    "createRelease",
    "uploadReleaseAsset",
    "updateRelease",
    "createTag",
  ])
    it(`resumes after interrupted ${operation} without replacing a numbered tag or image`, async () => {
      const state = fixture();
      state.failure = operation;
      await expect(state.candidate()).rejects.toThrow("Provider interrupted");
      const original = state.manifests.get(`${image}:1.0.0-rc.1`)?.digest;
      await state.invoke("resolve");
      await state.publish();
      expect(state.releases).toHaveLength(1);
      if (original)
        expect(state.manifests.get(`${image}:1.0.0-rc.1`).digest).toBe(
          original,
        );
      expect(
        state.writes.filter(
          (write) =>
            write.operation === "createRef" &&
            write.ref === "refs/tags/v1.0.0-rc.1",
        ),
      ).toHaveLength(1);
      expect(
        state.logs.some(
          (log) =>
            log.event === "release.failed" && log.provider_status === 503,
        ),
      ).toBe(true);
    });
  it("skips stale and CI-incomplete main revisions without writes", async () => {
    for (const change of [
      (state) => {
        state.main = "b".repeat(40);
      },
      (state) => {
        state.ci["codeql.yml"] = [];
      },
    ]) {
      const state = fixture();
      change(state);
      await state.invoke("resolve");
      expect(state.writes).toEqual([]);
      expect(state.logs.at(-1).outcome).toBe("skipped");
      expect(
        state.logs.find((log) => log.event === "release.version"),
      ).toMatchObject({
        source_sha: source,
        base: "v1.0.0",
        version: "v1.0.0-rc.1",
      });
      const observed = state.logs.filter((log) => log.event === "release.ci");
      expect(observed).toHaveLength(2);
      expect(observed[0].observed.run_url).toContain("/actions/runs/");
    }
  });
  for (const change of [
    { head_sha: "f".repeat(40) },
    { head_branch: "feature" },
    { event: "pull_request" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { status: "in_progress" },
    { head_repository: { full_name: "other/repository" } },
  ])
    it(`requires successful same-source CI: ${JSON.stringify(change)}`, async () => {
      const state = fixture();
      state.ci["ci.yml"] = [
        {
          head_sha: source,
          head_branch: "main",
          head_repository: { full_name: repository },
          event: "push",
          status: "completed",
          conclusion: "success",
          ...change,
        },
      ];
      await state.invoke("resolve");
      expect(state.writes).toEqual([]);
    });
  it("rejects foreign trigger provenance and a source outside main", async () => {
    const foreign = fixture();
    foreign.context.payload.workflow_run.head_repository.id = 2;
    await expect(foreign.invoke("resolve")).rejects.toThrow("same-repository");
    expect(foreign.writes).toEqual([]);
    const diverged = fixture();
    diverged.comparisons.set(`${source}:${source}`, "diverged");
    await expect(diverged.invoke("resolve")).rejects.toThrow("belong to main");
    expect(diverged.writes).toEqual([]);
  });
  it("rejects moved release tags before publishing images", async () => {
    const state = fixture();
    await state.invoke("resolve");
    state.refs.get("tags/v1.0.0-rc.1").object.sha = "f".repeat(40);
    await expect(state.publish()).rejects.toThrow("moved");
    expect(
      state.writes.filter((write) => write.operation === "registry"),
    ).toEqual([]);
  });
  it("fails closed if stable promotion supersedes an in-flight reservation", async () => {
    const state = fixture();
    await state.invoke("resolve");
    state.seed("v1.0.0", source, false);
    await expect(state.publish()).rejects.toThrow("superseded by stable");
    expect(
      state.writes.filter((write) => write.operation === "registry"),
    ).toEqual([]);
  });
  it("rejects missing native proof without publishing a version", async () => {
    const state = fixture();
    await state.invoke("resolve");
    const directory = await mkdtemp(join(tmpdir(), "orm-release-missing-"));
    try {
      await expect(
        state.invoke("publish", { RECEIPTS: directory }),
      ).rejects.toThrow("Both architecture receipts");
    } finally {
      await rm(directory, { recursive: true });
    }
    expect(
      state.writes.filter((write) => write.operation === "registry"),
    ).toEqual([]);
  });
  it("rejects a conflicting published image instead of rebuilding it", async () => {
    const state = fixture();
    await state.candidate();
    state.manifests.set(`${image}:1.0.0-rc.1`, {
      ...state.manifests.get(`${image}:1.0.0-rc.1`),
      digest: digest("f"),
    });
    const before = state.writes.length;
    await expect(state.invoke("publish")).rejects.toThrow("digest changed");
    expect(state.writes).toHaveLength(before);
  });
  it("rejects a conflicting immutable source-SHA image on publication retry before further writes", async () => {
    const state = fixture();
    await state.candidate();
    state.manifests.set(`${image}:sha-${source}`, {
      ...state.manifests.get(`${image}:sha-${source}`),
      digest: digest("f"),
    });
    const before = state.writes.length;
    await expect(state.invoke("publish")).rejects.toThrow(
      "Source image tag conflicts with this publication.",
    );
    expect(state.writes).toHaveLength(before);
    expect(state.manifests.get(`${image}:sha-${source}`).digest).toBe(
      digest("f"),
    );
  });
});

describe("actual stable promotion workflow script", () => {
  it("repairs the latest stable alias of a prior major without rolling back global latest", async () => {
    const state = fixture();
    await state.candidate();
    state.context.payload.inputs = { source_rc: "v1.0.0-rc.1" };
    state.failure = "createTag";
    await expect(state.invoke("promote")).rejects.toThrow(
      "Provider interrupted createTag",
    );
    state.main = "b".repeat(40);
    state.packageVersion = "2.0.0";
    state.context.payload.workflow_run.head_sha = state.main;
    await state.candidate();
    state.context.payload.inputs = { source_rc: "v2.0.0-rc.1" };
    await state.invoke("promote");
    const latest = state.manifests.get(`${image}:latest`).digest,
      majorTwo = state.refs.get("tags/v2").object.sha;
    state.context.payload.inputs = { source_rc: "v1.0.0-rc.1" };
    await state.invoke("promote");
    expect(
      state.tags.get(state.refs.get("tags/v1").object.sha).object.sha,
    ).toBe(source);
    expect(state.manifests.get(`${image}:latest`).digest).toBe(latest);
    expect(state.refs.get("tags/v2").object.sha).toBe(majorTwo);
  });
  for (const draft of [false, true])
    it(`rejects the previous RC after a current-main package bump, newer draft=${draft}`, async () => {
      const state = fixture();
      await state.candidate();
      state.main = "b".repeat(40);
      state.packageVersion = "1.1.0";
      if (draft) state.seed("v1.1.0-rc.1", state.main, true, true);
      state.context.payload.inputs = { source_rc: "v1.0.0-rc.1" };
      const before = state.writes.length;
      await expect(state.invoke("promote")).rejects.toThrow(
        "active intended release base",
      );
      expect(state.writes).toHaveLength(before);
      expect(
        state.logs.find((log) => log.event === "release.active_base"),
      ).toMatchObject({ base: "v1.1.0", main_sha: state.main });
    });
  it("preserves a verified completed promotion retry after the intended base advances", async () => {
    const state = fixture();
    await state.candidate();
    state.context.payload.inputs = { source_rc: "v1.0.0-rc.1" };
    await state.invoke("promote");
    state.main = "b".repeat(40);
    state.packageVersion = "2.0.0";
    await state.invoke("promote");
    expect(
      state.releases.filter((release) => !release.prerelease),
    ).toHaveLength(1);
  });
  it("retains prior and desired refs when an alias update is interrupted", async () => {
    const state = fixture();
    await state.candidate();
    const prior = state.refs.get("tags/v1-prerelease").object.sha;
    state.main = "b".repeat(40);
    state.context.payload.workflow_run.head_sha = state.main;
    state.failure = "updateRef";
    await expect(state.candidate()).rejects.toThrow(
      "Provider interrupted updateRef",
    );
    const failure = state.logs.findLast(
      (log) => log.event === "release.failed",
    );
    expect(failure).toMatchObject({
      operation: "github.updateRef",
      provider_status: 503,
      completed_stage: "github.createTag",
      prior,
      desired: {
        ref: "tags/v1-prerelease",
        source_sha: state.main,
        version: "v1.0.0-rc.2",
      },
    });
    expect(failure.desired.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      state.logs.findLast((log) => log.event === "release.intent"),
    ).toMatchObject({
      operation: "github.updateRef",
      prior,
      desired: failure.desired,
    });
  });
  it("retains promotion mutation and completed-stage evidence before provider failure", async () => {
    const state = fixture();
    await state.candidate();
    state.context.payload.inputs = { source_rc: "v1.0.0-rc.1" };
    state.failure = "updateRelease";
    await expect(state.invoke("promote")).rejects.toThrow(
      "Provider interrupted updateRelease",
    );
    expect(
      state.logs.findLast((log) => log.event === "release.failed"),
    ).toMatchObject({
      operation: "github.updateRelease",
      provider_status: 503,
      completed_stage: "registry.copy",
      desired: { tag: "v1.0.0", source_sha: source, draft: false },
      prior: { draft: true },
    });
  });
  it("promotes identical bytes, preserves the RC, and advances the next candidate to a patch", async () => {
    const state = fixture();
    await state.candidate();
    const original = state.manifests.get(`${image}:1.0.0-rc.1`).digest;
    state.context.payload.inputs = { source_rc: "v1.0.0-rc.1" };
    const before = state.writes.length;
    await state.invoke("promote");
    for (const tag of ["1.0.0", "1", "latest", "1.0.0-rc.1", "1-prerelease"])
      expect(state.manifests.get(`${image}:${tag}`).digest).toBe(original);
    expect(state.releases[0].prerelease).toBe(true);
    expect(state.releases[1]).toMatchObject({
      tag_name: "v1.0.0",
      draft: false,
      prerelease: false,
    });
    expect(
      state.writes
        .slice(before)
        .filter((write) => write.operation === "registry")
        .every(
          (write) =>
            !write.args.includes("--annotation") &&
            write.args.at(-1) === `${image}@${original}`,
        ),
    ).toBe(true);
    expect(state.refs.has("tags/v1")).toBe(true);
    state.outputs = {};
    await state.invoke("resolve");
    expect(state.outputs).toMatchObject({
      version: "1.0.0-rc.1",
      build_required: "false",
    });
    state.main = "b".repeat(40);
    state.context.payload.workflow_run.head_sha = state.main;
    await state.invoke("resolve");
    expect(state.outputs.version).toBe("1.0.1-rc.1");
  });
  it("rejects every RC except the newest published candidate for the active base", async () => {
    const state = fixture();
    await state.candidate();
    state.seed("v1.0.0-rc.2", "b".repeat(40));
    state.context.payload.inputs = { source_rc: "v1.0.0-rc.1" };
    const before = state.writes.length;
    await expect(state.invoke("promote")).rejects.toThrow(
      "latest published verified RC",
    );
    expect(state.writes).toHaveLength(before);
  });
  it("resumes interrupted stable publication with the same receipt and digest", async () => {
    const state = fixture();
    await state.candidate();
    state.context.payload.inputs = { source_rc: "v1.0.0-rc.1" };
    state.failure = "updateRelease";
    await expect(state.invoke("promote")).rejects.toThrow("interrupted");
    const original = state.manifests.get(`${image}:1.0.0`).digest;
    await state.invoke("promote");
    await state.invoke("promote");
    expect(state.releases).toHaveLength(2);
    expect(state.assets.size).toBe(2);
    expect(state.manifests.get(`${image}:latest`).digest).toBe(original);
  });
  for (const interruption of ["publication", "readback"])
    it(`keeps stable aliases on the prior publication after failed ${interruption} and repairs them without rebuilding`, async () => {
      const state = fixture();
      await state.candidate();
      state.context.payload.inputs = { source_rc: "v1.0.0-rc.1" };
      await state.invoke("promote");
      const priorDigest = state.manifests.get(`${image}:latest`).digest;
      const priorRef = state.refs.get("tags/v1").object.sha;
      state.main = "b".repeat(40);
      state.context.payload.workflow_run.head_sha = state.main;
      await state.candidate();
      const candidateDigest = state.manifests.get(`${image}:1.0.1-rc.1`).digest;
      state.context.payload.inputs = { source_rc: "v1.0.1-rc.1" };
      state.writes = [];
      if (interruption === "publication") state.failure = "updateRelease";
      else
        state.readFailure = {
          operation: "listReleases",
          after: "updateRelease",
        };
      await expect(state.invoke("promote")).rejects.toThrow(
        interruption === "publication"
          ? "Provider interrupted updateRelease"
          : "Provider read failed: listReleases",
      );
      expect(state.releases.at(-1).draft).toBe(interruption === "publication");
      expect(state.manifests.get(`${image}:1.0.1`).digest).toBe(
        candidateDigest,
      );
      for (const tag of ["1", "latest"])
        expect(state.manifests.get(`${image}:${tag}`).digest).toBe(priorDigest);
      expect(state.refs.get("tags/v1").object.sha).toBe(priorRef);
      const before = state.writes.length;
      await state.invoke("promote");
      expect(state.releases.at(-1).draft).toBe(false);
      for (const tag of ["1.0.1", "1", "latest"])
        expect(state.manifests.get(`${image}:${tag}`).digest).toBe(
          candidateDigest,
        );
      expect(state.refs.get("tags/v1").object.sha).not.toBe(priorRef);
      expect(
        state.writes
          .slice(before)
          .filter((write) => write.operation === "registry")
          .every(
            (write) =>
              !write.args.includes("--annotation") &&
              !write.args.includes(`${image}:1.0.1`) &&
              write.args.at(-1) === `${image}@${candidateDigest}`,
          ),
      ).toBe(true);
    });
  it("rejects non-main dispatch and malformed candidate input before writes", async () => {
    for (const configure of [
      (state) => {
        state.context.ref = "refs/heads/feature";
      },
      (state) => {
        state.context.payload.inputs = { source_rc: "v1.0.0; malicious" };
      },
    ]) {
      const state = fixture();
      configure(state);
      await expect(state.invoke("promote")).rejects.toThrow();
      expect(state.writes).toEqual([]);
    }
  });
  it("rejects missing, wrong-source, or incomplete native receipts", async () => {
    for (const change of [
      (state) => state.assets.clear(),
      (state) => {
        const asset = [...state.assets.values()][0],
          receipt = JSON.parse(asset.data);
        receipt.source_sha = "f".repeat(40);
        asset.data = Buffer.from(JSON.stringify(receipt));
      },
      (state) => {
        const asset = [...state.assets.values()][0],
          receipt = JSON.parse(asset.data);
        receipt.platforms.pop();
        asset.data = Buffer.from(JSON.stringify(receipt));
      },
    ]) {
      const state = fixture();
      await state.candidate();
      change(state);
      state.context.payload.inputs = { source_rc: "v1.0.0-rc.1" };
      const before = state.writes.length;
      await expect(state.invoke("promote")).rejects.toThrow();
      expect(state.writes).toHaveLength(before);
    }
  });
  it("moves only owned major aliases and never rewrites an exact tag", async () => {
    const state = fixture();
    await state.candidate();
    state.main = "b".repeat(40);
    state.context.payload.workflow_run.head_sha = state.main;
    await state.candidate();
    expect(state.outputs.version).toBe("1.0.0-rc.2");
    const updates = state.writes.filter(
      (write) => write.operation === "updateRef",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      ref: "tags/v1-prerelease",
      force: true,
    });
    expect(state.refs.get("tags/v1.0.0-rc.1").object.sha).toBe(source);
  });
});

describe("release diagnostics at normal Actions visibility", () => {
  it("reconstructs a rejected promotion from real Actions logger output without exposing environment credentials", () => {
    const policy = new URL("../scripts/release-policy.mjs", import.meta.url)
      .href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import * as core from '@actions/core';
      import { promoteStable } from ${JSON.stringify(policy)};
      try { await promoteStable({ core, github: {}, context: {
        repo: {owner: 'markhuangai', repo: 'opensource-repo-manager'}, runId: 123,
        eventName: 'workflow_dispatch', ref: 'refs/heads/main', payload: {inputs: {source_rc: 'invalid'}}
      }, env: {IMAGE: '${image}', GITHUB_RUN_ATTEMPT: '2', GITHUB_TOKEN: 'credential-canary-never-log'} }); }
      catch { process.exitCode = 1; }
    `,
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, ACTIONS_STEP_DEBUG: "false" },
      },
    );
    expect(child.status).toBe(1);
    const output = child.stdout + child.stderr;
    expect(output).toContain('"event":"release.started"');
    expect(output).toContain("::error::");
    expect(output).toContain('"stage":"promote"');
    expect(output).toContain('"attempt":2');
    expect(output).toContain('"source_rc":"invalid"');
    expect(output).toContain("source_rc must be an exact candidate tag");
    expect(output).toContain('"recovery":');
    expect(output).not.toContain("credential-canary-never-log");
  });
});
