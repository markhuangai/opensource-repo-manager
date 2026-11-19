import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { RuntimeError } from "../../domain/agents.ts";
import { githubId, type RepositoryIdentity } from "../../domain/jobs.ts";
import {
  remoteDev,
  remoteRunSchema,
  turnTitle,
  type RemoteRun,
  type RemoteTurn,
} from "../../domain/remote-turns.ts";

export class RemoteDevActions {
  private readonly coordinates;

  constructor(
    repository: string,
    private readonly api: Octokit,
  ) {
    const [owner, repo] = repository.split("/");
    this.coordinates = { owner, repo };
  }

  private async request(
    route: string,
    values: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    return this.api.request(route, {
      ...this.coordinates,
      ...values,
      request: {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        redirect: "error",
      },
    });
  }

  async workflow(signal: AbortSignal) {
    const workflow = z
      .object({ id: githubId, path: z.string(), state: z.literal("active") })
      .parse(
        (
          await this.request(
            "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}",
            { workflow_id: remoteDev.dispatcher },
            signal,
          )
        ).data,
      );
    if (workflow.path !== `.github/workflows/${remoteDev.dispatcher}`)
      throw new RuntimeError("agent_workflow_mismatch");
    return workflow.id;
  }

  async dispatch(
    repository: RepositoryIdentity,
    issue: number,
    turn: RemoteTurn,
    plan: string,
    signal: AbortSignal,
  ) {
    const response = await this.request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      {
        workflow_id: turn.workflow_id,
        ref: repository.default_branch,
        inputs: { issue: String(issue), turn: turn.id, plan },
        return_run_details: true,
      },
      signal,
    );
    if (response.status !== 200)
      throw new RuntimeError("agent_dispatch_uncertain");
    return z.object({ workflow_run_id: githubId }).parse(response.data)
      .workflow_run_id;
  }

  async run(id: number, signal: AbortSignal) {
    const run = remoteRunSchema.parse(
      (
        await this.request(
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/1",
          { run_id: id },
          signal,
        )
      ).data,
    );
    if (run.id !== id) throw new RuntimeError("agent_run_mismatch");
    return run;
  }

  async find(
    repository: RepositoryIdentity,
    actor: { id: number; login: string },
    issue: number,
    turn: RemoteTurn,
    signal: AbortSignal,
  ) {
    const schema = z.object({
      total_count: z.number().int().nonnegative(),
      workflow_runs: z.array(
        z.object({ id: githubId, display_title: z.string() }),
      ),
    });
    const matches = new Set<number>();
    const start = new Date(turn.created_at - 60_000).toISOString();
    const end = new Date(
      turn.created_at + remoteDev.registrationMs,
    ).toISOString();
    for (let page = 1; page <= 10; page++) {
      const runs = schema.parse(
        (
          await this.request(
            "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
            {
              workflow_id: turn.workflow_id,
              actor: actor.login,
              branch: repository.default_branch,
              event: "workflow_dispatch",
              created: `${start}..${end}`,
              per_page: 100,
              page,
            },
            signal,
          )
        ).data,
      );
      if (runs.total_count > 1000)
        throw new RuntimeError("agent_dispatch_uncertain");
      for (const run of runs.workflow_runs)
        if (run.display_title === turnTitle(issue, turn.id))
          matches.add(run.id);
      if (matches.size > 1) throw new RuntimeError("agent_dispatch_uncertain");
      if (page * 100 >= runs.total_count) break;
    }
    const [id] = matches;
    return id === undefined ? undefined : this.run(id, signal);
  }

  async executionTime(run: RemoteRun, signal: AbortSignal) {
    const data = z
      .object({
        jobs: z.array(
          z.object({
            steps: z
              .array(
                z.object({
                  name: z.string(),
                  started_at: z.iso
                    .datetime({ offset: true })
                    .nullable()
                    .optional(),
                  completed_at: z.iso
                    .datetime({ offset: true })
                    .nullable()
                    .optional(),
                }),
              )
              .optional(),
          }),
        ),
        total_count: z.number().int().nonnegative(),
      })
      .parse(
        (
          await this.request(
            "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
            { run_id: run.id, attempt_number: run.run_attempt, per_page: 100 },
            signal,
          )
        ).data,
      );
    const steps = data.jobs
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.name === "Execute agent" && step.started_at);
    if (data.total_count !== data.jobs.length || steps.length > 1)
      throw new RuntimeError("agent_run_mismatch");
    const step = steps[0];
    if (!step) return 0;
    const elapsed =
      Date.parse(step.completed_at ?? "") - Date.parse(step.started_at!);
    if (!Number.isFinite(elapsed) || elapsed < 0)
      throw new RuntimeError("agent_run_mismatch");
    return elapsed;
  }

  async cancel(run: RemoteRun, signal: AbortSignal) {
    if (run.status === "completed") return;
    await this.request(
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
      { run_id: run.id },
      signal,
    );
  }
}

export function assertDispatchRun(
  repository: RepositoryIdentity,
  actorId: number,
  issue: number,
  turn: RemoteTurn,
  run: RemoteRun,
) {
  if (
    (turn.run_id !== null && turn.run_id !== run.id) ||
    run.repository.id !== repository.id ||
    run.repository.full_name.toLowerCase() !==
      repository.full_name.toLowerCase() ||
    run.head_repository.id !== repository.id ||
    run.workflow_id !== turn.workflow_id ||
    run.path !== `.github/workflows/${remoteDev.dispatcher}` ||
    run.event !== "workflow_dispatch" ||
    run.display_title !== turnTitle(issue, turn.id) ||
    run.head_branch !== repository.default_branch ||
    run.run_attempt !== 1 ||
    run.actor.id !== actorId ||
    run.triggering_actor.id !== actorId ||
    Date.parse(run.created_at) < turn.created_at - 60000
  )
    throw new RuntimeError("agent_run_mismatch");
}

export function assertTurnRun(
  repository: RepositoryIdentity,
  actorId: number,
  issue: number,
  turn: RemoteTurn,
  run: RemoteRun,
) {
  assertDispatchRun(repository, actorId, issue, turn, run);
  if (run.head_sha !== turn.caller_sha)
    throw new RuntimeError("agent_run_mismatch");
}

export function assertRemoteDevPin(run: RemoteRun) {
  const prefix = `${remoteDev.repository}/${remoteDev.path}@`;
  const workflows = run.referenced_workflows?.filter((workflow) =>
    workflow.path.startsWith(prefix),
  );
  if (
    workflows?.length !== 1 ||
    workflows[0].sha !== remoteDev.sha ||
    ![remoteDev.tag, `refs/tags/${remoteDev.tag}`, remoteDev.sha].includes(
      workflows[0].path.slice(prefix.length),
    ) ||
    (workflows[0].ref !== undefined &&
      workflows[0].ref !== `refs/tags/${remoteDev.tag}`)
  )
    throw new RuntimeError("agent_provider_pin_mismatch");
}
