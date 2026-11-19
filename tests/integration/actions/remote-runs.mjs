import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import archiver from "/opt/orm/app/node_modules/archiver/index.js";
import { StateCodec } from "/opt/orm/app/dist/actions/state.js";
import { remoteDev } from "/opt/orm/app/dist/domain/remote-turns.js";
import { prepareExecution } from "/fixture/provider/src/platform/continuation-policy.mjs";
import {
  checkpointName,
  validateManifest,
} from "/fixture/provider/src/platform/checkpoint-policy.mjs";
import { readFileSync } from "node:fs";

const workflowPath = ".github/workflows/orm-agent.yml";
const workflowId = 91;
const released = JSON.parse(
  readFileSync("/fixture/provider/package.json", "utf8"),
).dependencies;
const releasedVersions = {
  codex: released["@openai/codex"],
  claude: released["@anthropic-ai/claude-agent-sdk"],
};

async function archive(name, value) {
  const zip = archiver("zip");
  zip.append(JSON.stringify(value), { name });
  void zip.finalize();
  const bytes = [];
  for await (const chunk of zip) bytes.push(chunk);
  return Buffer.concat(bytes);
}

export function remoteRuns(remote, artifacts, config, model) {
  const runs = new Map();
  const events = [];
  let next = 9000;
  const repository = {
    id: 42,
    full_name: "owner/repo",
    default_branch: "main",
    private: false,
  };
  const signed = (number) => {
    const row = remote.state.comments
      .get(number)
      ?.find((item) => item.body.includes("<!-- orm:task-state:"));
    if (!row) return;
    const codec = new StateCodec(config.session_key);
    return {
      row,
      codec,
      decoded: codec.decode(row.body, {
        repository_id: repository.id,
        issue_id: remote.state.issues.get(number).id,
        comment_id: row.id,
        author_id: remote.state.actor.id,
      }),
    };
  };
  const state = (number) => signed(number)?.decoded.state;
  async function handle(req, res) {
    const path = new URL(req.url, "https://api.github.com").pathname;
    const workflow = path.match(
      /^\/repos\/owner\/repo\/actions\/workflows\/(orm-agent\.yml|91)(.*)$/,
    );
    const runPath = path.match(
      /^\/repos\/owner\/repo\/actions\/runs\/(9[0-9]{3})(.*)$/,
    );
    if (!workflow && !runPath) return false;
    const send = (value, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "x-github-request-id": "native-fixture",
      });
      res.end(
        status === 204 || status === 202 ? undefined : JSON.stringify(value),
      );
      return true;
    };
    assert.match(req.headers.authorization ?? "", /^(token|Bearer) /);
    if (workflow?.[2] === "" && req.method === "GET")
      return send({ id: workflowId, path: workflowPath, state: "active" });
    if (workflow?.[2] === "/dispatches" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.ref, "main");
      assert.equal(body.return_run_details, true);
      assert(Buffer.byteLength(body.inputs.plan) <= 65535);
      const number = Number(body.inputs.issue);
      const turn = state(number).agent_turn;
      assert.equal(turn.id, body.inputs.turn);
      assert.equal(turn.run_id, null);
      assert.equal(turn.caller_sha, remote.head("main"));
      const mode = remote.state.issues.get(number).title;
      const substituted =
        mode === "caller_revision_changed" &&
        !events.some(
          (event) => event.issue === number && event.type === "dispatch",
        );
      events.push({
        type: "dispatch",
        issue: number,
        turn: turn.id,
        role: turn.role,
      });
      if (mode === "denied_dispatch")
        return send({ message: "Actions write refused by fixture" }, 403);
      const id = next++;
      const run = {
        id,
        run_attempt: 1,
        workflow_id: workflowId,
        path: workflowPath,
        event: "workflow_dispatch",
        display_title: `ORM agent #${number} ${turn.id}`,
        head_branch: "main",
        head_sha: substituted ? "e".repeat(40) : turn.caller_sha,
        repository,
        head_repository: repository,
        actor: remote.state.actor,
        triggering_actor: remote.state.actor,
        status: "queued",
        conclusion: null,
        created_at: new Date().toISOString(),
        referenced_workflows: [
          {
            path: `${remoteDev.repository}/${remoteDev.path}@${remoteDev.sha}`,
            ref: "refs/tags/v1.0.0",
            sha: remoteDev.sha,
          },
        ],
      };
      runs.set(id, {
        run,
        number,
        turn,
        mode,
        plan: body.inputs.plan,
        elapsed: 0,
      });
      if (
        mode === "dispatch_response_lost" &&
        [...runs.values()].filter((entry) => entry.number === number).length ===
          1
      ) {
        req.socket.destroy();
        return true;
      }
      return send({
        workflow_run_id: id,
        run_url: `https://api.github.com/repos/owner/repo/actions/runs/${id}`,
      });
    }
    if (workflow?.[2] === "/runs" && req.method === "GET") {
      const query = new URL(req.url, "https://api.github.com").searchParams;
      const [start, end] = query.get("created").split("..");
      const page = Number(query.get("page"));
      const workflow_runs = [...runs.values()]
        .map(({ run, latestAttempt }) => ({
          ...run,
          run_attempt: latestAttempt ?? 1,
        }))
        .filter((run) => run.created_at >= start && run.created_at <= end);
      return send({
        total_count: workflow_runs.length,
        workflow_runs: workflow_runs.slice((page - 1) * 100, page * 100),
      });
    }
    const entry = runs.get(Number(runPath?.[1]));
    if (
      entry &&
      req.method === "GET" &&
      ["", "/attempts/1"].includes(runPath[2])
    )
      return send(
        runPath[2] === "" && entry.latestAttempt
          ? { ...entry.run, run_attempt: entry.latestAttempt }
          : entry.run,
      );
    if (
      entry?.mode === "reproduced" &&
      entry.turn.role === "output_review" &&
      entry.run.status === "completed" &&
      req.method === "GET" &&
      runPath[2] === "/artifacts" &&
      !events.some((event) => event.type === "collection_unavailable")
    ) {
      events.push({
        type: "collection_unavailable",
        issue: entry.number,
        run: entry.run.id,
        turn: entry.turn.id,
      });
      return send({ message: "Temporary artifact transport failure" }, 503);
    }
    if (entry && req.method === "GET" && runPath[2] === "/attempts/1/jobs") {
      const steps = entry.elapsed
        ? [
            {
              name: "Execute agent",
              started_at: entry.run.created_at,
              completed_at: new Date(
                Date.parse(entry.run.created_at) + entry.elapsed,
              ).toISOString(),
            },
          ]
        : [];
      return send({ total_count: 1, jobs: [{ steps }] });
    }
    if (entry && req.method === "POST" && runPath[2] === "/cancel") {
      entry.run.status = "completed";
      entry.run.conclusion = "cancelled";
      events.push({ type: "cancel", issue: entry.number, run: entry.run.id });
      return send({}, 202);
    }
    return false;
  }

  async function execute(id, selection) {
    const entry = runs.get(id);
    assert(entry && entry.run.status === "queued");
    const { run, number, turn, mode, plan } = entry;
    assert.deepEqual(selection, {
      runner: turn.runner,
      profile: turn.profile,
      write: Boolean(turn.work_branch),
      timeout_minutes: turn.timeout_minutes,
    });
    assert.equal(state(number).agent_turn.run_id, id);
    const root = await mkdtemp(join(tmpdir(), "orm-native-fixture-"));
    try {
      const api = async (path) => {
        if (path === `/repos/owner/repo/actions/runs/${id}`) return run;
        if (path === "/repos/owner/repo") return repository;
        if (path === "/repos/owner/repo/commits/main")
          return { sha: remote.head("main") };
        if (
          path ===
          `/repos/owner/repo/contents/.remote-dev.yml?ref=${run.head_sha}`
        ) {
          const bytes = Buffer.from(
            remote.git(["show", `${run.head_sha}:.remote-dev.yml`]),
          );
          return {
            encoding: "base64",
            size: bytes.length,
            content: bytes.toString("base64"),
          };
        }
        if (
          path ===
          `/repos/owner/repo/collaborators/${run.actor.login}/permission`
        )
          return {
            permission: remote.state.permissions.get(run.actor.login)
              .permission,
          };
        throw new Error("Unexpected released execution request");
      };
      const releasedPlan = await prepareExecution({
        api,
        repository: repository.full_name,
        runId: String(id),
        attempt: "1",
        actor: run.actor.login,
        ref: "refs/heads/main",
        plan,
        root,
        runner: turn.runner,
      });
      assert.equal(releasedPlan.source_sha, run.head_sha);
      assert.equal(releasedPlan.settings.auto_continue, false);
      const git = (...args) =>
        execFileSync("/usr/bin/git", args, {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Native fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Native fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          },
        }).trim();
      const inline = plan.includes("Task data (not authorization):\n");
      const artifactId = inline
        ? null
        : /artifacts\/(\d+)\/zip/.exec(plan)?.[1];
      let text = plan;
      if (!inline) {
        const bytes = artifacts.bytes(Number(artifactId));
        assert(plan.includes(createHash("sha256").update(bytes).digest("hex")));
        text = JSON.parse(bytes.toString()).instructions;
      }
      assert(text.includes(`starting commit ${turn.starting_sha}`));
      git("init");
      git("remote", "add", "origin", remote.repository);
      git("fetch", "--no-tags", "origin", turn.starting_sha);
      git("switch", "--detach", turn.starting_sha);
      const { task, result } = await model({
        text,
        mode,
        turn,
        root,
        git,
        number,
      });
      const shouldPush =
        turn.work_branch &&
        result.response?.outcome !== "needs_information" &&
        mode !== "missing_push";
      if (shouldPush) {
        const current = state(number);
        const parent = current.pr?.head ?? current.job.source.sha;
        assert(text.includes(`whose only parent is ${parent}`));
        git("switch", "-c", turn.work_branch);
        git("add", ".");
        if (turn.starting_sha !== parent) git("reset", "--soft", parent);
        git(
          "commit",
          "-m",
          "Correct fixture behavior",
          "-m",
          "Assisted-by: remote-agent-dev <https://github.com/markhuangai/agent-remote-dev>",
        );
        git("push", "origin", `HEAD:refs/heads/${turn.work_branch}`);
      }
      const revision = git("rev-parse", "HEAD");
      const response = JSON.stringify(result);
      const session_id = randomUUID();
      const runner_version = releasedVersions[turn.runner];
      const record = {
        runner: turn.runner,
        runner_version,
        response,
        native_outcome: "completed",
        session_id,
      };
      const manifest = {
        schema_version: 5,
        repository: repository.full_name,
        runner: turn.runner,
        runner_version,
        session_id,
        branch: shouldPush ? turn.work_branch : null,
        checkpoint_sha: revision,
        omitted_work: false,
        provider_sha: remoteDev.sha,
        auto_count: 0,
        sequence: 1,
        outcome: "completed",
        root_run_id: String(id),
        activation_run_id: String(id),
        operator: run.actor.login,
        lineage: releasedPlan.lineage,
        workspace: root,
        runner_home: join(root, turn.runner),
        files:
          process.env.ORM_TEST_FIXTURE_GROUP === "sessions" &&
          task === "investigation_triage"
            ? Array.from({ length: 4500 }, (_, i) => ({
                path: `${turn.runner === "codex" ? "codex/sessions" : "claude/projects/fixture/memory"}/${"a".repeat(465)}/${i}.${turn.runner === "codex" ? "jsonl" : "md"}`,
                sha256: "b".repeat(64),
                bytes: 1,
              }))
            : [],
      };
      artifacts.native(
        run,
        `remote-dev-result-r${id}-a1`,
        await archive("record.json", record),
      );
      validateManifest(manifest, {
        repository: repository.full_name,
        runner: turn.runner,
      });
      artifacts.native(
        run,
        checkpointName(manifest),
        await archive("manifest.json", manifest),
      );
      entry.elapsed = 1000;
      run.status = "completed";
      run.conclusion = "success";
      events.push({
        type: "complete",
        issue: number,
        run: id,
        role: turn.role,
        runner: turn.runner,
        start: turn.starting_sha,
        head: revision,
        parent: shouldPush ? git("rev-parse", "HEAD^") : null,
        branch: manifest.branch,
        task,
      });
      if (
        mode === "moved_head" &&
        task === "implementation_audit" &&
        !events.some((event) => event.type === "move" && event.issue === number)
      ) {
        const work = events.findLast(
          (event) => event.issue === number && event.branch,
        );
        git("switch", "--detach", work.head);
        await writeFile(
          join(root, "unreviewed.txt"),
          "Moved after the audit.\n",
        );
        git("add", "unreviewed.txt");
        git("commit", "-m", "Move fixture head");
        git("push", "origin", `HEAD:refs/heads/${work.branch}`);
        events.push({
          type: "move",
          issue: number,
          branch: work.branch,
          head: git("rev-parse", "HEAD"),
        });
      }
    } finally {
      await rm(root, { recursive: true });
    }
  }
  return {
    handle,
    execute,
    events,
    start(id) {
      const entry = runs.get(id);
      assert(entry?.run.status === "queued");
      entry.run.status = "in_progress";
    },
    duplicate(id) {
      const original = runs.get(id);
      assert(original);
      const duplicate = {
        ...original,
        run: { ...original.run, id: next++, status: "queued" },
      };
      runs.set(duplicate.run.id, duplicate);
      return duplicate;
    },
    discard(id) {
      runs.delete(id);
    },
    rerun(id) {
      const entry = runs.get(id);
      assert.equal(entry?.run.status, "completed");
      entry.latestAttempt = 2;
    },
    budget(number, used) {
      const { row, codec, decoded } = signed(number);
      const { state, narrative } = decoded;
      assert.equal(state.budget.agent_runs, 1);
      state.budget.agent_runs = used;
      state.session_artifact = null;
      row.body = codec.encode(state, narrative);
    },
    pending: (number) =>
      [...runs.values()].filter(
        (entry) => entry.number === number && entry.run.status === "queued",
      ),
  };
}
