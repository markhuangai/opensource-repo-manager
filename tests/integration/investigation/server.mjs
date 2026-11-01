import { createServer, request } from "node:http";
import assert from "node:assert/strict";
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
import { artifactFixture } from "/actions-fixtures/artifact-fixture.mjs";
import { StateCodec } from "/opt/orm/app/dist/actions/state.js";

const actions = process.argv.includes("--actions");
let selectedIssue = 1;
let dataRoot = "/data";
let held = false;
let releaseHold;
const config = JSON.parse(readFileSync("/fixture/configuration.json", "utf8"));
const artifacts = actions ? artifactFixture(config) : undefined;
let sessionPhase = "seed";
let loseReferenceResponse = false,
  lostReferenceResponse = false;
let earlyQuestionReply = false;
let questionBoundary;
let publicationFault;
const publicationFaults = [];
let releaseQuestionBoundary;
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
  remote.git(["config", "uploadpack.allowReachableSHA1InWant", "true"]);
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
    if (
      questionBoundary?.issue === selectedIssue &&
      kind === "comment" &&
      !questionBoundary.armed
    ) {
      const rows = remote.state.comments.get(selectedIssue) ?? [];
      const canonical = rows.find((row) =>
        row.body.includes("<!-- orm:task-state:"),
      );
      const encoded = canonical?.body.match(
        /<!-- orm:task-state:v1:([A-Za-z0-9_-]+):/,
      )?.[1];
      const state =
        encoded && JSON.parse(Buffer.from(encoded, "base64url").toString());
      if (
        questionBoundary.stage === "checkpoint" &&
        state?.pending?.kind === "question" &&
        state.pending.status === "reviewed"
      )
        questionBoundary.armed = true;
      if (
        questionBoundary.stage === "dispatch" &&
        rows.some((row) => row.body.includes("Reply in a new issue comment."))
      ) {
        questionBoundary.armed = true;
        remote.addComment(
          selectedIssue,
          8,
          "reporter",
          "Confirmed fact: increment(1) must return 2.",
        );
        remote.state.dropAfter = "comment";
        remote.state.beforeRequest = async (method, path) => {
          if (
            method === "GET" &&
            path === `/repos/owner/repo/issues/${selectedIssue}/comments`
          ) {
            questionBoundary.held = true;
            await new Promise((resolve) => {
              releaseQuestionBoundary = resolve;
            });
          }
        };
      }
    }
    if (
      earlyQuestionReply &&
      kind === "comment" &&
      remote.state.comments
        .get(selectedIssue)
        ?.at(-1)
        ?.body.includes("Reply in a new issue comment.")
    ) {
      earlyQuestionReply = false;
      remote.addComment(
        selectedIssue,
        8,
        "reporter",
        "Confirmed fact: increment(1) must return 2.",
      );
      remote.state.dropAfter = "comment";
    }
    if (selectedIssue === 30 && kind === "comment" && loseReferenceResponse) {
      const row = remote.state.comments
        .get(30)
        ?.find((item) => item.body.includes("<!-- orm:task-state:"));
      const encoded = row?.body.match(
        /<!-- orm:task-state:v1:([A-Za-z0-9_-]+):/,
      )?.[1];
      if (
        encoded &&
        JSON.parse(Buffer.from(encoded, "base64url").toString())
          .session_artifact
      ) {
        loseReferenceResponse = false;
        lostReferenceResponse = true;
        remote.state.dropAfter = "comment";
      }
    }
    const notice =
      kind === "comment" && remote.state.comments.get(selectedIssue)?.at(-1);
    if (
      publicationFault === kind ||
      (publicationFault === "notification" &&
        notice &&
        !notice.body.includes("<!-- orm:task-state:") &&
        notice.body.includes("Automation clean; awaiting human review."))
    ) {
      publicationFaults.push({ issue: selectedIssue, kind: publicationFault });
      publicationFault = undefined;
      remote.state.dropAfter = kind;
      remote.state.rejectBefore = "comment";
    }
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
  const selected = modelFixture(
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
  selected.session = (text, role, first) => {
    if (role === "audit" || role === "output_review") {
      assert(
        !text.includes("native-history-canary"),
        "Auditor inherited coding history",
      );
      assert(
        !text.includes("Appended factual answer"),
        "Auditor inherited the coding reply",
      );
      return { result: "fresh-auditor" };
    }
    const resumed = ["resume", "interrupt", "duplicate"].includes(sessionPhase);
    if (first && resumed) {
      assert(
        text.includes("native-history-canary"),
        "Native conversation history was lost",
      );
      assert(
        text.includes("Appended factual answer"),
        "New admitted reply was lost",
      );
    }
    if (first && !resumed)
      assert(
        !text.includes("native-history-canary"),
        "Fresh recovery reused expired history",
      );
    return first
      ? {
          command: [
            "set -eu",
            'test "$(id -u)" = 10001',
            'test -z "${ORM_SESSION_KEY:-}${ACTIONS_RUNTIME_TOKEN:-}${ORM_ARTIFACT_TOKEN:-}"',
            'test "$(node --version)" = v24.18.0',
            ...(resumed
              ? [
                  'test "$(cat unfinished.txt)" = first',
                  "test ! -e README.md",
                  "test ! -e node_modules",
                  "test ! -e .venv",
                  "printf -- '-second' >> unfinished.txt",
                ]
              : [
                  "printf first > unfinished.txt",
                  "rm README.md",
                  "mkdir -p node_modules/fixture .venv",
                  "printf cache > node_modules/fixture/cache",
                  "printf cache > .venv/cache",
                ]),
          ].join("\n"),
        }
      : { result: "native-history-canary" };
  };
  return selected;
}
const tls = httpsServer(
  {
    key: readFileSync("/fixture-key.pem"),
    cert: readFileSync("/fixture-ca.pem"),
  },
  async (req, res) => {
    if (
      questionBoundary?.stage === "checkpoint" &&
      questionBoundary.armed &&
      req.url.endsWith("/CreateArtifact")
    ) {
      questionBoundary.held = true;
      await new Promise((resolve) => {
        releaseQuestionBoundary = resolve;
      });
      if (res.destroyed) return;
    }
    if (artifacts && (await artifacts.handle(req, res))) return;
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
    sessionPhase = url.searchParams.get("session") ?? "seed";
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
    url.pathname === "/publication-fault" &&
    req.method === "POST"
  ) {
    publicationFault = url.searchParams.get("kind");
    assert(
      ["notification", "thread_reply", "branch", "pull"].includes(
        publicationFault,
      ),
    );
    res.end("armed");
  } else if (
    actions &&
    url.pathname === "/age-repair-question" &&
    req.method === "POST"
  ) {
    const number = Number(url.searchParams.get("issue"));
    const row = remote.state.comments
      .get(number)
      .find((item) => item.body.includes("<!-- orm:task-state:"));
    const codec = new StateCodec(config.session_key);
    const saved = codec.decode(row.body, {
      repository_id: 42,
      issue_id: 1000 + number,
      comment_id: row.id,
      author_id: remote.state.actor.id,
    });
    assert(saved.state.pr.repair_reserved);
    assert.equal(saved.state.wait_accounted_at, null);
    saved.state.budget.repair_cycles = saved.state.limits.repair_cycles;
    saved.state.generation++;
    const old = new Date(Date.now() - 15 * 86400000).toISOString();
    const question = remote.state.comments
      .get(number)
      .find((item) => item.id === saved.state.question.comment_id);
    question.created_at = old;
    question.updated_at = old;
    artifacts.fault(saved.state.session_artifact.artifact_id, "expired");
    row.body = codec.encode(saved.state, saved.narrative);
    res.end("aged fifteen days at the final reserved repair cycle");
  } else if (
    actions &&
    url.pathname === "/clarification-issue" &&
    req.method === "POST"
  ) {
    const number = Number(url.searchParams.get("issue"));
    remote.state.issues.set(number, {
      id: 1000 + number,
      number,
      title: url.searchParams.get("mode"),
      body: "increment returns the wrong value; bug label alone is not proof",
      updated_at: new Date().toISOString(),
    });
    earlyQuestionReply = url.searchParams.get("early") === "true";
    questionBoundary = url.searchParams.has("boundary")
      ? {
          issue: number,
          stage: url.searchParams.get("boundary"),
          armed: false,
          held: false,
        }
      : undefined;
    res.end("created");
  } else if (
    actions &&
    url.pathname === "/release-question-boundary" &&
    req.method === "POST"
  ) {
    remote.state.beforeRequest = undefined;
    questionBoundary = undefined;
    releaseQuestionBoundary?.();
    res.end("released");
  } else if (
    actions &&
    url.pathname === "/legacy-question" &&
    req.method === "POST"
  ) {
    const number = Number(url.searchParams.get("issue"));
    const row = remote.state.comments
      .get(number)
      .find((row) => row.body.includes("<!-- orm:task-state:"));
    const codec = new StateCodec(config.session_key);
    const decoded = codec.decode(row.body, {
      repository_id: 42,
      issue_id: 1000 + number,
      comment_id: row.id,
      author_id: remote.state.actor.id,
    });
    const state = decoded.state;
    state.question = {
      questions: [...state.question.questions],
      input_digest: state.job.input_digest,
    };
    state.findings = {
      outcome: "needs_information",
      summary: "Existing legacy question awaiting a factual answer.",
      objective: "",
      proof: "none",
      evidence_ids: [],
      questions: state.question.questions,
    };
    state.pending = null;
    state.session_artifact = null;
    state.generation++;
    row.body = codec.encode(state, decoded.narrative);
    res.end("legacy signed state prepared");
  } else if (actions && url.pathname === "/answer" && req.method === "POST") {
    const number = Number(url.searchParams.get("issue"));
    const login = url.searchParams.get("actor") ?? "reporter";
    const id =
      login === "fixture"
        ? 7
        : login === "reporter"
          ? 8
          : login.endsWith("[bot]")
            ? 10
            : 9;
    remote.state.permissions.set(login, {
      id,
      permission: login === "fixture" ? "admin" : "read",
    });
    const row = remote.addComment(
      number,
      id,
      login,
      url.searchParams.get("body") ??
        "Confirmed fact: increment(1) must return 2.",
    );
    if (login.endsWith("[bot]")) row.author_type = "Bot";
    res.end(JSON.stringify(row));
  } else if (
    actions &&
    url.pathname === "/artifact-fault" &&
    req.method === "POST"
  ) {
    if (url.searchParams.get("kind") === "drop_reference")
      loseReferenceResponse = true;
    else
      artifacts.fault(
        Number(url.searchParams.get("id")),
        url.searchParams.get("kind"),
      );
    res.end("armed");
  } else if (
    actions &&
    url.pathname === "/session-issue" &&
    req.method === "POST"
  ) {
    const number = Number(url.searchParams.get("issue"));
    remote.state.issues.set(number, {
      id: 1000 + number,
      number,
      title: "native session continuation",
      body: "Preserve unfinished work",
      updated_at: "2026-10-28T00:00:00Z",
    });
    res.end("created");
  } else if (
    actions &&
    url.pathname === "/forget-local" &&
    req.method === "POST"
  ) {
    const key = `${dataRoot}:${selectedIssue}`;
    database?.close();
    database = undefined;
    databases.delete(key);
    res.end("closed local fixture connection");
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
    url.pathname === "/restore-main" &&
    req.method === "POST"
  ) {
    const sha = url.searchParams.get("sha");
    assert(/^[a-f0-9]{40}$/.test(sha));
    remote.git(["update-ref", "refs/heads/main", sha]);
    res.end("restored fixture main");
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
  } else if (url.pathname === "/proof") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        source,
        artifacts: artifacts?.proof(),
        lost_reference_response: lostReferenceResponse,
        held,
        question_boundary: questionBoundary,
        publication_faults: publicationFaults,
        conversations: database
          ? store.db
              .prepare("SELECT content FROM agent_conversations")
              .all()
              .map((row) => JSON.parse(row.content))
              .map((conversation) => ({
                id: conversation.id,
                request_digest: conversation.request_digest,
                messages: conversation.messages,
                native_id: store
                  .runs()
                  .find((run) => run.id === conversation.run_id)?.session_id,
              }))
          : [],
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
                    json_array_length(content,'$.continuation.request.input.context.comments') AS context_comment_count,
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
    if (url.pathname === "/review")
      remote.state.threads.set(pull.number, [
        makeThread(9000 + pull.number, head),
      ]);
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
