import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/repositories/store.ts";
import { IntakeService } from "../src/services/intake.ts";
import { fixtureGitHub, fixtureSnapshot } from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => AbortSignal.timeout(10000);
async function setup(
  hooks: ConstructorParameters<typeof IntakeService>[4] = {},
) {
  const root = await mkdtemp(join(tmpdir(), "orm-intake-"));
  const github = await fixtureGitHub();
  const loaded = await fixtureSnapshot();
  const store = new Store(join(root, "state", "manager.sqlite"));
  const service = new IntakeService(
    store,
    github.reader,
    loaded.snapshot,
    loaded.secrets,
    hooks,
  );
  cleanups.push(async () => {
    await service.stop();
    store.close();
    await github.close();
    await rm(root, { recursive: true });
  });
  return { github, loaded, store, service };
}

describe("selected-issue intake", () => {
  it("enrolls only the selected issue without scanning backlog", async () => {
    const f = await setup();
    f.github.state.issues[2] = makeIssue(2);
    expect(f.service.enrolled()).toBe(false);
    await expect(f.service.refresh(1, signal())).rejects.toThrow(
      "enrollment_pending",
    );
    await f.service.enrollIssue(1, signal());
    expect(f.service.enrolled()).toBe(true);
    expect(f.store.jobs().map((job) => job.issue_number)).toEqual([1]);
    expect(
      f.github.requests.some((request) =>
        request.url?.match(/\/issues(?:\?|$)/),
      ),
    ).toBe(false);
  });
  it("uses current GitHub state for closure and reopening without resetting budgets or snapshots", async () => {
    const f = await setup();
    await f.service.enrollIssue(1, signal());
    const initial = f.store.job(1)!;
    f.store.db
      .prepare(
        "UPDATE jobs SET budget_json=json_set(budget_json,'$.model_requests',17)",
      )
      .run();
    f.github.state.issues[1].state = "closed";
    await f.service.refresh(1, signal());
    const closed = f.store.job(1)!;
    expect(closed.status).toBe("closed");
    await f.service.refresh(1, signal());
    expect(f.store.job(1)!.revision).toBe(closed.revision);
    f.github.state.issues[1].state = "open";
    await f.service.refresh(1, signal());
    expect(f.store.job(1)).toMatchObject({
      id: initial.id,
      revision: closed.revision + 1,
      snapshot_digest: initial.snapshot_digest,
    });
    expect(JSON.parse(f.store.job(1)!.budget_json).model_requests).toBe(17);
  });
  it("filters only recorded automation comments, preserving human replies by the same account", async () => {
    const f = await setup();
    await f.service.enrollIssue(1, signal());
    const job = f.store.job(1)!;
    f.store.recordPublication({
      operation_key: "owned",
      job_id: job.id,
      revision: job.revision,
      kind: "issue_comment",
      object_id: "9001",
      number: null,
      head_sha: null,
      receipt_json: "{}",
    });
    f.github.state.comments[1] = [9001, 9002].map((id) => ({
      id,
      body: String(id),
      updated_at: "2026-11-02T00:00:00Z",
      user: { id: 7, login: "pat-owner" },
    }));
    await f.service.refresh(1, signal());
    expect(
      JSON.parse(f.store.job(1)!.input_json).comments.map(
        (comment: { id: number }) => comment.id,
      ),
    ).toEqual([9002]);
  });
  it("fences a completed old read when a newer refresh applies first", async () => {
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await setup({
      beforeIssue: async (context) => {
        if (context.body === "stale") {
          entered();
          await releasing;
        }
      },
    });
    await f.service.enrollIssue(1, signal());
    f.github.state.issues[1].body = "stale";
    const stale = f.service.refresh(1, signal());
    await entering;
    try {
      f.github.state.issues[1].body = "current";
      await f.service.refresh(1, signal());
    } finally {
      release();
    }
    await stale;
    expect(JSON.parse(f.store.job(1)!.input_json).body).toBe("current");
    expect(f.store.job(1)!.revision).toBe(2);
  });
  it("refuses secret-bearing input and preserves the last accepted issue", async () => {
    const f = await setup();
    await f.service.enrollIssue(1, signal());
    const before = f.store.job(1);
    f.github.state.issues[1].body = f.loaded.secrets.get("github.token");
    await expect(f.service.refresh(1, signal())).rejects.toThrow(
      "secret_in_input",
    );
    expect(f.store.job(1)).toEqual(before);
  });
  it.each([
    [401, "github_authentication"],
    [429, "github_rate_limited"],
    [500, "github_read_failed"],
  ] as const)(
    "propagates %i provider failures without accepting input",
    async (status, code) => {
      const f = await setup();
      f.github.state.failures["/repos/owner/repo/issues/1"] = { status };
      await expect(f.service.enrollIssue(1, signal())).rejects.toThrow(code);
      expect(f.store.jobs()).toEqual([]);
    },
  );
  it("propagates storage failures instead of acknowledging uncommitted work", async () => {
    const f = await setup();
    f.store.db.exec(
      "CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'storage failure'); END",
    );
    await expect(f.service.enrollIssue(1, signal())).rejects.toThrow(
      "storage failure",
    );
    expect(f.store.jobs()).toEqual([]);
  });
  it("rejects repository replacement and stops accepting refreshes after cancellation", async () => {
    const f = await setup();
    await f.service.enrollIssue(1, signal());
    f.github.state.repository.id = 99;
    await expect(f.service.enrollIssue(1, signal())).rejects.toThrow(
      "repository_changed",
    );
    expect(f.store.repository()!.id).toBe(42);
    await f.service.stop();
    expect(f.service.enrolled()).toBe(false);
    await expect(f.service.refresh(1, signal())).rejects.toThrow();
  });
});
