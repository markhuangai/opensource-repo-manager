import { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  githubId,
  repositoryIdentity,
  sha,
  IntakeError,
  type RepositoryIdentity,
} from "../../domain/jobs.ts";
import type {
  OwnedComment,
  OwnedPull,
} from "../../services/publication/contracts.ts";

const user = z.object({
  id: githubId,
  login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/),
});
const comment = z.object({ id: githubId, body: z.string(), user });
const pull = z.object({
  id: githubId,
  number: githubId,
  title: z.string(),
  body: z.string().nullable(),
  user,
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
export interface GitHubWriter {
  repository(signal: AbortSignal): Promise<RepositoryIdentity>;
  actor(signal: AbortSignal): Promise<{ id: number; login: string }>;
  issueOpen(number: number, signal: AbortSignal): Promise<boolean>;
  branch(
    name: string,
    signal: AbortSignal,
  ): Promise<{ head: string | null; protected: boolean }>;
  comments(issue: number, signal: AbortSignal): Promise<OwnedComment[]>;
  pulls(branch: string, signal: AbortSignal): Promise<RemotePull[]>;
  pull(number: number, signal: AbortSignal): Promise<RemotePull>;
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
          ...this.coordinates,
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
  async issueOpen(number: number, signal: AbortSignal) {
    const issue = z
      .object({
        number: githubId,
        state: z.enum(["open", "closed"]),
        pull_request: z.unknown().optional(),
      })
      .parse(
        await this.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}",
          { issue_number: number },
          signal,
        ),
      );
    return (
      issue.number === number && !issue.pull_request && issue.state === "open"
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
      return { id: row.id, body: row.body, author_id: row.user.id };
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
      author_id: row.user.id,
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
