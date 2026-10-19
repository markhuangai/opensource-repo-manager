import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicationFixture } from "/publication-fixture.ts";
import { Octokit } from "/opt/orm/app/node_modules/@octokit/rest/dist-src/index.js";
import { OctokitWriter } from "/opt/orm/app/dist/adapters/github/writer.js";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
import { Supervisor } from "/opt/orm/app/dist/runtime/supervisor.js";
import { userProcesses } from "/opt/orm/app/dist/runtime/process.js";
import { PublicationScanner } from "/opt/orm/app/dist/services/publication/scanner.js";
import {
  loadProtectedConfiguration,
  createRunSnapshot,
} from "/opt/orm/app/dist/config/load.js";
import { parseConfiguration } from "/opt/orm/app/dist/config/schema.js";
import { separateSecrets } from "/opt/orm/app/dist/config/secrets.js";
import { respond as claude } from "/agent-fixtures/claude.mjs";
import { respond as codex } from "/agent-fixtures/codex.mjs";

async function events(stream) {
  const result = [];
  for await (const event of stream) result.push(event);
  return result;
}
async function until(check) {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
    assert(Date.now() < deadline, "publication fixture condition timed out");
    await delay(20);
  }
}
export async function runPublicationTests() {
  const root = "/data/publication-proof";
  await mkdir(root, { mode: 0o711 });
  const remote = await createPublicationFixture(join(root, "git"));
  const loaded = await loadProtectedConfiguration(),
    database = join(root, "state", "publication.sqlite");
  let store = new Store(database),
    supervisor,
    fixture,
    sdk,
    rejectReview = false,
    wrongBinding = false,
    modelDown = false,
    nested = false,
    holdReview,
    reviewEntered = false;
  const errors = [],
    requests = [],
    proof = [],
    reviewProgress = [];
  const model = createServer((req, res) => {
    if (modelDown) {
      res.statusCode = 503;
      res.end("unavailable");
      return;
    }
    return (sdk === "claude" ? claude : codex)(req, res, fixture);
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const proxy = `http://127.0.0.1:${model.address().port}/v1`;
  const profiles = {
    codex: { sdk: "codex", model: "gpt-5.5", effort: "xhigh" },
    claude: {
      sdk: "claude",
      model: "auto",
      behaves_as: "claude-opus-4-8",
      effort: "xhigh",
    },
  };
  let number = 8000;
  const signal = () => new globalThis.AbortController().signal;
  store.enroll({
    id: 42,
    full_name: "owner/repo",
    default_branch: "main",
    private: false,
  });
  let config, snapshot, secrets, options;
  const seed = () => {
    store.saveSnapshot(snapshot);
    store.discover([++number], 1, true);
    store.applyIssue(
      store.nextDirty(),
      {
        id: number + 10000,
        number,
        state: "open",
        title: "Publication fixture",
        body: "maintenance",
        updated_at: "2026-10-19T00:00:00Z",
        comments: [],
        source: remote.source,
      },
      snapshot,
    );
    return store.job(number);
  };
  const candidate = async (job, label, binary = false, structured) => {
    fixture.environmentCommand = `printf '${label}\\n' > app.txt; ${binary ? "printf '\\000\\377' > image.bin; " : ""}${structured ? `printf '%s' '${Buffer.from(structured.content).toString("base64")}' | base64 -d > '${structured.path}'; ` : ""}test "$(cat app.txt)" = '${label}' && printf '\\nBOOTSTRAP_TESTS_PASSED\\n'`;
    const implementation = (
      await events(
        supervisor.run(
          supervisor.request(job.id, "implementation", {
            task: "bootstrap_environment",
          }),
          signal(),
        ),
      )
    ).at(-1);
    assert.equal(implementation.outcome, "completed");
    assert(implementation.artifact);
    fixture.environmentCommand = `test "$(cat app.txt)" = '${label}' && printf '\\nBOOTSTRAP_TESTS_PASSED\\n'`;
    const audit = (
      await events(
        supervisor.run(
          supervisor.request(
            job.id,
            "audit",
            { task: "bootstrap_environment" },
            implementation.artifact,
          ),
          signal(),
        ),
      )
    ).at(-1);
    assert.equal(audit.outcome, "completed");
    const auditRun = store
      .runs()
      .findLast((run) => run.role === "audit" && run.job_id === job.id);
    const ids = [];
    for (const kind of ["audit", "test"])
      ids.push(
        await supervisor.publication.recordEvidence(
          {
            job_id: job.id,
            revision: job.revision,
            kind,
            source_sha: remote.source.sha,
            artifact_digest: implementation.artifact,
            outcome: "passed",
            details: {
              run_id: auditRun.id,
              command: fixture.environmentCommand,
              result: "BOOTSTRAP_TESTS_PASSED",
            },
          },
          signal(),
        ),
      );
    return {
      job_id: job.id,
      revision: job.revision,
      kind: "change",
      artifact_digest: implementation.artifact,
      expected_head: supervisor.publication.repository.target(job.id).head,
      evidence_ids: ids,
      title: `Fix ${label}`,
      body: `Verified fixture change ${label}.`,
      commit_message: `Fix ${label}`,
    };
  };
  const status = (job, body) => ({
    job_id: job.id,
    revision: job.revision,
    kind: "status",
    body,
  });
  const publish = (proposal) =>
    supervisor.publication.publish(proposal, signal());
  try {
    for (sdk of ["codex", "claude"]) {
      config = parseConfiguration(await readFile("/config/config.yml", "utf8"));
      config.github.repository = "owner/repo";
      config.github.token = remote.state.token;
      config.proxy.url = proxy;
      config.proxy.key = `publication-model-${randomUUID()}`;
      config.github.webhook_secret = `line-one\nline-two ${randomUUID()}`;
      config.notifications.smtp = {
        enabled: true,
        host: "smtp.example.invalid",
        port: 587,
        secure: false,
        username: "publication-fixture-user",
        password: `folded password ${randomUUID()}`,
        from: "fixture@example.invalid",
        to: ["fixture@example.invalid"],
      };
      config.limits.infrastructure_retries = 20;
      config.mcp = { ...config.mcp, servers: {}, credentials: {} };
      config.profiles = Object.fromEntries(
        Object.keys(config.roles).map((role) => [role, profiles[sdk]]),
      );
      const bundles = {};
      for (const role of Object.keys(config.roles)) {
        config.roles[role].profile = role;
        config.roles[role].mcp = {};
        const bundle = globalThis.structuredClone(
          loaded.snapshot.roles[role].bundle,
        );
        bundle.system += "\nOPERATOR_SYSTEM_CANARY";
        bundle.user += "\nOPERATOR_USER_CANARY";
        for (const file of bundle.skills)
          if (file.path.endsWith("SKILL.md")) {
            const bytes = Buffer.concat([
              Buffer.from(file.content_base64, "base64"),
              Buffer.from("\nOPERATOR_SKILL_CANARY"),
            ]);
            file.content_base64 = bytes.toString("base64");
            file.sha256 = createHash("sha256").update(bytes).digest("hex");
          }
        bundles[role] = bundle;
      }
      const separated = separateSecrets(config);
      secrets = separated.secrets;
      snapshot = createRunSnapshot(separated.settings, bundles, secrets);
      const silent = () => {};
      options = {
        root: join(root, `runtime-${sdk}`),
        sourceUrl: () => remote.url + "/owner/repo.git",
        publicationWriter: (ready) =>
          new OctokitWriter(
            "owner/repo",
            new Octokit({
              auth: remote.state.token,
              baseUrl: remote.url,
              log: { debug: silent, info: silent, warn: silent, error: silent },
            }),
            ready,
          ),
        workers: { [sdk]: `/opt/orm/app/dist/adapters/agents/${sdk}.js` },
      };
      supervisor = await Supervisor.create(store, snapshot, secrets, options);
      const runJobAgent = supervisor.runJobAgent.bind(supervisor);
      supervisor.runJobAgent = async function* (...args) {
        for await (const event of runJobAgent(...args)) {
          if (event.type === "progress" && /^[a-z_]{1,64}$/.test(event.message))
            reviewProgress.push(event.message);
          yield event;
        }
      };
      fixture = {
        config,
        store,
        root: options.root,
        requests,
        errors,
        histories: new Map(),
        mcpCredential: "publication-mcp-unused",
        async outputReview(text) {
          if (holdReview) {
            reviewEntered = true;
            await holdReview;
          }
          const run = store.runs().findLast((run) => run.finished_at === null);
          assert.equal(run.role, "output_review");
          assert.equal(run.uid, 10003);
          assert.equal(run.session_id, null);
          assert.equal(store.leases().length, 1);
          if (nested) {
            assert(run.parent_id);
            assert(
              (await userProcesses(10001)).some(
                (process) => process.state === "T",
              ),
            );
          }
          const binding = /"binding":"([a-f0-9]{64})"/.exec(text)[1];
          return {
            approved: !rejectReview,
            binding: wrongBinding ? "0".repeat(64) : binding,
            findings: rejectReview ? ["unsupported fixture claim"] : [],
          };
        },
      };
      const scanner = supervisor.publication.outputReview.scanner;
      await scanner.scan({ ordinary: "verified text" }, signal());
      const unknownSecret = "ghp_" + "Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0Uv9Wx8";
      await assert.rejects(
        scanner.scan(
          {
            field: `${unknownSecret} # gitleaks:allow`,
            ".gitleaksignore": "*",
            ".gitleaks.toml": "[allowlist]\nregexes=['.*']",
          },
          signal(),
        ),
        /publication_scan_failed/,
      );
      await assert.rejects(
        scanner.scan({ [remote.state.token]: "structured key" }, signal()),
        /publication_secret/,
      );
      const escaped = (value) =>
        [...value]
          .map(
            (character) =>
              `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
          )
          .join("");
      for (const value of [
        `{"key":"${escaped(remote.state.token)}"}`,
        `{"${escaped(remote.state.token)}":"value"}`,
      ])
        await assert.rejects(
          scanner.scan(value, signal()),
          /publication_secret/,
        );
      await assert.rejects(
        scanner.scan(`{"key":"${escaped(unknownSecret)}"}`, signal()),
        /publication_scan_failed/,
      );
      const yamlEscaped = (value, width) =>
        [...value]
          .map(
            (character) =>
              `\\${width === 2 ? "x" : "U"}${character.charCodeAt(0).toString(16).padStart(width, "0")}`,
          )
          .join("");
      for (const width of [2, 8]) {
        for (const token of [remote.state.token, unknownSecret]) {
          for (const text of [
            `key: "${yamlEscaped(token, width)}"\n`,
            `"${yamlEscaped(token, width)}": value\n`,
          ])
            await assert.rejects(
              scanner.scan(text, signal()),
              token === remote.state.token
                ? /publication_secret/
                : /publication_scan_failed/,
            );
        }
      }
      const foldedSecret = config.notifications.smtp.password.replace(
        " ",
        "\n  ",
      );
      for (const quote of ["'", '"'])
        for (const text of [
          `password: ${quote}${foldedSecret}${quote}\n`,
          `? ${quote}${foldedSecret}${quote}\n: value\n`,
        ])
          await assert.rejects(
            scanner.scan(text, signal()),
            /publication_secret/,
          );
      const blockPassword = config.notifications.smtp.password.replace(
        " ",
        "\n",
      );
      const blockSecrets = [
        `password: ${foldedSecret}\n`,
        `? ${foldedSecret}\n: value\n`,
        `password: >-\n  ${blockPassword.replaceAll("\n", "\n  ")}\n`,
        `? >-\n  ${blockPassword.replaceAll("\n", "\n  ")}\n: value\n`,
        `password: |-\n  ${config.github.webhook_secret.replaceAll("\n", "\n  ")}\n`,
        `? |-\n  ${config.github.webhook_secret.replaceAll("\n", "\n  ")}\n: value\n`,
      ];
      for (const text of blockSecrets)
        await assert.rejects(
          scanner.scan(text, signal()),
          /publication_secret/,
        );
      await assert.rejects(
        scanner.scan(
          { path: "invalid.yml", mode: "100644", text: "key: [unterminated" },
          signal(),
        ),
        /publication_structured_invalid/,
      );
      await assert.rejects(
        new PublicationScanner(
          join(options.root, "private", "missing-tool"),
          secrets,
          "/not-installed/gitleaks",
        ).scan("ordinary", signal()),
      );
      proof.push({ sdk, scanning: "passed" });

      const commentJob = seed(),
        proposal = status(commentJob, "Verified investigation result.");
      remote.state.comments.set(commentJob.issue_number, [
        { id: 1, body: "A genuine human using the PAT account", author_id: 7 },
      ]);
      remote.state.dropAfter = "comment";
      const commentReceipt = await publish(proposal);
      assert.equal(
        commentReceipt.status,
        "confirmed",
        JSON.stringify({
          failure: commentReceipt.failure,
          fixture_errors: errors.map((error) => error.message),
          review_progress: reviewProgress,
          model_requests: requests.length,
          runs: store
            .runs()
            .map((run) => ({ role: run.role, status: run.status })),
        }),
      );
      assert.equal((await publish(proposal)).id, commentReceipt.id);
      assert.equal(
        remote.state.comments.get(commentJob.issue_number).length,
        2,
      );
      assert(!store.owns("issue_comment", 1));
      remote.state.dropAfter = "comment";
      const changed = await publish(
        status(commentJob, "Updated verified progress."),
      );
      assert.equal(changed.status, "confirmed");
      assert.equal(changed.target.comment.id, commentReceipt.target.comment.id);
      remote.state.comments
        .get(commentJob.issue_number)
        .find((row) => row.id === changed.target.comment.id).body =
        "Human edit";
      const mutationCount = remote.state.mutations.length;
      assert.equal(
        (await publish(status(commentJob, "Must not overwrite"))).failure,
        "publication_comment_changed",
      );
      assert.equal(remote.state.mutations.length, mutationCount);
      proof.push({ sdk, comments_and_replay: "passed" });

      const reviewJob = seed(),
        request = {
          job_id: reviewJob.id,
          revision: reviewJob.revision,
          destination: { type: "fixture", id: "original" },
          payload: { text: "Evidence-backed text" },
          evidence: { source_sha: remote.source.sha },
        };
      const reviewed = await supervisor.publication.outputReview.review(
        request,
        signal(),
      );
      assert.equal(
        supervisor.publication.outputReview.verify(reviewed.id, request).id,
        reviewed.id,
      );
      assert.throws(
        () =>
          supervisor.publication.outputReview.verify(reviewed.id, {
            ...request,
            payload: { text: "Changed" },
          }),
        /output_review_mismatch/,
      );
      for (const changedRequest of [
        { ...request, evidence: { source_sha: "f".repeat(40) } },
        { ...request, artifact_digest: "f".repeat(64) },
      ])
        assert.throws(
          () =>
            supervisor.publication.outputReview.verify(
              reviewed.id,
              changedRequest,
            ),
          /output_review_mismatch/,
        );
      assert.throws(
        () =>
          supervisor.publication.outputReview.verify(reviewed.id, {
            ...request,
            destination: { type: "fixture", id: "different" },
          }),
        /output_review_mismatch/,
      );
      wrongBinding = true;
      await assert.rejects(
        supervisor.publication.outputReview.review(request, signal()),
        /output_review_rejected/,
      );
      wrongBinding = false;
      rejectReview = true;
      const rejected = await publish(status(reviewJob, "Rejected content"));
      rejectReview = false;
      assert.equal(rejected.status, "blocked");
      assert.equal(rejected.failure, "output_review_rejected");
      const aborted = new globalThis.AbortController();
      aborted.abort();
      await assert.rejects(
        supervisor.publication.outputReview.review(request, aborted.signal),
      );
      const reviewCancellation = new globalThis.AbortController();
      let releaseCancelled;
      holdReview = new Promise((resolve) => {
        releaseCancelled = resolve;
      });
      reviewEntered = false;
      const cancelledReview = supervisor.publication.outputReview.review(
        request,
        reviewCancellation.signal,
      );
      const cancellationResult = assert.rejects(cancelledReview);
      try {
        await until(() => reviewEntered);
        reviewCancellation.abort();
      } finally {
        releaseCancelled();
        holdReview = undefined;
      }
      await cancellationResult;
      assert.equal(store.leases().length, 0);
      assert.equal((await userProcesses(10003)).length, 0);
      proof.push({ sdk, exact_review_binding: "passed" });

      const concurrentJob = seed(),
        beforeConcurrent = remote.state.mutations.length;
      let releaseReview;
      holdReview = new Promise((resolve) => {
        releaseReview = resolve;
      });
      reviewEntered = false;
      const mutableProposal = status(concurrentJob, "Serialized publication");
      const concurrent = publish(mutableProposal);
      try {
        await until(() => reviewEntered);
        mutableProposal.body = "Changed after review started";
        await assert.rejects(
          publish(status(concurrentJob, "Concurrent publication")),
          /publication_busy/,
        );
        assert.equal(remote.state.mutations.length, beforeConcurrent);
      } finally {
        releaseReview();
        holdReview = undefined;
      }
      const serialized = await concurrent;
      assert.equal(serialized.status, "confirmed");
      assert(
        serialized.target.comment.body.startsWith("Serialized publication\n"),
      );
      proof.push({ sdk, serialization: "passed" });

      const gitRetryJob = seed(),
        gitRetryChange = await candidate(gitRetryJob, `${sdk}-git-retry`),
        beforeGitRetry = remote.state.mutations.length,
        beforeInfrastructure = JSON.parse(
          store.jobById(gitRetryJob.id).budget_json,
        ).infrastructure_retries;
      remote.state.rateLimit = {
        method: "GET",
        path: "/owner/repo.git/info/refs",
        seconds: 0,
      };
      const failedFetch = await publish(gitRetryChange);
      assert.equal(failedFetch.status, "prepared");
      assert.equal(failedFetch.failure, "publication_git_failed");
      assert.equal(remote.state.rateLimit, null);
      assert.equal(failedFetch.retry_pending, true);
      assert.equal(failedFetch.review_id, null);
      assert.equal(remote.state.mutations.length, beforeGitRetry);
      const retriedFetch = await publish(gitRetryChange);
      assert.equal(
        retriedFetch.status,
        "confirmed",
        JSON.stringify(retriedFetch),
      );
      assert.equal(retriedFetch.id, failedFetch.id);
      assert.equal(
        JSON.parse(store.jobById(gitRetryJob.id).budget_json)
          .infrastructure_retries,
        beforeInfrastructure + 1,
      );
      assert.equal((await publish(gitRetryChange)).id, retriedFetch.id);
      proof.push({ sdk, safe_git_read_retry: "passed" });

      const changeJob = seed();
      let change = await candidate(changeJob, `${sdk}-initial`);
      const missing = await publish({
        ...change,
        evidence_ids: ["a".repeat(64), "b".repeat(64)],
      });
      assert.equal(missing.status, "blocked");
      remote.state.dropAfter = "pull";
      const first = await publish(change);
      assert.equal(first.status, "confirmed", JSON.stringify(first));
      assert.equal(remote.head(first.target.branch), first.commit);
      assert.equal(
        remote.git(["show", `${first.commit}:app.txt`]),
        `${sdk}-initial`,
      );
      assert.equal(
        remote.state.pulls.filter(
          (row) => row.branch === first.target.branch && row.state === "open",
        ).length,
        1,
      );
      assert.equal((await publish(change)).id, first.id);
      const beforeMetadata = remote.state.mutations.length;
      const metadata = await publish({
        ...change,
        expected_head: first.commit,
        title: "Updated metadata only",
        body: "Updated reviewed description.",
      });
      assert.equal(metadata.status, "confirmed", JSON.stringify(metadata));
      assert.equal(metadata.commit, first.commit);
      assert.equal(remote.head(first.target.branch), first.commit);
      assert.deepEqual(remote.state.mutations.slice(beforeMetadata), ["pull"]);
      assert.equal(metadata.target.pull.title, "Updated metadata only");
      for (const kind of ["branch", "pull"]) {
        change = await candidate(changeJob, `${sdk}-lost-${kind}`);
        remote.state.dropAfter = kind;
        const result = await publish(change);
        assert.equal(result.status, "confirmed", JSON.stringify(result));
        assert.equal((await publish(change)).id, result.id);
        assert.equal(
          remote.state.pulls.filter(
            (row) => row.branch === result.target.branch,
          ).length,
          1,
        );
        assert.equal(result.target.pull.id, first.target.pull.id);
      }
      const closedPullChange = await candidate(changeJob, `${sdk}-closed-pr`),
        ownedPull = remote.state.pulls.find(
          (row) => row.id === first.target.pull.id,
        );
      ownedPull.state = "closed";
      const beforeClosed = remote.state.mutations.length;
      assert.equal(
        (await publish(closedPullChange)).failure,
        "publication_pull_changed",
      );
      assert.equal(remote.state.mutations.length, beforeClosed);
      assert.equal(
        remote.state.pulls.filter((row) => row.branch === first.target.branch)
          .length,
        1,
      );
      ownedPull.state = "open";
      const old = supervisor.publication.repository.target(changeJob.id),
        human = remote.commit(
          { ...remote.initial, "app.txt": "human" },
          old.head,
        );
      remote.git(["update-ref", `refs/heads/${old.branch}`, human.sha]);
      const beforeDrift = remote.state.mutations.length;
      assert.equal(
        (await publish({ ...change, title: "Unexpected head" })).failure,
        "publication_head_changed",
      );
      assert.equal(remote.state.mutations.length, beforeDrift);
      proof.push({ sdk, branch_pr_and_lost_responses: "passed" });

      const protectedJob = seed(),
        protectedChange = await candidate(protectedJob, `${sdk}-protected`);
      remote.state.protected.add(
        supervisor.publication.repository.target(protectedJob.id).branch,
      );
      assert.equal(
        (await publish(protectedChange)).failure,
        "publication_branch_protected",
      );
      const binaryJob = seed(),
        binaryChange = await candidate(binaryJob, `${sdk}-binary`, true);
      assert.equal(
        (await publish(binaryChange)).failure,
        "publication_binary_unsupported",
      );
      const closed = seed();
      remote.state.closed.add(closed.issue_number);
      assert.equal(
        (await publish(status(closed, "Closed issue"))).failure,
        "publication_issue_closed",
      );
      proof.push({ sdk, policy_rejections: "passed" });

      const escapedJob = seed();
      const escapedChange = await candidate(
        escapedJob,
        `${sdk}-escaped`,
        false,
        {
          path: "structured.json",
          content: `{"key":"${escaped(unknownSecret)}"}`,
        },
      );
      const beforeEscaped = remote.state.mutations.length;
      assert.equal(
        (await publish(escapedChange)).failure,
        "publication_scan_failed",
      );
      assert.equal(remote.state.mutations.length, beforeEscaped);
      const yamlJob = seed();
      const yamlChange = await candidate(yamlJob, `${sdk}-yaml`, false, {
        path: "structured.yml",
        content: `"${yamlEscaped(unknownSecret, 2)}": "${yamlEscaped(unknownSecret, 8)}"\n`,
      });
      const beforeYaml = remote.state.mutations.length;
      assert.equal(
        (await publish(yamlChange)).failure,
        "publication_scan_failed",
      );
      assert.equal(remote.state.mutations.length, beforeYaml);
      const foldedJob = seed();
      const foldedChange = await candidate(foldedJob, `${sdk}-folded`, false, {
        path: "folded.yml",
        content: `? '${foldedSecret}'\n: "${foldedSecret}"\n`,
      });
      const beforeFolded = remote.state.mutations.length;
      assert.equal((await publish(foldedChange)).failure, "publication_secret");
      assert.equal(remote.state.mutations.length, beforeFolded);
      const blockJob = seed();
      const blockChange = await candidate(blockJob, `${sdk}-blocks`, false, {
        path: "blocks.yaml",
        content: blockSecrets.join("\n---\n"),
      });
      const beforeBlocks = remote.state.mutations.length;
      assert.equal((await publish(blockChange)).failure, "publication_secret");
      assert.equal(remote.state.mutations.length, beforeBlocks);
      for (const kind of ["issue_comment", "pull_request"]) {
        const legacyJob = seed();
        store.recordPublication({
          operation_key: `${sdk}-${kind}-legacy`,
          job_id: legacyJob.id,
          revision: legacyJob.revision,
          kind,
          object_id: String(legacyJob.id + 90000),
          number: kind === "pull_request" ? legacyJob.id + 90000 : null,
          head_sha: null,
          receipt_json: "{}",
        });
        const beforeLegacy = remote.state.mutations.length;
        await assert.rejects(
          publish(status(legacyJob, "Do not replace legacy ownership")),
          /publication_legacy_ownership/,
        );
        assert.equal(remote.state.mutations.length, beforeLegacy);
      }

      for (const method of ["GET", "POST"]) {
        const limitedJob = seed();
        const limitedProposal = status(limitedJob, `Backoff ${method}`);
        remote.state.rateLimit = {
          method,
          path:
            method === "GET"
              ? "/repos/owner/repo"
              : `/repos/owner/repo/issues/${limitedJob.issue_number}/comments`,
          seconds: 5,
        };
        const limited = await publish(limitedProposal);
        assert.equal(limited.failure, "github_rate_limited");
        assert(limited.retry_at > Date.now());
        const beforeBackoff = remote.state.requests.length;
        await assert.rejects(publish(limitedProposal), /publication_backoff/);
        await assert.rejects(
          supervisor.publication.reconcile(limited.id, signal()),
          /publication_backoff/,
        );
        assert.equal(remote.state.requests.length, beforeBackoff);
        const otherJob = seed();
        const otherProposal = status(
          otherJob,
          `Shared provider backoff ${method}`,
        );
        await assert.rejects(publish(otherProposal), /publication_backoff/);
        assert.equal(remote.state.requests.length, beforeBackoff);
        if (method === "GET") {
          await supervisor.close();
          store.close();
          store = new Store(database);
          fixture.store = store;
          supervisor = await Supervisor.create(
            store,
            snapshot,
            secrets,
            options,
          );
          await assert.rejects(publish(otherProposal), /publication_backoff/);
          assert.equal(remote.state.requests.length, beforeBackoff);
        }
        await delay(Math.max(0, limited.retry_at - Date.now() + 10));
        if (method === "GET") {
          assert.equal((await publish(limitedProposal)).status, "confirmed");
          assert.equal((await publish(otherProposal)).status, "confirmed");
        } else {
          assert.equal(
            (await supervisor.publication.reconcile(limited.id, signal()))
              .status,
            "uncertain",
          );
          const usage = JSON.parse(store.jobById(limitedJob.id).budget_json);
          assert.equal(usage.infrastructure_retries, 1);
          store.db
            .prepare(
              "UPDATE jobs SET budget_json=json_set(budget_json,'$.infrastructure_retries',?) WHERE id=?",
            )
            .run(config.limits.infrastructure_retries, limitedJob.id);
          const beforeExhaustion = remote.state.requests.length;
          await assert.rejects(
            supervisor.publication.reconcile(limited.id, signal()),
            /infrastructure_budget_exhausted/,
          );
          assert.equal(remote.state.requests.length, beforeExhaustion);
        }
      }

      const pagedJob = seed();
      remote.state.afterMutation = (kind) => {
        if (kind === "comment") remote.state.repository_id = 43;
      };
      const paged = await publish(status(pagedJob, "Recover across pages"));
      remote.state.afterMutation = undefined;
      remote.state.repository_id = 42;
      assert.equal(paged.status, "uncertain");
      remote.state.comments.get(pagedJob.issue_number).unshift(
        ...Array.from({ length: 100 }, (_, index) => ({
          id: 500000 + index,
          body: "Unowned fixture comment",
          author_id: 8,
        })),
      );
      let releasePage;
      let pageEntered = false;
      const heldPage = new Promise((resolve) => {
        releasePage = resolve;
      });
      const pagedPath = `/repos/owner/repo/issues/${pagedJob.issue_number}/comments`;
      remote.state.beforeRequest = async (method, path) => {
        if (method === "GET" && path === pagedPath) {
          pageEntered = true;
          await heldPage;
        }
      };
      const pageRecovery = supervisor.publication.reconcile(paged.id, signal());
      let limiter, beforeNextPage;
      const limiterJob = seed();
      try {
        await until(() => pageEntered);
        remote.state.rateLimit = {
          method: "GET",
          path: "/repos/owner/repo",
          seconds: 3,
        };
        limiter = await publish(status(limiterJob, "Establish shared backoff"));
        assert.equal(limiter.failure, "github_rate_limited");
        beforeNextPage = remote.state.requests.length;
      } finally {
        remote.state.beforeRequest = undefined;
        releasePage();
      }
      const deferredPage = await pageRecovery;
      assert.equal(deferredPage.failure, "publication_backoff");
      assert.equal(remote.state.requests.length, beforeNextPage);
      await delay(Math.max(0, limiter.retry_at - Date.now() + 10));
      const beforePageRecovery = remote.state.mutations.length;
      assert.equal(
        (await supervisor.publication.reconcile(paged.id, signal())).status,
        "confirmed",
      );
      assert.equal(remote.state.mutations.length, beforePageRecovery);
      proof.push({ sdk, provider_backoff_between_pages: "passed" });

      const uncertainJob = seed(),
        uncertainProposal = status(uncertainJob, "Uncertain effect");
      remote.state.rejectBefore = "comment";
      assert.equal((await publish(uncertainProposal)).status, "uncertain");
      const beforeUncertain = remote.state.mutations.length;
      assert.equal((await publish(uncertainProposal)).status, "uncertain");
      await assert.rejects(
        publish(status(uncertainJob, "Another create")),
        /publication_pending/,
      );
      assert.equal(remote.state.mutations.length, beforeUncertain);

      const restartJob = seed(),
        restartProposal = status(restartJob, "Recover after revision changes");
      remote.state.afterMutation = (kind) => {
        if (kind === "comment") {
          remote.state.repository_id = 43;
          store.db
            .prepare("UPDATE jobs SET revision=revision+1 WHERE id=?")
            .run(restartJob.id);
        }
      };
      const interrupted = await publish(restartProposal);
      assert.equal(interrupted.status, "uncertain");
      remote.state.afterMutation = undefined;
      remote.state.repository_id = 42;
      await supervisor.close();
      store.close();
      store = new Store(database);
      fixture.store = store;
      supervisor = await Supervisor.create(store, snapshot, secrets, options);
      const recovered = await supervisor.publication.reconcile(
        interrupted.id,
        signal(),
      );
      assert.equal(recovered.status, "confirmed");
      assert(store.owns("issue_comment", recovered.target.comment.id));
      assert.equal((await publish(restartProposal)).id, recovered.id);
      proof.push({ sdk, restart_stale_reconciliation: "passed" });

      for (const boundary of ["branch", "pull"]) {
        const recoveryJob = seed();
        const recoveryProposal = await candidate(
          recoveryJob,
          `${sdk}-restart-${boundary}`,
        );
        remote.state.dropAfter = boundary;
        remote.state.afterMutation = (kind) => {
          if (kind !== boundary) return;
          remote.state.repository_id = 43;
          store.db
            .prepare("UPDATE jobs SET revision=revision+1 WHERE id=?")
            .run(recoveryJob.id);
        };
        const pending = await publish(recoveryProposal);
        assert.equal(pending.status, "uncertain", JSON.stringify(pending));
        remote.state.repository_id = 42;
        remote.state.afterMutation = undefined;
        await supervisor.close();
        store.close();
        store = new Store(database);
        fixture.store = store;
        supervisor = await Supervisor.create(store, snapshot, secrets, options);
        let releaseReconciliation;
        let reconciliationEntered = false;
        const held = new Promise((resolve) => {
          releaseReconciliation = resolve;
        });
        remote.state.beforeRequest = async (method, path) => {
          if (method === "GET" && path === "/repos/owner/repo") {
            reconciliationEntered = true;
            await held;
          }
        };
        const recovering = supervisor.publication.reconcile(
          pending.id,
          signal(),
        );
        try {
          await until(() => reconciliationEntered);
          await assert.rejects(publish(recoveryProposal), /publication_busy/);
          await assert.rejects(
            supervisor.publication.reconcile(pending.id, signal()),
            /publication_busy/,
          );
        } finally {
          remote.state.beforeRequest = undefined;
          releaseReconciliation();
        }
        const beforeRecovery = remote.state.mutations.length;
        const result = await recovering;
        assert.equal(
          result.status,
          boundary === "pull" ? "confirmed" : "reviewed",
          JSON.stringify(result),
        );
        assert.equal(
          result.steps.find((step) => step.kind === boundary).state,
          "confirmed",
        );
        assert.equal(remote.state.mutations.length, beforeRecovery);
        assert.equal(
          remote.state.pulls.filter(
            (row) => row.branch === result.target.branch,
          ).length,
          boundary === "pull" ? 1 : 0,
        );
        if (boundary === "branch")
          await assert.rejects(publish(recoveryProposal), /revision_stale/);
      }
      proof.push({ sdk, branch_pull_restart_and_serialization: "passed" });

      const nestedJob = seed(),
        cancellation = new globalThis.AbortController();
      fixture.held = false;
      const parentTask = events(
        supervisor.run(
          supervisor.request(nestedJob.id, "implementation", {
            scenario: "cancel",
          }),
          cancellation.signal,
        ),
      );
      await until(() => fixture.held);
      const parent = store
        .runs()
        .findLast(
          (run) => run.job_id === nestedJob.id && run.finished_at === null,
        );
      nested = true;
      const nestedRequest = {
        ...request,
        job_id: nestedJob.id,
        revision: nestedJob.revision,
        parent_run_id: parent.id,
      };
      const used = JSON.parse(
        store.jobById(nestedJob.id).budget_json,
      ).model_requests;
      const nestedReceipt = await supervisor.publication.outputReview.review(
        nestedRequest,
        signal(),
      );
      nested = false;
      assert.equal(store.leases().length, 1);
      assert(
        JSON.parse(store.jobById(nestedJob.id).budget_json).model_requests >
          used,
      );
      cancellation.abort();
      assert.equal((await parentTask).at(-1).outcome, "cancelled");
      assert.throws(
        () =>
          supervisor.publication.outputReview.verify(
            nestedReceipt.id,
            nestedRequest,
          ),
        /output_review_cancelled/,
      );
      proof.push({ sdk, one_slot_review: "passed" });

      const outageJob = seed();
      modelDown = true;
      assert.equal(
        (await publish(status(outageJob, "Generated narrative"))).failure,
        "output_review_rejected",
      );
      const beforeTemplate = requests.length;
      assert.equal(
        (
          await publish({
            job_id: outageJob.id,
            revision: outageJob.revision,
            kind: "notice",
            reason: "model_unavailable",
          })
        ).status,
        "confirmed",
      );
      assert.equal(requests.length, beforeTemplate);
      modelDown = false;
      const exhausted = seed();
      store.db
        .prepare(
          "UPDATE jobs SET budget_json=json_set(budget_json,'$.model_requests',?) WHERE id=?",
        )
        .run(snapshot.settings.limits.model_requests, exhausted.id);
      assert.equal(
        (await publish(status(exhausted, "No model budget"))).status,
        "blocked",
      );
      assert.equal(
        (
          await publish({
            job_id: exhausted.id,
            revision: exhausted.revision,
            kind: "notice",
            reason: "budget_exhausted",
          })
        ).status,
        "confirmed",
      );
      const activeExhausted = seed(),
        activeLimit = snapshot.settings.limits.active_minutes * 60000;
      store.db
        .prepare(
          "UPDATE jobs SET budget_json=json_set(budget_json,'$.active_ms',?) WHERE id=?",
        )
        .run(activeLimit, activeExhausted.id);
      modelDown = true;
      const beforeActiveNotice = requests.length;
      await assert.rejects(
        publish(status(activeExhausted, "No active-time budget")),
        /active_budget_exhausted/,
      );
      assert.equal(
        (
          await publish({
            job_id: activeExhausted.id,
            revision: activeExhausted.revision,
            kind: "notice",
            reason: "budget_exhausted",
          })
        ).status,
        "confirmed",
      );
      assert.equal(requests.length, beforeActiveNotice);
      const activeUsage = JSON.parse(
        store.jobById(activeExhausted.id).budget_json,
      );
      assert.equal(activeUsage.active_ms, activeLimit);
      assert.equal(activeUsage.model_requests, 0);
      modelDown = false;
      assert.equal(store.leases().length, 0);
      assert.equal(
        errors.length,
        0,
        errors.map((error) => error.message).join("\n"),
      );
      proof.push({ sdk, outage_and_budgets: "passed" });

      let noticeEntered = false,
        releaseNotice,
        noticeTimer;
      const heldNotice = new Promise((resolve) => {
        releaseNotice = resolve;
      });
      remote.state.beforeRequest = async (method, path) => {
        if (method === "GET" && path === "/repos/owner/repo") {
          noticeEntered = true;
          await heldNotice;
        }
      };
      const beforeShutdown = remote.state.mutations.length;
      const noticeDuringShutdown = publish({
        job_id: activeExhausted.id,
        revision: activeExhausted.revision,
        kind: "notice",
        reason: "publication_blocked",
      });
      await until(() => noticeEntered);
      const stopping = supervisor.close();
      try {
        const [receipt] = await Promise.race([
          Promise.all([noticeDuringShutdown, stopping]),
          new Promise((_, reject) => {
            noticeTimer = globalThis.setTimeout(
              () => reject(new Error("notice shutdown timed out")),
              5000,
            );
          }),
        ]);
        assert.equal(receipt.status, "prepared");
        assert.equal(remote.state.mutations.length, beforeShutdown);
        assert.equal(store.leases().length, 0);
      } finally {
        globalThis.clearTimeout(noticeTimer);
        remote.state.beforeRequest = undefined;
        releaseNotice();
        await Promise.all([noticeDuringShutdown, stopping]);
      }
      proof.push({ sdk, notice_shutdown: "passed" });
      supervisor = undefined;
    }
    assert.equal(
      (await userProcesses(10001)).length +
        (await userProcesses(10002)).length +
        (await userProcesses(10003)).length,
      0,
    );
    for (const completedSdk of ["codex", "claude"])
      assert(
        (
          await readdir(
            join(root, `runtime-${completedSdk}`, "private", "publication"),
          )
        ).every((name) => name === "scans"),
      );
    return {
      publication: "passed",
      proof,
      cleanup: "passed",
      scanner: "8.30.1",
    };
  } finally {
    await supervisor?.close();
    if (store.db.open) store.close();
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    await remote.close();
  }
}
