import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import {
  PublicationGit,
  protectedPath,
  runGit,
} from "../src/adapters/github/git.ts";
import { OctokitWriter } from "../src/adapters/github/writer.ts";
import { WorkspaceService } from "../src/services/workspaces/index.ts";
import {
  PublicationScanner,
  publicationText,
} from "../src/services/publication/scanner.ts";
import { proposalSchema } from "../src/services/publication/contracts.ts";
import { fixtureConfiguration, fixtureSnapshot } from "./fixtures.ts";
import type { ArtifactManifest } from "../src/domain/agents.ts";
import { createPublicationFixture } from "./fixtures/publication.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orm-publication-"));
  cleanup.push(() => rm(root, { recursive: true }));
  const fixture = await createPublicationFixture(join(root, "remote"));
  cleanup.push(fixture.close);
  const loaded = await fixtureSnapshot();
  const service = new WorkspaceService(join(root, "runtime"), loaded.secrets);
  await service.initialize();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  for (const [path, data] of Object.entries(fixture.initial))
    await writeFile(join(workspace, path), data);
  await writeFile(join(workspace, "app.txt"), "fixed\n", { mode: 0o755 });
  const freeze = () =>
    service.freeze(
      { run_id: "fixture", job_id: 1, revision: 1, source: fixture.source },
      workspace,
      1048576,
      new AbortController().signal,
    );
  const git = new PublicationGit(
    join(root, "publisher"),
    loaded.secrets,
    "owner/repo",
    () => fixture.url + "/owner/repo.git",
  );
  await git.initialize(fixture.source.sha, new AbortController().signal);
  const build = async (manifest?: ArtifactManifest) =>
    git.build(
      manifest ?? (await freeze()),
      join(service.privateRoot, "blobs"),
      fixture.source.sha,
      "Fix fixture\n",
      fixture.state.actor,
      "2026-10-19T00:00:00Z",
      1048576,
      new AbortController().signal,
    );
  return { root, fixture, loaded, service, workspace, git, freeze, build };
}

describe("publication policy and immutable Git export", () => {
  it("rejects decoded YAML credentials before scanner execution, including folded and block keys", async () => {
    const config = fixtureConfiguration();
    config.github.webhook_secret = "folded fixture password";
    const { secrets } = await fixtureSnapshot("fixture-model", config);
    const scanner = new PublicationScanner("/not-used", secrets);
    for (const text of [
      'password: "folded\\x20fixture\\x20password"\n',
      "password: folded\n  fixture password\n",
      "? folded\n  fixture password\n: value\n",
      "password: >-\n  folded\n  fixture password\n",
      "? >-\n  folded\n  fixture password\n: value\n",
      'password: "folded\n  fixture password"\n',
    ])
      await expect(
        scanner.scan(
          { path: "fixture.yaml", mode: "100644", text },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "publication_secret" });
    await expect(
      scanner.scan(
        { path: "invalid.yaml", mode: "100644", text: "key: [unterminated" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "publication_structured_invalid" });
  });
  it.each([
    ".github/workflows/check.yml",
    ".github/workflows",
    ".github/actions/task/a.ts",
    "some/action.yaml",
    "CODEOWNERS",
    ".github/dependabot.yml",
    ".gitmodules",
    ".GIT/config",
  ])("rejects protected target %s", (path) =>
    expect(protectedPath(path)).toBe(true),
  );
  it.each([
    ".github/ISSUE_TEMPLATE/bug.md",
    ".github/README.md",
    "src/actions.ts",
    "README.md",
  ])("allows ordinary file %s", (path) =>
    expect(protectedPath(path)).toBe(false),
  );
  it.each([
    Buffer.from([0, 1, 255]),
    Buffer.from("%PDF-1.7\n"),
    Buffer.from("a\0b"),
  ])("rejects unsupported binary bytes", (bytes) =>
    expect(() => publicationText(bytes)).toThrow(
      "publication_binary_unsupported",
    ),
  );
  it("does not let proposals select arbitrary branches, destinations or template text", () => {
    expect(
      proposalSchema.safeParse({
        job_id: 1,
        revision: 1,
        kind: "notice",
        reason: "model_unavailable",
        body: "unreviewed",
      }).success,
    ).toBe(false);
    expect(
      proposalSchema.safeParse({
        job_id: 1,
        revision: 1,
        kind: "status",
        body: "ready",
        branch: "main",
      }).success,
    ).toBe(false);
  });
  it("exports one clean commit with final bytes, executable modes, deletions and safe links, preserving unchanged binaries", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.workspace, "tool"), "#!/bin/sh\nprintf ok\n", {
      mode: 0o755,
    });
    await symlink("app.txt", join(fixture.workspace, "current"));
    const result = await fixture.build(),
      signal = new AbortController().signal;
    expect(
      (
        await fixture.git.command(
          [
            "rev-list",
            "--count",
            `${fixture.fixture.source.sha}..${result.commit}`,
          ],
          signal,
        )
      )
        .toString()
        .trim(),
    ).toBe("1");
    expect(
      (
        await fixture.git.command(["show", `${result.commit}:app.txt`], signal)
      ).toString(),
    ).toBe("fixed\n");
    const binary = await fixture.git.command(
      ["show", `${result.commit}:image.bin`],
      signal,
    );
    expect(binary).toEqual(fixture.fixture.initial["image.bin"]);
    expect(result.changes.map((file) => file.path)).not.toContain("image.bin");
    expect(
      (
        await fixture.git.command(
          ["ls-tree", result.commit, "tool", "current"],
          signal,
        )
      ).toString(),
    ).toContain("100755 blob");
    expect(
      (
        await fixture.git.command(["show", `${result.commit}:current`], signal)
      ).toString(),
    ).toBe("app.txt");
    await fixture.git.push(
      result.commit,
      "orm/11111111-1111-4111-8111-111111111111/issue-1",
      signal,
    );
    expect(
      fixture.fixture.head("orm/11111111-1111-4111-8111-111111111111/issue-1"),
    ).toBe(result.commit);
  });
  it.each(["protected", "binary", "corrupt", "escape", "secret"])(
    "blocks %s before a remote mutation",
    async (kind) => {
      const fixture = await setup();
      if (kind === "protected") {
        await mkdir(join(fixture.workspace, ".github", "workflows"), {
          recursive: true,
        });
        await writeFile(
          join(fixture.workspace, ".github", "workflows", "new.yml"),
          "name: injected",
        );
      }
      if (kind === "binary")
        await writeFile(
          join(fixture.workspace, "image.bin"),
          Buffer.from([0, 9, 255]),
        );
      if (kind === "secret")
        await writeFile(
          join(fixture.workspace, "app.txt"),
          fixture.loaded.secrets.get("github.token"),
        );
      if (kind === "escape") {
        await symlink("../private", join(fixture.workspace, "escape"));
        await expect(fixture.freeze()).rejects.toThrow("artifact_path_invalid");
        return;
      }
      const manifest = await fixture.freeze();
      if (kind === "corrupt") {
        const file = manifest.files.find((file) => file.path === "app.txt")!;
        if (file.kind !== "file") throw Error("fixture file missing");
        const path = join(fixture.service.privateRoot, "blobs", file.digest);
        await chmod(path, 0o600);
        await writeFile(path, "tampered");
        await chmod(path, 0o400);
      }
      await expect(fixture.build(manifest)).rejects.toThrow(
        /publication_path_protected|publication_binary_unsupported|artifact_corrupt|publication_secret/,
      );
      expect(fixture.fixture.state.mutations).toEqual([]);
    },
  );
  it("ignores worker history and hooks even when an intermediate commit contains a secret", async () => {
    const fixture = await setup();
    const environment = {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      signal = new AbortController().signal;
    const workerGit = async (args: string[], input?: string) =>
      (await runGit(args, fixture.workspace, environment, signal, input))
        .toString()
        .trim();
    await workerGit(["init", "."]);
    const blob = await workerGit(
      ["hash-object", "-w", "--stdin"],
      fixture.loaded.secrets.get("github.token"),
    );
    const tree = await workerGit(["mktree"], `100644 blob ${blob}\tapp.txt\n`);
    const intermediate = await workerGit(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nsecret intermediate\n`,
    );
    await workerGit(["update-ref", "refs/heads/work", intermediate]);
    await writeFile(
      join(fixture.workspace, ".git", "config"),
      `[filter "evil"]\nclean = touch ${join(fixture.root, "unexpected")}\n`,
    );
    await writeFile(
      join(fixture.workspace, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\ntouch ${join(fixture.root, "unexpected")}\nexit 99\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(fixture.workspace, ".gitattributes"),
      "app.txt filter=evil\n",
    );
    const result = await fixture.build();
    expect(result.changes.some((file) => file.path.includes(".git/"))).toBe(
      false,
    );
    expect(
      (
        await fixture.git.command(
          ["cat-file", "-p", result.commit],
          new AbortController().signal,
        )
      ).toString(),
    ).not.toContain(fixture.loaded.secrets.get("github.token"));
    await expect(lstat(join(fixture.root, "unexpected"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      fixture.git.command(["cat-file", "-e", intermediate], signal),
    ).rejects.toThrow("publication_git_failed");
  });
  it("cancels a Git write while its HTTP transport is waiting for a response", async () => {
    const fixture = await setup();
    const result = await fixture.build();
    const cancellation = new AbortController();
    let release!: () => void,
      entered = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.fixture.state.holdBefore = async () => {
      entered = true;
      await held;
    };
    const pushing = fixture.git
      .push(
        result.commit,
        "orm/11111111-1111-4111-8111-111111111111/issue-1",
        cancellation.signal,
      )
      .then(
        () => "completed",
        () => "cancelled",
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = Date.now() + 2000;
      while (!entered && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(entered).toBe(true);
      cancellation.abort();
      const outcome = await Promise.race([
        pushing,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("hung"), 1000);
        }),
      ]);
      expect(outcome).toBe("cancelled");
    } finally {
      if (timer) clearTimeout(timer);
      release();
      fixture.fixture.state.holdBefore = undefined;
      await pushing;
    }
  });
});

describe("GitHub publication HTTP adapter", () => {
  it("uses scoped routes for real comment and PR effects and reports protection and response loss", async () => {
    const { fixture } = await setup(),
      signal = new AbortController().signal;
    const silent = () => {};
    const writer = new OctokitWriter(
      "owner/repo",
      new Octokit({
        auth: fixture.state.token,
        baseUrl: fixture.url,
        log: { debug: silent, info: silent, warn: silent, error: silent },
      }),
    );
    expect((await writer.repository(signal)).id).toBe(42);
    expect(await writer.actor(signal)).toEqual(fixture.state.actor);
    fixture.state.comments.set(2, [
      {
        id: 91,
        body: "App comment",
        author_id: 8,
        author_login: "github-actions[bot]",
      },
      { id: 92, body: "Deleted author", author_id: null },
    ]);
    expect(await writer.comments(2, signal)).toEqual([
      { id: 91, body: "App comment", author_id: 8 },
      { id: 92, body: "Deleted author", author_id: null },
    ]);
    const retryAfter = new Date(Date.now() + 300000).toUTCString();
    fixture.state.rateLimit = {
      method: "GET",
      path: "/user",
      seconds: retryAfter,
    };
    await expect(writer.actor(signal)).rejects.toMatchObject({
      code: "github_rate_limited",
      retryAt: Date.parse(retryAfter),
    });
    const branch = "orm/11111111-1111-4111-8111-111111111111/issue-1";
    fixture.state.protected.add(branch);
    expect(await writer.branch(branch, signal)).toEqual({
      head: null,
      protected: true,
    });
    await writer.comment(1, null, "reviewed", signal);
    const comment = (await writer.comments(1, signal))[0];
    await writer.comment(1, comment.id, "updated", signal);
    expect((await writer.comments(1, signal))[0].body).toBe("updated");
    fixture.state.dropAfter = "comment";
    await expect(
      writer.comment(1, null, "lost response", signal),
    ).rejects.toThrow("github_publication_failed");
    expect(
      (await writer.comments(1, signal)).filter(
        (row) => row.body === "lost response",
      ),
    ).toHaveLength(1);
    fixture.git(["update-ref", `refs/heads/${branch}`, fixture.source.sha]);
    await writer.updatePull(
      null,
      { title: "Reviewed", body: "Evidence", branch, base: "main" },
      signal,
    );
    const pull = (await writer.pulls(branch, signal))[0];
    expect(pull).toMatchObject({
      head: fixture.source.sha,
      state: "open",
      draft: false,
      repository_id: 42,
    });
    await writer.updatePull(
      pull.number,
      { title: "Updated", body: "New evidence", branch, base: "main" },
      signal,
    );
    expect((await writer.pull(pull.number, signal)).body).toBe("New evidence");
    const remotePull = fixture.state.pulls[0];
    remotePull.author = 8;
    remotePull.author_login = "github-actions[bot]";
    expect((await writer.pulls(branch, signal))[0].author_id).toBe(8);
    remotePull.author = null;
    expect((await writer.pull(pull.number, signal)).author_id).toBeNull();
    fixture.state.actor.login = "github-actions[bot]";
    await expect(writer.actor(signal)).rejects.toThrow();
  });
});
