import { Octokit } from "@octokit/rest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { GitHubActionsSource } from "../src/adapters/github/actions-source.ts";
import { routeActions } from "../src/actions/routing.ts";
import {
  prepareActionsConfiguration,
  readActionsConfiguration,
} from "../src/actions/setup.ts";
import { ActionsState } from "../src/actions/persistence.ts";
import { StateCodec, type TaskState } from "../src/actions/state.ts";
import { Store } from "../src/repositories/store.ts";
import { digest } from "../src/domain/agents.ts";
import { separateSecrets } from "../src/config/secrets.ts";
import {
  parseActionsConfiguration,
  parseRepositoryActionsConfiguration,
} from "../src/config/schema.ts";
import { loadWorkflowBundles } from "../src/config/bundles.ts";
import {
  fixtureConfiguration,
  fixtureConfigurationSources,
  fixtureSnapshot,
} from "./fixtures.ts";
import { createPublicationFixture } from "./fixtures/publication.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => AbortSignal.timeout(30000);
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orm-routing-"));
  cleanups.push(() => rm(root, { recursive: true }));
  const remote = await createPublicationFixture(join(root, "remote"));
  cleanups.push(remote.close);
  const issue = (number: number) => ({
    id: 1000 + number,
    number,
    title: "Bug",
    body: "Supported behavior is broken",
    updated_at: "2026-11-01T00:00:00Z",
  });
  remote.state.issues.set(1, issue(1));
  const source = new GitHubActionsSource(
    "owner/repo",
    new Octokit({
      auth: remote.state.token,
      baseUrl: remote.url,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    }),
  );
  const config = fixtureConfiguration(),
    { snapshot } = await fixtureSnapshot("fixture-model", config);
  const key = randomBytes(32).toString("base64"),
    { secrets } = separateSecrets(config, key);
  const store = new Store(join(root, "manager.sqlite"));
  cleanups.push(async () => {
    if (store.db.open) store.close();
  });
  await ActionsState.open(store, snapshot, secrets, 1, signal(), {
    writer: source,
    reader: source.reader,
  });
  const codec = new StateCodec(key);
  const row = remote.state.comments
    .get(1)!
    .find((row) => row.body.includes("<!-- orm:task-state:"))!;
  const decode = () =>
    codec.decode(row.body, {
      repository_id: 42,
      issue_id: 1001,
      comment_id: row.id,
      author_id: 7,
    });
  const update = (change: (state: TaskState) => void) => {
    const value = decode();
    change(value.state);
    row.body = codec.encode(value.state, value.narrative);
  };
  const route = (
    event: string,
    payload: object,
    options: { issueNumber?: string; ref?: string; now?: number } = {},
  ) =>
    routeActions(
      source,
      {
        event,
        payload: {
          repository: { id: 42, full_name: "owner/repo" },
          ...payload,
        },
        repository: "owner/repo",
        sessionKey: key,
        ref: "refs/heads/main",
        ...options,
      },
      signal(),
    );
  return { root, remote, source, config, row, decode, update, route, issue };
}

describe("Actions routing against authenticated GitHub state", () => {
  it("automatically selects new issues while existing backlog requires manual enrollment", async () => {
    const f = await setup();
    f.remote.state.issues.set(2, f.issue(2));
    expect(
      (await f.route("issues", { action: "opened", issue: { number: 2 } }))
        .issues,
    ).toEqual([2]);
    for (const action of ["edited", "reopened", "closed"])
      expect(
        (await f.route("issues", { action, issue: { number: 2 } })).issues,
      ).toEqual([]);
    expect(
      (
        await f.route(
          "workflow_dispatch",
          { sender: { id: 7, login: "fixture" } },
          { issueNumber: "2" },
        )
      ).issues,
    ).toEqual([2]);
    expect(
      (await f.route("issues", { action: "edited", issue: { number: 1 } }))
        .issues,
    ).toEqual([1]);
    expect(f.remote.state.issueLabels.has(2)).toBe(false);
  });
  it("requires current maintainer permission and a default-branch manual dispatch", async () => {
    const f = await setup();
    for (const [sender, ref, issueNumber] of [
      [{ id: 8, login: "reporter" }, "refs/heads/main", "1"],
      [{ id: 7, login: "fixture" }, "refs/heads/untrusted", "1"],
      [{ id: 7, login: "fixture" }, "refs/heads/main", "1; unsafe"],
    ] as const)
      await expect(
        f.route("workflow_dispatch", { sender }, { ref, issueNumber }),
      ).rejects.toThrow();
    await expect(
      f.route("issues", {
        repository: { id: 99, full_name: "owner/repo" },
        action: "opened",
        issue: { number: 1 },
      }),
    ).rejects.toThrow("state_invalid");
  });
  it("excludes recorded automation but admits genuine PAT-owner comments and duplicate signals", async () => {
    const f = await setup();
    expect(
      (
        await f.route("issue_comment", {
          action: "created",
          issue: { number: 1 },
          comment: { id: f.row.id },
        })
      ).issues,
    ).toEqual([]);
    const comment = f.remote.addComment(
      1,
      7,
      "fixture",
      "A genuine factual answer",
    );
    for (let count = 0; count < 2; count++)
      expect(
        (
          await f.route("issue_comment", {
            action: "created",
            issue: { number: 1 },
            comment: { id: comment.id },
          })
        ).issues,
      ).toEqual([1]);
    expect(
      (
        await f.route("issue_comment", {
          action: "edited",
          issue: { number: 1 },
          comment: { id: comment.id },
        })
      ).issues,
    ).toEqual([]);
  });
  it("fails closed for tampered or conflicting authoritative comments", async () => {
    const f = await setup();
    const body = f.row.body;
    f.row.body = "Edited narrative\n" + body;
    await expect(
      f.route("issue_comment", {
        action: "created",
        issue: { number: 1 },
        comment: { id: 999 },
      }),
    ).rejects.toThrow("state_invalid");
    f.row.body = body;
    f.remote.addComment(1, 7, "fixture", body);
    await expect(
      f.route("issue_comment", {
        action: "created",
        issue: { number: 1 },
        comment: { id: 999 },
      }),
    ).rejects.toThrow("state_conflict");
  });
  it("resolves owned PR head, closure and PR-comment activity to the same root issue", async () => {
    const f = await setup(),
      state = f.decode().state;
    f.remote.git([
      "update-ref",
      `refs/heads/${state.branch}`,
      f.remote.source.sha,
    ]);
    f.remote.state.pulls.push({
      id: 201,
      number: 20,
      branch: state.branch,
      base: "main",
      title: "Fix",
      body: "Scoped fix",
      author: 7,
      state: "open",
      draft: false,
    });
    f.update((state) => {
      state.pull = {
        id: 201,
        number: 20,
        author_id: 7,
        head: f.remote.source.sha,
        base: "main",
        title_digest: digest("Fix"),
        body_digest: digest("Scoped fix"),
      };
    });
    for (const action of ["synchronize", "closed"])
      expect(
        (
          await f.route("pull_request_target", {
            action,
            pull_request: { number: 20 },
          })
        ).issues,
      ).toEqual([1]);
    expect(
      (
        await f.route("issue_comment", {
          action: "created",
          issue: { number: 20, pull_request: {} },
          comment: { id: 999 },
        })
      ).issues,
    ).toEqual([1]);
    f.remote.state.pulls[0].head_repository_id = 99;
    expect(
      (
        await f.route("pull_request_target", {
          action: "synchronize",
          pull_request: { number: 20 },
        })
      ).issues,
    ).toEqual([]);
    f.remote.state.pulls[0].head_repository_id = 42;
    f.remote.state.pulls[0].author = 9;
    expect(
      (
        await f.route("pull_request_target", {
          action: "synchronize",
          pull_request: { number: 20 },
        })
      ).issues,
    ).toEqual([]);
  });
  it("routes a PR with an authenticated pending publication intent after response loss", async () => {
    const f = await setup(),
      branch = f.decode().state.branch;
    f.remote.git(["update-ref", `refs/heads/${branch}`, f.remote.source.sha]);
    f.remote.state.pulls.push({
      id: 201,
      number: 20,
      branch,
      base: "main",
      title: "Fix",
      body: "Scoped fix",
      author: 7,
      state: "open",
      draft: false,
    });
    f.update((state) => {
      state.pending = {
        id: "a".repeat(64),
        revision: 1,
        kind: "change",
        actor: { id: 7, login: "fixture" },
        source: f.remote.source,
        branch,
        commit: f.remote.source.sha,
        review_id: randomUUID(),
        review_binding: "b".repeat(64),
        policy_identity: "fixture",
        status: "uncertain",
        retry_at: 0,
        retry_pending: false,
        steps: [],
        pull_intent: { branch, base: "main", title: "Fix", body: "Scoped fix" },
      };
    });
    expect(
      (
        await f.route("pull_request_target", {
          action: "synchronize",
          pull_request: { number: 20 },
        })
      ).issues,
    ).toEqual([1]);
    f.remote.state.pulls[0].body = "Unrelated publication";
    expect(
      (
        await f.route("pull_request_target", {
          action: "synchronize",
          pull_request: { number: 20 },
        })
      ).issues,
    ).toEqual([]);
  });
  it("paginates enrolled open and closed tasks and fairly rotates oversized schedule batches", async () => {
    const f = await setup();
    for (let number = 2; number <= 302; number++) {
      f.remote.state.issues.set(number, f.issue(number));
      f.remote.state.issueLabels.set(number, ["orm:managed"]);
    }
    f.remote.state.closed.add(2);
    f.remote.state.issues.set(999, f.issue(999));
    const first = (await f.route("schedule", {}, { now: 0 })).issues;
    const second = (await f.route("schedule", {}, { now: 900000 })).issues;
    expect(first).toHaveLength(256);
    expect(second).toHaveLength(46);
    expect(new Set([...first, ...second]).size).toBe(302);
    expect(first).toContain(2);
    expect([...first, ...second]).not.toContain(999);
    expect(
      f.remote.state.requests.filter(
        (row) => row.path === "/repos/owner/repo/issues",
      ).length,
    ).toBeGreaterThanOrEqual(8);
  });
});

function operatorConfiguration() {
  const config = fixtureConfiguration();
  return {
    version: config.version,
    github: { token: { from_secret: "ORM_GITHUB_TOKEN" } },
    session_key: { from_secret: "ORM_SESSION_KEY" },
    proxy: { url: config.proxy.url, key: { from_secret: "ORM_PROXY_KEY" } },
    profiles: config.profiles,
    pr_monitor: config.pr_monitor,
    limits: config.limits,
    roles: Object.fromEntries(
      Object.entries(config.roles).map(([name, role]) => [
        name,
        { profile: role.profile, prompts: role.prompts, skills: role.skills },
      ]),
    ),
  };
}

describe("trusted repository Actions configuration", () => {
  it("loads pinned Git blobs, overlays bundles and produces protected validated runtime configuration", async () => {
    const f = await setup();
    const pinned = f.remote.commit(
      {
        ".github/orm.yml": stringify(operatorConfiguration()),
        ".github/orm/prompts/user.md": "Reviewed operator prompt\n",
        ".github/orm/skills/example/SKILL.md": "Reviewed operator skill\n",
      },
      f.remote.source.sha,
    );
    f.remote.git(["update-ref", "refs/heads/main", pinned.sha]);
    const tree = await f.source.files(
      await f.source.repository(signal()),
      signal(),
    );
    for (const path of [
      ".github/orm",
      ".github/orm/prompts",
      ".github/orm/skills",
      ".github/orm/skills/example",
    ]) {
      const directory = tree.files.find((entry) => entry.path === path);
      expect(directory).toMatchObject({ type: "tree", mode: "040000" });
      expect(directory).not.toHaveProperty("size");
    }
    const roots = {
      config: join(f.root, "config"),
      prompts: join(f.root, "prompts"),
      skills: join(f.root, "skills"),
      defaults: fileURLToPath(new URL("../examples/workflow", import.meta.url)),
    };
    const loaded = await readActionsConfiguration(
      f.source,
      "owner/repo",
      fixtureConfigurationSources(),
      signal(),
    );
    expect(
      await prepareActionsConfiguration(f.source, loaded, signal(), roots),
    ).toEqual({ source_sha: pinned.sha });
    const path = join(roots.config, "actions.yml"),
      config = parseActionsConfiguration(await readFile(path, "utf8"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(roots.config)).mode & 0o777).toBe(0o700);
    const { settings, secrets } = separateSecrets(config);
    const bundles = await loadWorkflowBundles(settings, secrets, roots);
    expect(bundles.implementation.user).toBe("Reviewed operator prompt\n");
    expect(
      Buffer.from(
        bundles.implementation.skills.find(
          (file) => file.path === "example/SKILL.md",
        )!.content_base64,
        "base64",
      ).toString(),
    ).toBe("Reviewed operator skill\n");
    expect(secrets.containsCredentials(bundles)).toBe(false);
    expect(config.github.repository).toBe("owner/repo");
    expect(config.roles.audit.profile).toBe("review");
    await expect(
      prepareActionsConfiguration(f.source, loaded, signal(), roots),
    ).rejects.toThrow();
  });
  it("rejects a truncated recursive Git-tree response at the transport boundary", async () => {
    const f = await setup();
    f.remote.state.truncatedTree = true;
    await expect(
      f.source.files(await f.source.repository(signal()), signal()),
    ).rejects.toThrow("state_size_limit");
    expect(
      f.remote.state.requests.some((request) =>
        request.path.includes("/git/trees/"),
      ),
    ).toBe(true);
  });
  it("rejects repository-stored credentials and service-only configuration", () => {
    for (const extra of [
      { github: { repository: "other/repo", token: "leak" } },
      { notifications: {} },
      { mcp: {} },
    ])
      expect(() =>
        parseRepositoryActionsConfiguration(
          stringify({ ...operatorConfiguration(), ...extra }),
          "owner/repo",
          fixtureConfigurationSources(),
        ),
      ).toThrow();
    const input = operatorConfiguration();
    Object.assign(input.proxy, { key: "leaked" });
    expect(() =>
      parseRepositoryActionsConfiguration(
        stringify(input),
        "owner/repo",
        fixtureConfigurationSources(),
      ),
    ).toThrow();
  });
  it("rejects non-directory override roots instead of silently using defaults", async () => {
    const f = await setup();
    for (const path of [
      ".github/orm",
      ".github/orm/prompts",
      ".github/orm/skills",
    ]) {
      const pinned = f.remote.commit(
        {
          ".github/orm.yml": stringify(operatorConfiguration()),
          [path]: "../untrusted",
        },
        f.remote.source.sha,
      );
      f.remote.git(["update-ref", "refs/heads/main", pinned.sha]);
      await expect(
        readActionsConfiguration(
          f.source,
          "owner/repo",
          fixtureConfigurationSources(),
          signal(),
        ),
      ).rejects.toThrow("bundle_invalid");
    }
  });
  it("rejects symlinks and oversized blob metadata before downloading bundle contents", async () => {
    const f = await setup();
    const base = {
      path: ".github/orm/prompts/user.md",
      type: "blob",
      mode: "100644",
      sha: "a".repeat(40),
      size: 1,
    };
    for (const change of [
      { mode: "120000" },
      { size: 1024 * 1024 + 1 },
      { type: "commit" },
    ])
      await expect(
        f.source.blob({ ...base, ...change }, signal()),
      ).rejects.toThrow("state_invalid");
  });
});
