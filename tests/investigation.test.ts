import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/repositories/store.ts";
import { InvestigationRepository } from "../src/repositories/investigation.ts";
import { fixtureSnapshot } from "./fixtures.ts";
import { createPublicationFixture } from "./fixtures/publication.ts";
import { resolveSourceEvidence } from "../src/services/investigation/evidence.ts";
import {
  investigationPlanSchema,
  renderFindings,
} from "../src/services/investigation/contracts.ts";
import type { IssueContext } from "../src/domain/jobs.ts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orm-investigation-"));
  cleanups.push(() => rm(root, { recursive: true }));
  const path = join(root, "state", "manager.sqlite");
  let store = new Store(path);
  cleanups.push(() => {
    if (store.db.open) store.close();
  });
  const loaded = await fixtureSnapshot();
  store.saveSnapshot(loaded.snapshot);
  store.enroll({
    id: 42,
    full_name: "owner/repo",
    default_branch: "main",
    private: false,
  });
  const context: IssueContext = {
    id: 101,
    number: 1,
    title: "Issue",
    body: "bug",
    state: "open",
    updated_at: "2026-10-21T00:00:00Z",
    comments: [],
    source: {
      sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
      default_branch: "main",
    },
  };
  const apply = () =>
    store.applyIssue(store.refreshIssue(1), context, loaded.snapshot);
  apply();
  return {
    root,
    path,
    loaded,
    context,
    apply,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new Store(path);
      return store;
    },
    repository: new InvestigationRepository(store),
  };
}

describe("durable investigations", () => {
  it("allows the last retry and retains a denied reservation across revisions and restart", async () => {
    const f = await fixture(),
      job = f.store.job(1)!,
      limit = f.loaded.snapshot.settings.limits.infrastructure_retries;
    for (let attempt = 0; attempt < limit; attempt++)
      expect(f.store.reserveInfrastructureRetry(job.id)).toBe(true);
    const allowed = JSON.parse(f.store.job(1)!.budget_json);
    expect(allowed.infrastructure_retries).toBe(limit);
    expect(allowed.infrastructure_exhausted).toBeUndefined();
    expect(f.store.reserveInfrastructureRetry(job.id)).toBe(false);
    const denied = f.store.job(1)!.budget_json;
    expect(JSON.parse(denied)).toMatchObject({
      infrastructure_retries: limit,
      infrastructure_exhausted: true,
    });
    f.context.body = "Human clarification";
    f.apply();
    expect(f.store.job(1)!.revision).toBe(job.revision + 1);
    expect(f.reopen().job(1)!.budget_json).toBe(denied);
    expect(f.store.reserveInfrastructureRetry(job.id)).toBe(false);
    expect(JSON.parse(f.store.job(1)!.budget_json)).toEqual(JSON.parse(denied));
  });

  it.each(["needs_information", "no_fix", "manual_feature"] as const)(
    "keeps completed %s evidence pinned until issue activity changes",
    async (outcome) => {
      const f = await fixture(),
        job = f.store.job(1)!,
        record = f.repository.ensure(job);
      record.stage = "completed";
      record.result = {
        outcome,
        summary: "Reviewed source",
        proof: "none",
        objective: "",
        evidence_ids: [],
        questions: [],
      };
      f.repository.save(record);
      f.context.source = { ...f.context.source, sha: "c".repeat(40) };
      f.apply();
      expect(f.store.job(1)).toEqual(job);
      f.context.comments.push({
        id: 7,
        body: "New information",
        updated_at: "2026-10-21T00:01:00Z",
        user: { id: 7, login: "human" },
      });
      f.apply();
      expect(f.store.job(1)!.revision).toBe(job.revision + 1);
      expect(JSON.parse(f.store.job(1)!.input_json).source.sha).toBe(
        f.context.source.sha,
      );
      expect(f.repository.get(record.id).source).toEqual(record.source);
    },
  );

  it.each(["inspecting", "completed"] as const)(
    "invalidates source drift during %s maintenance work without resetting budgets",
    async (stage) => {
      const f = await fixture(),
        record = f.repository.ensure(f.store.job(1)!);
      record.stage = stage;
      record.result = {
        outcome: "maintenance_candidate",
        bug: {
          expected_behavior: "Documented existing behavior",
          observed_behavior: "Supported behavior fails",
          existing_contract: "Verified supported source contract",
        },
        summary: "Defect",
        proof: "source",
        objective: "Fix defect",
        evidence_ids: [],
        questions: [],
      };
      f.repository.save(record);
      f.store.db
        .prepare(
          "UPDATE jobs SET phase=?,budget_json=json_set(budget_json,'$.model_requests',19)",
        )
        .run(stage === "completed" ? "implementation" : "investigation");
      f.context.source = { ...f.context.source, sha: "d".repeat(40) };
      f.apply();
      expect(f.store.job(1)).toMatchObject({
        revision: 2,
        phase: "investigation",
      });
      expect(JSON.parse(f.store.job(1)!.budget_json).model_requests).toBe(19);
      expect(() => f.repository.assertCurrent(record)).toThrow(
        "revision_stale",
      );
    },
  );

  it("preserves interrupted checkpoints and rejects evidence from another revision", async () => {
    const f = await fixture(),
      record = f.repository.ensure(f.store.job(1)!);
    record.stage = "summarizing";
    record.agent_pending = true;
    record.evidence_ids = [
      f.repository.recordEvidence({
        job_id: 1,
        revision: 1,
        source: f.context.source,
        kind: "context",
        details: { issue: "untrusted" },
      }),
    ];
    f.repository.save(record);
    const repository = new InvestigationRepository(f.reopen());
    expect(repository.get(record.id)).toEqual(record);
    expect(() =>
      repository.evidence(record.evidence_ids[0], 1, 2, f.context.source),
    ).toThrow("investigation_evidence_missing");
    expect(() =>
      repository.evidence(record.evidence_ids[0], 1, 1, {
        ...f.context.source,
        sha: "f".repeat(40),
      }),
    ).toThrow("investigation_evidence_mismatch");
    f.context.state = "closed";
    f.apply();
    expect(() => repository.assertCurrent(record)).toThrow("revision_stale");
  });

  it("requires confirmed publication before implementation handoff", async () => {
    const f = await fixture(),
      record = f.repository.ensure(f.store.job(1)!);
    record.result = {
      outcome: "maintenance_candidate",
      bug: {
        expected_behavior: "Documented existing behavior",
        observed_behavior: "Supported behavior fails",
        existing_contract: "Verified supported source contract",
      },
      summary: "Defect",
      proof: "source",
      objective: "Fix defect",
      evidence_ids: [],
      questions: [],
    };
    expect(() => f.repository.finish(record)).toThrow(
      "investigation_publication_unconfirmed",
    );
    expect(f.store.job(1)!.phase).toBe("investigation");
    expect(renderFindings(record)).toContain("not reproduced");
  });

  it("resolves actual pinned Git bytes and rejects forged paths and ranges", async () => {
    const f = await fixture(),
      remote = await createPublicationFixture(join(f.root, "git"));
    cleanups.push(() => remote.close());
    f.context.source = remote.source;
    f.apply();
    const job = f.store.job(1)!;
    const binding = {
      job_id: job.id,
      revision: job.revision,
      source: remote.source,
      snapshot_digest: job.snapshot_digest,
      repository: "owner/repo",
    };
    const resolve = (path: string, end_line = 1) =>
      resolveSourceEvidence(
        f.store,
        f.loaded.secrets,
        join(f.root, "evidence"),
        binding,
        [{ kind: "source", path, start_line: 1, end_line }],
        1048576,
        new AbortController().signal,
        () => remote.url + "/owner/repo.git",
      );
    expect(await resolve("app.txt")).toMatchObject([
      { text: "original", source: remote.source },
    ]);
    await expect(resolve("missing.txt")).rejects.toThrow(
      "investigation_evidence_path_invalid",
    );
    await expect(resolve("app.txt", 99)).rejects.toThrow(
      "investigation_evidence_range_invalid",
    );
    await expect(resolve("image.bin")).rejects.toThrow(
      "publication_binary_unsupported",
    );
    expect(
      investigationPlanSchema.safeParse({
        hypothesis: "Escape",
        citations: [
          { kind: "source", path: "../secret", start_line: 1, end_line: 1 },
        ],
        commands: [],
      }).success,
    ).toBe(false);
  });
});
