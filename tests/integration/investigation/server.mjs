import { createServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFileSync } from "node:fs";
import Database from "/opt/orm/app/node_modules/better-sqlite3/lib/index.js";
import { createPublicationFixture } from "/publication-fixture.ts";
import { respond as claude } from "/agent-fixtures/claude.mjs";
import { respond as codex } from "/agent-fixtures/codex.mjs";
import { sourceFiles, modelFixture } from "./protocol.mjs";

const config = JSON.parse(readFileSync("/fixture/configuration.json", "utf8"));
const remote = await createPublicationFixture("/fixture/git");
remote.state.token = config.github.token;
const source = remote.commit(sourceFiles);
remote.git(["update-ref", "refs/heads/main", source.sha]);
remote.state.issues.set(1, {
  id: 1001,
  number: 1,
  title: "source_only",
  body: "increment returns the wrong value",
  updated_at: "2026-10-21T00:00:00Z",
});
let database;
const store = {
  get db() {
    return (database ??= new Database("/data/state/manager.sqlite", {
      readonly: true,
      fileMustExist: true,
    }));
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
const fixture = modelFixture(config, store, "/data/runtime");
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
  if (req.url === "/proof") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        source,
        comments: [...remote.state.comments.entries()],
        pulls: remote.state.pulls,
        mutations: remote.state.mutations,
        errors: fixture.errors.map((error) => error.message),
        requests: fixture.requests.map((item) => item.scenario),
      }),
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
  } else if (req.url === "/notify") {
    for await (const chunk of req) void chunk;
    res.end("accepted");
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
  database?.close();
  await remote.close();
});
