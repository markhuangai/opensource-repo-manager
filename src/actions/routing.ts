import { z } from "zod";
import { githubId, type RepositoryIdentity } from "../domain/jobs.ts";
import type { GitHubActionsSource } from "../adapters/github/actions-source.ts";
import {
  StateCodec,
  StateError,
  stateMarker,
  type TaskState,
} from "./state.ts";

const eventSchema = z.object({
  repository: z.object({ id: githubId, full_name: z.string() }),
  action: z.string().optional(),
  issue: z
    .object({ number: githubId, pull_request: z.unknown().optional() })
    .optional(),
  pull_request: z.object({ number: githubId }).optional(),
  comment: z.object({ id: githubId }).optional(),
  sender: z.object({ id: githubId, login: z.string() }).optional(),
});
export type RoutingSource = Pick<
  GitHubActionsSource,
  | "repository"
  | "actor"
  | "taskIssue"
  | "comments"
  | "pull"
  | "enrolled"
  | "reader"
>;

export async function authenticatedTask(
  source: RoutingSource,
  repository: RepositoryIdentity,
  number: number,
  key: string,
  signal: AbortSignal,
) {
  const issue = await source.taskIssue(number, signal);
  if (!issue.managed) return null;
  const actor = await source.actor(signal);
  const rows = (await source.comments(number, signal)).filter(
    (row) => row.author_id === actor.id && row.body.includes(stateMarker),
  );
  if (rows.length !== 1)
    throw new StateError(rows.length ? "state_conflict" : "state_missing");
  const state = new StateCodec(key).decode(rows[0].body, {
    repository_id: repository.id,
    issue_id: issue.id,
    comment_id: rows[0].id,
    author_id: actor.id,
  }).state;
  if (
    state.issue.number !== number ||
    state.repository.full_name.toLowerCase() !==
      repository.full_name.toLowerCase()
  )
    throw new StateError("state_incompatible");
  return state;
}

function ownedComment(state: TaskState, id: number) {
  return (
    state.comment_id === id ||
    (state.question &&
      "comment_id" in state.question &&
      state.question.comment_id === id) ||
    state.pr?.owned?.some(
      (item) => item.kind === "issue_comment" && item.id === id,
    ) ||
    state.pending?.steps.some(
      (step) =>
        step.object_id === id &&
        ["comment", "question_comment", "notification_comment"].includes(
          step.kind,
        ),
    )
  );
}

export async function routeActions(
  source: RoutingSource,
  request: {
    event: string;
    payload: unknown;
    repository: string;
    sessionKey: string;
    issueNumber?: string;
    ref?: string;
    now?: number;
  },
  signal: AbortSignal,
) {
  const repository = await source.repository(signal);
  const event = eventSchema.parse(request.payload);
  if (
    event.repository.id !== repository.id ||
    event.repository.full_name.toLowerCase() !==
      repository.full_name.toLowerCase() ||
    request.repository.toLowerCase() !== repository.full_name.toLowerCase()
  )
    throw new StateError("state_invalid");
  let numbers: number[] = [];
  if (request.event === "workflow_dispatch") {
    if (
      !event.sender ||
      request.ref !== `refs/heads/${repository.default_branch}` ||
      !(await source.reader.maintainer(event.sender, signal))
    )
      throw new StateError("state_invalid");
    const number = request.issueNumber;
    if (
      !number ||
      !/^[1-9][0-9]*$/.test(number) ||
      !Number.isSafeInteger(Number(number))
    )
      throw new StateError("state_invalid");
    await source.taskIssue(Number(number), signal);
    numbers = [Number(number)];
  } else if (request.event === "schedule") {
    numbers = await source.enrolled(signal);
    const batches = Math.max(1, Math.ceil(numbers.length / 256));
    const page = Math.floor((request.now ?? Date.now()) / 900_000) % batches;
    numbers = numbers.slice(page * 256, (page + 1) * 256);
  } else if (
    request.event === "issues" &&
    event.issue &&
    !event.issue.pull_request &&
    ["opened", "edited", "reopened", "closed"].includes(event.action ?? "")
  ) {
    const issue = await source.taskIssue(event.issue.number, signal);
    if (issue.managed || (event.action === "opened" && issue.state === "open"))
      numbers = [issue.number];
  } else if (
    (request.event === "pull_request_target" &&
      ["synchronize", "closed"].includes(event.action ?? "")) ||
    (request.event === "issue_comment" &&
      event.action === "created" &&
      event.issue?.pull_request)
  ) {
    const number = event.pull_request?.number ?? event.issue?.number;
    if (!number) throw new StateError("state_invalid");
    const pull = await source.pull(number, signal);
    const match = /^orm\/[a-f0-9-]{36}\/issue-([1-9][0-9]*)$/.exec(pull.branch);
    if (
      match &&
      pull.repository_id === repository.id &&
      pull.base_repository_id === repository.id
    ) {
      const root = Number(match[1]);
      if (!Number.isSafeInteger(root)) throw new StateError("state_invalid");
      const state = await authenticatedTask(
        source,
        repository,
        root,
        request.sessionKey,
        signal,
      );
      const intent =
        state?.pending?.pull_intent ??
        state?.pr?.resume_publication?.pull_intent;
      const owned =
        state &&
        state.branch === pull.branch &&
        state.author_id === pull.author_id &&
        ((state.pull?.id === pull.id &&
          state.pull.number === pull.number &&
          state.pull.author_id === pull.author_id) ||
          (intent &&
            intent.branch === pull.branch &&
            intent.base === pull.base &&
            intent.title === pull.title &&
            intent.body === pull.body));
      if (owned && !(event.comment && ownedComment(state, event.comment.id)))
        numbers = [root];
    }
  } else if (
    request.event === "issue_comment" &&
    event.action === "created" &&
    event.issue &&
    event.comment
  ) {
    const state = await authenticatedTask(
      source,
      repository,
      event.issue.number,
      request.sessionKey,
      signal,
    );
    if (state && !ownedComment(state, event.comment.id))
      numbers = [event.issue.number];
  }
  return {
    version: 1,
    repository_id: repository.id,
    issues: [...new Set(numbers)],
  };
}
