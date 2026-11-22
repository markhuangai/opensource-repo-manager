import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import {
  assertDispatchRun,
  assertRemoteDevPin,
  assertTurnRun,
  DispatchRunMismatch,
  RemoteDevActions,
} from "../src/adapters/github/remote-dev.ts";
import { digest } from "../src/domain/agents.ts";
import {
  remoteDev,
  remoteRunSchema,
  turnSchema,
  turnTitle,
} from "../src/domain/remote-turns.ts";

const repository = {
  id: 42,
  full_name: "owner/repo",
  default_branch: "main",
  private: false,
};
const actor = { id: 7, login: "controller" };
const start = "a".repeat(40);
const caller = "b".repeat(40);
const instructions = "Read the pinned source and assess the issue.";

function operation(runner: "claude" | "codex") {
  return turnSchema.parse({
    id: randomUUID(),
    job_id: 1,
    revision: 2,
    phase: "investigation",
    request_digest: digest({ runner }),
    role: "investigation",
    profile: "coding",
    runner,
    starting_sha: start,
    work_branch: null,
    plan_digest: digest(instructions),
    caller_sha: caller,
    workflow_id: 91,
    timeout_minutes: 5,
    created_at: Date.now(),
    run_id: null,
    elapsed_ms: null,
  });
}

function runFor(turn: ReturnType<typeof operation>) {
  return remoteRunSchema.parse({
    id: 9000,
    run_attempt: 1,
    workflow_id: turn.workflow_id,
    path: ".github/workflows/orm-agent.yml",
    event: "workflow_dispatch",
    display_title: turnTitle(18, turn.id),
    head_branch: "main",
    head_sha: caller,
    repository,
    head_repository: repository,
    actor,
    triggering_actor: actor,
    status: "completed",
    conclusion: "success",
    created_at: new Date().toISOString(),
    referenced_workflows: [
      {
        path: `${remoteDev.repository}/${remoteDev.path}@${remoteDev.sha}`,
        ref: `refs/tags/${remoteDev.tag}`,
        sha: remoteDev.sha,
      },
    ],
  });
}

describe("published remote development workflow", () => {
  it.each(["codex", "claude"] as const)(
    "dispatches and recovers the exact authorized %s operation",
    async (runner) => {
      const turn = operation(runner);
      const run = runFor(turn);
      const requests: Array<{
        method: string | undefined;
        path: string | undefined;
        body: unknown;
      }> = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : null;
        requests.push({ method: req.method, path: req.url, body });
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST" && req.url?.endsWith("/dispatches")) {
          res.end(JSON.stringify({ workflow_run_id: run.id }));
        } else if (
          req.url?.startsWith("/repos/owner/repo/actions/workflows/91/runs")
        ) {
          const query = new URL(req.url, "http://fixture").searchParams;
          res.end(
            JSON.stringify({
              total_count: 101,
              workflow_runs:
                query.get("page") === "2"
                  ? [{ ...run, run_attempt: 2 }]
                  : Array.from({ length: 100 }, (_, offset) => ({
                      id: 9100 + offset,
                      display_title: `Unrelated dispatch ${offset}`,
                    })),
            }),
          );
        } else if (
          req.url === "/repos/owner/repo/actions/runs/9000/attempts/1"
        ) {
          res.end(JSON.stringify(run));
        } else if (
          req.url?.startsWith(
            "/repos/owner/repo/actions/runs/9000/attempts/1/jobs?",
          )
        ) {
          res.end(
            JSON.stringify({
              total_count: 1,
              jobs: [
                {
                  steps: [
                    {
                      name: "Execute agent",
                      started_at: "2026-11-19T01:00:00-08:00",
                      completed_at: "2026-11-19T09:00:03Z",
                    },
                  ],
                },
              ],
            }),
          );
        } else {
          res
            .writeHead(404)
            .end(JSON.stringify({ message: "unexpected request" }));
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("fixture address unavailable");
        const api = new RemoteDevActions(
          repository.full_name,
          new Octokit({ baseUrl: `http://127.0.0.1:${address.port}` }),
        );
        const signal = AbortSignal.timeout(5000);
        expect(
          await api.dispatch(repository, 18, turn, instructions, signal),
        ).toBe(run.id);
        const recovered = await api.find(repository, actor, 18, turn, signal);
        expect(recovered?.id).toBe(run.id);
        expect(recovered?.run_attempt).toBe(1);
        expect(await api.run(run.id, signal)).toEqual(run);
        expect(await api.executionTime(run, signal)).toBe(3000);
        expect(requests.filter((request) => request.method === "POST")).toEqual(
          [
            {
              method: "POST",
              path: "/repos/owner/repo/actions/workflows/91/dispatches",
              body: {
                ref: "main",
                inputs: { issue: "18", turn: turn.id, plan: instructions },
                return_run_details: true,
              },
            },
          ],
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("rejects replaced provider revisions, another repository and reruns", () => {
    const turn = operation("codex");
    const run = runFor(turn);
    expect(() => assertRemoteDevPin(run)).not.toThrow();
    expect(() =>
      assertTurnRun(repository, actor.id, 18, turn, run),
    ).not.toThrow();
    expect(() =>
      assertTurnRun(repository, actor.id, 18, turn, { ...run, run_attempt: 2 }),
    ).toThrow("agent_run_mismatch");
    expect(() =>
      assertTurnRun(repository, actor.id, 18, turn, {
        ...run,
        head_repository: { id: 100 },
      }),
    ).toThrow("agent_run_mismatch");
    for (const changed of [
      { actor: { ...actor, id: 100 } },
      { triggering_actor: { id: 100 } },
      { head_sha: start },
    ])
      expect(() =>
        assertTurnRun(repository, actor.id, 18, turn, { ...run, ...changed }),
      ).toThrow("agent_run_mismatch");
    expect(() =>
      assertRemoteDevPin({
        ...run,
        referenced_workflows: [{ ...run.referenced_workflows![0], sha: start }],
      }),
    ).toThrow("agent_provider_pin_mismatch");
  });

  it("reports the failed dispatch identity comparison", () => {
    const pending = operation("claude");
    const run = runFor(pending);
    const turn = { ...pending, run_id: run.id };
    const earliest = turn.created_at - 60_000;
    const matching = {
      ...run,
      created_at: new Date(earliest).toISOString(),
      repository: { ...repository, full_name: "Owner/Repo" },
    };
    expect(() =>
      assertDispatchRun(repository, actor.id, 18, turn, matching),
    ).not.toThrow();
    for (const [field, expected, observed, change] of [
      ["id", run.id, 9001, { id: 9001 }],
      [
        "repository.id",
        repository.id,
        43,
        { repository: { ...repository, id: 43 } },
      ],
      [
        "repository.full_name",
        repository.full_name,
        "Owner/Other",
        { repository: { ...repository, full_name: "Owner/Other" } },
      ],
      [
        "head_repository.id",
        repository.id,
        43,
        { head_repository: { id: 43 } },
      ],
      ["workflow_id", turn.workflow_id, 92, { workflow_id: 92 }],
      [
        "path",
        run.path,
        ".github/workflows/other.yml",
        { path: ".github/workflows/other.yml" },
      ],
      ["event", "workflow_dispatch", "push", { event: "push" }],
      [
        "display_title",
        matching.display_title,
        "ORM agent",
        { display_title: "ORM agent" },
      ],
      [
        "head_branch",
        repository.default_branch,
        "other",
        { head_branch: "other" },
      ],
      ["run_attempt", 1, 2, { run_attempt: 2 }],
      ["actor.id", actor.id, 8, { actor: { ...actor, id: 8 } }],
      ["triggering_actor.id", actor.id, 8, { triggering_actor: { id: 8 } }],
      [
        "created_at",
        earliest,
        earliest - 1,
        { created_at: new Date(earliest - 1).toISOString() },
      ],
    ] as const) {
      const validate = () =>
        assertDispatchRun(repository, actor.id, 18, turn, {
          ...matching,
          ...change,
        });
      expect(validate).toThrow(DispatchRunMismatch);
      expect(validate).toThrow(
        expect.objectContaining({
          code: "agent_run_mismatch",
          field,
          expected,
          observed,
        }),
      );
    }
  });
});
