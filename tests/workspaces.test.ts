import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../src/services/workspaces/index.ts";
import { treeBytes } from "../src/services/workspaces/files.ts";
import { fixtureSnapshot } from "./fixtures.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orm-workspace-"));
  roots.push(root);
  const { secrets } = await fixtureSnapshot();
  const service = new WorkspaceService(join(root, "runtime"), secrets);
  await service.initialize();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const request = {
    run_id: "a",
    job_id: 1,
    revision: 1,
    source: {
      sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
      default_branch: "main",
    },
  };
  return { root, service, workspace, request };
}

describe("immutable workspace artifacts", () => {
  it("freezes real bytes, modes and safe links while ignoring worker Git metadata", async () => {
    const { service, workspace, request } = await setup();
    await writeFile(join(workspace, "file"), "candidate bytes", {
      mode: 0o755,
    });
    await symlink("file", join(workspace, "link"));
    await symlink("/config", join(workspace, ".git"));
    const manifest = await service.freeze(
      request,
      workspace,
      1024 * 1024,
      new AbortController().signal,
    );
    const hash = createHash("sha256").update("candidate bytes").digest("hex");
    expect(manifest.files).toEqual([
      { path: "file", kind: "file", digest: hash, mode: 0o755 },
      { path: "link", kind: "link", target: "file", mode: 0o777 },
    ]);
    expect(
      await readFile(join(service.privateRoot, "blobs", hash), "utf8"),
    ).toBe("candidate bytes");
    expect(
      (await lstat(join(service.privateRoot, "blobs", hash))).mode & 0o777,
    ).toBe(0o400);
    await writeFile(join(workspace, "file"), "changed afterwards");
    expect(
      await readFile(join(service.privateRoot, "blobs", hash), "utf8"),
    ).toBe("candidate bytes");
  });
  it.each(["absolute", "relative", "hardlink", "fifo"])(
    "rejects %s escapes or special files",
    async (kind) => {
      const { root, service, workspace, request } = await setup();
      const outside = join(root, "outside");
      await writeFile(outside, "private bytes");
      if (kind === "absolute") await symlink(outside, join(workspace, "bad"));
      if (kind === "relative")
        await symlink("../outside", join(workspace, "bad"));
      if (kind === "hardlink") await link(outside, join(workspace, "bad"));
      if (kind === "fifo") execFileSync("mkfifo", [join(workspace, "bad")]);
      await expect(
        service.freeze(
          request,
          workspace,
          1024 * 1024,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/artifact_(path|type)_invalid/);
      expect(await readFile(outside, "utf8")).toBe("private bytes");
    },
  );
  it("bounds real disk inspection and respects cancellation", async () => {
    const { service, workspace, request } = await setup();
    await writeFile(join(workspace, "large"), Buffer.alloc(4096));
    await expect(treeBytes(workspace, 128)).rejects.toThrow("storage_limit");
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.freeze(request, workspace, 100000, controller.signal),
    ).rejects.toThrow();
  });
  it.each(["outside", ".git/config"])(
    "rejects chained links into %s during freeze and restore",
    async (destination) => {
      const { service, workspace, request } = await setup();
      await mkdir(join(workspace, "d"));
      await symlink("..", join(workspace, "d/up"));
      const target =
        destination === "outside" ? "d/up/../outside" : "d/up/.git/config";
      await symlink(target, join(workspace, "escape"));
      await expect(
        service.freeze(
          request,
          workspace,
          100000,
          new AbortController().signal,
        ),
      ).rejects.toThrow("artifact_path_invalid");
      await expect(
        service.restore(
          {
            ...request,
            files: [
              { path: "d/up", kind: "link", target: "..", mode: 0o777 },
              { path: "escape", kind: "link", target, mode: 0o777 },
            ],
          },
          workspace,
          "audit",
          100000,
          new AbortController().signal,
        ),
      ).rejects.toThrow("artifact_path_invalid");
      expect((await lstat(join(workspace, "escape"))).isSymbolicLink()).toBe(
        true,
      );
    },
  );
  it("preserves safe chained and dangling links as metadata", async () => {
    const { service, workspace, request } = await setup();
    await mkdir(join(workspace, "d"));
    await symlink("..", join(workspace, "d/up"));
    await symlink("d/up/missing", join(workspace, "safe"));
    const manifest = await service.freeze(
      request,
      workspace,
      100000,
      new AbortController().signal,
    );
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[1]).toMatchObject({
      kind: "link",
      target: "d/up/missing",
    });
  });
});
