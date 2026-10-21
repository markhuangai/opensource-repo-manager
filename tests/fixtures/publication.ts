import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function createPublicationFixture(root: string) {
  const repository = join(root, "owner", "repo.git");
  await mkdir(join(root, "owner"), { recursive: true });
  const env = {
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (args: string[], input?: string | Buffer) =>
    execFileSync("/usr/bin/git", ["--git-dir", repository, ...args], {
      env,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  execFileSync("/usr/bin/git", ["init", "--bare", repository], {
    env,
    stdio: "pipe",
  });
  const object = (type: string, data: string | Buffer) =>
    git(["hash-object", "-t", type, "-w", "--stdin"], data);
  const commit = (files: Record<string, string | Buffer>, parent?: string) => {
    const entries = new Map<string, { mode: string; sha: string }>();
    for (const [path, bytes] of Object.entries(files))
      entries.set(path, { mode: "100644", sha: object("blob", bytes) });
    const treeFor = (prefix: string): string => {
      const names = [
        ...new Set(
          [...entries.keys()]
            .filter((path) => path.startsWith(prefix))
            .map((path) => path.slice(prefix.length).split("/")[0]),
        ),
      ];
      const data = names
        .map((name) => {
          const entry = entries.get(prefix + name);
          return {
            name,
            directory: !entry,
            mode: entry?.mode ?? "40000",
            sha: entry?.sha ?? treeFor(prefix + name + "/"),
          };
        })
        .sort((a, b) =>
          Buffer.compare(
            Buffer.from(a.name + (a.directory ? "/" : "")),
            Buffer.from(b.name + (b.directory ? "/" : "")),
          ),
        );
      return object(
        "tree",
        Buffer.concat(
          data.map((entry) =>
            Buffer.concat([
              Buffer.from(`${entry.mode} ${entry.name}\0`),
              Buffer.from(entry.sha, "hex"),
            ]),
          ),
        ),
      );
    };
    const tree = treeFor("");
    const sha = object(
      "commit",
      `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nfixture\n`,
    );
    return { sha, tree_sha: tree, default_branch: "main" };
  };
  const initial = {
    "app.txt": "original\n",
    "image.bin": Buffer.from([0, 1, 2, 255]),
  };
  const source = commit(initial);
  git(["update-ref", "refs/heads/main", source.sha]);
  type Pull = {
    id: number;
    number: number;
    title: string;
    body: string;
    branch: string;
    base: string;
    state: string;
    author: number | null;
    author_login?: string;
    draft: boolean;
  };
  const state = {
    issues: new Map<
      number,
      {
        id: number;
        number: number;
        title: string;
        body: string | null;
        updated_at: string;
      }
    >(),
    token: "github-fixture-token",
    actor: { id: 7, login: "fixture" },
    repository_id: 42,
    default_branch: "main",
    closed: new Set<number>(),
    protected: new Set<string>(),
    comments: new Map<
      number,
      Array<{
        id: number;
        body: string;
        author_id: number | null;
        author_login?: string;
      }>
    >(),
    pulls: [] as Pull[],
    mutations: [] as string[],
    dropAfter: "",
    rejectBefore: "",
    holdBefore: undefined as undefined | (() => Promise<void>),
    afterMutation: undefined as undefined | ((kind: string) => void),
    beforeRequest: undefined as
      undefined | ((method: string, path: string) => Promise<void>),
    requests: [] as Array<{ method: string; path: string }>,
    rateLimit: null as null | {
      method: string;
      path: string;
      seconds: number | string;
    },
  };
  let nextId = 100;
  const head = (branch: string) => {
    try {
      return git(["rev-parse", "--verify", `refs/heads/${branch}`]);
    } catch {
      return null;
    }
  };
  const pull = (row: Pull) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    draft: row.draft,
    user:
      row.author === null
        ? null
        : { id: row.author, login: row.author_login ?? "fixture" },
    head: {
      sha: head(row.branch),
      ref: row.branch,
      repo: { id: state.repository_id },
    },
    base: { ref: row.base, repo: { id: state.repository_id } },
  });
  const backends = new Map<ReturnType<typeof spawn>, Promise<void>>();
  const stop = (child: ReturnType<typeof spawn>) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture"),
      path = decodeURIComponent(url.pathname);
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    state.requests.push({ method: req.method!, path });
    await state.beforeRequest?.(req.method!, path);
    if (
      state.rateLimit &&
      state.rateLimit.method === req.method &&
      state.rateLimit.path === path
    ) {
      res.setHeader("retry-after", String(state.rateLimit.seconds));
      state.rateLimit = null;
      send({ message: "rate limited" }, 429);
      return;
    }
    const mutate = async (kind: string) => {
      if (state.rejectBefore === kind) {
        state.rejectBefore = "";
        send({ message: "denied" }, 403);
        return false;
      }
      await state.holdBefore?.();
      state.mutations.push(kind);
      return true;
    };
    const complete = (kind: string, value: unknown) => {
      state.afterMutation?.(kind);
      if (state.dropAfter === kind) {
        state.dropAfter = "";
        res.destroy();
      } else send(value);
    };
    if (path.startsWith("/owner/repo.git/")) {
      const mutating =
        path.endsWith("/git-receive-pack") && req.method === "POST";
      if (mutating && !(await mutate("branch"))) return;
      if (req.destroyed || res.destroyed) return;
      const child = spawn("/usr/lib/git-core/git-http-backend", [], {
        detached: true,
        env: {
          ...env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: "fixture",
          REQUEST_METHOD: req.method!,
          QUERY_STRING: url.search.slice(1),
          PATH_INFO: path,
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: req.headers["content-length"] ?? "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const disconnected = () => {
        if (!res.writableFinished) stop(child);
      };
      res.on("close", disconnected);
      backends.set(
        child,
        new Promise<void>((resolve) => {
          child.on("close", () => {
            res.off("close", disconnected);
            backends.delete(child);
            resolve();
          });
        }),
      );
      let pending = Buffer.alloc(0),
        headers = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (headers) {
          res.write(chunk);
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        const end = pending.indexOf("\r\n\r\n");
        if (end < 0) return;
        for (const line of pending.subarray(0, end).toString().split("\r\n")) {
          const colon = line.indexOf(":"),
            name = line.slice(0, colon),
            value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status")
            res.statusCode = Number(value.split(" ")[0]);
          else res.setHeader(name, value);
        }
        headers = true;
        res.write(pending.subarray(end + 4));
      });
      child.stderr.resume();
      child.stdin.on("error", () => res.destroy());
      child.on("error", () => res.destroy());
      child.on("close", (code) => {
        if (mutating) state.afterMutation?.("branch");
        if (code !== 0 || (mutating && state.dropAfter === "branch")) {
          state.dropAfter = "";
          res.destroy();
        } else res.end();
      });
      req.pipe(child.stdin);
      return;
    }
    if (
      req.headers.authorization !== `token ${state.token}` &&
      req.headers.authorization !== `Bearer ${state.token}`
    ) {
      send({}, 401);
      return;
    }
    const base = "/repos/owner/repo";
    if (path === "/user") {
      send(state.actor);
      return;
    }
    if (path === base) {
      send({
        id: state.repository_id,
        full_name: "owner/repo",
        default_branch: state.default_branch,
        private: false,
      });
      return;
    }
    if (path === `${base}/issues` && req.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      send(
        [...state.issues.values()]
          .filter((item) => !state.closed.has(item.number))
          .slice((page - 1) * 100, page * 100)
          .map((item) => ({ ...item, state: "open" })),
      );
      return;
    }
    if (path === `${base}/commits/${state.default_branch}`) {
      const sha = head(state.default_branch);
      send({
        sha,
        commit: { tree: { sha: git(["rev-parse", `${sha}^{tree}`]) } },
      });
      return;
    }
    const rules = path.match(/^\/repos\/owner\/repo\/rules\/branches\/(.+)$/);
    if (rules) {
      send(state.protected.has(rules[1]) ? [{ type: "deletion" }] : []);
      return;
    }
    const branch = path.match(/^\/repos\/owner\/repo\/branches\/(.+)$/);
    if (branch) {
      const sha = head(branch[1]);
      send(
        sha
          ? {
              name: branch[1],
              protected: state.protected.has(branch[1]),
              commit: { sha },
            }
          : {},
        sha ? 200 : 404,
      );
      return;
    }
    const issue = path.match(
      /^\/repos\/owner\/repo\/issues\/(\d+)(\/comments)?$/,
    );
    if (issue) {
      const number = Number(issue[1]);
      if (!issue[2]) {
        send({
          ...state.issues.get(number),
          number,
          state: state.closed.has(number) ? "closed" : "open",
        });
        return;
      }
      const comments = state.comments.get(number) ?? [];
      if (req.method === "GET") {
        const page = Number(url.searchParams.get("page") ?? 1);
        send(
          comments.slice((page - 1) * 100, page * 100).map((row) => ({
            ...row,
            updated_at: "2026-10-21T00:00:00Z",
            user:
              row.author_id === null
                ? null
                : { id: row.author_id, login: row.author_login ?? "fixture" },
          })),
        );
        return;
      }
      if (req.method === "POST") {
        if (!(await mutate("comment"))) return;
        let data = "";
        for await (const chunk of req) data += chunk;
        const value = {
          id: ++nextId,
          body: JSON.parse(data).body as string,
          author_id: state.actor.id,
        };
        comments.push(value);
        state.comments.set(number, comments);
        complete("comment", value);
        return;
      }
    }
    const comment = path.match(
      /^\/repos\/owner\/repo\/issues\/comments\/(\d+)$/,
    );
    if (comment && req.method === "PATCH") {
      if (!(await mutate("comment"))) return;
      let data = "";
      for await (const chunk of req) data += chunk;
      const current = [...state.comments.values()]
        .flat()
        .find((row) => row.id === Number(comment[1]));
      if (!current) {
        send({}, 404);
        return;
      }
      current.body = JSON.parse(data).body;
      complete("comment", current);
      return;
    }
    const pr = path.match(/^\/repos\/owner\/repo\/pulls(?:\/(\d+))?$/);
    if (pr) {
      const current = state.pulls.find((row) => row.number === Number(pr[1]));
      if (req.method === "GET") {
        if (pr[1]) send(current ? pull(current) : {}, current ? 200 : 404);
        else {
          const branch = url.searchParams.get("head")?.split(":")[1],
            page = Number(url.searchParams.get("page") ?? 1);
          send(
            state.pulls
              .filter((row) => !branch || row.branch === branch)
              .slice((page - 1) * 100, page * 100)
              .map(pull),
          );
        }
        return;
      }
      if (!(await mutate("pull"))) return;
      let data = "";
      for await (const chunk of req) data += chunk;
      const input = JSON.parse(data);
      if (current) {
        current.title = input.title;
        current.body = input.body;
        complete("pull", pull(current));
      } else {
        const value = {
          id: ++nextId,
          number: nextId,
          title: input.title,
          body: input.body,
          branch: input.head,
          base: input.base,
          state: "open",
          author: state.actor.id,
          draft: input.draft,
        };
        state.pulls.push(value);
        complete("pull", pull(value));
      }
      return;
    }
    send({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("fixture unavailable");
  return {
    state,
    source,
    initial,
    repository,
    git,
    commit,
    head,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      for (const child of backends.keys()) stop(child);
      await Promise.all(backends.values());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
