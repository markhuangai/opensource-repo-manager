import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { Diagnostics } from "/fixture/provider/dist/diagnostics.js";
import { TaskGit } from "/fixture/provider/dist/git.js";
import { restoreCheckpoint } from "/fixture/provider/dist/resume.js";

const workflowPath = ".github/workflows/orm-agent.yml";
const workflowId = 91;
const released = JSON.parse(
  readFileSync("/fixture/provider/package.json", "utf8"),
).dependencies;
const releasedVersions = {
  codex: released["@openai/codex"],
  claude: released["@anthropic-ai/claude-agent-sdk"],
};

async function archive(name, value, files = []) {
  const zip = archiver("zip");
  zip.append(JSON.stringify(value), { name });
  for (const { path, content } of files) zip.append(content, { name: path });
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
  const latestRun = ({ run, latestAttempt }) =>
    latestAttempt
      ? {
          ...run,
          run_attempt: latestAttempt,
          status: "in_progress",
          conclusion: null,
        }
      : run;
  remote.state.afterMutation = (kind) => {
    if (kind !== "comment") return;
    for (const { number, registration } of runs.values()) {
      if (!registration) continue;
      const runId = state(number)?.agent_turn?.run_id ?? null;
      if (runId === registration.bound) continue;
      registration.bound = runId;
      events.push({ type: "registration_write", issue: number, run_id: runId });
    }
  };
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
        ...(mode.startsWith("registration_") && {
          registration: { reads: 0, bound: null },
        }),
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
        .filter((entry) => !entry.deleted)
        .map(latestRun)
        .filter((run) => run.created_at >= start && run.created_at <= end);
      return send({
        total_count: workflow_runs.length,
        workflow_runs: workflow_runs.slice((page - 1) * 100, page * 100),
      });
    }
    const entry = runs.get(Number(runPath?.[1]));
    if (entry?.deleted && req.method === "GET")
      return send({ message: "Workflow run not found" }, 404);
    if (
      entry &&
      req.method === "GET" &&
      ["", "/attempts/1"].includes(runPath[2])
    ) {
      if (entry.registration && runPath[2] === "/attempts/1") {
        const read = ++entry.registration.reads;
        events.push({
          type: "registration_read",
          issue: entry.number,
          run_id: state(entry.number).agent_turn.run_id,
        });
        if (entry.mode === "registration_transient" && read === 1)
          return send({ ...entry.run, display_title: "ORM agent" });
        if (entry.mode === "registration_visibility" && read === 1)
          return send({ message: "Run not yet visible" }, 404);
        if (entry.mode === "registration_visibility" && read === 2)
          return send({ ...entry.run, display_title: "ORM agent" });
        if (entry.mode === "registration_invisible" && read <= 5)
          return send({ message: "Run not yet visible" }, 404);
        if (entry.mode === "registration_persistent")
          return send({
            ...entry.run,
            display_title: `PRIVATE_TITLE_BODY\n${config.github.token}\r\u001b${"x".repeat(4096)}`,
          });
        if (entry.mode === "registration_slow") {
          if (read === 1) return send({ ...entry.run, id: 9999 });
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 15_000);
            res.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          if (res.destroyed) return true;
        }
      }
      return send(runPath[2] === "" ? latestRun(entry) : entry.run);
    }
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
      ...(turn.resume ? { resume_run_id: turn.resume.run_id } : {}),
    });
    assert.equal(state(number).agent_turn.run_id, id);
    const directory = await mkdtemp(join(tmpdir(), "orm-native-fixture-"));
    const root = join(directory, "repo");
    const runnerHome = join(directory, turn.runner);
    await mkdir(root);
    await mkdir(runnerHome);
    try {
      const api = async (path) => {
        const url = new URL(path, "https://api.github.com");
        const runPath =
          /^\/repos\/owner\/repo\/actions\/runs\/(\d+)(\/artifacts)?$/.exec(
            url.pathname,
          );
        if (runPath) {
          const producer = runs.get(Number(runPath[1]));
          assert(producer);
          if (runPath[2]) {
            const rows = artifacts.available(producer.run.id);
            const page = Number(url.searchParams.get("page"));
            const perPage = Number(url.searchParams.get("per_page"));
            assert(Number.isSafeInteger(page) && page > 0);
            assert.equal(perPage, 100);
            return {
              total_count: rows.length,
              artifacts: rows.slice((page - 1) * perPage, page * perPage),
            };
          }
          return latestRun(producer);
        }
        const artifactPath =
          /^\/repos\/owner\/repo\/actions\/artifacts\/(\d+)(\/zip)?$/.exec(
            path,
          );
        if (artifactPath)
          return artifactPath[2]
            ? artifacts.bytes(Number(artifactPath[1]))
            : artifacts
                .available()
                .find((item) => item.id === Number(artifactPath[1]));
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
        throw new Error(
          `Unexpected released execution request ${url.pathname}`,
        );
      };
      const releasedPlan = await prepareExecution({
        api,
        repository: repository.full_name,
        runId: String(id),
        attempt: "1",
        actor: run.actor.login,
        ref: "refs/heads/main",
        plan,
        root: join(directory, "provider-restore"),
        runner: turn.runner,
        resumeRunId: selection.resume_run_id
          ? String(selection.resume_run_id)
          : "",
      });
      assert.equal(releasedPlan.source_sha, run.head_sha);
      assert.equal(releasedPlan.settings.auto_continue, false);
      const gitEnv = {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Native fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Native fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      };
      const git = (...args) =>
        execFileSync("/usr/bin/git", args, {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: gitEnv,
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
      const { restored } = releasedPlan;
      if (restored) {
        const log = new Diagnostics();
        const taskGit = new TaskGit(root, gitEnv, log);
        await restoreCheckpoint(
          { runner: turn.runner, runnerHome },
          restored.root,
          restored.manifest,
          taskGit,
          log,
        );
        const history =
          turn.runner === "codex"
            ? join(
                runnerHome,
                "sessions",
                `${restored.manifest.session_id}.jsonl`,
              )
            : join(
                runnerHome,
                "projects",
                "fixture",
                `${restored.manifest.session_id}.jsonl`,
              );
        assert.match(await readFile(history, "utf8"), /Prior fixture turn/);
        assert.equal(
          git("rev-parse", "HEAD"),
          restored.manifest.checkpoint_sha,
        );
        events.push({
          type: "native_restore",
          issue: number,
          run: id,
          parent: restored.run.id,
          restored_sha: restored.manifest.checkpoint_sha,
          start: turn.starting_sha,
          role: turn.role,
        });
      }
      git("fetch", "--no-tags", "origin", turn.starting_sha);
      git("switch", "--detach", turn.starting_sha);
      const { task, result } = turn.assessment
        ? {
            task: "implementation_candidate_assessment",
            result:
              mode === "incomplete_assessment"
                ? { outcome: "incomplete" }
                : mode === "conflicting_assessment"
                  ? { response: { summary: "Invalid completion record" } }
                  : {
                      response: {
                        summary:
                          "The existing pushed candidate restores increment.",
                        title: "Fix supported increment",
                        commit_message: "Fix supported increment",
                      },
                    },
          }
        : await model({
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
      const firstWriter =
        turn.work_branch &&
        !events.some(
          (item) => item.issue === number && item.type === "write_attempt",
        );
      if (turn.work_branch)
        events.push({ type: "write_attempt", issue: number, run: id });
      const interrupted = Boolean(
        shouldPush &&
        firstWriter &&
        [
          "interrupted_coding",
          "expired_coding",
          "no_coding_session",
          "moved_progress",
        ].includes(mode),
      );
      const lostResult = Boolean(
        shouldPush &&
        firstWriter &&
        [
          "lost_final_result",
          "incomplete_assessment",
          "conflicting_assessment",
        ].includes(mode),
      );
      const asking = Boolean(
        turn.progress &&
        turn.work_branch &&
        result.response?.outcome === "needs_information",
      );
      const noConversation =
        (interrupted && mode === "no_coding_session") ||
        (mode === "failed_investigation" &&
          task === "investigation_triage" &&
          !events.some(
            (item) => item.issue === number && item.type === "no_conversation",
          ));
      const interruptedInvestigation =
        mode === "interrupted_investigation" &&
        task === "investigation_triage" &&
        !events.some(
          (item) => item.issue === number && item.type === "interrupted",
        );
      const nativeOutcome = noConversation
        ? "failed"
        : interrupted || interruptedInvestigation
          ? "cancelled"
          : "completed";
      let checkpointHead;
      if ((shouldPush || asking) && turn.progress) {
        const { branch, parent_sha: parent } = turn.progress;
        assert(text.includes(`only parent ${parent}`));
        git("switch", "-C", branch, turn.starting_sha);
        git("add", "bug.mjs");
        if (git("diff", "--cached", "--name-only")) {
          git("commit", "-m", "Correct increment");
          git("push", "origin", `HEAD:refs/heads/${branch}`);
        }
        checkpointHead = git("rev-parse", "HEAD");
        git("add", ".");
        if (git("status", "--porcelain")) {
          git("commit", "-m", "Record regression coverage");
          git("push", "origin", `HEAD:refs/heads/${branch}`);
        }
        if (interrupted) {
          events.push({
            type: "progress_only",
            issue: number,
            run: id,
            branch,
            first: checkpointHead,
            head: git("rev-parse", "HEAD"),
          });
        } else if (shouldPush) {
          const candidate = git(
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            parent,
            "-m",
            "Correct fixture behavior",
          );
          git("push", "origin", `${candidate}:refs/heads/${turn.work_branch}`);
          git("switch", "-c", turn.work_branch, candidate);
        }
      } else if (shouldPush) {
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
      const session_id = noConversation
        ? ""
        : mode === "changed_session" && restored
          ? randomUUID()
          : (restored?.manifest.session_id ?? randomUUID());
      const runner_version = releasedVersions[turn.runner];
      const files = [
        {
          path:
            turn.runner === "codex"
              ? `codex/sessions/${session_id}.jsonl`
              : `claude/projects/fixture/${session_id}.jsonl`,
          content:
            JSON.stringify(
              turn.runner === "codex"
                ? {
                    type: "session_meta",
                    payload: { id: session_id, message: "Prior fixture turn" },
                  }
                : { sessionId: session_id, text: "Prior fixture turn" },
            ) + "\n",
        },
      ];
      if (
        process.env.ORM_TEST_FIXTURE_GROUP === "sessions" &&
        task === "investigation_triage"
      ) {
        const statePath =
          turn.runner === "codex"
            ? "codex/sessions"
            : "claude/projects/fixture/memory";
        const subdirectory = `${"a".repeat(232)}/${"a".repeat(232)}`;
        for (let i = 0; i < 4500; i++)
          files.push({
            path: `${statePath}/${subdirectory}/${i}.${turn.runner === "codex" ? "jsonl" : "md"}`,
            content:
              turn.runner === "codex"
                ? JSON.stringify({
                    type: "session_meta",
                    payload: { id: `fixture-${i}` },
                  }) + "\n"
                : "Prior fixture turn",
          });
      }
      const record = {
        runner: turn.runner,
        runner_version,
        response: nativeOutcome === "completed" ? response : "",
        native_outcome: nativeOutcome,
        session_id,
      };
      const manifest = {
        schema_version: 5,
        repository: repository.full_name,
        runner: turn.runner,
        runner_version,
        session_id,
        branch: interrupted
          ? turn.progress.branch
          : shouldPush
            ? turn.work_branch
            : asking
              ? turn.progress.branch
              : null,
        checkpoint_sha: interrupted ? checkpointHead : revision,
        omitted_work: interrupted,
        provider_sha: remoteDev.sha,
        auto_count: 0,
        sequence: 1,
        outcome: nativeOutcome,
        root_run_id: releasedPlan.root_run_id,
        activation_run_id: releasedPlan.activation_run_id,
        operator: run.actor.login,
        lineage: releasedPlan.lineage,
        workspace: root,
        runner_home: runnerHome,
        files: files.map(({ path, content }) => ({
          path,
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: Buffer.byteLength(content),
        })),
      };
      if (!lostResult)
        artifacts.native(
          run,
          `remote-dev-result-r${id}-a1`,
          await archive("record.json", record),
        );
      if (session_id) {
        validateManifest(manifest, {
          repository: repository.full_name,
          runner: turn.runner,
        });
        artifacts.native(
          run,
          checkpointName(manifest),
          await archive("manifest.json", manifest, files),
        );
        if (interrupted && mode === "expired_coding") {
          const saved = artifacts
            .available(run.id)
            .find((artifact) => artifact.name === checkpointName(manifest));
          artifacts.fault(saved.id, "expired");
        }
      }
      entry.elapsed = 1000;
      run.status = "completed";
      run.conclusion = noConversation
        ? "failure"
        : nativeOutcome === "cancelled"
          ? "timed_out"
          : "success";
      events.push({
        type: noConversation
          ? "no_conversation"
          : nativeOutcome === "cancelled"
            ? "interrupted"
            : "complete",
        issue: number,
        run: id,
        role: turn.role,
        runner: turn.runner,
        start: turn.starting_sha,
        head: revision,
        parent: shouldPush ? git("rev-parse", "HEAD^") : null,
        branch: manifest.branch,
        progress_branch: turn.progress?.branch,
        assessment_of: turn.assessment?.sha,
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
      await rm(directory, { recursive: true });
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
    deleteLegacyProducer(number, id) {
      const entry = runs.get(id);
      assert.equal(entry?.run.status, "completed");
      const { row, codec, decoded } = signed(number);
      const { state, narrative } = decoded;
      assert.equal(state.agent_recovery.investigation.run_id, id);
      delete state.agent_recovery;
      row.body = codec.encode(state, narrative);
      entry.deleted = true;
    },
    codingCandidate: (number) =>
      state(number)?.agent_recovery?.coding?.candidate,
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
