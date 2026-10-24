import { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  prReview,
  prComment,
  prCheck,
  prStatus,
  prReaction,
  prThread,
  threadComment,
  type PrSnapshot,
  type PrRequirements,
} from "../../services/pr-monitor/contracts.ts";
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
  monitor(number: number, signal: AbortSignal): Promise<PrSnapshot>;
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
        ...(route === "POST /graphql" ? {} : this.coordinates),
        ...parameters,
        ...(cached ? { headers: { "if-none-match": cached.etag } } : {}),
        request: {
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          redirect: "error",
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
      if (
        code === 404 &&
        route.endsWith("/protection") &&
        z
          .object({
            response: z.object({
              data: z.object({ message: z.literal("Branch not protected") }),
            }),
          })
          .safeParse(error).success
      )
        throw new IntakeError("github_branch_unprotected");
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
      .parse(await this.read("POST /graphql", { query, variables }, signal));
    if (!response.data || response.errors?.length)
      throw new IntakeError("github_graphql_failed");
    return response.data;
  }

  private async threads(number: number, signal: AbortSignal) {
    const pageInfo = z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    });
    const comments = z.object({ nodes: z.array(threadComment), pageInfo });
    const thread = prThread.omit({ comments: true }).extend({ comments });
    const fields =
      "id databaseId body author { login } createdAt updatedAt path line originalLine commit { oid } originalCommit { oid } pullRequestReview { databaseId commit { oid } }";
    const result: PrSnapshot["threads"] = [],
      cursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const data = await this.graphql(
        `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){ reviewThreads(first:100,after:$cursor){ nodes { id isResolved isOutdated comments(first:100){ nodes { ${fields} } pageInfo {hasNextPage endCursor} } } pageInfo {hasNextPage endCursor} } } } }`,
        { ...this.coordinates, number, cursor },
        signal,
      );
      const connection = z
        .object({
          repository: z.object({
            pullRequest: z.object({
              reviewThreads: z.object({ nodes: z.array(thread), pageInfo }),
            }),
          }),
        })
        .parse(data).repository.pullRequest.reviewThreads;
      for (const value of connection.nodes) {
        const items = [...value.comments.nodes],
          seen = new Set<string>();
        let more = value.comments.pageInfo;
        while (more.hasNextPage) {
          if (!more.endCursor || seen.has(more.endCursor))
            throw new IntakeError("github_pagination_invalid");
          seen.add(more.endCursor);
          const next = await this.graphql(
            `query($id:ID!,$cursor:String!){ node(id:$id){ ... on PullRequestReviewThread { comments(first:100,after:$cursor){nodes{${fields}}pageInfo{hasNextPage endCursor}} } } }`,
            { id: value.id, cursor: more.endCursor },
            signal,
          );
          const page = z.object({ node: z.object({ comments }) }).parse(next)
            .node.comments;
          items.push(...page.nodes);
          more = page.pageInfo;
        }
        result.push(prThread.parse({ ...value, comments: items }));
      }
      if (!connection.pageInfo.hasNextPage) return result;
      if (
        !connection.pageInfo.endCursor ||
        cursors.has(connection.pageInfo.endCursor)
      )
        throw new IntakeError("github_pagination_invalid");
      cursor = connection.pageInfo.endCursor;
      cursors.add(cursor);
    }
  }

  private async requirements(
    branch: string,
    signal: AbortSignal,
  ): Promise<PrRequirements> {
    const result: PrRequirements = {
      checks: [],
      unknown: [],
      human_approvals: 0,
    };
    try {
      const protection = z
        .object({
          required_status_checks: z
            .object({
              contexts: z.array(z.string()).optional(),
              checks: z
                .array(
                  z.object({
                    context: z.string(),
                    app_id: z.number().int().nullable(),
                  }),
                )
                .optional(),
            })
            .nullable()
            .optional(),
          required_pull_request_reviews: z
            .object({ required_approving_review_count: z.number().int() })
            .nullable()
            .optional(),
        })
        .parse(
          await this.read(
            "GET /repos/{owner}/{repo}/branches/{branch}/protection",
            { branch },
            signal,
          ),
        );
      const required = protection.required_status_checks;
      result.checks.push(
        ...(required?.checks?.map((item) => ({
          name: item.context,
          app_id: item.app_id !== null && item.app_id > 0 ? item.app_id : null,
        })) ?? []),
      );
      result.checks.push(
        ...(required?.contexts
          ?.filter((name) => !result.checks.some((item) => item.name === name))
          .map((name) => ({ name, app_id: null })) ?? []),
      );
      result.human_approvals =
        protection.required_pull_request_reviews
          ?.required_approving_review_count ?? 0;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (!(error instanceof IntakeError)) throw error;
      if (
        error.code === "github_rate_limited" ||
        error.code === "github_authentication"
      )
        throw error;
      if (error.code !== "github_branch_unprotected")
        result.unknown.push("branch_protection");
    }
    try {
      const rules = await this.pages(
        "GET /repos/{owner}/{repo}/rules/branches/{branch}",
        { branch },
        z.object({
          type: z.string(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
        signal,
      );
      for (const rule of rules) {
        if (rule.type === "required_status_checks") {
          const parameters = z
            .object({
              required_status_checks: z.array(
                z.object({
                  context: z.string(),
                  integration_id: z.number().int().nullable().optional(),
                }),
              ),
            })
            .parse(rule.parameters);
          result.checks.push(
            ...parameters.required_status_checks.map((item) => ({
              name: item.context,
              app_id:
                item.integration_id && item.integration_id > 0
                  ? item.integration_id
                  : null,
            })),
          );
        } else if (rule.type === "pull_request") {
          const parameters = z
            .object({ required_approving_review_count: z.number().int() })
            .parse(rule.parameters);
          result.human_approvals = Math.max(
            result.human_approvals,
            parameters.required_approving_review_count,
          );
        } else if (
          ![
            "deletion",
            "non_fast_forward",
            "creation",
            "update",
            "required_linear_history",
            "required_signatures",
            "commit_message_pattern",
            "commit_author_email_pattern",
            "committer_email_pattern",
            "branch_name_pattern",
            "file_path_restriction",
            "max_file_path_length",
            "file_extension_restriction",
            "max_file_size",
          ].includes(rule.type)
        ) {
          result.unknown.push(rule.type);
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (!(error instanceof IntakeError)) throw error;
      if (
        error.code === "github_rate_limited" ||
        error.code === "github_authentication"
      )
        throw error;
      result.unknown.push("rulesets");
    }
    return result;
  }

  async monitor(number: number, signal: AbortSignal): Promise<PrSnapshot> {
    const schema = z.object({
      id: githubId,
      node_id: z.string(),
      number: githubId,
      state: z.enum(["open", "closed"]),
      draft: z.boolean(),
      merged: z.boolean(),
      user: z.object({ id: githubId }).nullable(),
      updated_at: z.string(),
      head: z.object({
        sha,
        ref: z.string(),
        repo: z.object({ id: githubId }),
      }),
      base: z.object({
        sha,
        ref: z.string(),
        repo: z.object({ id: githubId }),
      }),
    });
    const pull = schema.parse(
      await this.read(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { pull_number: number },
        signal,
      ),
    );
    if (pull.number !== number) throw new IntakeError("pull_identity_changed");
    const snapshot: PrSnapshot = {
      id: pull.id,
      node_id: pull.node_id,
      number,
      state: pull.state,
      merged: pull.merged,
      draft: pull.draft,
      author_id: pull.user?.id ?? null,
      repository_id: pull.head.repo.id,
      base_repository_id: pull.base.repo.id,
      branch: pull.head.ref,
      base: pull.base.ref,
      base_sha: pull.base.sha,
      head_sha: pull.head.sha,
      updated_at: pull.updated_at,
      comments: await this.pages(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { issue_number: number },
        prComment,
        signal,
      ),
      reviews: await this.pages(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { pull_number: number },
        prReview,
        signal,
      ),
      threads: await this.threads(number, signal),
      reactions: await this.pages(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/reactions",
        { issue_number: number },
        prReaction,
        signal,
      ),
      checks: await this.pages(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        { ref: pull.head.sha, filter: "all" },
        prCheck,
        signal,
        "check_runs",
      ),
      statuses: await this.pages(
        "GET /repos/{owner}/{repo}/commits/{ref}/statuses",
        { ref: pull.head.sha },
        prStatus,
        signal,
      ),
      requirements: await this.requirements(pull.base.ref, signal),
    };
    const after = schema.parse(
      await this.read(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { pull_number: number },
        signal,
      ),
    );
    if (
      after.head.sha !== snapshot.head_sha ||
      after.base.sha !== snapshot.base_sha ||
      after.state !== snapshot.state ||
      after.draft !== snapshot.draft
    )
      throw new IntakeError("pull_changed_during_read");
    return snapshot;
  }
}
