import { setTimeout } from "node:timers/promises";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { GitHubActionsSource } from "../adapters/github/actions-source.ts";
import {
  assertRemoteDevPin,
  assertTurnRun,
  type RemoteDevActions,
} from "../adapters/github/remote-dev.ts";
import type { ActionsConfiguration, Role } from "../config/schema.ts";
import { digest, RuntimeError } from "../domain/agents.ts";
import type { RepositoryIdentity } from "../domain/jobs.ts";
import { remoteDev } from "../domain/remote-turns.ts";
import { issueDigest } from "../repositories/actions.ts";
import { authenticatedTask } from "./routing.ts";

export async function authorizeAgent(
  source: GitHubActionsSource,
  api: RemoteDevActions,
  repository: RepositoryIdentity,
  input: {
    issue: number;
    turn: string;
    plan: string;
    run: number;
    configSha: string;
    config: ActionsConfiguration;
  },
  sessionKey: string,
  signal: AbortSignal,
) {
  if (
    !z.uuid().safeParse(input.turn).success ||
    !input.plan ||
    Buffer.byteLength(input.plan) > remoteDev.planBytes ||
    !Number.isSafeInteger(input.run) ||
    input.run < 1
  )
    throw new RuntimeError("agent_request_invalid");
  const run = await api.run(input.run, signal);
  assertRemoteDevPin(run);
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await authenticatedTask(
      source,
      repository,
      input.issue,
      sessionKey,
      signal,
    );
    const turn = state?.agent_turn;
    if (
      !state ||
      !turn ||
      turn.id !== input.turn ||
      turn.plan_digest !== digest(input.plan) ||
      state.job?.id !== turn.job_id ||
      state.job.revision !== turn.revision ||
      state.job.phase !== turn.phase ||
      state.job.status !== "pending" ||
      turn.caller_sha !== input.configSha ||
      input.config.roles[turn.role].profile !== turn.profile ||
      input.config.profiles[turn.profile]?.sdk !== turn.runner ||
      turn.elapsed_ms !== null
    )
      throw new RuntimeError("agent_request_unauthorized");
    assertTurnRun(repository, state.author_id, input.issue, turn, run);
    if (turn.run_id === run.id) {
      const issue = await source.reader.issue(input.issue, repository, signal);
      const pull = state.pull && (await source.pull(state.pull.number, signal));
      if (
        issue.state !== "open" ||
        issue.source.sha !== input.configSha ||
        issueDigest(issue) !== state.job.issue_digest ||
        (state.pull &&
          pull &&
          (pull.state !== "open" ||
            pull.id !== state.pull.id ||
            pull.head !== state.pull.head ||
            pull.branch !== state.branch ||
            pull.repository_id !== repository.id ||
            pull.base_repository_id !== repository.id))
      )
        throw new RuntimeError("agent_revision_superseded");
      if (
        turn.work_branch &&
        (turn.role !== "implementation" ||
          state.scope?.revision !== turn.revision ||
          state.job.phase === "investigation" ||
          turn.work_branch !== `orm-work/${state.task_id}/${turn.id}` ||
          (await source.branch(turn.work_branch, signal)).head !== null)
      )
        throw new RuntimeError("agent_write_unauthorized");
      await requireAgentConfiguration(source, repository, run, signal);
      return {
        runner: turn.runner,
        profile: turn.profile,
        write: Boolean(turn.work_branch),
        timeout_minutes: turn.timeout_minutes,
      };
    }
    await setTimeout(2000, undefined, { signal });
  }
  throw new RuntimeError("agent_dispatch_unregistered");
}

export async function requireAgentConfiguration(
  source: GitHubActionsSource,
  repository: RepositoryIdentity,
  run: { head_sha: string; actor: { id: number; login: string } },
  signal: AbortSignal,
) {
  const pinned = await source.files(repository, signal);
  const file = pinned.files.find((file) => file.path === ".remote-dev.yml");
  if (pinned.source.sha !== run.head_sha || !file)
    throw new RuntimeError("agent_project_configuration_invalid");
  const bytes = await source.blob(file, signal);
  if (bytes.length > 65536)
    throw new RuntimeError("agent_project_configuration_invalid");
  const doc = parseDocument(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    { uniqueKeys: true, strict: true, schema: "core" },
  );
  if (doc.errors.length || doc.warnings.length)
    throw new RuntimeError("agent_project_configuration_invalid");
  const config: unknown = doc.toJS({ maxAliasCount: 0 });
  if (
    !z
      .object({ "auto-continue": z.literal(false).optional() })
      .safeParse(config).success
  )
    throw new RuntimeError("agent_automatic_continuation_enabled");
  if (
    !z
      .object({
        skills: z.tuple([]).optional(),
        "user-level-md-url": z.undefined().optional(),
      })
      .safeParse(config).success
  )
    throw new RuntimeError("agent_project_configuration_unpinned");
  const actor = z
    .object({ "allowed-actors": z.array(z.string()) })
    .safeParse(config);
  if (
    !actor.success ||
    !actor.data["allowed-actors"].includes(run.actor.login) ||
    !(await source.reader.maintainer(run.actor, signal))
  )
    throw new RuntimeError("agent_actor_unauthorized");
}

export function probeProfile(config: ActionsConfiguration, role: Role) {
  const profile = config.roles[role].profile;
  return {
    runner: config.profiles[profile].sdk,
    profile,
    write: false,
    timeout_minutes: 2,
  };
}
