import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const receiptName = "publication.json";
const annotation = "org.opensource-repo-manager.publication";
const platforms = ["linux/amd64", "linux/arm64"];
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

export function parseVersion(tag) {
  const match =
    typeof tag === "string" &&
    tag.match(
      /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.([1-9][0-9]*))?$/,
    );
  if (!match || match[0] !== tag) return undefined;
  const parts = match
    .slice(1)
    .map((part) => (part === undefined ? undefined : Number(part)));
  if (!parts.every((part) => part === undefined || Number.isSafeInteger(part)))
    return undefined;
  return {
    tag,
    base: `v${match[1]}.${match[2]}.${match[3]}`,
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    rc: parts[3],
  };
}

export function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"])
    if (left[key] !== right[key]) return left[key] - right[key];
  if (left.rc === right.rc) return 0;
  if (left.rc === undefined) return 1;
  if (right.rc === undefined) return -1;
  return left.rc - right.rc;
}

function published(release) {
  return !release.draft && Boolean(release.published_at);
}

function versions(releases, prerelease) {
  return releases
    .filter(
      (release) => published(release) && release.prerelease === prerelease,
    )
    .map((release) => ({ release, version: parseVersion(release.tag_name) }))
    .filter(
      ({ version }) => version && (version.rc !== undefined) === prerelease,
    )
    .sort((a, b) => compareVersions(b.version, a.version));
}

function intendedBase(packageVersion, releases) {
  let base = parseVersion(`v${packageVersion}`);
  assert(
    base && base.rc === undefined,
    "package.json version must be a canonical stable version.",
  );
  const stable = versions(releases, false)[0]?.version;
  if (stable && compareVersions(base, stable) <= 0) {
    base = parseVersion(`v${stable.major}.${stable.minor}.${stable.patch + 1}`);
    assert(base, "Next patch version exceeds the supported integer range.");
  }
  return base;
}

export function nextCandidate(packageVersion, releases, refs, source) {
  const base = intendedBase(packageVersion, releases);
  const latest = versions(releases, true)[0]?.version;
  assert(
    !latest || compareVersions(base, parseVersion(latest.base)) >= 0,
    "Candidate base was superseded; use the current main revision.",
  );
  const candidates = refs
    .map((ref) => ({
      ref,
      version: parseVersion(ref.ref?.replace(/^refs\/tags\//, "")),
    }))
    .filter(
      ({ version }) => version?.rc !== undefined && version.base === base.base,
    );
  const sameSource = candidates.filter(
    ({ ref }) => ref.object.type === "commit" && ref.object.sha === source,
  );
  assert(
    sameSource.length <= 1,
    "Multiple candidate tags identify this source.",
  );
  if (sameSource.length) return sameSource[0].version;
  const highest = Math.max(
    0,
    ...candidates.map(({ version }) => version.rc),
    ...releases
      .map((release) => parseVersion(release.tag_name))
      .filter((version) => version?.base === base.base)
      .map((version) => version.rc ?? 0),
  );
  const next = parseVersion(`${base.base}-rc.${highest + 1}`);
  assert(next, "Next candidate number exceeds the supported integer range.");
  return next;
}

export function verifyPlatforms(manifest, expected) {
  const runnable = manifest.manifests?.filter(
    (item) =>
      item.annotations?.["vnd.docker.reference.type"] !==
      "attestation-manifest",
  );
  assert(runnable, "A combined image index is required.");
  assert.deepEqual(
    runnable
      .map((item) => ({
        platform: `${item.platform?.os}/${item.platform?.architecture}`,
        platform_digest: item.digest,
      }))
      .sort((a, b) => a.platform.localeCompare(b.platform)),
    expected,
    "Manifest differs from the smoke-tested platforms.",
  );
}

export function verifyReceipt(receipt, release, source, image, manifest) {
  assert(
    receipt?.version === 1 &&
      receipt.release_id === release.id &&
      receipt.tag === release.tag_name &&
      receipt.source_sha === source &&
      receipt.image === image &&
      digestPattern.test(receipt.digest),
    "Publication receipt identity mismatch.",
  );
  assert.deepEqual(
    receipt.platforms?.map((item) => item.platform),
    platforms,
    "Both native platform receipts are required.",
  );
  assert(
    receipt.platforms.every((item) => digestPattern.test(item.platform_digest)),
    "Invalid native platform digest.",
  );
  assert.equal(manifest.digest, receipt.digest, "Publication digest changed.");
  verifyPlatforms(manifest, receipt.platforms);
  const proof = verifyCandidateImage(
    manifest,
    source,
    receipt.candidate_tag ?? receipt.tag,
    receipt.candidate_release_id ?? release.id,
  );
  assert.deepEqual(
    proof.platforms,
    receipt.platforms,
    "Image proof differs from the durable receipt.",
  );
}

function verifyCandidateImage(manifest, source, tag, releaseId) {
  const proof = JSON.parse(manifest.annotations?.[annotation] ?? "null");
  assert(
    digestPattern.test(manifest.digest) &&
      (proof?.version === 2 ||
        (proof?.version === 1 &&
          releaseId !== undefined &&
          proof.release_id === releaseId)) &&
      proof.source_sha === source &&
      proof.release_version === tag.slice(1),
    "Image has no matching verified publication.",
  );
  assert.deepEqual(
    proof.platforms?.map((item) => item.platform),
    platforms,
    "Both native platform receipts are required.",
  );
  assert(
    proof.platforms.every((item) => digestPattern.test(item.platform_digest)),
    "Invalid native platform digest.",
  );
  verifyPlatforms(manifest, proof.platforms);
  return proof;
}

async function missing(read) {
  try {
    return await read();
  } catch (error) {
    if (error.status !== 404) throw error;
    return undefined;
  }
}

function operation({ github, context, core, exec, env = process.env }, stage) {
  const started = Date.now();
  const common = {
    repository: `${context.repo.owner}/${context.repo.repo}`,
    run_id: context.runId,
    attempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1),
    stage,
  };
  const log = (event, details = {}, level = "info") =>
    core[level](
      JSON.stringify({
        event: `release.${event}`,
        ...common,
        elapsed_ms: Date.now() - started,
        ...details,
      }),
    );
  const repo = context.repo;
  let lastMutation;
  let pendingMutation;
  let failedRead;
  async function read(name, args, invoke) {
    const target = Object.fromEntries(
      [
        "ref",
        "branch",
        "path",
        "head_sha",
        "event",
        "workflow_id",
        "base",
        "head",
        "tag",
        "tag_sha",
        "release_id",
        "asset_id",
        "reference",
      ]
        .filter((key) => args[key] !== undefined)
        .map((key) => [key, args[key]]),
    );
    log("read", { operation: name, target });
    try {
      return await invoke(args);
    } catch (error) {
      failedRead = { operation: name, target, error };
      throw error;
    }
  }
  async function mutate(name, details, write) {
    pendingMutation = { operation: name, ...details };
    log("intent", pendingMutation);
    const result = await write();
    lastMutation = pendingMutation;
    log("completed", {
      ...lastMutation,
      provider_status: result?.status ?? "success",
    });
    pendingMutation = undefined;
    return result;
  }
  const image = env.IMAGE;
  assert(
    image === `ghcr.io/${common.repository.toLowerCase()}`,
    "Unexpected release image repository.",
  );
  const api = {
    github,
    context,
    core,
    env,
    image,
    log,
    mutate,
    read,
    async packageVersion(source) {
      const { data: file } = await read(
        "github.getContent",
        {
          ...repo,
          path: "package.json",
          ref: source,
        },
        (args) => github.rest.repos.getContent(args),
      );
      assert(
        file.type === "file" && file.encoding === "base64",
        "Source package metadata is unavailable.",
      );
      const version = JSON.parse(
        Buffer.from(file.content, "base64").toString("utf8"),
      ).version;
      log("settings", {
        source_sha: source,
        package_version: parseVersion(`v${version}`) ? version : "invalid",
      });
      return version;
    },
    async history() {
      const releases = await read(
        "github.listReleases",
        {
          ...repo,
          per_page: 100,
        },
        (args) => github.paginate(github.rest.repos.listReleases, args),
      );
      const refs = await read(
        "github.listMatchingRefs",
        {
          ...repo,
          ref: "tags/v",
          per_page: 100,
        },
        (args) => github.paginate(github.rest.git.listMatchingRefs, args),
      );
      for (let offset = 0; offset < releases.length; offset += 100)
        log("history", {
          releases: releases
            .slice(offset, offset + 100)
            .map(({ id, tag_name, draft, prerelease, published_at }) => ({
              id,
              tag_name,
              draft,
              prerelease,
              published_at,
            })),
        });
      for (let offset = 0; offset < refs.length; offset += 100)
        log("tags", {
          refs: refs
            .slice(offset, offset + 100)
            .map(({ ref, object }) => ({ ref, object })),
        });
      return { releases, refs };
    },
    async source(source, latest = false) {
      assert(shaPattern.test(source), "An immutable source SHA is required.");
      const main = (
        await read("github.getBranch", { ...repo, branch: "main" }, (args) =>
          github.rest.repos.getBranch(args),
        )
      ).data.commit.sha;
      const comparison = (
        await read(
          "github.compareCommits",
          {
            ...repo,
            base: source,
            head: main,
          },
          (args) => github.rest.repos.compareCommits(args),
        )
      ).data;
      log("source", {
        source_sha: source,
        main_sha: main,
        comparison: comparison.status,
        require_current_main: latest,
      });
      assert(
        ["ahead", "identical"].includes(comparison.status),
        "Release source does not belong to main.",
      );
      return !latest || main === source;
    },
    async ci(source) {
      let ready = true;
      for (const workflow_id of ["ci.yml", "codeql.yml"]) {
        const run = (
          await read(
            "github.listWorkflowRuns",
            {
              ...repo,
              workflow_id,
              head_sha: source,
              branch: "main",
              event: "push",
              per_page: 1,
            },
            (args) => github.rest.actions.listWorkflowRuns(args),
          )
        ).data.workflow_runs[0];
        const valid =
          run &&
          run.head_sha === source &&
          run.head_branch === "main" &&
          run.event === "push" &&
          run.head_repository?.full_name === common.repository &&
          run.status === "completed" &&
          run.conclusion === "success";
        log("ci", {
          source_sha: source,
          workflow: workflow_id,
          expected: "successful exact-source main push",
          observed: run
            ? {
                head_sha: run.head_sha,
                branch: run.head_branch,
                event: run.event,
                repository: run.head_repository?.full_name,
                status: run.status,
                conclusion: run.conclusion,
                run_attempt: run.run_attempt,
                run_url: run.html_url,
              }
            : null,
          ready: Boolean(valid),
        });
        ready &&= Boolean(valid);
      }
      return ready;
    },
    async tagSource(tag, source) {
      const commit = (
        await read(
          "github.getCommit",
          { ...repo, ref: `tags/${tag}` },
          (args) => github.rest.repos.getCommit(args),
        )
      ).data.sha;
      log("tag", { tag, expected_source: source, observed_source: commit });
      assert.equal(commit, source, `Release tag ${tag} moved.`);
    },
    async release(tag) {
      const matches = (
        await read("github.listReleases", { ...repo, per_page: 100 }, (args) =>
          github.paginate(github.rest.repos.listReleases, args),
        )
      ).filter((release) => release.tag_name === tag);
      assert(matches.length <= 1, `Conflicting releases for ${tag}.`);
      if (!matches.length)
        throw Object.assign(new Error(`Release ${tag} not found.`), {
          status: 404,
        });
      const release = matches[0];
      log("release_lookup", {
        tag,
        release_id: release.id,
        draft: release.draft,
        prerelease: release.prerelease,
      });
      return release;
    },
    async inspect(reference, optional = false) {
      return read("registry.inspect", { reference }, async () => {
        const result = await exec.getExecOutput(
          "docker",
          [
            "buildx",
            "imagetools",
            "inspect",
            reference,
            "--format",
            "{{json .Manifest}}",
          ],
          { silent: true, ignoreReturnCode: true },
        );
        if (
          optional &&
          result.exitCode &&
          /manifest unknown|not found|404/i.test(result.stderr)
        )
          return undefined;
        if (result.exitCode)
          throw Object.assign(
            new Error(
              `Registry inspection failed for ${reference}: ${result.stderr}`,
            ),
            { exitCode: result.exitCode },
          );
        const manifest = JSON.parse(result.stdout);
        log("manifest", {
          reference,
          digest: manifest.digest,
          manifests: manifest.manifests,
        });
        return manifest;
      });
    },
    async copy(tags, digest) {
      const prior = {};
      for (const tag of tags)
        prior[`${image}:${tag}`] =
          (await api.inspect(`${image}:${tag}`, true))?.digest ?? null;
      await mutate(
        "registry.copy",
        {
          prior,
          desired: { tags: tags.map((tag) => `${image}:${tag}`), digest },
        },
        () =>
          exec.exec("docker", [
            "buildx",
            "imagetools",
            "create",
            ...tags.flatMap((tag) => ["--tag", `${image}:${tag}`]),
            `${image}@${digest}`,
          ]),
      );
      for (const tag of tags)
        assert.equal(
          (await api.inspect(`${image}:${tag}`)).digest,
          digest,
          `Copied image ${tag} changed digest.`,
        );
      log("images", { tags, digest });
    },
    async receipt(release) {
      const assets = await read(
        "github.listReleaseAssets",
        { ...repo, release_id: release.id, per_page: 100 },
        (args) => github.paginate(github.rest.repos.listReleaseAssets, args),
      );
      const matches = assets.filter((asset) => asset.name === receiptName);
      assert(matches.length <= 1, "Duplicate durable publication receipts.");
      if (!matches.length) return undefined;
      const result = await read(
        "github.getReleaseAsset",
        {
          ...repo,
          asset_id: matches[0].id,
          headers: { accept: "application/octet-stream" },
        },
        (args) => github.rest.repos.getReleaseAsset(args),
      );
      const receipt = JSON.parse(Buffer.from(result.data).toString("utf8"));
      log("receipt_read", {
        release_id: release.id,
        expected_tag: release.tag_name,
        observed: {
          version: receipt?.version,
          release_id: receipt?.release_id,
          tag: receipt?.tag,
          source_sha: receipt?.source_sha,
          image: receipt?.image,
          digest: receipt?.digest,
          platforms: receipt?.platforms,
          candidate_tag: receipt?.candidate_tag,
          candidate_release_id: receipt?.candidate_release_id,
        },
      });
      return receipt;
    },
    async saveReceipt(release, receipt) {
      log("receipt_expected", receipt);
      const prior = await api.receipt(release);
      if (prior)
        assert.deepEqual(
          prior,
          receipt,
          "Existing durable receipt conflicts with publication.",
        );
      else {
        const data = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
        await mutate(
          "github.uploadReleaseAsset",
          {
            prior: null,
            desired: { release_id: release.id, name: receiptName, receipt },
          },
          () =>
            github.rest.repos.uploadReleaseAsset({
              ...repo,
              release_id: release.id,
              name: receiptName,
              data,
              headers: {
                "content-type": "application/json",
                "content-length": data.length,
              },
            }),
        );
      }
      assert.deepEqual(
        await api.receipt(release),
        receipt,
        "Durable receipt readback failed.",
      );
      log("receipt", receipt);
    },
    async numberedTag(tag, source) {
      const ref = await missing(() =>
        read("github.getRef", { ...repo, ref: `tags/${tag}` }, (args) =>
          github.rest.git.getRef(args),
        ),
      );
      if (ref) await api.tagSource(tag, source);
      else
        await mutate(
          "github.createRef",
          { prior: null, desired: { ref: `refs/tags/${tag}`, sha: source } },
          () =>
            github.rest.git.createRef({
              ...repo,
              ref: `refs/tags/${tag}`,
              sha: source,
            }),
        );
      await api.tagSource(tag, source);
    },
    async alias(tag, source) {
      const version = parseVersion(tag);
      assert(version, "Invalid exact alias target.");
      const alias = `v${version.major}${version.rc === undefined ? "" : "-prerelease"}`;
      const previous = await missing(() =>
        read("github.getRef", { ...repo, ref: `tags/${alias}` }, (args) =>
          github.rest.git.getRef(args),
        ),
      );
      if (previous) {
        assert.equal(
          previous.data.object.type,
          "tag",
          "Existing floating alias is not an owned annotated tag.",
        );
        const prior = (
          await read(
            "github.getTag",
            {
              ...repo,
              tag_sha: previous.data.object.sha,
            },
            (args) => github.rest.git.getTag(args),
          )
        ).data;
        const priorVersion = parseVersion(prior.message.trim());
        assert(
          prior.tag === alias &&
            priorVersion?.major === version.major &&
            (priorVersion.rc === undefined) === (version.rc === undefined) &&
            prior.object.type === "commit",
          "Existing alias has no matching release identity.",
        );
        assert(
          compareVersions(priorVersion, version) <= 0,
          "Floating alias would move backward.",
        );
        if (priorVersion.tag === tag) {
          assert.equal(
            prior.object.sha,
            source,
            "Floating alias source changed.",
          );
          return;
        }
      }
      const created = (
        await mutate(
          "github.createTag",
          {
            prior: previous?.data.object.sha ?? null,
            desired: { alias, tag, source_sha: source },
          },
          () =>
            github.rest.git.createTag({
              ...repo,
              tag: alias,
              message: tag,
              object: source,
              type: "commit",
            }),
        )
      ).data;
      if (previous)
        await mutate(
          "github.updateRef",
          {
            prior: previous.data.object.sha,
            desired: {
              ref: `tags/${alias}`,
              sha: created.sha,
              source_sha: source,
              version: tag,
            },
          },
          () =>
            github.rest.git.updateRef({
              ...repo,
              ref: `tags/${alias}`,
              sha: created.sha,
              force: true,
            }),
        );
      else
        await mutate(
          "github.createRef",
          {
            prior: null,
            desired: {
              ref: `refs/tags/${alias}`,
              sha: created.sha,
              source_sha: source,
              version: tag,
            },
          },
          () =>
            github.rest.git.createRef({
              ...repo,
              ref: `refs/tags/${alias}`,
              sha: created.sha,
            }),
        );
      const actual = (
        await read("github.getRef", { ...repo, ref: `tags/${alias}` }, (args) =>
          github.rest.git.getRef(args),
        )
      ).data;
      assert.equal(
        actual.object.sha,
        created.sha,
        "Floating alias readback failed.",
      );
      const target = (
        await read(
          "github.getTag",
          { ...repo, tag_sha: actual.object.sha },
          (args) => github.rest.git.getTag(args),
        )
      ).data;
      assert(
        target.tag === alias &&
          target.message.trim() === tag &&
          target.object.type === "commit" &&
          target.object.sha === source,
        "Floating alias target readback failed.",
      );
      log("alias", {
        alias,
        version: tag,
        source_sha: source,
        previous: previous?.data.object.sha ?? null,
        desired: created.sha,
      });
    },
    async summary(receipt) {
      await core.summary
        .addHeading("Release publication receipt")
        .addCodeBlock(
          JSON.stringify(
            {
              ...receipt,
              run_url: `${context.serverUrl}/${common.repository}/actions/runs/${context.runId}`,
            },
            null,
            2,
          ),
          "json",
        )
        .write();
    },
    async run(fn) {
      log("started");
      try {
        const result = await fn(api);
        log("finished", { outcome: result?.outcome ?? "published" });
        return result;
      } catch (error) {
        core.error(
          JSON.stringify({
            event: "release.failed",
            ...common,
            elapsed_ms: Date.now() - started,
            source_sha:
              env.SOURCE_SHA ?? context.payload.workflow_run?.head_sha,
            version: env.VERSION,
            source_rc: context.payload.inputs?.source_rc,
            ...(pendingMutation ??
              (failedRead?.error === error
                ? { operation: failedRead.operation, target: failedRead.target }
                : { operation: "validation" })),
            last_completed_mutation: lastMutation,
            completed_stage: lastMutation?.operation ?? "read_only_validation",
            evidence_unavailable:
              failedRead?.error === error
                ? "Required provider read failed before the remaining evidence could be collected."
                : undefined,
            cause: error.message,
            provider_status:
              error.status ?? error.exitCode ?? error.code ?? "not_reported",
            recovery:
              "Inspect the completed stage and source/receipt evidence; correct the cause, then rerun. Never replace a numbered tag or receipt.",
          }),
        );
        throw error;
      }
    },
  };
  return api;
}

export async function resolveCandidate(options) {
  return operation(options, "resolve").run(async (api) => {
    const { context, core, log } = api;
    const run = context.payload.workflow_run;
    assert(
      context.eventName === "workflow_run" &&
        run?.event === "push" &&
        run.head_branch === "main" &&
        run.conclusion === "success" &&
        run.head_repository?.id === context.payload.repository.id &&
        run.head_repository.full_name ===
          `${context.repo.owner}/${context.repo.repo}`,
      "A successful same-repository main-push workflow run is required.",
    );
    const source = run.head_sha;
    const current = await api.source(source, true);
    const ready = await api.ci(source);
    const packageVersion = await api.packageVersion(source);
    const { releases, refs } = await api.history();
    log("base", {
      source_sha: source,
      base: intendedBase(packageVersion, releases).base,
    });
    const completedSource = versions(releases, true).find(({ release }) =>
      refs.some(
        (ref) =>
          ref.ref === `refs/tags/${release.tag_name}` &&
          ref.object.type === "commit" &&
          ref.object.sha === source,
      ),
    );
    const version =
      completedSource?.version ??
      nextCandidate(packageVersion, releases, refs, source);
    log("version", {
      source_sha: source,
      package_version: packageVersion,
      version: version.tag,
      base: version.base,
    });
    if ((!current && !completedSource) || !ready) {
      log("skipped", {
        source_sha: source,
        reason: "source_superseded_or_ci_incomplete",
        version: version.tag,
        base: version.base,
      });
      return { outcome: "skipped" };
    }
    await api.numberedTag(version.tag, source);
    const release = await missing(() => api.release(version.tag));
    if (release)
      assert(
        release.tag_name === version.tag && release.prerelease,
        "Candidate release identity conflicts with its reservation.",
      );
    const receipt = release && (await api.receipt(release));
    for (const [name, value] of Object.entries({
      version: version.tag.slice(1),
      source_sha: source,
      build_required: !receipt && (!release || release.draft),
      publish_required: true,
    }))
      core.setOutput(name, String(value));
    return {
      outcome: !release || release.draft ? "reserved" : "resume_publication",
    };
  });
}

async function candidateProof(api, release, source) {
  assert(
    release.prerelease && parseVersion(release.tag_name)?.rc !== undefined,
    "A candidate release is required.",
  );
  await api.tagSource(release.tag_name, source);
  const receipt = await api.receipt(release);
  assert(receipt, "Candidate has no durable publication receipt.");
  const manifest = await api.inspect(`${api.image}@${receipt.digest}`);
  verifyReceipt(receipt, release, source, api.image, manifest);
  assert.equal(
    (await api.inspect(`${api.image}:${release.tag_name.slice(1)}`)).digest,
    receipt.digest,
    "Candidate version image moved.",
  );
  api.log("verified", receipt);
  return receipt;
}

export async function publishCandidate(options) {
  return operation(options, "publish").run(async (api) => {
    const { github, context, env, image, log } = api;
    const source = env.SOURCE_SHA;
    const version = parseVersion(`v${env.VERSION}`);
    assert(
      version?.rc !== undefined,
      "An exact candidate version is required.",
    );
    let release = await missing(() => api.release(version.tag));
    const completed = release && published(release);
    assert(
      await api.source(source, !completed),
      "Candidate source was superseded; wait for current main CI.",
    );
    assert(
      await api.ci(source),
      "Candidate requires successful exact-source main-push CI.",
    );
    if (release)
      assert(release.prerelease, "Candidate release changed channel.");
    await api.tagSource(version.tag, source);
    const state = await api.history();
    const stable = versions(state.releases, false)[0]?.version;
    assert(
      completed ||
        !stable ||
        compareVersions(parseVersion(version.base), stable) > 0,
      "Candidate reservation was superseded by stable promotion.",
    );
    let receipt = release && (await api.receipt(release));
    let manifest = await api.inspect(`${image}:${env.VERSION}`, true);
    if (receipt) {
      assert(manifest, "Published version image is missing.");
      verifyReceipt(receipt, release, source, image, manifest);
    } else if (manifest) {
      verifyCandidateImage(manifest, source, version.tag, release?.id);
      log(
        "resumed",
        { version: version.tag, source_sha: source, digest: manifest.digest },
        "warning",
      );
    } else {
      assert(!completed, "Completed candidate image cannot be rebuilt.");
      assert.deepEqual(
        (await readdir(env.RECEIPTS)).sort(),
        ["image-amd64.json", "image-arm64.json"],
        "Both architecture receipts are required.",
      );
      const native = await Promise.all(
        ["amd64", "arm64"].map(async (arch) => {
          const item = JSON.parse(
            await readFile(join(env.RECEIPTS, `image-${arch}.json`), "utf8"),
          );
          log("native", {
            expected: {
              source_sha: source,
              version: env.VERSION,
              platform: `linux/${arch}`,
              smoke: "passed",
            },
            observed: item,
          });
          assert(
            item.source_sha === source &&
              item.version === env.VERSION &&
              item.platform === `linux/${arch}` &&
              item.smoke === "passed" &&
              digestPattern.test(item.digest) &&
              digestPattern.test(item.platform_digest),
            "Native smoke receipt mismatch.",
          );
          const actual = await api.inspect(`${image}@${item.digest}`);
          assert.equal(
            actual.digest,
            item.digest,
            "Native build digest changed.",
          );
          if (actual.manifests)
            verifyPlatforms(actual, [
              {
                platform: item.platform,
                platform_digest: item.platform_digest,
              },
            ]);
          else
            assert.equal(
              actual.digest,
              item.platform_digest,
              "Native platform digest changed.",
            );
          return item;
        }),
      );
      const proof = {
        version: 2,
        source_sha: source,
        release_version: env.VERSION,
        platforms: native.map(({ platform, platform_digest }) => ({
          platform,
          platform_digest,
        })),
      };
      await api.mutate(
        "registry.create_candidate_index",
        {
          prior: null,
          desired: { tag: `${image}:${env.VERSION}`, proof },
        },
        () =>
          options.exec.exec("docker", [
            "buildx",
            "imagetools",
            "create",
            "--tag",
            `${image}:${env.VERSION}`,
            "--annotation",
            `index:${annotation}=${JSON.stringify(proof)}`,
            ...native.map((item) => `${image}@${item.digest}`),
          ]),
      );
      manifest = await api.inspect(`${image}:${env.VERSION}`);
      verifyCandidateImage(manifest, source, version.tag);
    }
    const sourceTag = await api.inspect(`${image}:sha-${source}`, true);
    if (sourceTag)
      assert.equal(
        sourceTag.digest,
        manifest.digest,
        "Source image tag conflicts with this publication.",
      );
    else await api.copy([`sha-${source}`], manifest.digest);
    await api.tagSource(version.tag, source);
    assert(
      await api.source(source, !completed),
      "Candidate source advanced during publication; rerun only for current main.",
    );
    if (completed && !receipt) {
      receipt = {
        version: 1,
        release_id: release.id,
        tag: version.tag,
        source_sha: source,
        image,
        digest: manifest.digest,
        platforms: verifyCandidateImage(
          manifest,
          source,
          version.tag,
          release.id,
        ).platforms,
      };
      await api.saveReceipt(release, receipt);
    }
    const latest = versions((await api.history()).releases, true).find(
      ({ version: other }) => other.major === version.major,
    )?.version;
    if (completed && latest && compareVersions(latest, version) > 0) {
      assert(
        receipt,
        "Completed candidate has no durable publication receipt.",
      );
      log("skipped", {
        source_sha: source,
        version: version.tag,
        reason: "newer_candidate_for_major",
        latest: latest.tag,
      });
      await api.summary(receipt);
      return { outcome: "superseded" };
    }
    assert(
      !latest || compareVersions(latest, version) <= 0,
      "A newer candidate already exists.",
    );
    const body = `Verified native AMD64 and ARM64 images.\n\nSource: ${source}\n\nRuntime image: \`${image}@${manifest.digest}\`\n\nWorkflow: \`${context.repo.owner}/${context.repo.repo}/.github/workflows/maintenance.yml@${version.tag}\`\n\nSee publication.json for the immutable image receipt.`;
    if (!release)
      release = (
        await api.mutate(
          "github.createRelease",
          {
            prior: null,
            desired: {
              tag: version.tag,
              source_sha: source,
              draft: false,
              prerelease: true,
              digest: manifest.digest,
            },
          },
          () =>
            github.rest.repos.createRelease({
              ...context.repo,
              tag_name: version.tag,
              target_commitish: source,
              name: version.tag,
              body,
              draft: false,
              prerelease: true,
              make_latest: "false",
            }),
        )
      ).data;
    else if (release.draft)
      release = (
        await api.mutate(
          "github.updateRelease",
          {
            prior: { release_id: release.id, draft: true },
            desired: {
              tag: version.tag,
              source_sha: source,
              draft: false,
              prerelease: true,
            },
          },
          () =>
            github.rest.repos.updateRelease({
              ...context.repo,
              release_id: release.id,
              draft: false,
              prerelease: true,
              make_latest: "false",
              body,
            }),
        )
      ).data;
    receipt ??= {
      version: 1,
      release_id: release.id,
      tag: version.tag,
      source_sha: source,
      image,
      digest: manifest.digest,
      platforms: verifyCandidateImage(manifest, source, version.tag, release.id)
        .platforms,
    };
    verifyReceipt(receipt, release, source, image, manifest);
    await api.saveReceipt(release, receipt);
    const current = await api.release(version.tag);
    assert(
      published(current) && current.prerelease && current.id === release.id,
      "Candidate publication readback failed.",
    );
    await candidateProof(api, current, source);
    await api.copy([`${version.major}-prerelease`], receipt.digest);
    await api.alias(version.tag, source);
    await api.summary(receipt);
  });
}

export async function promoteStable(options) {
  return operation(options, "promote").run(async (api) => {
    const { github, context, image, log } = api;
    assert(
      context.eventName === "workflow_dispatch" &&
        context.ref === "refs/heads/main",
      "Stable promotion must be dispatched from main.",
    );
    const version = parseVersion(context.payload.inputs?.source_rc);
    assert(
      version?.rc !== undefined,
      "source_rc must be an exact candidate tag such as v1.0.0-rc.1.",
    );
    const candidate = await api.release(version.tag);
    assert(
      published(candidate) && candidate.prerelease,
      "A published prerelease is required.",
    );
    const source = (
      await api.read(
        "github.getCommit",
        {
          ...context.repo,
          ref: `tags/${version.tag}`,
        },
        (args) => github.rest.repos.getCommit(args),
      )
    ).data.sha;
    assert(await api.source(source), "Candidate source must belong to main.");
    assert(
      await api.ci(source),
      "Promotion requires successful exact-source main-push CI.",
    );
    const receipt = await candidateProof(api, candidate, source);
    const state = await api.history();
    const latest = versions(state.releases, true)[0]?.version;
    const stable = versions(state.releases, false)[0];
    const target = parseVersion(version.base);
    const stableForMajor = versions(state.releases, false).find(
      ({ version: other }) => other.major === version.major,
    );
    const replay = stableForMajor?.version.tag === version.base;
    if (replay) {
      const prior = await api.receipt(stableForMajor.release);
      assert(
        prior &&
          prior.candidate_tag === version.tag &&
          prior.candidate_release_id === candidate.id,
        "Stable publication does not match the selected candidate.",
      );
      verifyReceipt(
        prior,
        stableForMajor.release,
        source,
        image,
        await api.inspect(`${image}:${version.base.slice(1)}`),
      );
    }
    const main = (
      await api.read(
        "github.getBranch",
        { ...context.repo, branch: "main" },
        (args) => github.rest.repos.getBranch(args),
      )
    ).data.commit.sha;
    const active = intendedBase(await api.packageVersion(main), state.releases);
    log("active_base", {
      source_sha: source,
      main_sha: main,
      base: active.base,
      source_rc: version.tag,
      completed_publication_replay: replay,
    });
    assert(
      replay || version.base === active.base,
      "Candidate does not belong to the active intended release base.",
    );
    assert(
      replay || latest?.tag === version.tag,
      "Only the latest published verified RC for the active base may be promoted.",
    );
    assert(
      replay || !stable || compareVersions(stable.version, target) <= 0,
      "Stable release would move backward.",
    );
    const priorStable = replay ? stableForMajor : stable;
    if (priorStable) {
      const priorSource = (
        await api.read(
          "github.getCommit",
          {
            ...context.repo,
            ref: `tags/${priorStable.version.tag}`,
          },
          (args) => github.rest.repos.getCommit(args),
        )
      ).data.sha;
      const comparison = (
        await api.read(
          "github.compareCommits",
          {
            ...context.repo,
            base: priorSource,
            head: source,
          },
          (args) => github.rest.repos.compareCommits(args),
        )
      ).data;
      assert(
        ["ahead", "identical"].includes(comparison.status),
        "Promotion would move the stable source backward.",
      );
    }
    log("promotion", {
      source_rc: version.tag,
      source_sha: source,
      version: version.base,
      digest: receipt.digest,
      prior_stable: stable?.version.tag ?? null,
    });
    await api.numberedTag(version.base, source);
    let release = await missing(() => api.release(version.base));
    if (!release)
      release = (
        await api.mutate(
          "github.createRelease",
          {
            prior: null,
            desired: {
              tag: version.base,
              source_sha: source,
              draft: true,
              prerelease: false,
            },
          },
          () =>
            github.rest.repos.createRelease({
              ...context.repo,
              tag_name: version.base,
              target_commitish: source,
              name: version.base,
              body: `Promotes ${version.tag} at ${source}; publication pending.`,
              draft: true,
              prerelease: false,
            }),
        )
      ).data;
    assert(
      release.tag_name === version.base && !release.prerelease,
      "Stable reservation identity changed.",
    );
    const promoted = {
      ...receipt,
      release_id: release.id,
      tag: version.base,
      candidate_tag: version.tag,
      candidate_release_id: candidate.id,
    };
    const existing = await api.inspect(
      `${image}:${version.base.slice(1)}`,
      true,
    );
    if (existing)
      assert.equal(
        existing.digest,
        receipt.digest,
        "Stable version image conflicts with the candidate digest.",
      );
    await api.saveReceipt(release, promoted);
    await candidateProof(api, await api.release(version.tag), source);
    const currentState = await api.history();
    const currentMain = (
      await api.read(
        "github.getBranch",
        { ...context.repo, branch: "main" },
        (args) => github.rest.repos.getBranch(args),
      )
    ).data.commit.sha;
    assert(
      replay ||
        intendedBase(
          await api.packageVersion(currentMain),
          currentState.releases,
        ).base === version.base,
      "Active intended release base changed before promotion.",
    );
    assert(
      replay ||
        versions(currentState.releases, true)[0]?.version.tag === version.tag,
      "Latest candidate changed before promotion.",
    );
    const currentStable = versions(currentState.releases, false)[0]?.version;
    if (!existing) await api.copy([version.base.slice(1)], receipt.digest);
    verifyReceipt(
      promoted,
      release,
      source,
      image,
      await api.inspect(`${image}:${version.base.slice(1)}`),
    );
    if (release.draft)
      await api.mutate(
        "github.updateRelease",
        {
          prior: { release_id: release.id, draft: true },
          desired: {
            tag: version.base,
            source_sha: source,
            draft: false,
            prerelease: false,
          },
        },
        () =>
          github.rest.repos.updateRelease({
            ...context.repo,
            release_id: release.id,
            draft: false,
            prerelease: false,
            make_latest: "true",
            body: `Promoted ${version.tag} without rebuilding.\n\nSource: ${source}\n\nRuntime image: \`${image}@${receipt.digest}\`\n\nWorkflow: \`${context.repo.owner}/${context.repo.repo}/.github/workflows/maintenance.yml@${version.base}\`\n\nImage labels retain the original candidate version. See publication.json for provenance.`,
          }),
      );
    const current = await api.release(version.base);
    assert(
      published(current) && !current.prerelease && current.id === release.id,
      "Stable publication readback failed.",
    );
    await api.tagSource(version.base, source);
    const tags = [String(version.major)];
    if (!currentStable || compareVersions(target, currentStable) >= 0)
      tags.push("latest");
    await api.copy(tags, receipt.digest);
    await api.alias(version.base, source);
    await api.summary(promoted);
  });
}
