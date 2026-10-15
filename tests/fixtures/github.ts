import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

export function makeIssue(number: number, state = "open") {
  return {
    id: 1000 + number,
    number,
    state,
    title: `Issue ${number}`,
    body: "A maintenance problem",
    updated_at: "2026-10-15T00:00:00Z",
  };
}

export function githubFixtureState() {
  return {
    token: "github-fixture-token",
    repository: {
      id: 42,
      full_name: "owner/repo",
      default_branch: "main",
      private: true,
    },
    issues: { "1": makeIssue(1) } as Record<
      string,
      ReturnType<typeof makeIssue> & { pull_request?: object }
    >,
    comments: {} as Record<
      string,
      Array<{
        id: number;
        body: string;
        updated_at: string;
        user: { id: number; login: string };
      }>
    >,
    pulls: {} as Record<
      string,
      {
        id: number;
        number: number;
        state: string;
        updated_at: string;
        head: { sha: string };
      }
    >,
    failures: {} as Record<
      string,
      { status: number; headers?: Record<string, string> }
    >,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  };
}
export type GitHubFixtureState = ReturnType<typeof githubFixtureState>;

export async function githubFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: GitHubFixtureState,
) {
  const url = new URL(request.url!, "https://api.github.com");
  response.setHeader("content-type", "application/json");
  function send(body: unknown, status = 200) {
    const bytes = JSON.stringify(body);
    if (status === 200) {
      const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
      response.setHeader("etag", etag);
      if (request.headers["if-none-match"] === etag) {
        response.statusCode = 304;
        response.end();
        return;
      }
    }
    response.statusCode = status;
    response.end(bytes);
  }
  if (request.method !== "GET") return send({ message: "Reads only" }, 405);
  if (
    request.headers.authorization !== `token ${state.token}` &&
    request.headers.authorization !== `Bearer ${state.token}`
  )
    return send({ message: "Authentication required" }, 401);
  const failed =
    state.failures[url.pathname + url.search] ?? state.failures[url.pathname];
  if (failed) {
    for (const [key, value] of Object.entries(failed.headers ?? {}))
      response.setHeader(key, value);
    return send(
      { message: "Upstream failure with fixture-only diagnostic" },
      failed.status,
    );
  }
  const base = "/repos/owner/repo";
  if (url.pathname === base) return send(state.repository);
  if (url.pathname === `${base}/issues`) {
    const page = Number(url.searchParams.get("page") ?? 1),
      size = Number(url.searchParams.get("per_page") ?? 100);
    const issues = Object.values(state.issues)
      .filter((issue) => issue.state === "open")
      .sort((a, b) => a.number - b.number);
    return send(issues.slice((page - 1) * size, page * size));
  }
  const issue = url.pathname.match(
    /^\/repos\/owner\/repo\/issues\/(\d+)(\/comments)?$/,
  );
  if (issue) {
    if (issue[2]) {
      const comments = state.comments[issue[1]] ?? [];
      const page = Number(url.searchParams.get("page") ?? 1);
      return send(comments.slice((page - 1) * 100, page * 100));
    }
    return state.issues[issue[1]]
      ? send(state.issues[issue[1]])
      : send({ message: "Not found" }, 404);
  }
  const pull = url.pathname.match(
    /^\/repos\/owner\/repo\/pulls\/(\d+)(\/(reviews|comments))?$/,
  );
  if (pull) {
    if (pull[2]) return send([]);
    return state.pulls[pull[1]]
      ? send(state.pulls[pull[1]])
      : send({ message: "Not found" }, 404);
  }
  if (url.pathname.endsWith("/check-runs")) return send({ check_runs: [] });
  if (url.pathname.endsWith("/statuses")) return send([]);
  if (url.pathname === `${base}/commits/${state.repository.default_branch}`)
    return send({ sha: state.commit, commit: { tree: { sha: state.tree } } });
  return send({ message: "Unknown fixture route" }, 404);
}
