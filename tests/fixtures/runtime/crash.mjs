import { readFile } from "node:fs/promises";
import { loadProtectedConfiguration } from "/opt/orm/app/dist/config/load.js";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";

const options = JSON.parse(await readFile(process.argv[2], "utf8"));
const { secrets } = await loadProtectedConfiguration();
const store = new Store(options.database),
  job = store.jobById(options.job);
const snapshot = store.snapshot(job.snapshot_digest);
const supervisor = await Supervisor.create(store, snapshot, secrets, {
  root: options.root,
  workers: { claude: options.worker, codex: options.worker },
  sourceUrl: () => options.source,
});
for await (const event of supervisor.run(
  supervisor.request(job.id, "implementation", { mode: "hang" }),
  new globalThis.AbortController().signal,
)) {
  if (event.type === "progress" && event.message === "ready")
    process.stdout.write("ready\n");
}
