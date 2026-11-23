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
      if (turn.progress) {
        const progress = turn.progress;
        const coding = state.agent_recovery?.coding;
        if (
          turn.role !== "implementation" ||
          !state.scope ||
          state.agent_recovery?.revision !== turn.revision ||
          !coding ||
          coding.key !== progress.key ||
          coding.branch !== progress.branch ||
          coding.head !== progress.head ||
          coding.base_sha !== progress.base_sha ||
          coding.parent_sha !== progress.parent_sha ||
          coding.writer_run_id !== turn.previous_writer_run_id ||
          progress.parent_sha !== (state.pr?.head ?? state.job.source.sha) ||
          !progress.branch.startsWith(`orm-work/${state.task_id}/`) ||
          progress.branch === turn.work_branch ||
          Boolean(turn.work_branch) === Boolean(turn.assessment) ||
          (await source.branch(progress.branch, signal)).head !== progress.head
        )
          throw new RuntimeError("agent_progress_conflict");
        if (coding.writer_run_id) {
          const previous = await api.latest(coding.writer_run_id, signal);
          if (
            previous.status !== "completed" ||
            previous.repository.id !== repository.id ||
            previous.head_repository.id !== repository.id ||
            previous.actor.id !== state.author_id ||
            previous.workflow_id !== turn.workflow_id ||
            previous.path !== `.github/workflows/${remoteDev.dispatcher}` ||
            previous.event !== "workflow_dispatch" ||
            !previous.display_title.startsWith(`ORM agent #${input.issue} `)
          )
            throw new RuntimeError("agent_progress_conflict");
        }
        if (turn.assessment) {
          const candidate = turn.assessment;
          if (
            !coding.candidate ||
            digest(coding.candidate) !== digest(candidate) ||
            candidate.writer_run_id !== coding.writer_run_id ||
            !candidate.branch.startsWith(`orm-work/${state.task_id}/`) ||
            turn.starting_sha !== candidate.sha ||
            (
              await source.workCandidate(
                candidate.branch,
                progress.parent_sha,
                progress.head,
                signal,
              )
            )?.sha !== candidate.sha
          )
            throw new RuntimeError("agent_progress_conflict");
        } else if (turn.starting_sha !== (progress.head ?? progress.base_sha)) {
          throw new RuntimeError("agent_progress_conflict");
        }
      }
      if (turn.resume) {
        const session = turn.work_branch
          ? state.agent_recovery?.coding?.session
          : state.agent_recovery?.investigation;
        if (
          (!turn.work_branch && turn.role !== "investigation") ||
          !session ||
          digest(session) !== digest(turn.resume) ||
          session.key !== turn.recovery_key ||
          (await api.resumeStatus(
            repository,
            state.author_id,
            input.issue,
            turn,
            session,
            signal,
          )) !== "available"
        )
          throw new RuntimeError("agent_resume_unavailable");
      }
      if (
        turn.progress &&
        (await source.branch(turn.progress.branch, signal)).head !==
          turn.progress.head
      )
        throw new RuntimeError("agent_progress_conflict");
      const remaining = Math.floor(
        (state.limits.active_ms - state.budget.active_ms) / 60000,
      );
      if (remaining < 1 || state.budget.agent_runs > state.limits.agent_runs)
        throw new RuntimeError("agent_budget_exhausted");
      await requireAgentConfiguration(source, repository, run, signal);
      return {
        runner: turn.runner,
        profile: turn.profile,
        write: Boolean(turn.work_branch),
        timeout_minutes: Math.min(turn.timeout_minutes, remaining),
        ...(turn.resume ? { resume_run_id: turn.resume.run_id } : {}),
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
