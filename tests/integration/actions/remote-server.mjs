import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFileSync, symlinkSync } from "node:fs";
import { stringify } from "/opt/orm/app/node_modules/yaml/dist/index.js";
import {
  createPublicationFixture,
  makeCheck,
  makeThread,
} from "/publication-fixture.ts";
import { artifactFixture } from "./artifact-fixture.mjs";
import { fixtureSource, model } from "./model.mjs";
symlinkSync("/opt/orm/app/node_modules", "/fixture/provider/node_modules");
const { remoteRuns } = await import("./remote-runs.mjs");

const config = JSON.parse(readFileSync("/fixture/configuration.json", "utf8"));
const artifacts = artifactFixture(config);
const remote = await createPublicationFixture("/fixture/git");
remote.state.token = config.github.token;
remote.state.bootstrapToken = config.bootstrap_token;
remote.state.permissions.set("untrusted", { id: 99, permission: "read" });
const {
  session_key: _key,
  artifact_tokens: _tokens,
  bootstrap_token: _bootstrap,
  redaction_values: _redactions,
  ...settings
} = config;
void _key;
void _tokens;
void _bootstrap;
void _redactions;
remote.git(["config", "uploadpack.allowReachableSHA1InWant", "true"]);
const revision = remote.commit({
  ...fixtureSource,
  ".github/orm.yml": stringify({
    ...settings,
    github: { token: { from_secret: "ORM_GITHUB_TOKEN" } },
    session_key: { from_secret: "ORM_SESSION_KEY" },
  }),
  ...(process.env.ORM_TEST_FIXTURE_GROUP === "sessions"
    ? {
        ".github/orm/prompts/system.md":
          "Pinned system instructions.\n" +
          "Additional context.\n".repeat(1900),
        ".github/orm/prompts/user.md":
          "Pinned user instructions.\n" + "Additional context.\n".repeat(1900),
      }
    : {}),
  ".remote-dev.yml":
    "allowed-actors: [fixture]\nskills: []\nauto-continue: false\n",
});
remote.git(["update-ref", "refs/heads/main", revision.sha]);
const runs = remoteRuns(remote, artifacts, config, model);

const tls = httpsServer(
  {
    key: readFileSync("/fixture-key.pem"),
    cert: readFileSync("/fixture-ca.pem"),
  },
  async (req, res) => {
    try {
      if ((await runs.handle(req, res)) || (await artifacts.handle(req, res)))
        return;
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
    } catch (error) {
      console.error(error.message);
      res.writeHead(500).end();
    }
  },
);

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  const issue = Number(url.searchParams.get("issue"));
  const send = (value) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  };
  try {
    switch (url.pathname) {
      case "/seed":
        remote.state.issues.set(issue, {
          id: issue + 1000,
          number: issue,
          title: url.searchParams.get("mode"),
          body: "The existing add-one behavior is wrong.",
          updated_at: "2026-10-21T00:00:00Z",
        });
        return send({ sha: revision.sha });
      case "/pending":
        return send(
          runs
            .pending(issue)
            .map(({ run, turn, plan }) => ({ run, turn, plan })),
        );
      case "/complete": {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        await runs.execute(
          Number(url.searchParams.get("run")),
          JSON.parse(Buffer.concat(chunks).toString()),
        );
        return send({});
      }
      case "/move-owned": {
        const pull = remote.state.pulls.find((row) =>
          row.branch.endsWith(`/issue-${issue}`),
        );
        assert(pull);
        const head = remote.commit(
          { ...fixtureSource, "README.md": "Human update.\n" },
          remote.head(pull.branch),
        ).sha;
        remote.git(["update-ref", `refs/heads/${pull.branch}`, head]);
        return send({ head });
      }
      case "/move-progress": {
        const row = runs.events.findLast(
          (item) => item.issue === issue && item.type === "progress_only",
        );
        assert(row);
        const changed = remote.commit(
          { ...fixtureSource, "README.md": "Unexpected work branch change.\n" },
          remote.head("main"),
        ).sha;
        remote.git(["update-ref", `refs/heads/${row.branch}`, changed]);
        return send({ head: changed });
      }
      case "/start":
        runs.start(Number(url.searchParams.get("run")));
        return send({});
      case "/duplicate":
        return send(runs.duplicate(Number(url.searchParams.get("run"))));
      case "/discard-duplicate":
        runs.discard(Number(url.searchParams.get("run")));
        return send({});
      case "/rerun":
        runs.rerun(Number(url.searchParams.get("run")));
        return send({});
      case "/budget":
        runs.budget(issue, Number(url.searchParams.get("used")));
        return send({});
      case "/close":
        remote.state.closed.add(issue);
        return send({});
      case "/reply": {
        const allowed = url.searchParams.get("allowed") === "true";
        remote.addComment(
          issue,
          allowed ? 8 : 99,
          allowed ? "reporter" : "untrusted",
          "Expected result confirmed. increment(1) must be 2.",
        );
        return send({});
      }
      case "/checks": {
        const pull = remote.state.pulls.find((row) =>
          row.branch.endsWith(`/issue-${issue}`),
        );
        assert(pull);
        const head = remote.head(pull.branch);
        remote.state.checks.set(head, [makeCheck(head)]);
        if (url.searchParams.get("repair") === "true") {
          remote.state.threads.set(pull.number, [
            makeThread(9000 + pull.number, head),
          ]);
        } else if (url.searchParams.get("repair") === "false")
          remote.state.threads.delete(pull.number);
        return send({ head, number: pull.number });
      }
      case "/fault":
        artifacts.fault(
          Number(url.searchParams.get("artifact")),
          url.searchParams.get("kind"),
        );
        return send({});
      case "/lose-pull":
        remote.state.dropAfter = "pull";
        return send({});
      case "/read":
      case "/proof":
        return send({
          comments: remote.state.comments.get(issue) ?? [],
          pulls: remote.state.pulls
            .filter((row) => row.branch.endsWith(`/issue-${issue}`))
            .map((row) => ({ ...row, head: remote.head(row.branch) })),
          events: runs.events.filter((row) => row.issue === issue),
          work_heads: Object.fromEntries(
            remote
              .git([
                "for-each-ref",
                "--format=%(refname:short) %(objectname)",
                "refs/heads/orm-work",
              ])
              .split("\n")
              .filter(Boolean)
              .map((row) => row.split(" ")),
          ),
          ...artifacts.proof(),
        });
      default:
        res.writeHead(404).end();
    }
  } catch (error) {
    console.error(error.message);
    res.writeHead(500).end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((resolve) => tls.listen(443, "0.0.0.0", resolve));
await new Promise((resolve) => http.listen(8317, "0.0.0.0", resolve));
process.on("SIGTERM", async () => {
  for (const server of [http, tls]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await remote.close();
});
