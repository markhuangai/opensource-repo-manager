import { afterEach, describe, expect, it } from "vitest";
import { fixtureGitHub } from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";

const fixtures: Array<Awaited<ReturnType<typeof fixtureGitHub>>> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture() {
  const value = await fixtureGitHub();
  fixtures.push(value);
  return value;
}
const signal = () => new AbortController().signal;

describe("Octokit read integration against GitHub HTTP", () => {
  it("revalidates cached responses by route and page while honoring changes and access errors", async () => {
    const github = await fixture();
    await github.reader.repository(signal());
    expect(await github.reader.repository(signal())).toEqual(
      github.state.repository,
    );
    expect(github.requests.at(-1)?.status).toBe(304);
    github.state.repository.private = false;
    expect((await github.reader.repository(signal())).private).toBe(false);
    expect(github.requests.at(-1)?.status).toBe(200);
    for (let number = 2; number <= 101; number++)
      github.state.issues[number] = makeIssue(number);
    await github.reader.issuePage(1, signal());
    await github.reader.issuePage(2, signal());
    expect((await github.reader.issuePage(1, signal())).numbers).toHaveLength(
      100,
    );
    expect((await github.reader.issuePage(2, signal())).numbers).toEqual([101]);
    expect(github.requests.slice(-2).map((request) => request.status)).toEqual([
      304, 304,
    ]);
    github.state.failures["/repos/owner/repo"] = { status: 401 };
    await expect(github.reader.repository(signal())).rejects.toThrow(
      "github_authentication",
    );
    expect(github.requests.at(-1)?.status).toBe(401);
  });
  it.each([false, true])(
    "authenticates %s-private repositories and reads bound source metadata",
    async (privateRepository) => {
      const github = await fixture();
      github.state.repository.private = privateRepository;
      const repo = await github.reader.repository(signal());
      expect(repo).toEqual(github.state.repository);
      const issue = await github.reader.issue(1, repo, signal());
      expect(issue.source).toEqual({
        default_branch: "main",
        sha: "a".repeat(40),
        tree_sha: "b".repeat(40),
      });
      expect(
        github.requests.every(
          (request) =>
            request.method === "GET" &&
            request.url!.startsWith("/repos/owner/repo") &&
            request.authorization!.includes(github.state.token),
        ),
      ).toBe(true);
    },
  );
  it("paginates issue discovery, excludes PRs and reads all comment pages", async () => {
    const github = await fixture();
    for (let number = 2; number <= 101; number++)
      github.state.issues[number] = makeIssue(number);
    github.state.issues[2].pull_request = {
      url: "https://untrusted.invalid/ignored",
    };
    expect((await github.reader.issuePage(1, signal())).numbers).not.toContain(
      2,
    );
    expect(await github.reader.issuePage(2, signal())).toEqual({
      numbers: [101],
      finished: true,
    });
    github.state.comments[1] = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      body: "Comment",
      updated_at: "2026-10-15T00:00:00Z",
      user: { id: 7, login: "pat-owner" },
    }));
    const issue = await github.reader.issue(
      1,
      github.state.repository,
      signal(),
    );
    expect(issue.comments).toHaveLength(101);
    await expect(
      github.reader.issue(2, github.state.repository, signal()),
    ).rejects.toThrow("issue_is_pull_request");
  });
  it("returns safe authentication, access, rate-limit and provider errors", async () => {
    const github = await fixture();
    for (const [status, code] of [
      [401, "github_authentication"],
      [403, "github_access_denied"],
      [404, "github_not_found"],
      [500, "github_read_failed"],
    ] as const) {
      github.state.failures["/repos/owner/repo"] = { status };
      await expect(github.reader.repository(signal())).rejects.toThrow(code);
    }
    github.state.failures["/repos/owner/repo"] = {
      status: 429,
      headers: { "retry-after": "120" },
    };
    try {
      await github.reader.repository(signal());
      throw new Error("Expected rate limit");
    } catch (error) {
      expect(error).toMatchObject({ code: "github_rate_limited" });
      expect(String(error)).not.toContain("fixture-only");
    }
  });
  it("reads owned-PR context through fixed read routes", async () => {
    const github = await fixture();
    github.state.pulls[5] = {
      id: 5005,
      number: 5,
      state: "open",
      updated_at: "2026-10-15T00:00:00Z",
      head: { sha: "c".repeat(40) },
    };
    expect(await github.reader.pull(5, signal())).toMatchObject({
      id: 5005,
      head_sha: "c".repeat(40),
      comments: [],
      reviews: [],
      checks: [],
      statuses: [],
    });
    expect(
      github.requests.some((request) =>
        request.url!.includes("/commits/" + "c".repeat(40) + "/check-runs"),
      ),
    ).toBe(true);
  });
  it("aborts an outstanding HTTP request", async () => {
    const github = await fixture();
    let received!: () => void;
    const seen = new Promise<void>((resolve) => {
      received = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    github.beforeRequest(async () => {
      received();
      await blocked;
    });
    const controller = new AbortController();
    const request = github.reader.repository(controller.signal);
    await seen;
    controller.abort();
    await expect(request).rejects.toThrow();
    release();
  });
});
