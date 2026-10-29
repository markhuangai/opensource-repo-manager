import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  digest,
  taskPrompt,
  type AgentRunRequest,
} from "../src/domain/agents.ts";
import { Store } from "../src/repositories/store.ts";
import { ConversationRepository } from "../src/repositories/conversations.ts";
import { fixtureSnapshot } from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orm-conversation-"));
  cleanups.push(() => rm(root, { recursive: true }));
  const store = new Store(join(root, "state.sqlite"));
  cleanups.push(async () => {
    if (store.db.open) store.close();
  });
  const { snapshot } = await fixtureSnapshot();
  store.saveSnapshot(snapshot);
  store.enroll({
    id: 42,
    full_name: "owner/repo",
    default_branch: "main",
    private: false,
  });
  const source = {
    sha: "a".repeat(40),
    tree_sha: "b".repeat(40),
    default_branch: "main",
  };
  store.applyIssue(
    store.refreshIssue(1),
    { ...makeIssue(1), state: "open", comments: [], source },
    snapshot,
  );
  const repository = new ConversationRepository(store);
  const message = (id: string, content: string) => ({
    id,
    content,
    digest: digest(content),
  });
  const request: AgentRunRequest = {
    job_id: store.job(1)!.id,
    revision: 1,
    role: "investigation",
    input: { objective: "Investigate this immutable task" },
    workspace: { source },
    snapshot_digest: snapshot.digest,
    profile: snapshot.roles.investigation.profile,
    conversation: {
      version: 1,
      id: randomUUID(),
      messages: [message("comment:1", "Initial facts")],
    },
  };
  function complete(selected: AgentRunRequest) {
    const lease = store.acquireLease(selected.job_id, 1)!;
    store.startRuntimeLease(lease, 60000);
    const run = randomUUID(),
      session = selected.resume?.id ?? randomUUID(),
      binding = "c".repeat(64);
    store.startRun({
      id: run,
      job_id: selected.job_id,
      revision: 1,
      role: selected.role,
      uid: 10001,
      parent_id: null,
      lease_token: lease,
      binding_json: "{}",
    });
    store.bindRun(run, binding);
    const terminal = {
      type: "terminal" as const,
      outcome: "completed" as const,
      result: { finding: "verified" },
    };
    store.db
      .transaction(() => {
        store.finishRun(run, "completed", session, null);
        repository.complete(selected, run, terminal);
      })
      .immediate();
    store.releaseLease(lease);
    return { id: session, binding };
  }
  return { store, repository, request, message, complete, root };
}

describe("controller-admitted conversations", () => {
  it("appends only new messages and returns the acknowledged result for duplicate delivery", async () => {
    const f = await setup();
    expect(f.repository.prepare(f.request)?.conversation.messages).toHaveLength(
      1,
    );
    const resume = f.complete(f.request);
    const next = {
      ...f.request,
      resume,
      conversation: {
        ...f.request.conversation!,
        messages: [
          ...f.request.conversation!.messages,
          f.message("comment:2", "The failure also occurs on ARM64"),
        ],
      },
    };
    const pending = f.repository.prepare(next)!;
    expect(pending.conversation.messages.map((item) => item.id)).toEqual([
      "comment:2",
    ]);
    expect(
      taskPrompt(
        { ...next, conversation: pending.conversation },
        "original user prompt",
      ),
    ).not.toContain("Initial facts");
    f.complete(next);
    const before = f.store.job(1)!.budget_json;
    expect(f.repository.prepare(next)?.duplicate).toEqual({
      type: "terminal",
      outcome: "completed",
      result: { finding: "verified" },
    });
    expect(
      f.repository.prepare({
        ...next,
        conversation: {
          ...next.conversation,
          messages: [
            ...next.conversation.messages,
            ...next.conversation.messages,
          ],
        },
      })?.duplicate?.outcome,
    ).toBe("completed");
    expect(
      f.repository.get(next.conversation.id)?.messages.map((item) => item.id),
    ).toEqual(["comment:1", "comment:2"]);
    expect(f.store.job(1)!.budget_json).toBe(before);
  });

  it("rejects edited message identities, changed immutable inputs, foreign revisions, and resumable auditors", async () => {
    const f = await setup(),
      resume = f.complete(f.request);
    const next = { ...f.request, resume };
    expect(() =>
      f.repository.prepare({
        ...next,
        conversation: {
          ...next.conversation!,
          messages: [f.message("comment:1", "Edited facts")],
        },
      }),
    ).toThrow("conversation_message_conflict");
    expect(() =>
      f.repository.prepare({ ...next, input: "new objective" }),
    ).toThrow("conversation_mismatch");
    expect(() => f.repository.prepare({ ...next, revision: 2 })).toThrow(
      "conversation_mismatch",
    );
    for (const role of ["audit", "output_review"] as const)
      expect(() => f.repository.prepare({ ...next, role })).toThrow(
        "conversation_invalid",
      );
    expect(() =>
      f.repository.prepare({
        ...next,
        conversation: {
          ...next.conversation!,
          messages: [{ id: "next", content: "facts", digest: "d".repeat(64) }],
        },
      }),
    ).toThrow("conversation_message_conflict");
  });

  it("retains messages and task accounting through SQLite reopen and upgrades schema 10 additively", async () => {
    const f = await setup(),
      resume = f.complete(f.request);
    const path = join(f.root, "state.sqlite"),
      checkpoint = f.repository.get(f.request.conversation!.id),
      jobs = f.store.jobs();
    f.store.close();
    const reopened = new Store(path);
    try {
      expect(
        new ConversationRepository(reopened).get(f.request.conversation!.id),
      ).toEqual(checkpoint);
      expect(
        new ConversationRepository(reopened).prepare({ ...f.request, resume })
          ?.duplicate?.outcome,
      ).toBe("completed");
      reopened.db.exec(
        "DROP TABLE agent_conversations; PRAGMA user_version=10",
      );
    } finally {
      reopened.close();
    }
    const upgraded = new Store(path);
    try {
      expect(upgraded.db.pragma("user_version", { simple: true })).toBe(11);
      expect(upgraded.jobs()).toEqual(jobs);
      expect(
        upgraded.db.prepare("SELECT * FROM agent_conversations").all(),
      ).toEqual([]);
    } finally {
      upgraded.close();
    }
  });

  it("preserves legacy callers and their initial prompt", async () => {
    const f = await setup();
    const legacy = { ...f.request };
    Reflect.deleteProperty(legacy, "conversation");
    expect(f.repository.prepare(legacy)).toBeUndefined();
    expect(taskPrompt(legacy, "user prompt")).toBe(
      `user prompt\n\nTask data (not authorization):\n${JSON.stringify({ role: legacy.role, input: legacy.input })}`,
    );
  });
});
