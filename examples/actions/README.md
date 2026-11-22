# Configure repository maintenance

These examples run ORM in your GitHub repository. Start with the [installation guide](../../README.md#install-in-your-repository) for file destinations and a first run.

## Credentials and branch rules

Create repository Actions secrets under **Settings → Secrets and variables → Actions**. The example workflows expect the following names.

| Secret                                       | Value or repository permission                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORM_GITHUB_TOKEN`                           | Controller personal access token (PAT). Grant Actions, Issues, Contents, and Pull requests read/write, plus Metadata, Checks, and Commit statuses read. GitHub's default-branch protection lookup also requires Administration read. [GitHub token permissions](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection--fine-grained-access-tokens) |
| `ORM_SESSION_KEY`                            | A base64-encoded 32-byte key. Generate it once with `openssl rand -base64 32`. Retain it across runs so ORM can authenticate task comments and decrypt its checkpoints.                                                                                                                                                                                                       |
| `ORM_AGENT_READ_TOKEN`                       | Contents and Actions read, for checking out source and downloading phase inputs. Used for read-only phases and the configuration probe.                                                                                                                                                                                                                                       |
| `ORM_AGENT_WORK_TOKEN`                       | A separate coding identity with Contents write and Actions read. Leave Issues and Pull requests write access disabled for this identity.                                                                                                                                                                                                                                      |
| `ORM_CODING_SETTINGS`, `ORM_REVIEW_SETTINGS` | Native provider settings. In the example, supply Claude settings JSON for `coding` and Codex TOML for `review`. Set each model and effort in its own settings.                                                                                                                                                                                                                |
| `ORM_CLAUDE_API_KEY`, `ORM_CODEX_API_KEY`    | API keys for the providers selected by your profiles. The example uses both.                                                                                                                                                                                                                                                                                                  |

Scope each GitHub token to the consumer repository. Enforce the coding identity's branch restrictions with GitHub rules. It needs to create and advance only `orm-work/**`. Those pushes are visible immediately. Protect the default branch, workflow configuration, and the controller's `orm/**` PR branches from that identity. The controller holds the publication token and signing key and advances the PR branch after audit and testing.

Use disposable Linux runners. The native Codex and Claude processes have full access within their runner job. Their session, checkpoint, and result artifacts follow your repository's Actions access and retention policy. ORM dispatches these jobs through [agent-remote-dev v1.0.0](https://github.com/markhuangai/agent-remote-dev/releases/tag/v1.0.0).

Controller toolchain commands run without service credentials. Docker shares the host kernel and permits outbound network access.

## Profiles and PR checks

[orm.yml](orm.yml) assigns the `bootstrap`, `investigation`, and `implementation` roles to the `coding` profile. It assigns `audit` and `output_review` to `review`. If you rename profiles or change providers, match the keys in `ORM_AGENT_PROFILES` in [orm-agent.yml](orm-agent.yml) and [test-ai.yml](test-ai.yml) to those names and supply the corresponding native settings and API keys.

The image includes [default prompts and skills](../workflow). For overrides, put regular files in `.github/orm/prompts/` and `.github/orm/skills/` and name them in the role configuration. ORM reads them from the same default-branch commit as `.github/orm.yml`. In [.remote-dev.yml](remote-dev.yml), keep `skills: []`, omit `user-level-md-url`, and keep `auto-continue: false`. The controller token owner and anyone dispatching the probe must be listed in `allowed-actors` and have repository write access.

With `pr_monitor.requirements_source: github`, ORM reads branch protection and applicable rulesets. Use `required_checks` for additional check names. The placeholder `{pr}` in a name expands to the PR number. If GitHub discovery is unavailable or a rule is unsupported, `requirements_source: operator` lets you provide a complete list with `required_checks`. Known GitHub requirements still apply. For a repository with only local checks, explicitly set `requirements_source: operator` and `local_checks_only: true` with an empty `required_checks` list. This requires successful discovery showing no unknown or required GitHub checks.

The example's `automated_reviewers` list requires both Codex and CodeRabbit to finish on the current PR commit. Set it to `[]` if your repository requires neither, or list the bots you actually use. Each entry has a `login` and a `signal` of `github_review`, `codex`, or `coderabbit`. ORM waits for pending checks and missing review signals. A reviewer reporting a quota or rate limit blocks readiness. Maintainers handle human approval and merging.

## Task limits and recovery

Set per-issue limits in `.github/orm.yml`. The example allows 60 active minutes, 200 agent runs, three repair cycles, two infrastructure retries, and 24 hours waiting for remote checks. Each authorized dispatch counts once. Time waiting for a human reply or queued agent execution does not spend active or CI-wait time. Restarting the controller preserves the task's budgets.

For local verification, ORM supports public Go modules (including CGO), npm, pnpm, Yarn, and Python projects using pip, Poetry, or uv. If dependencies are needed, provide a usable lockfile or fully pinned requirements from a supported public registry. Unavailable versions, private dependency credentials, or missing local infrastructure can block a task. Platform-specific checks such as Windows CI run in your repository's workflows.

Keep the `orm:managed` label, ORM's signed issue comment, and controller artifacts. The comment identifies the run and checkpoint. ORM requests 14-day retention for encrypted controller checkpoints. If an artifact expires or is deleted, ORM must verify the work again within the remaining budget. If ORM asks for information, reply in a new issue comment. The reporter or a maintainer can supply facts. Questions about intended behavior or scope require a maintainer.

## Versions and upgrades

The callers use reusable workflows from `markhuangai/opensource-repo-manager`. Use the same ORM reference for maintenance, agent dispatch, and the optional probe. `@v1-prerelease` follows published candidates. After a stable v1 release is published, `@v1` follows stable releases. A numbered release tag or a full workflow commit SHA with a published image pins the installation. [Published releases](https://github.com/markhuangai/opensource-repo-manager/releases)

On GitHub.com the workflow resolves the image for its own source commit, verifies its publication proof and both native Linux manifests (AMD64 and ARM64), then uses one immutable digest for the whole run. To override automatic selection, pass a compatible `runtime-image` pinned by `@sha256:` in each caller. A verified release's `publication.json` records its image digest.

The current configuration and signed comments use version 2. The controller opens fresh or schema-13 databases. Keep older tasks and their data with their compatible pinned workflow and image. Preserve the session key, task comments, artifacts, and publication receipts when upgrading.

## Troubleshoot a run

Read the failed **Repository maintenance**, **ORM agent**, or **Test AI configuration** run in your own repository. To filter its Actions log locally, substitute the run ID and your repository name. Image selection allows 60 seconds for registry inspection and records the failing stage in `runtime.failed`.

```sh
gh run view RUN_ID --repo OWNER/REPO --log | rg 'runtime\.|agent\.|api\.request\.|configuration_|controller_failed|actions\.failed|::error::'
```

| Symptom                                          | What to check                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.failed`                                 | Check the logged workflow commit and GHCR error. Verify that a release published an image for that commit, or supply a known-compatible digest from its receipt. `runtime.resolved` and `runtime.used` show the selected image. |
| `agent.dispatch_failed`                          | Check the HTTP status and request ID. Confirm `orm-agent.yml` is on the default branch, the controller login is allowlisted, and its PAT has Actions write access.                                                              |
| `agent_actor_unauthorized` during the probe      | Check the GitHub login that started the run against `allowed-actors` and confirm that account has repository write access. Start a fresh dispatch from the default branch.                                                      |
| `agent.checkout_mismatch` or `agent.stale_audit` | Compare the logged candidate SHA with the checkout and work-branch head in the referenced agent run and attempt. A moved candidate needs a fresh audit and tests.                                                               |
| `waiting/remote_checks`                          | Inspect required checks and reviewer signals on the current PR commit, including every bot listed in `automated_reviewers`. The controller releases its runner while waiting.                                                   |
