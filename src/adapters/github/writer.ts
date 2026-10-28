import { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  githubId,
  issueComment,
  repositoryIdentity,
  sha,
  IntakeError,
  type RepositoryIdentity,
  type IssueContext,
} from "../../domain/jobs.ts";
import type {
  OwnedComment,
  OwnedPull,
} from "../../services/publication/contracts.ts";

const user = z.object({
  id: githubId,
  login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/),
});
const comment = issueComment.pick({ id: true, body: true, user: true });
const pull = z.object({
  id: githubId,
  number: githubId,
  title: z.string(),
  body: z.string().nullable(),
  user: issueComment.shape.user,
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  head: z.object({ sha, ref: z.string(), repo: z.object({ id: githubId }) }),
  base: z.object({ ref: z.string(), repo: z.object({ id: githubId }) }),
});
export type RemotePull = OwnedPull & {
  state: "open" | "closed";
  draft: boolean;
  branch: string;
  repository_id: number;
  base_repository_id: number;
};
export type RemoteThread = {
  id: string;
  pull_id: number;
  pull_number: number;
  repository_id: number;
  resolved: boolean;
  comments: {
    id: number;
    node_id: string;
    body: string;
    author_login: string | null;
  }[];
};
export interface GitHubWriter {
  repository(signal: AbortSignal): Promise<RepositoryIdentity>;
  actor(signal: AbortSignal): Promise<{ id: number; login: string }>;
  issueOpen(
    number: number,
    signal: AbortSignal,
    expected?: Pick<IssueContext, "id" | "title" | "body">,
  ): Promise<boolean>;
  branch(
    name: string,
    signal: AbortSignal,
  ): Promise<{ head: string | null; protected: boolean }>;
  comments(issue: number, signal: AbortSignal): Promise<OwnedComment[]>;
  pulls(branch: string, signal: AbortSignal): Promise<RemotePull[]>;
  pull(number: number, signal: AbortSignal): Promise<RemotePull>;
  thread(id: string, signal: AbortSignal): Promise<RemoteThread>;
  replyThread(id: string, body: string, signal: AbortSignal): Promise<void>;
  resolveThread(id: string, signal: AbortSignal): Promise<void>;
  comment(
    issue: number,
    id: number | null,
    body: string,
    signal: AbortSignal,
  ): Promise<void>;
  updatePull(
    number: number | null,
    request: { title: string; body: string; branch: string; base: string },
    signal: AbortSignal,
  ): Promise<void>;
}
export function createGitHubWriter(
  repository: string,
  token: string,
  ready: () => void,
) {
  const silent = () => {};
  return new OctokitWriter(
    repository,
    new Octokit({
      auth: token,
      log: { debug: silent, info: silent, warn: silent, error: silent },
    }),
    ready,
  );
}
export class OctokitWriter implements GitHubWriter {
  private coordinates: { owner: string; repo: string };
  private readonly client: Octokit;
  private readonly ready: () => void;
  constructor(
    repository: string,
    client: Octokit,
    ready: () => void = () => {},
  ) {
    this.client = client;
    this.ready = ready;
    const [owner, repo] = repository.split("/");
    this.coordinates = { owner, repo };
  }
  private async request(
    route: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    this.ready();
    try {
      return (
        await this.client.request(route, {
          ...(route === "POST /graphql" ? {} : this.coordinates),
          ...parameters,
          request: {
            signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
            redirect: "error",
          },
        })
      ).data;
    } catch (error) {
      const parsed = z
        .object({
          status: z.number().optional(),
          response: z
            .object({ headers: z.record(z.string(), z.unknown()) })
            .optional(),
        })
        .safeParse(error);
      const status = parsed.success ? parsed.data.status : undefined;
      const headers = parsed.success
        ? parsed.data.response?.headers
        : undefined;
      if (
        status === 429 ||
        (status === 403 &&
          (headers?.["x-ratelimit-remaining"] === "0" ||
            headers?.["retry-after"] !== undefined))
      ) {
        const after = Number(headers?.["retry-after"]),
          date =
            typeof headers?.["retry-after"] === "string"
              ? Date.parse(headers["retry-after"])
              : NaN,
          reset = Number(headers?.["x-ratelimit-reset"]) * 1000,
          deadlines = [
            Number.isFinite(after) && after > 0
              ? Date.now() + after * 1000
              : date,
            reset,
          ].filter((deadline) => deadline > Date.now());
        throw new IntakeError(
          "github_rate_limited",
          deadlines.length ? Math.max(...deadlines) : Date.now() + 60000,
        );
      }
      throw new IntakeError(
        status === 404
          ? "github_not_found"
          : status === 401 || status === 403
            ? "github_access_denied"
            : "github_publication_failed",
      );
    }
  }
  private async pages(
    route: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const rows: unknown[] = [];
    for (let page = 1; ; page++) {
      const data = z
        .array(z.unknown())
        .parse(
          await this.request(
            route,
            { ...parameters, per_page: 100, page },
            signal,
          ),
        );
      rows.push(...data);
      if (data.length < 100) return rows;
    }
  }
  async repository(signal: AbortSignal) {
    return repositoryIdentity.parse(
      await this.request("GET /repos/{owner}/{repo}", {}, signal),
    );
  }
  async actor(signal: AbortSignal) {
    return user.parse(await this.request("GET /user", {}, signal));
  }
  async taskIssue(number: number, signal: AbortSignal) {
    const issue = z
      .object({
        id: githubId,
        number: githubId,
        state: z.enum(["open", "closed"]),
        pull_request: z.unknown().optional(),
        labels: z.array(z.object({ name: z.string() })),
      })
      .parse(
        await this.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}",
          { issue_number: number },
          signal,
        ),
      );
    if (issue.number !== number || issue.pull_request)
      throw new IntakeError("issue_identity_changed");
    return {
      id: issue.id,
      number,
      state: issue.state,
      managed: issue.labels.some((label) => label.name === "orm:managed"),
    };
  }
  async enrollManaged(number: number, signal: AbortSignal) {
    const label = { name: "orm:managed" };
    try {
      await this.request(
        "GET /repos/{owner}/{repo}/labels/{name}",
        label,
        signal,
      );
    } catch (error) {
      if (!(error instanceof IntakeError) || error.code !== "github_not_found")
        throw error;
      try {
        await this.request(
          "POST /repos/{owner}/{repo}/labels",
          {
            ...label,
            color: "57606a",
            description:
              "Durable ORM task; preserve its authenticated state comment.",
          },
          signal,
        );
      } catch {
        await this.request(
          "GET /repos/{owner}/{repo}/labels/{name}",
          label,
          signal,
        );
      }
    }
    try {
      await this.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
        { issue_number: number, labels: [label.name] },
        signal,
      );
    } catch (error) {
      if (!(await this.taskIssue(number, signal)).managed) throw error;
    }
    if (!(await this.taskIssue(number, signal)).managed)
      throw new IntakeError("state_enrollment_failed");
  }
  async issueOpen(
    number: number,
    signal: AbortSignal,
    expected?: Pick<IssueContext, "id" | "title" | "body">,
  ) {
    const issue = z
      .object({
        number: githubId,
        state: z.enum(["open", "closed"]),
        pull_request: z.unknown().optional(),
        id: githubId.optional(),
        title: z.string().optional(),
        body: z.string().nullable().optional(),
      })
      .parse(
        await this.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}",
          { issue_number: number },
          signal,
        ),
      );
    return (
      issue.number === number &&
      !issue.pull_request &&
      issue.state === "open" &&
      (!expected ||
        (issue.id === expected.id &&
          issue.title === expected.title &&
          issue.body === expected.body))
    );
  }
  async branch(name: string, signal: AbortSignal) {
    const rules = await this.pages(
      "GET /repos/{owner}/{repo}/rules/branches/{branch}",
      { branch: name },
      signal,
    );
    try {
      const branch = z
        .object({
          name: z.string(),
          protected: z.boolean(),
          commit: z.object({ sha }),
        })
        .parse(
          await this.request(
            "GET /repos/{owner}/{repo}/branches/{branch}",
            { branch: name },
            signal,
          ),
        );
      if (branch.name !== name)
        throw new IntakeError("github_identity_changed");
      return {
        head: branch.commit.sha,
        protected: branch.protected || rules.length > 0,
      };
    } catch (error) {
      if (error instanceof IntakeError && error.code === "github_not_found")
        return { head: null, protected: rules.length > 0 };
      throw error;
    }
  }
  async comments(issue: number, signal: AbortSignal): Promise<OwnedComment[]> {
    return (
      await this.pages(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { issue_number: issue },
        signal,
      )
    ).map((value) => {
      const row = comment.parse(value);
      return {
        id: row.id,
        body: row.body ?? "",
        author_id: row.user?.id ?? null,
      };
    });
  }
  private projection(value: unknown): RemotePull {
    const row = pull.parse(value);
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      body: row.body ?? "",
      head: row.head.sha,
      base: row.base.ref,
      author_id: row.user?.id ?? null,
      state: row.state,
      draft: row.draft,
      branch: row.head.ref,
      repository_id: row.head.repo.id,
      base_repository_id: row.base.repo.id,
    };
  }
  async pulls(branch: string, signal: AbortSignal) {
    return (
      await this.pages(
        "GET /repos/{owner}/{repo}/pulls",
        { head: `${this.coordinates.owner}:${branch}`, state: "all" },
        signal,
      )
    ).map((value) => this.projection(value));
  }
  async pull(number: number, signal: AbortSignal) {
    return this.projection(
      await this.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { pull_number: number },
        signal,
      ),
    );
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const response = z
      .object({
        data: z.record(z.string(), z.unknown()).nullable().optional(),
        errors: z.array(z.unknown()).optional(),
      })
      .parse(await this.request("POST /graphql", { query, variables }, signal));
    if (!response.data || response.errors?.length)
      throw new IntakeError("github_publication_failed");
    return response.data;
  }

  async thread(id: string, signal: AbortSignal): Promise<RemoteThread> {
    const pageInfo = z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    });
    const comment = z.object({
      id: z.string(),
      databaseId: githubId,
      body: z.string(),
      author: z.object({ login: z.string() }).nullable(),
    });
    const schema = z.object({
      node: z.object({
        id: z.string(),
        isResolved: z.boolean(),
        pullRequest: z.object({
          databaseId: githubId,
          number: githubId,
          repository: z.object({ databaseId: githubId }),
        }),
        comments: z.object({ nodes: z.array(comment), pageInfo }),
      }),
    });
    const comments: RemoteThread["comments"] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    let result: RemoteThread | undefined;
    for (;;) {
      const data = await this.graphql(
        "query($id:ID!,$cursor:String){node(id:$id){...on PullRequestReviewThread{id isResolved pullRequest{databaseId number repository{databaseId}}comments(first:100,after:$cursor){nodes{id databaseId body author{login}}pageInfo{hasNextPage endCursor}}}}}",
        { id, cursor },
        signal,
      );
      const value = schema.parse(data).node;
      if (value.id !== id) throw new IntakeError("github_thread_invalid");
      const identity = {
        id,
        pull_id: value.pullRequest.databaseId,
        pull_number: value.pullRequest.number,
        repository_id: value.pullRequest.repository.databaseId,
      };
      if (
        result &&
        (result.pull_id !== identity.pull_id ||
          result.resolved !== value.isResolved)
      )
        throw new IntakeError("github_thread_changed");
      result = { ...identity, resolved: value.isResolved, comments };
      comments.push(
        ...value.comments.nodes.map((item) => ({
          id: item.databaseId,
          node_id: item.id,
          body: item.body,
          author_login: item.author?.login ?? null,
        })),
      );
      if (!value.comments.pageInfo.hasNextPage) return result;
      cursor = value.comments.pageInfo.endCursor;
      if (!cursor || seen.has(cursor))
        throw new IntakeError("github_pagination_invalid");
      seen.add(cursor);
    }
  }

  async replyThread(id: string, body: string, signal: AbortSignal) {
    const data = await this.graphql(
      "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}",
      { id, body },
      signal,
    );
    z.object({
      addPullRequestReviewThreadReply: z.object({
        comment: z.object({ id: z.string() }),
      }),
    }).parse(data);
  }

  async resolveThread(id: string, signal: AbortSignal) {
    const data = await this.graphql(
      "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}",
      { id },
      signal,
    );
    const result = z
      .object({
        resolveReviewThread: z.object({
          thread: z.object({ id: z.string(), isResolved: z.literal(true) }),
        }),
      })
      .parse(data);
    if (result.resolveReviewThread.thread.id !== id)
      throw new IntakeError("github_thread_invalid");
  }
  async comment(
    issue: number,
    id: number | null,
    body: string,
    signal: AbortSignal,
  ) {
    await this.request(
      id === null
        ? "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
        : "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      { issue_number: issue, ...(id === null ? {} : { comment_id: id }), body },
      signal,
    );
  }
  async updatePull(
    number: number | null,
    request: { title: string; body: string; branch: string; base: string },
    signal: AbortSignal,
  ) {
    await this.request(
      number === null
        ? "POST /repos/{owner}/{repo}/pulls"
        : "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        ...(number === null
          ? { head: request.branch, base: request.base, draft: false }
          : { pull_number: number }),
        title: request.title,
        body: request.body,
      },
      signal,
    );
  }
}
