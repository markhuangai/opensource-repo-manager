import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Toolchains } from "/opt/orm/app/dist/adapters/toolchains/index.js";
import { parseActionsConfiguration } from "/opt/orm/app/dist/config/schema.js";
import { separateSecrets } from "/opt/orm/app/dist/config/secrets.js";
import { rootDirectory } from "/opt/orm/app/dist/services/workspaces/files.js";

const version = "24.18.0";
const filename = `node-v${version}-linux-${process.arch}.tar.gz`;
const archive = join("/fixture", filename);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const downloads = (tools) =>
  join(tools.privateRoot, "data", "downloads", "node", version);
const mode = process.argv[2];

if (mode === "prepare") {
  const started = performance.now();
  const { secrets } = separateSecrets(
    parseActionsConfiguration(
      await readFile("/fixture/config/actions.yml", "utf8"),
    ),
  );
  const plan = {
    version: 1,
    toolchains: [{ language: "node", version }],
    system_packages: [],
    package_managers: [],
    setup_commands: [],
    test_commands: [],
  };
  const limits = { output: 16 * 1024 * 1024, storage: 2 * 1024 ** 3 };
  async function install(name, bytes) {
    const tools = new Toolchains(
      `/cache/${name}`,
      `/cache/${name}-private`,
      secrets,
    );
    await tools.initialize();
    if (bytes) {
      await rootDirectory(downloads(tools));
      await writeFile(join(downloads(tools), filename), bytes, { mode: 0o600 });
    }
    return tools.ensure(plan, AbortSignal.timeout(300000), () => {}, limits);
  }
  const cold = await install("cold");
  const bytes = await readFile(
    join(
      "/cache/cold-private/toolchains/data/downloads/node",
      version,
      filename,
    ),
  );
  const seeded = await install("seeded", bytes);
  assert.deepEqual(
    seeded.tools[0].node_signature,
    cold.tools[0].node_signature,
  );
  assert.deepEqual(seeded.tools[0].integrity, cold.tools[0].integrity);
  const corrupted = Buffer.from(bytes);
  corrupted[1024] ^= 1;
  await assert.rejects(
    install("corrupted", corrupted),
    (error) => error.code === "bootstrap_command_failed",
  );
  await writeFile(archive, bytes, { mode: 0o400, flag: "wx" });
  const receipt = {
    filename,
    digest: hash(bytes),
    node_signature: cold.tools[0].node_signature,
    installation_integrity: cold.tools[0].integrity,
    seeded_installation: "verified",
    corrupted_archive: "rejected",
    duration_ms: performance.now() - started,
  };
  await writeFile("/fixture/toolchain-cache.json", JSON.stringify(receipt), {
    mode: 0o444,
    flag: "wx",
  });
} else {
  assert.equal(mode, "seed");
  const number = process.argv[3];
  assert(/^[1-9]\d*$/.test(number));
  const receipt = JSON.parse(
    await readFile("/fixture/toolchain-cache.json", "utf8"),
  );
  assert.equal(hash(await readFile(archive)), receipt.digest);
  await rootDirectory("/data/actions", 0o711);
  const root = `/data/actions/${number}`;
  await rootDirectory(root, 0o711);
  await rootDirectory(join(root, "runtime"), 0o711);
  const target = join(
    root,
    "runtime/private/toolchains/data/downloads/node",
    version,
  );
  await rootDirectory(target);
  // Preserve existing cache bytes so corruption is still rejected by the real installer.
  await copyFile(
    archive,
    join(target, filename),
    constants.COPYFILE_EXCL,
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}
