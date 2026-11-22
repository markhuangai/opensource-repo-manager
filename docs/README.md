# Maintaining opensource-repo-manager

Use this guide to work on ORM itself. The [consumer guide](../README.md) covers installation in another repository. The [controller reference](controller.md) traces an issue from enrollment through investigation, verified publication, and human review.

## Develop and validate locally

Use Node 24.18.0, npm 12.0.2, and Docker with Buildx and a local Unix-socket daemon. Run these commands from the repository root.

```sh
npm ci
npm run check
npm run test:container -- --platform linux/amd64
```

`npm run check` runs Prettier, ESLint, TypeScript, the unit tests, and the production build. On an ARM64 host use `--platform linux/arm64`. The container harness exercises the built image's default entrypoint with controlled GitHub and artifact transports and real Git commits. It uses an isolated Docker client configuration for public pulls and cleans up its labeled resources. If the daemon and CLI have different temporary filesystems, set `TMPDIR` to a writable shared path such as `"$PWD/node_modules"` for the container command.

To diagnose one suite, add `--suite implementation-monitor-state` or another [suite name](../scripts/container-suites.mjs). The `bootstrap` selector runs the Node, Python, and Go groups in fresh containers with separate 40-minute limits. Each group verifies its SDK and scenario coverage. The Actions suite runs up to four isolated lanes on a shared image. Add `--suite actions --actions-concurrency 1` to run the Actions scenarios serially.

For workflow changes, run the same actionlint 1.7.12 check as CI.

```sh
actionlint .github/workflows/*.yml examples/actions/{maintenance,orm-agent,test-ai}.yml
```

PR CI runs on native AMD64 and ARM64 and tests GitHub's PR merge commit. Each suite reports the tested commit, PR head, dirty-worktree flag, source and test digest, image ID, scenario coverage, timings, and cleanup. When interpreting CI timings, keep attempts separate, distinguish queue from execution time, and account for overlapping lanes. The 30-minute target requires three representative fresh heads, all required current-head results, and complete native coverage. [CI workflow](../.github/workflows/ci.yml) · [Performance measurements and coverage](ci-performance.md)

## Run remote development on this project

Open **Actions → Remote development → Run workflow** on `main`. Select Codex or Claude and enter the approved plan, including the task branch, checks, and PR for human review. To resume, select the original runner and supply its `resume-run-id`. Eligible timeouts resume from a saved session up to three times. Push work you need to recover across runs.

This repository's manual workflow calls `agent-remote-dev@v1`. Configure `REMOTE_DEV_PAT` for task-branch pushes and PR creation using an account without a bypass on `main`. Codex uses `CODEX_CONFIG_TOML` and `CODEX_API_KEY`. Claude uses `CLAUDE_SETTINGS_JSON` and `ANTHROPIC_API_KEY`. Use plans suitable for public session artifacts and restrict dispatch through the project's allowlist. [Manual workflow](../.github/workflows/remote-dev.yml) · [Project allowlist](../.remote-dev.yml)

## Review pull requests

Trusted maintainers' PRs start AI review through `pull_request_target`. Other-author and fork PRs use successful PR CodeQL completion. CI, CodeQL, and direct review respond to opening, updating, reopening, marking ready, and editing a PR. Retargeting a PR to `main` registers validation. Title and body edits also rerun CI. A manual dispatch accepts an open PR number.

Require successful Repository CI, native container checks, CodeQL analysis, CodeQL, and `AI PR review / PR #<number>` for the current head. Agent-owned delivery also follows the configured Codex and CodeRabbit review requirements. The review workflow deduplicates runs for the same head and reports incomplete review as a blocking status. Check the review status itself before merge.

The reviewer calls `ai-pr-reviewer@v1-prerelease` with Claude, model `auto` by default, `xhigh` effort, six goals, up to 200 turns per goal, and a 50-minute review limit. It reinspects claimed fixes, then reviews design, security, reliability, public contracts, scope, and tests. It uses a pristine checkout, read-only tools, and project-scoped `recall_memory`. Human approval and merge remain required.

Set the endpoint with the `AI_ENDPOINT` Actions variable or secret and optionally set the `AI_REVIEW_MODEL` variable. Supply `LOCAL_AI_SECRET`, `PR_REVIEW_PAT`, `PROJECT_MEMORY_MCP_ENDPOINT`, and this project's read-only `PROJECT_MEMORY_MCP_TOKEN`. Interactive review needs Contents and Pull requests read/write, Commit statuses write, and Issues read. [AI review workflow](../.github/workflows/ai-pr-review.yml)

## Publish releases

Successful Repository CI and CodeQL push runs on `main` trigger prerelease publication. Both validations must be the latest attempts for the same source SHA in this repository, and that SHA must still be current on `main`. Rapid merges can supersede intermediate revisions. The `package.json` version sets the minimum release base. Update it and the lockfile root version in the same PR to start a minor or major line. After a stable release, ordinary patch progression starts the next patch's RC series automatically.

The prerelease workflow reserves an immutable Git tag and builds natively on `ubuntu-24.04` and `ubuntu-24.04-arm`. Before publishing the combined image, both images must pass default-entrypoint startup, source and platform identity, Node/SQLite execution, and bundled-tool smoke checks. It then publishes the GitHub prerelease, attaches and reads back `publication.json`, and advances the prerelease aliases. The image proof binds source, version, and native digests. [Prerelease workflow](../.github/workflows/release.yml)

| Channel   | Example Git tag | Moving Git tag  | GHCR image tags                                       |
| --------- | --------------- | --------------- | ----------------------------------------------------- |
| Candidate | `v1.0.0-rc.1`   | `v1-prerelease` | `1.0.0-rc.1`, `1-prerelease`, `sha-<full-source-sha>` |
| Stable    | `v1.0.0`        | `v1`            | `1.0.0`, `1`, `latest`                                |

To promote the latest verified RC for the active base, dispatch **Promote stable release** from `main`. Substitute the verified RC in this command.

```sh
gh workflow run promote-release.yml --ref main -f source_rc=v1.0.0-rc.3
```

Promotion verifies source ancestry, exact-source main CI, the candidate tag and receipt, the image digest, and both native manifests. It copies the verified multi-architecture index, so the stable digest equals the RC digest and OCI labels retain the RC version. A package-version bump on `main` closes the older base to new promotions. A conflicting stable tag, source, image, or receipt blocks publication. Numbered versions are immutable. Repairs to older majors preserve the global `latest` alias. [Promotion workflow](../.github/workflows/promote-release.yml)

Candidate and promotion runs serialize their release-state mutations. If `main` advances during a build, the next validated revision supplies the next candidate. After an interruption, inspect the failed stage and recovery field before rerunning the same Actions run.

```sh
gh run view RUN_ID --repo markhuangai/opensource-repo-manager --log | rg 'release\.|::warning::|::error::'
```

Retries reuse matching tags, verified images, releases, and receipts. A published prerelease can briefly lack its receipt if the upload was interrupted. Rerunning recovers the image and advances aliases after receipt readback. Expired one-day architecture artifacts may require rebuilding untagged native images. Preserve legacy draft releases and orphaned reservations during recovery. GHCR visibility is a separate operator setting. Verify anonymous pulls on both supported platforms before advertising public image access.
