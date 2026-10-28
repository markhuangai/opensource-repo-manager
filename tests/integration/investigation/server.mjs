import { createServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFileSync, mkdirSync } from "node:fs";
import Database from "/opt/orm/app/node_modules/better-sqlite3/lib/index.js";
import {
  createPublicationFixture,
  makeCheck,
  makeThread,
} from "/publication-fixture.ts";
import { notificationFixture } from "/notification-fixtures/fixture.mts";
import { respond as claude } from "/agent-fixtures/claude.mjs";
import { respond as codex } from "/agent-fixtures/codex.mjs";
import { sourceFiles, modelFixture } from "./protocol.mjs";

const actions = process.argv.includes("--actions");
let selectedIssue = 1;
let dataRoot = "/data";
let held = false;
let releaseHold;
const config = JSON.parse(readFileSync("/fixture/configuration.json", "utf8"));
const remote = await createPublicationFixture("/fixture/git");
mkdirSync("/fixture/notifications", { recursive: true });
const notificationServer = await notificationFixture("/fixture/notifications", {
  key: "/fixture-key.pem",
  cert: "/fixture-ca.pem",
  listenHost: "0.0.0.0",
  smtpPort: 8465,
});
const notifications = [],
  discord = [];
remote.state.token = config.github.token;
const source = remote.commit(sourceFiles);
remote.git(["update-ref", "refs/heads/main", source.sha]);
remote.state.issues.set(1, {
  id: 1001,
  number: 1,
  title: "monitor_pipeline",
  body: "increment returns the wrong value",
  updated_at: "2026-10-21T00:00:00Z",
});
if (actions) {
  for (const [index, mode] of [
    "source_only",
    "needs_information",
    "manual_feature",
    "no_fix",
    "closed",
    "blocked",
    "cancel",
    "unrelated",
  ].entries())
    remote.state.issues.set(index + 1, {
      id: 1001 + index,
      number: index + 1,
      title: mode,
      body: "increment returns the wrong value",
      updated_at: "2026-10-21T00:00:00Z",
    });
  remote.state.closed.add(5);
  for (const number of [9, 10])
    remote.state.issues.set(number, {
      id: 1000 + number,
      number,
      title: "source_only",
      body: "increment returns the wrong value",
      updated_at: "2026-10-21T00:00:00Z",
    });
  remote.state.afterMutation = (kind) => {
    if (selectedIssue === 10 && dataRoot === "/data" && kind === "pull") {
      remote.state.dropAfter = "pull";
      remote.state.rejectBefore = "comment";
    }
  };
}
let database;
const databases = new Map();
const store = {
  get db() {
    return (database ??= new Database(
      actions
        ? `${dataRoot}/actions/${selectedIssue}/state/manager.sqlite`
        : "/data/state/manager.sqlite",
      {
        readonly: true,
        fileMustExist: true,
      },
    ));
  },
  runs() {
    return this.db.prepare("SELECT * FROM agent_runs ORDER BY rowid").all();
  },
  jobById(id) {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  },
  snapshot(id) {
    return JSON.parse(
      this.db.prepare("SELECT content FROM snapshots WHERE digest=?").get(id)
        .content,
    );
  },
};
let fixture = makeFixture();
function makeFixture() {
  return modelFixture(
    config,
    store,
    actions ? `${dataRoot}/actions/${selectedIssue}/runtime` : "/data/runtime",
    {
      investigationObjective:
        actions && selectedIssue === 9 && dataRoot === "/fresh-data"
          ? "Restore the documented add-one result for increment."
          : undefined,
      async implementation(task) {
        if (
          actions &&
          selectedIssue === 9 &&
          dataRoot === "/data" &&
          task === "implementation_change"
        ) {
          held = true;
          await new Promise((resolve) => {
            releaseHold = resolve;
          });
        }
      },
      async investigate() {
        if (actions && selectedIssue === 7) {
          held = true;
          await new Promise((resolve) => {
            releaseHold = resolve;
          });
        }
      },
    },
  );
}
const tls = httpsServer(
  {
    key: readFileSync("/fixture-key.pem"),
    cert: readFileSync("/fixture-ca.pem"),
  },
  (req, res) => {
    const upstream = request(
      remote.url + req.url,
      { method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  },
);
const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (actions && url.pathname === "/select" && req.method === "POST") {
    if (database) databases.set(`${dataRoot}:${selectedIssue}`, database);
    selectedIssue = Number(url.searchParams.get("issue"));
    dataRoot =
      url.searchParams.get("fresh") === "true" ? "/fresh-data" : "/data";
    if (selectedIssue === 999)
      remote.state.readFailure = {
        path: "/repos/owner/repo/issues/999",
        status: 404,
      };
    database = databases.get(`${dataRoot}:${selectedIssue}`);
    held = false;
    fixture = makeFixture();
    res.end("selected");
  } else if (
    actions &&
    url.pathname === "/corrupt-state" &&
    req.method === "POST"
  ) {
    const number = Number(url.searchParams.get("issue"));
    const comment = remote.state.comments
      .get(number)
      .find((item) => item.body.includes("<!-- orm:task-state:"));
    if (url.searchParams.get("delete") === "true")
      remote.state.comments.set(
        number,
        remote.state.comments
          .get(number)
          .filter((item) => item.id !== comment.id),
      );
    else comment.body = "Edited outside the controller\n" + comment.body;
    res.end("changed");
  } else if (actions && url.pathname === "/release" && req.method === "POST") {
    releaseHold?.();
    res.end("released");
  } else if (
    actions &&
    url.pathname === "/advance-main" &&
    req.method === "POST"
  ) {
    const next = remote.commit(
      { ...sourceFiles, "unrelated.md": "Unrelated default-branch change.\n" },
      remote.head("main"),
    );
    remote.git(["update-ref", "refs/heads/main", next.sha]);
    res.end("advanced");
  } else if (
    actions &&
    url.pathname === "/reject-checkpoint" &&
    req.method === "POST"
  ) {
    remote.state.rejectBefore = "comment";
    res.end("armed");
  } else if (
    actions &&
    url.pathname === "/merge-owned" &&
    req.method === "POST"
  ) {
    const number = Number(url.searchParams.get("issue"));
    const pull = remote.state.pulls.find((pull) =>
      pull.branch.endsWith(`/issue-${number}`),
    );
    pull.state = "closed";
    remote.state.closed.add(number);
    remote.git(["update-ref", "refs/heads/main", remote.head(pull.branch)]);
    res.end("merged");
  } else if (req.url === "/proof") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        source,
        held,
        github_requests: remote.state.requests,
        runs: database
          ? store.runs().map(({ role, uid, status, finished_at }) => ({
              role,
              uid,
              status,
              finished_at,
            }))
          : [],
        leases: database
          ? store.db.prepare("SELECT count(*) AS count FROM coding_lease").get()
              .count
          : 0,
        comments: [...remote.state.comments.entries()],
        pulls: remote.state.pulls,
        mutations: remote.state.mutations,
        errors: fixture.errors.map((error) => error.message),
        requests: fixture.requests.map((item) => item.scenario),
        workflow: database
          ? ["investigations", "implementations", "pr_monitors"].map(
              (phase) => ({
                phase,
                records: store.db
                  .prepare(
                    `SELECT job_id, json_extract(content,'$.stage') AS stage,
                    json_extract(content,'$.failure') AS failure,
                    json_extract(content,'$.retry_at') AS retry_at FROM ${phase}`,
                  )
                  .all()
                  .slice(-3),
              }),
            )
          : [],
        deliveries: database
          ? store.db
              .prepare(
                `SELECT channel,state,retry_at,
                json_extract(content,'$.reason') AS reason
                FROM notification_deliveries ORDER BY rowid DESC LIMIT 9`,
              )
              .all()
          : [],
        notifications,
        discord,
        smtp: notificationServer.messages,
        heads: remote.state.pulls.map((pull) => ({
          number: pull.number,
          id: pull.id,
          head: remote.head(pull.branch),
        })),
        threads: [...remote.state.threads.entries()],
        monitors: database
          ? store.db
              .prepare("SELECT content FROM pr_monitors")
              .all()
              .map((row) => JSON.parse(row.content))
          : [],
        reconstructed:
          actions && database
            ? store.db
                .prepare(
                  "SELECT reconstructed FROM actions_checkpoint WHERE singleton=1",
                )
                .get()?.reconstructed
            : null,
      }),
    );
  } else if (
    (url.pathname === "/review" || url.pathname === "/checks") &&
    req.method === "POST"
  ) {
    const pull = url.searchParams.has("issue")
        ? remote.state.pulls.find((pull) =>
            pull.branch.endsWith(
              `/issue-${Number(url.searchParams.get("issue"))}`,
            ),
          )
        : remote.state.pulls[0],
      head = remote.head(pull.branch);
    if (req.url === "/review")
      remote.state.threads.set(pull.number, [makeThread(9001, head)]);
    remote.state.checks.set(head, [makeCheck(head)]);
    remote.state.reviews.set(
      pull.number,
      ["chatgpt-codex-connector[bot]", "coderabbitai[bot]"].map(
        (login, index) => ({
          id: 20000 + remote.state.mutations.length * 10 + index,
          node_id: `REVIEW_${head}_${index}`,
          user: { id: 200 + index, login },
          commit_id: head,
          state: "COMMENTED",
          body: "",
          submitted_at: new Date().toISOString(),
        }),
      ),
    );
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ pull_number: pull.number, pull_id: pull.id, head }),
    );
  } else if (req.url === "/new" && req.method === "POST") {
    remote.state.issues.set(2, {
      id: 1002,
      number: 2,
      title: "manual_feature",
      body: "Add a new feature",
      updated_at: "2026-10-21T00:01:00Z",
    });
    res.end("created");
  } else if (req.url === "/notify" || req.url === "/discord") {
    let body = "";
    for await (const chunk of req) body += chunk;
    (req.url === "/notify" ? notifications : discord).push(JSON.parse(body));
    res.statusCode = 204;
    res.end();
  } else
    await (config.profiles.worker.sdk === "claude" ? claude : codex)(
      req,
      res,
      fixture,
    );
});
await new Promise((resolve) => tls.listen(443, "0.0.0.0", resolve));
await new Promise((resolve) => http.listen(8317, "0.0.0.0", resolve));
process.on("SIGTERM", async () => {
  for (const server of [http, tls]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (database) databases.set(selectedIssue, database);
  for (const connection of databases.values()) connection.close();
  await notificationServer.close();
  await remote.close();
});
