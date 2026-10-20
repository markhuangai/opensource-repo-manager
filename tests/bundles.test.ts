import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkflowBundles } from "../src/config/bundles.ts";
import { createRunSnapshot } from "../src/config/load.ts";
import { readRegularFile } from "../src/config/files.ts";
import { separateSecrets } from "../src/config/secrets.ts";
import { fixtureMcp } from "./fixtures.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orm-bundles-"));
  temporary.push(root);
  const roots = {
    prompts: join(root, "prompts"),
    skills: join(root, "skills"),
  };
  await mkdir(roots.prompts);
  await mkdir(join(roots.skills, "example", "references"), { recursive: true });
  await writeFile(join(roots.prompts, "system.md"), "Trusted system prompt\n", {
    mode: 0o644,
  });
  await writeFile(join(roots.prompts, "user.md"), "Trusted user prompt\n", {
    mode: 0o644,
  });
  await writeFile(
    join(roots.skills, "example", "SKILL.md"),
    "Read references/note.md.\n",
    { mode: 0o644 },
  );
  await writeFile(
    join(roots.skills, "example", "references", "note.md"),
    "Contained reference\n",
    { mode: 0o644 },
  );
  const config = fixtureMcp();
  for (const role of Object.values(config.roles)) role.skills = ["example"];
  return { root, roots, config, ...separateSecrets(config) };
}

describe("immutable credential-free workflow snapshots", () => {
  it("copies contained resources and per-role policy without worker credentials or endpoints", async () => {
    const { roots, settings, secrets } = await fixture();
    const bundles = await loadWorkflowBundles(settings, secrets, roots);
    const snapshot = createRunSnapshot(settings, bundles, secrets);
    expect(
      snapshot.roles.investigation.mcp.context.tools.store_record.effect,
    ).toBe("write");
    expect(snapshot.roles.output_review.mcp).toEqual({});
    expect(snapshot.settings.mcp.servers.context.credential_ref).toBe(
      "service",
    );
    expect(snapshot.roles.audit.bundle.skills.map((file) => file.path)).toEqual(
      ["example/references/note.md", "example/SKILL.md"].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    expect(
      Buffer.from(
        snapshot.roles.audit.bundle.skills[0].content_base64,
        "base64",
      ).toString(),
    ).toBe("Contained reference\n");
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(
      /REPLACE_GITHUB|REPLACE_CPA|REPLACE_NOTIFICATION|mcp-credential-canary/,
    );
    expect(JSON.stringify(snapshot.roles)).not.toMatch(
      /tools\.example|cpa:8317|credential_ref|Authorization/,
    );
    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects nested mutation and preserves old snapshots after config and bundle edits", async () => {
    const { roots, settings, secrets } = await fixture();
    const before = createRunSnapshot(
      settings,
      await loadWorkflowBundles(settings, secrets, roots),
      secrets,
    );
    expect(() =>
      Object.assign(before.roles.audit.profile, { model: "changed" }),
    ).toThrow();
    expect(() =>
      Object.assign(before.settings.roles.investigation.mcp.context, {
        tools: ["missing"],
      }),
    ).toThrow();
    expect(() =>
      Object.assign(before.roles.audit.bundle.skills, { 0: {} }),
    ).toThrow();
    await writeFile(
      join(roots.prompts, "system.md"),
      "Reconfigured system prompt\n",
    );
    settings.limits.active_minutes = 30;
    settings.roles.investigation.mcp.context.tools = ["read_record"];
    const after = createRunSnapshot(
      settings,
      await loadWorkflowBundles(settings, secrets, roots),
      secrets,
    );
    expect(before.roles.audit.bundle.system).toBe("Trusted system prompt\n");
    expect(before.settings.limits.active_minutes).toBe(60);
    expect(
      before.roles.investigation.mcp.context.tools.store_record.effect,
    ).toBe("write");
    expect(after.roles.audit.bundle.system).toBe(
      "Reconfigured system prompt\n",
    );
    expect(
      after.roles.investigation.mcp.context.tools.store_record,
    ).toBeUndefined();
    expect(after.digest).not.toBe(before.digest);
  });
  for (const reference of [
    "../config/config.yml",
    "/config/config.yml",
    "example/../secret",
    "example\\secret",
    "example//SKILL.md",
  ])
    it(`rejects an escaping or ambiguous reference ${reference}`, async () => {
      const { roots, settings, secrets } = await fixture();
      settings.roles.audit.prompts.system = reference;
      await expect(
        loadWorkflowBundles(settings, secrets, roots),
      ).rejects.toThrow("bundle_invalid");
    });
  it("rejects file symlinks, directory symlinks and missing bundle references", async () => {
    const { root, roots, settings, secrets } = await fixture();
    await writeFile(join(root, "outside.md"), "Protected outside content\n");
    await symlink(join(root, "outside.md"), join(roots.prompts, "linked.md"));
    settings.roles.audit.prompts.system = "linked.md";
    await expect(loadWorkflowBundles(settings, secrets, roots)).rejects.toThrow(
      "bundle_invalid",
    );
    settings.roles.audit.prompts.system = "system.md";
    await symlink(root, join(roots.skills, "linked"));
    settings.roles.audit.skills = ["linked"];
    await expect(loadWorkflowBundles(settings, secrets, roots)).rejects.toThrow(
      "bundle_invalid",
    );
    settings.roles.audit.skills = ["missing"];
    await expect(loadWorkflowBundles(settings, secrets, roots)).rejects.toThrow(
      "bundle_invalid",
    );
  });
  it("rejects writable bundles and credential content rather than redacting trusted instructions", async () => {
    const { roots, settings, secrets } = await fixture();
    const path = join(roots.prompts, "system.md");
    await chmod(path, 0o666);
    await expect(loadWorkflowBundles(settings, secrets, roots)).rejects.toThrow(
      "bundle_invalid",
    );
    await chmod(path, 0o644);
    await writeFile(path, "mcp-credential-canary");
    await expect(loadWorkflowBundles(settings, secrets, roots)).rejects.toThrow(
      "secret_in_snapshot",
    );
    await writeFile(path, "Trusted prompt\n");
    await writeFile(
      join(roots.skills, "example", "references", "note.md"),
      secrets.get("github.token"),
    );
    await expect(loadWorkflowBundles(settings, secrets, roots)).rejects.toThrow(
      "secret_in_snapshot",
    );
  });
  it("rejects worker-readable configuration using actual filesystem metadata", async () => {
    const { root } = await fixture();
    const path = join(root, "config.yml");
    await writeFile(path, "credential-file-canary", { mode: 0o644 });
    await expect(readRegularFile(path, true)).rejects.toThrow(
      "config_permissions",
    );
  });
  it("rejects missing skill entrypoints and invalid UTF-8 prompts", async () => {
    const { roots, settings, secrets } = await fixture();
    await mkdir(join(roots.skills, "empty"));
    settings.roles.audit.skills.push("empty");
    await expect(loadWorkflowBundles(settings, secrets, roots)).rejects.toThrow(
      "bundle_invalid",
    );
    settings.roles.audit.skills = ["example"];
    await writeFile(
      join(roots.prompts, "system.md"),
      Buffer.from([0xff, 0xfe]),
    );
    await expect(loadWorkflowBundles(settings, secrets, roots)).rejects.toThrow(
      "bundle_invalid",
    );
  });
});
