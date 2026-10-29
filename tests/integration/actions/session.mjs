import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { loadProtectedActionsConfiguration } from "/opt/orm/app/dist/config/load.js";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { ActionsState } from "/opt/orm/app/dist/actions/persistence.js";
import { ActionsArtifacts } from "/opt/orm/app/dist/actions/artifacts.js";
import { GitHubArtifacts } from "/opt/orm/app/dist/adapters/github/artifacts.js";
import { createApplication } from "/opt/orm/app/dist/runtime/application.js";
import { digest } from "/opt/orm/app/dist/domain/agents.js";
import { rootDirectory } from "/opt/orm/app/dist/services/workspaces/files.js";
import { ConversationRepository } from "/opt/orm/app/dist/repositories/conversations.js";

const number = Number(process.argv[2]),
  phase = process.argv[3];
const loaded = await loadProtectedActionsConfiguration();
const root = `/data/actions/${number}`;
await rootDirectory("/data/actions", 0o711);
await rootDirectory(root, 0o711);
const store = new Store(join(root, "state", "manager.sqlite"));
const signal = AbortSignal.timeout(600000);
const artifacts = new ActionsArtifacts(
  loaded.actions,
  loaded.snapshot,
  loaded.secrets,
  join(root, "runtime"),
  new GitHubArtifacts(loaded.actions, loaded.secrets),
);
await artifacts.initialize(signal);
const state = await ActionsState.open(
  store,
  loaded.snapshot,
  loaded.secrets,
  number,
  signal,
  { artifacts },
);
assert.equal(state.result(), undefined);
const before = JSON.parse(store.job(number).budget_json);
const application = await createApplication(
  store,
  loaded,
  {
    info() {},
    error(message) {
      console.error(message);
    },
  },
  {
    mode: "actions",
    root: join(root, "runtime"),
    publicationWriter: () => state.writer,
  },
);
const conversationId = "33333333-3333-4333-8333-333333333333";
let outcome;
try {
  const job = store.job(number),
    conversations = new ConversationRepository(store);
  const previous = conversations.get(conversationId);
  const starting = ["seed", "fresh"].includes(phase);
  assert.equal(
    Boolean(previous),
    !starting,
    "Session restoration changed conversation identity",
  );
  if (phase === "resume" || phase === "interrupt") {
    assert.equal(
      (await readdir(join(root, "runtime", "toolchains"))).length,
      0,
      "Installed toolchains were restored from the artifact",
    );
  }
  const bootstrap = starting
    ? await application.supervisor.bootstrap.prepare(
        application.supervisor.request(job.id, "bootstrap"),
        signal,
      )
    : JSON.parse(
        store.db
          .prepare(
            "SELECT receipt_json FROM bootstrap_attempts WHERE job_id=? AND status='ready' ORDER BY rowid DESC LIMIT 1",
          )
          .get(job.id).receipt_json,
      );
  const initial = {
    id: "comment:seed",
    content: "Initial factual report",
    digest: digest("Initial factual report"),
  };
  const answer = {
    id: "comment:reply",
    content: "Appended factual answer",
    digest: digest("Appended factual answer"),
  };
  const prior = previous && store.run(previous.run_id);
  const request = {
    ...application.supervisor.request(job.id, "investigation", {
      scenario: "session_checkpoint",
    }),
    bootstrap_receipt: bootstrap.id,
    conversation: {
      version: 1,
      id: conversationId,
      messages: starting ? [initial] : [initial, answer],
    },
    ...(prior
      ? {
          resume: {
            id: prior.session_id,
            binding: JSON.parse(prior.binding_json).binding,
          },
        }
      : {}),
  };
  const events = [];
  for await (const event of application.supervisor.run(request, signal))
    events.push(event);
  const terminal = events.at(-1);
  assert.equal(terminal.outcome, "completed", JSON.stringify(events));
  const record = conversations.get(conversationId);
  assert.equal(record.messages.length, starting ? 1 : 2);
  const manifest = store.artifact(terminal.artifact, job.id, job.revision);
  const unfinished = manifest.files.find(
    (file) => file.path === "unfinished.txt",
  );
  assert(unfinished?.kind === "file");
  assert.equal(
    await readFile(
      join(root, "runtime", "private", "blobs", unfinished.digest),
      "utf8",
    ),
    starting ? "first" : "first-second",
  );
  assert(
    !manifest.files.some((file) =>
      /node_modules|\.venv|README.md/.test(file.path),
    ),
  );
  const after = JSON.parse(store.job(number).budget_json);
  assert(after.model_requests > before.model_requests);
  assert(after.active_ms >= before.active_ms);
  if (phase === "interrupt") {
    await store.checkpoint(signal);
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  }
  if (!starting) {
    const count = store.runs().length,
      budget = store.job(number).budget_json;
    const replay = [];
    for await (const event of application.supervisor.run(request, signal))
      replay.push(event);
    assert.deepEqual(replay.at(-1), terminal);
    assert.equal(
      store.runs().length,
      count,
      "Duplicate input started another worker",
    );
    assert.equal(
      store.job(number).budget_json,
      budget,
      "Duplicate input consumed budget",
    );
  }
  for (const role of ["audit", "output_review"]) {
    const fresh = [];
    for await (const event of application.supervisor.run(
      {
        ...application.supervisor.request(
          job.id,
          role,
          { scenario: "session_audit" },
          terminal.artifact,
        ),
      },
      signal,
    ))
      fresh.push(event);
    assert.equal(fresh.at(-1).outcome, "completed", JSON.stringify(fresh));
  }
  await store.checkpoint(signal, true);
  outcome = {
    outcome: "waiting",
    reason: "session_verified",
    ...state.identifiers(),
    before,
    after: JSON.parse(store.job(number).budget_json),
    messages: record.messages.length,
    native_id: store.run(record.run_id).session_id,
  };
} finally {
  await application.close();
}
console.log(JSON.stringify(outcome));
