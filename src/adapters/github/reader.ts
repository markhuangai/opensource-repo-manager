import { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  githubId,
  issueComment,
  issueSummary,
  repositoryIdentity,
  sha,
  IntakeError,
  type IssueContext,
  type PullContext,
  type RepositoryIdentity,
  type SourceMetadata,
} from "../../domain/jobs.ts";

export interface GitHubReader {
  repository(signal: AbortSignal): Promise<RepositoryIdentity>;
  issuePage(
    page: number,
    signal: AbortSignal,
  ): Promise<{ numbers: number[]; finished: boolean }>;
  issue(
    number: number,
    repository: RepositoryIdentity,
    signal: AbortSignal,
  ): Promise<IssueContext>;
  source(branch: string, signal: AbortSignal): Promise<SourceMetadata>;
  pull(number: number, signal: AbortSignal): Promise<PullContext>;
}

const review = z.object({
  id: githubId,
  body: z.string().nullable(),
  state: z.string(),
  submitted_at: z.string().nullable(),
  user: z.object({ id: githubId, login: z.string() }).nullable(),
});
const reviewComment = z.object({
  id: githubId,
  body: z.string(),
  updated_at: z.string(),
  user: z.object({ id: githubId, login: z.string() }).nullable(),
});
const check = z.object({
  id: githubId,
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_sha: sha,
});
const status = z.object({
  id: githubId,
  state: z.string(),
  context: z.string(),
  updated_at: z.string(),
});

export function createGitHubReader(
  repository: string,
  token: string,
): GitHubReader {
  const silent = () => {};
  return new OctokitReader(
    repository,
    new Octokit({
      auth: token,
      log: { debug: silent, info: silent, warn: silent, error: silent },
    }),
  );
}

export class OctokitReader implements GitHubReader {
  private readonly coordinates: { owner: string; repo: string };
  private readonly client: Octokit;
  private readonly cache = new Map<string, { etag: string; data: unknown }>();
  constructor(repository: string, client: Octokit) {
    const [owner, repo] = repository.split("/");
    this.coordinates = { owner, repo };
    this.client = client;
  }

  private async read(
    route: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const key = JSON.stringify([route, parameters]);
    const cached = this.cache.get(key);
    try {
      const result = await this.client.request(route, {
        ...this.coordinates,
        ...parameters,
        ...(cached ? { headers: { "if-none-match": cached.etag } } : {}),
        request: {
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        },
      });
      if (typeof result.headers.etag === "string")
        this.cache.set(key, { etag: result.headers.etag, data: result.data });
      else this.cache.delete(key);
      return result.data;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const parsed = z
        .object({
          status: z.number().optional(),
          response: z
            .object({ headers: z.record(z.string(), z.unknown()) })
            .optional(),
        })
        .safeParse(error);
      const code = parsed.success ? parsed.data.status : undefined;
      if (code === 304 && cached) return cached.data;
      const headers = parsed.success
        ? parsed.data.response?.headers
        : undefined;
      const remaining = headers?.["x-ratelimit-remaining"];
      if (
        code === 429 ||
        (code === 403 &&
          (remaining === "0" || headers?.["retry-after"] !== undefined))
      ) {
        const after = Number(headers?.["retry-after"]);
        const reset = Number(headers?.["x-ratelimit-reset"]) * 1000;
        const retryAt =
          Number.isFinite(after) && after > 0
            ? Date.now() + after * 1000
            : Number.isFinite(reset) && reset > Date.now()
              ? reset
              : Date.now() + 60_000;
        throw new IntakeError("github_rate_limited", retryAt);
      }
      throw new IntakeError(
        code === 401
          ? "github_authentication"
          : code === 403
            ? "github_access_denied"
            : code === 404 || code === 410
              ? "github_not_found"
              : "github_read_failed",
      );
    }
  }

  async repository(signal: AbortSignal) {
    return repositoryIdentity.parse(
      await this.read("GET /repos/{owner}/{repo}", {}, signal),
    );
  }

  async issuePage(page: number, signal: AbortSignal) {
    const rows = z
      .array(
        z.object({ number: githubId, pull_request: z.unknown().optional() }),
      )
      .parse(
        await this.read(
          "GET /repos/{owner}/{repo}/issues",
          {
            state: "open",
            sort: "created",
            direction: "asc",
            per_page: 100,
            page,
          },
          signal,
        ),
      );
    return {
      numbers: rows.filter((row) => !row.pull_request).map((row) => row.number),
      finished: rows.length < 100,
    };
  }

  private async pages<T>(
    route: string,
    parameters: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    field?: string,
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; ; page++) {
      const response = await this.read(
        route,
        { ...parameters, per_page: 100, page },
        signal,
      );
      const data = field
        ? z.record(z.string(), z.unknown()).parse(response)[field]
        : response;
      const items = z.array(schema).parse(data);
      rows.push(...items);
      if (items.length < 100) return rows;
    }
  }

  async source(branch: string, signal: AbortSignal) {
    const value = z
      .object({ sha, commit: z.object({ tree: z.object({ sha }) }) })
      .parse(
        await this.read(
          "GET /repos/{owner}/{repo}/commits/{ref}",
          { ref: branch },
          signal,
        ),
      );
    return {
      default_branch: branch,
      sha: value.sha,
      tree_sha: value.commit.tree.sha,
    };
  }

  async issue(
    number: number,
    repository: RepositoryIdentity,
    signal: AbortSignal,
  ): Promise<IssueContext> {
    const raw = z
      .object({ pull_request: z.unknown().optional() })
      .passthrough()
      .parse(
        await this.read(
          "GET /repos/{owner}/{repo}/issues/{issue_number}",
          { issue_number: number },
          signal,
        ),
      );
    if (raw.pull_request) throw new IntakeError("issue_is_pull_request");
    const issue = issueSummary.parse(raw);
    if (issue.number !== number)
      throw new IntakeError("issue_identity_changed");
    const comments = await this.pages(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { issue_number: number },
      issueComment,
      signal,
    );
    return {
      ...issue,
      comments,
      source: await this.source(repository.default_branch, signal),
    };
  }

  async pull(number: number, signal: AbortSignal): Promise<PullContext> {
    const pull = z
      .object({
        id: githubId,
        number: githubId,
        state: z.enum(["open", "closed"]),
        updated_at: z.string(),
        head: z.object({ sha }),
      })
      .parse(
        await this.read(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}",
          { pull_number: number },
          signal,
        ),
      );
    if (pull.number !== number) throw new IntakeError("pull_identity_changed");
    return {
      id: pull.id,
      number,
      state: pull.state,
      head_sha: pull.head.sha,
      updated_at: pull.updated_at,
      comments: await this.pages(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { issue_number: number },
        issueComment,
        signal,
      ),
      reviews: await this.pages(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { pull_number: number },
        review,
        signal,
      ),
      review_comments: await this.pages(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        { pull_number: number },
        reviewComment,
        signal,
      ),
      checks: await this.pages(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        { ref: pull.head.sha },
        check,
        signal,
        "check_runs",
      ),
      statuses: await this.pages(
        "GET /repos/{owner}/{repo}/commits/{ref}/statuses",
        { ref: pull.head.sha },
        status,
        signal,
      ),
    };
  }
}
