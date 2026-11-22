# opensource-repo-manager

GitHub Actions maintenance that investigates selected issues, prepares audited and tested fixes, follows PR feedback, and publishes readiness for human review. Each invocation uses a temporary Linux container and exits when work completes, blocks, or must wait.

The image's default entrypoint is the bounded Actions runtime. Authenticated GitHub comments hold task authority; encrypted Actions artifacts retain recoverable controller checkpoints. Human review and merge remain required.

## Run remote development

Open **Actions → Remote development → Run workflow** on `main`. Choose Codex or Claude and enter an approved plan that calls for a task branch, the required checks, and a PR for human review. To resume a conversation, select its original runner and supply its `resume-run-id`. Eligible timeouts resume from a saved session up to three times. Push work you want to recover across runs.

The [manual workflow](.github/workflows/remote-dev.yml) follows `agent-remote-dev@v1`. Set `REMOTE_DEV_PAT` to a repository-scoped credential for pushing task branches and opening PRs. Use an account without a bypass on `main`. Configure `CODEX_CONFIG_TOML` and `CODEX_API_KEY` for Codex, or `CLAUDE_SETTINGS_JSON` and `ANTHROPIC_API_KEY` for Claude. The dispatch allowlist is in [`.remote-dev.yml`](.remote-dev.yml). Use plans suitable for this public repository because repository readers can download session artifacts.

## Install bounded Actions maintenance

1. Copy [maintenance.yml](examples/actions/maintenance.yml) and [orm-agent.yml](examples/actions/orm-agent.yml) to the consumer's `.github/workflows/` on its default branch. ORM's callers use `@v1-prerelease` and resolve a compatible image by digest. An exact ORM release tag or reviewed commit also works when its matching image is published.
2. Copy [orm.yml](examples/actions/orm.yml) to `.github/orm.yml` and [remote-dev.yml](examples/actions/remote-dev.yml) to `.remote-dev.yml`. Replace the placeholder in `allowed-actors` with the controller PAT owner's GitHub login. That account needs repository write access. Set `auto-continue: false` and put ORM prompts and skill overrides under `.github/orm/`.
3. Add the Actions secrets below. Keep the profile names in both caller maps aligned with `profiles` in `.github/orm.yml`. The example maps `coding` to Claude settings JSON and `review` to Codex TOML. Put each profile's model and effort in its native settings.
4. Configure GitHub rules so the dedicated coding identity can create and advance branches only under `orm-work/**`. Keep the default branch, workflow configuration and `orm/**` PR branches under controller and maintainer control. Use disposable Linux runners (such as `ubuntu-24.04`) with Docker and Buildx for the controller.

| Secret                                       | Purpose                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ORM_GITHUB_TOKEN`                           | Repository-scoped controller PAT. Give it Actions, Issues, Contents and Pull requests read/write, plus Metadata, Checks and Commit statuses read. GitHub requirement discovery also needs applicable ruleset/protection reads. |
| `ORM_SESSION_KEY`                            | Base64-encoded 32 random bytes. Generate once with `openssl rand -base64 32` and retain it for signed task state and separate controller-checkpoint encryption.                                                                |
| `ORM_CODING_SETTINGS`, `ORM_REVIEW_SETTINGS` | Native profile content mapped explicitly in the consumer workflows. Keep API keys in their own secrets.                                                                                                                        |
| `ORM_CLAUDE_API_KEY`, `ORM_CODEX_API_KEY`    | Native provider authentication. Configure the keys for the harnesses your roles select.                                                                                                                                        |
| `ORM_AGENT_READ_TOKEN`                       | Repository-scoped token with Contents and Actions read. This token can fetch commits and download pinned phase inputs.                                                                                                         |
| `ORM_AGENT_WORK_TOKEN`                       | Dedicated coding identity with Contents write on the configured work-branch namespace and Actions read for phase inputs. Give it neither Issues nor Pull requests write.                                                       |

The controller resolves `.github/orm.yml` plus regular prompt and skill overrides from the same default-branch revision. It keeps the publication PAT and signing key in controller jobs. The preflight checks the enrolled issue, signed phase, exact caller and provider revisions, dispatch identity, run ID and attempt before selecting the one native profile. ORM calls [the released agent workflow](https://github.com/markhuangai/agent-remote-dev/releases/tag/v1.0.0) for the execution.

New issues start automatically. Edits, reopening and closing resume enrolled issues. A maintainer can enroll an existing issue from the default branch using **Run workflow** with `issue-number`. Completed agent runs, allowed comments, owned PR events and the 15-minute schedule wake the controller. All invocations for each issue share one concurrency group. A controller run waiting for an agent, a person or remote checks exits and releases its runner.

Version 2 configuration and signed comments and schema 13 SQLite are required. Earlier formats stop with the existing data intact. Install the version 2 examples for a new consumer. Keep older tasks and data with their compatible pinned workflow and image.

## Run one bounded maintenance task

The production container processes one selected issue with the dedicated container PID namespace and verified GitHub Actions context. The caller supplies the repository and run identity, the Actions artifact runtime token and results URL, and `ORM_SESSION_KEY`. The controller emits a single JSON result to stdout. `waiting/agent_run` means an authorized turn is pending. `waiting/needs_information` and `waiting/remote_checks` mean the controller is waiting for an admitted reply or current-head checks. Waiting exits zero. Blocked and failed runs exit nonzero. `ready/human_review` requires human review and merge.

The authenticated issue comment records phase authorization, budgets, GitHub run identity, publication intent and ownership. Preserve it and the `orm:managed` label. At idle boundaries, ORM encrypts a consistent SQLite backup and the content required to resume controller verification. The comment binds that checkpoint to its run, attempt, artifact ID, digest and expiry. ORM requests 14-day retention. A fresh invocation checks provenance, restores working state, and reconciles any owned publication before new effects. Expired or deleted evidence follows the fresh-verification recovery path within the existing task budget.

The controller charges `limits.agent_runs` once for each authorized dispatch and records elapsed native execution against `limits.active_minutes`. The remaining active time also bounds the native job timeout. Infrastructure and repair retry limits still apply. Human replies and queued Actions time consume neither active execution nor CI-wait time. Automatic upstream continuation is disabled. Clarification uses an independently reviewed question and the reporter's or maintainer's admitted replies as input to a fresh run.

### Diagnose a run

```sh
gh run view RUN_ID --repo OWNER/REPO --log | rg 'agent\.|api\.request\.|configuration_|actions\.failed'
```

For `agent.dispatch_failed`, inspect the HTTP status and correlated request ID. Verify that `orm-agent.yml` is registered on the default branch, the configured controller is allowlisted and the PAT has Actions write access. An ambiguous response is reconciled by the signed operation UUID and expected caller before any new work.

For `agent.checkout_mismatch` or `agent.stale_audit`, compare the expected candidate SHA with the observed checkout or remote work head. Read the referenced native run and its attempt. A moved work branch requires a replacement with a fresh audit and tests before promotion. Logs include issue, phase, harness, run and attempt when available, expected and observed revisions, decision, elapsed time, remaining budget and recovery action. Neither native settings nor credentials belong in diagnostic output.

## Selected issue intake and storage

Enrollment verifies the configured GitHub repository and reads only the selected issue. Monotonic per-issue refresh generations prevent overlapping reads from applying stale state. Owned comment IDs exclude automation output while preserving genuine human replies from the same PAT account. Closure, reopening, scope changes, publication ownership and revision fencing remain authoritative.

Local SQLite uses WAL, full synchronous commits, prepared statements and transactions under a supervisor-owned 0700 directory with 0600 files. Schema 13 initializes fresh databases and reopens existing schema-13 databases. All earlier and unknown versions are rejected without migration or reset. Workers cannot access it. Authenticated task comments remain authoritative over restored local budgets and publication state. Preserve committed WAL state when taking a backup.

## Automatic issue investigation

Each bounded invocation advances its selected issue through one execution slot. Each investigation reads pinned source, proposes citations and optional reproduction commands, obtains audited setup when needed, and executes reproduction under the coding UID in a fresh source workspace. Nonzero reproduction exits are recorded with command, environment, source, revision, and bounded output; they are not confused with setup success. Source citations are resolved from supervisor-controlled Git objects. Source and command receipts establish evidence.

Structured outcomes are `maintenance_candidate`, `needs_information`, `no_fix`, `manual_feature`, and `blocked`. Maintenance requires a concrete objective and supervisor-recorded reproduction or independently reviewed source proof. Source-only findings say **not reproduced**. The exact findings and evidence pass the existing scanner and independent output review before publication. A confirmed publication queues maintenance with `phase: implementation`; the same serialized coordinator automatically consumes that handoff. Features remain manual even when a maintainer accepts the idea. Information requests use reviewed question comments; handoffs and blockers remain visible in the managed status.

The publisher updates one durable instance-owned comment. Fixed stage templates retain the exact previously reviewed summary, its original inspected SHA, and an owned PR reference when available. Changed narrative requires new review. Pending comment writes are reconciled before applying issue activity, so a lost publication response cannot become fresh human input. A genuine comment by the PAT owner is still input. Closed issues cancel work and retain their last comment. Human edits or deletion of the owned comment block publication instead of being overwritten or replaced.

Completed information/no-fix/feature investigations rerun only after issue edits, human comments, or reopening. A default-branch change invalidates active investigations and queued maintenance handoffs. Snapshots and lifetime budgets survive all revisions and restarts. Model/review/evidence failures stay blocked; only classified transient failures receive bounded infrastructure retries. Cancelling an invocation cancels active work while retaining checkpoints. The controller retains PR and issue publication authority.

## Automatic maintenance implementation

Confirmed reproduced and reviewed source-only maintenance candidates enter a durable implementation pipeline. The coordinator freezes the original objective, acceptance criteria, edit paths and discovered local checks before coding. The coding run starts on its assigned work branch at the recorded commit. The implementation role adds a real regression; a fresh independent audit inspects the entire immutable candidate. Features, unrelated/protected edits, weakened checks and mismatched receipts cannot advance.

After a matching audit, the supervisor checks out that candidate and executes Linux-local repository checks under the audit verification UID (10002), separately from coding workers. Receipts identify commands, working directories, environment identity, source/artifact/scope digests, actual exits and bounded output digests. Source integrity is checked around setup and every command. Failed tests or audit findings can return to implementation within the lifetime repair budget (three by default); changed candidates require fresh audit and test evidence. Missing local infrastructure blocks the job. Discovered remote-only checks remain explicitly pending.

The existing scanner and output review gate the exact candidate before normal publication to the recorded instance-owned branch and one non-draft PR. The PR includes the issue-closing reference and audit/test summary. One owned issue comment reports the actual stage and retained investigation evidence. Successful publication enters `remote_review`, releases the execution slot and hands the PR to durable CI/review monitoring. Readiness comments require current-head evidence. No automatic merge occurs.

Checkpoints retain completed audits, tests and publication operation IDs across retries and shutdown. Publication response loss is reconciled before more mutation; unexpected human branch changes and default-branch drift block publication. Closed or revised issues cancel the old candidate. Once an owned PR exists, subsequent issue/PR activity stays in remote waiting rather than creating another first-publication pipeline. Operator-mounted implement and audit skills guide model behavior; repository text cannot expand the frozen scope.

## PR feedback and current-head readiness

After first publication, the supervisor monitors only PRs recorded as owned by this instance. The reusable workflow routes owned-PR activity and scheduled reconciliation to the selected issue; the runtime reads current state. Full REST/GraphQL pagination includes conversation comments, reviews, review threads, every nested reply, reactions, check attempts and statuses. Waiting releases the coding slot. A separate lifetime 24-hour wait budget includes downtime; restarts, new commits and policy edits do not reset it. Active/model limits, the three-repair ceiling and two infrastructure retries remain shared with the original job.

`pr_monitor` defaults to `enabled: true`, `requirements_source: github`, empty `required_checks` and `automated_reviewers`, and `local_checks_only: false`. The monitor reads legacy branch protection and applicable rulesets and combines discovered required checks with operator additions. Required source/integration identities are retained. Unknown/inaccessible requirements block readiness. To attest a complete checklist when discovery is unavailable or includes an unsupported automation rule, explicitly select `requirements_source: operator` and supply `required_checks`. Known discovered checks remain mandatory. An empty result set is never success; explicit local-checks-only policy is accepted only when no GitHub CI requirement or unknown requirement exists. The example lists this repository's additional CI/security/review gates. `{pr}` in a configured name expands to the owned PR number.

`automated_reviewers` entries contain `login` and `signal: github_review|codex|coderabbit`. Generic reviews must name the current SHA. Codex and CodeRabbit support their bounded no-findings signals only from the verified bot identities during the current head's review cycle. A newer in-progress indicator, absent completion, unavailable reviewer, quota/rate limit, failed, cancelled, neutral, skipped or pending required check blocks readiness. A CodeRabbit rate-limit notice is not a completed review in this runtime. Human approval remains a separate merge gate and is never granted by the monitor. The runtime does not trigger/retry remote workflows or update the base branch automatically.

The implementation role assesses each actionable surface against the frozen scope and actual candidate. Candidate-file citations and controller audit/test receipts support dispositions; thread resolution and outdated anchors alone establish no fix. Assessment cannot change source. Valid corrections return to the existing implementation/audit/unprivileged-test/scanner/output-review pipeline, then advance the owned branch normally. Feedback replies and supported resolutions use the durable publication journal. Interrupted effects are observed by exact IDs/markers before any further mutation. Unknown scope, human branch changes, insufficient CI evidence, exhausted budgets and timeouts remain visible operator handoffs.

When every current-head gate and finding disposition is complete, the existing owned issue comment says **Automation clean; awaiting human review**. A deduplicated readiness comment identifies the head. Check/review activity or changed policy invalidates the evidence; each publication revalidates GitHub. A readiness comment is not permission to merge and does not prove the branch is current with then-current main; the maintainer must validate the merge candidate and required human review.

## Execution and verification

Agent turns run in `agent-remote-dev@v1.0.0`. The controller supplies pinned phase instructions and a starting Git revision. It limits inline instructions to the provider's 65,535-byte plan contract and uses a digested Actions artifact for larger input. It validates the native result and completed checkpoint manifest against the authorized run. The supplied audit request binds the frozen scope, source and exact candidate commit.

Coding and repair push coherent progress commits to a dedicated `orm-work/<task>/<id>` branch. ORM can start a replacement agent at the last verified push and restore a compatible native conversation. Native session artifacts hold the conversation and its Git and run metadata. Work left on a runner may need to be recreated.

The agent publishes one candidate commit on a separate work branch. Its tree matches the final progress push, and its sole parent is the frozen source for a first change or the last verified PR head for an update. A fresh audit and the controller's required local checks bind the exact candidate SHA before it advances the PR.

The ORM issue comment links to the latest attempt and the saved conversation. It shows when another maintenance event can retry and what to inspect if verification stops. Keep the owned work refs and Actions artifacts while recovery is pending. ORM can use verified Git progress after a native session expires. The encrypted controller checkpoint preserves task state and spent budgets.

Controller workspace and toolchain commands use separate unprivileged users and clean environments. UID-wide process cleanup and bounded disk, process and output checks apply to those commands. Disk usage is a monitored soft limit. Native jobs follow the upstream execution policy and use the consumer's Actions artifact access and retention settings.

## Audited repository bootstrap

`Supervisor.bootstrap.prepare(request, signal)` prepares the pinned source and returns a durable setup receipt. Internal callers attach its ID as `bootstrap_receipt` to later agent requests. Investigation and maintenance call this capability when their commands require project tools. A setup failure blocks the selected task and is reported in its bounded result.

The configured bootstrap harness inspects source and proposes a strict structured plan. A fresh audit run independently approves the exact source and plan digests before installation. Plans contain exact Go/Node/Python versions, signed distro package names, exact package-manager versions, unprivileged setup commands, and proposed local/remote test commands. Bootstrap verifies tools and setup; investigation owns project test execution. Windows requirements remain recorded remote checks.

Mise v2026.10.9 is pinned by architecture-specific checksums. Its built-in installers run in private supervisor configuration with safe mode, hooks/plugins/default packages disabled, and download verification enabled. Node signature/checksum checks and Python artifact attestations are required; unsupported precompiled versions fail without source-build fallback. APT accepts package names through fixed commands, trusted image sources, and no-removal policy. Distro and toolchain vendors remain trusted privileged-code suppliers.

Public Go modules, npm, pnpm, Yarn Classic/current Yarn, pip/venv, Poetry, and uv are supported. Package managers install as workers in private run directories. Standard sources are the public Go proxy/checksum service, npm/Yarn registries, and PyPI. Existing usable locks or complete pinned requirements are required when dependencies are needed; missing/stale locks, credentials, custom registries, unavailable versions, and failed setup block explicitly. npm's `private: true` publishing flag does not by itself indicate private dependencies.

Shared toolchains are supervisor-owned and read-only. Each coding/audit run receives independent writable dependency environments and caches. Setup cannot change manifest or lockfile fingerprints. Generated dependency state is excluded from artifacts and rebuilt on fresh/resumed runs; existing source is preserved. The supervisor retains the fixed runtime while project commands use verified tool paths.

Receipts bind job/revision, pinned source/artifact, prompt snapshot, plan/audit, manifest/lock fingerprints, platform, package inventory, installer/tool integrity, exact versions, and actual command results. Changed identities invalidate reuse and resume. Installation intent precedes mutation; interruptions remain recorded and partial/unverified installations block reuse. Inspect damaged package or tool state before retrying; do not remove shared packages or caches automatically. Disable consumer dispatch and cancel any active invocation before operator recovery; verify worker cleanup and preserve the last acknowledged checkpoint.

## Reviewed GitHub publication

`Supervisor.publication.publish(proposal, signal)` is a callable supervisor capability. It accepts status text, structured investigation findings, fixed investigation/PR-stage updates, reviewed feedback replies and resolutions, a fixed operational-notice reason, or a change proposal with a frozen artifact, expected bot head, and supervisor-recorded audit/test evidence IDs. `recordEvidence(evidence, signal)` scans and stores immutable evidence bound to the job/revision, source and artifact. The maintenance pipeline supplies independent audit and actual supervisor-executed test evidence; worker claims alone are not receipts. Investigation, implementation and PR monitoring invoke this publication gate; there is no HTTP mutation endpoint.

`publication.outputReview.review(request, signal)` and `verify(receiptId, request)` provide the reusable external-output gate. The request binds destination identity, exact payload, evidence, artifact, policy and job snapshot. Structured strings and keys receive known-secret and pinned Gitleaks 8.30.1 checks. Scanner rules and ignores come from isolated supervisor storage; repository suppressions and inline allow comments have no authority. Scan/review errors block publication with safe codes. Unknown secrets can still evade heuristic detection.

Decoded YAML scalar scanning includes duplicate keys, plain and quoted folding, and block scalars. YAML artifacts must parse completely. Scanner inputs are limited to 1 MiB per text field and 32 MiB in aggregate, with bounded document depth and node counts; incomplete coverage blocks publication.

Generated payloads receive a fresh read-only output review. The controller validates the exact payload binding and rejects changed destinations or bytes. Fixed operational notices use checked templates.

The publisher preserves one owned status comment and one owned open PR per issue. It validates scoped changes and requires audit and deterministic test evidence for the exact Git tree. After verifying the work branch still points to that commit, ORM advances its separate PR branch by fast-forward and opens or updates the owned PR. Changed binaries, protected paths and unsupported Git object types block publication.

Publication intent precedes each transmission. Exact markers, IDs, bytes and remote heads reconcile confirmed effects, including after restart or a changed job revision. `publication.reconcile(operationId, signal)` observes an interrupted operation without transmitting another write. An absent object after an ambiguous create remains uncertain; another create is blocked until inspection. Confirmed operation replay returns its stored receipt. Intake-observed heads never replace the last confirmed publisher head.

Publication and reconciliation serialize per issue. Provider backoff persists across restarts, and subsequent safe observation retries consume the job's infrastructure retry budget. Legacy ownership without confirmed target state blocks new objects. Reviewed PR title/body changes may reuse the confirmed branch head without creating a commit.

Preserve authenticated task state, artifacts and publication receipts when changing the pinned runtime. Human review and merge remain required.

## Releases and version references

Successful Repository CI and CodeQL main-push runs automatically start the prerelease workflow. It requires both latest-attempt validations for the exact same source SHA, same-repository provenance, and the current main revision. PR checks, cancelled or failed validation, and superseded sources do not publish candidates. CI keeps its existing cancellation policy; rapid merges can supersede intermediate revisions. The workflow runs its own publication jobs directly, so it does not depend on events generated by `GITHUB_TOKEN`.

The first candidate is `v1.0.0-rc.1`. Further validated revisions increment `rc.N` until stable promotion; after `v1.0.0`, the next candidate becomes `v1.0.1-rc.1`. `package.json` supplies the minimum intended release base. Bump its stable version and the lockfile root version together in a normal PR to start a minor or major line, such as `1.1.0` or `2.0.0`. Ordinary patch progression does not create version-bump commits or require a package edit.

Each candidate reserves only an immutable Git tag before building on native `ubuntu-24.04` and `ubuntu-24.04-arm` runners. Both digest-addressed images must pass bounded default-entrypoint startup, source/platform identity, Node/SQLite execution, and bundled native-tool smoke checks. Only then can it publish and verify the combined image, create a published prerelease (`draft: false`, `prerelease: true`), attach and read back `publication.json`, and update the major prerelease aliases. New candidates never create draft releases. New image proofs bind the source, release version and native digests before a GitHub release ID exists; old proofs and receipts remain supported for verification and stable promotion.

| Channel   | Exact Git tag | Moving Git tag  | GHCR tags                                             |
| --------- | ------------- | --------------- | ----------------------------------------------------- |
| Candidate | `v1.0.0-rc.N` | `v1-prerelease` | `1.0.0-rc.N`, `1-prerelease`, `sha-<full-source-sha>` |
| Stable    | `v1.0.0`      | `v1`            | `1.0.0`, `1`, `latest`                                |

Future majors follow the same pattern: `v2-prerelease` and `v2`, with `2-prerelease` and `2` image tags. Numbered Git and image references cannot be replaced by retries. Moving Git aliases are annotated tags naming their exact release. Stable and prerelease aliases are separate; publishing a candidate never changes stable aliases or `latest`.

To publish stable, dispatch **Promote stable release** from `main` and provide the latest published, verified RC for the active base:

```sh
gh workflow run promote-release.yml --ref main -f source_rc=v1.0.0-rc.3
```

A package-version bump on current `main` starts the intended line immediately, so older RCs cannot be newly promoted while the new line is awaiting validation or building. Retries of an already completed matching stable publication may repair its aliases while it remains the latest stable release for its major; repairing an older major never changes global `latest`.

The workflow derives `v1.0.0`, verifies source ancestry, exact-source main CI, the candidate tag, durable receipt, image digest and both native manifests, and copies that existing multi-architecture index. It does not rebuild. Candidate and stable digests must match exactly; OCI version labels retain the original RC version. The prerelease remains available. A conflicting existing stable tag, source, image or receipt blocks publication.

Consumers can call `markhuangai/opensource-repo-manager/.github/workflows/maintenance.yml@v1` for the latest published stable `1.x.x` release or `@v1-prerelease` for the latest published `1.x.x-rc.n` prerelease; the same references work for `test-ai.yml`. There is no root action. Both reusable workflows accept an optional `runtime-image` override. When omitted or empty, a runtime job inside the called workflow runs once per invocation and selects `ghcr.io/markhuangai/opensource-repo-manager:sha-<workflow-commit>` using GitHub.com's called-job workflow identity, rather than the consumer's commit or a separate moving alias. It verifies the source-bound version-2 publication proof and both smoke-tested native manifests, then passes one immutable `@sha256:` reference to routing and every maintenance job, or to the AI test. The runtime job receives no configuration secrets and needs no additional caller permissions.

Exact release tags and full workflow commit pins use the same source-bound selection. An unreleased commit may have no image; wait for its successful main validation and automatic prerelease, or provide a known-compatible immutable `runtime-image` from a verified release's `publication.json`. Explicit overrides keep the existing digest validation, support other image repositories, and bypass automatic lookup and job-identity requirements. Missing identity, unavailable images, invalid proof, and architecture mismatches fail before configuration secrets reach a runtime container. The resolver never substitutes another release.

Image-selection logs use normal Actions visibility. `runtime.resolved` records the selected digest, source and release version; `runtime.used` connects each consuming job to that digest. `runtime.failed` identifies the stage, expected/observed proof, provider status and error, elapsed time, and recovery action. Registry inspection has a 60-second deadline and no automatic retry. Public manifest captures are limited to 64 KiB and provider-error captures to 16 KiB, with omissions reported explicitly; an oversized manifest fails selection. Configuration and credentials are excluded, and log retention follows the existing Actions policy. Collect one invocation with `gh run view RUN_ID --repo CALLER_REPO --log | rg 'runtime\.|::error::'`. For registry failures, verify GHCR connectivity and publication for the logged workflow commit; for proof failures, inspect the logged public manifest and select or repair the matching workflow/image pair.

Candidate and promotion runs serialize independently. Their reservation/finalization steps share a release-state concurrency lock, so they cannot simultaneously change release authority. Older pending candidate runs may coalesce. The shared lock protects GitHub and registry mutations; main can still advance during a build, in which case publication fails with a superseded-source diagnostic and the new validated main revision supplies the next candidate.

After an interruption, inspect the failed stage before rerunning the same Actions run. Completed candidates can repair their major aliases after main advances; replaying an older RC never replaces a newer candidate within that major. Matching completed versions and durable receipts are reused; an index already published before receipt upload is verified and recovered without replacement. One-day architecture artifacts may expire, so an unfinished build can require rebuilding untagged native digests. Legacy draft and orphaned tag reservations are retained as evidence, and newer sources allocate a later RC. Release creation and receipt upload are separate GitHub operations: an interrupted upload can leave a published prerelease with its verified image digest in the body but no receipt asset yet. Rerunning recovers the same image and release; moving aliases stay unchanged until receipt readback passes. Never delete or move numbered tags to bypass a conflict. Failed native builds can leave untagged digests, as before; release tags are published only after both native smoke tests pass.

Release logs use normal Actions visibility and structured `release.*` events. They include repository, run/attempt, stage, source/version, CI decisions and run URLs, platform/digest evidence, durations, outcomes and causal errors. Collect one operation with:

```sh
gh run view RUN_ID --repo markhuangai/opensource-repo-manager --log | rg 'release\.|::warning::|::error::'
```

The last completed stage and error's recovery field identify whether to wait for current-main validation, repair the native build, correct access/provider failure, or inspect a conflicting tag/receipt. Debug logging is optional; required evidence is emitted without enabling it. Logs use the repository's existing Actions retention. Release assets retain durable publication receipts beyond the one-day architecture artifacts; credentials, environments and authentication headers are excluded.

GHCR package visibility remains an operator setting. Ensure the package is public and verify anonymous pulls for both supported platforms before announcing anonymous availability. This PR delivers automation; it does not dispatch a release, change package settings, deploy consumers, or merge itself. A human merge activates automatic prereleases for subsequent successful main validation, including that merge when eligible.

## Test consumer AI configuration

Copy [test-ai.yml](examples/actions/test-ai.yml) into the consumer's `.github/workflows/` and use the same ORM release reference as the maintenance and dispatch callers. Run **Test AI configuration** from the default branch after installation and choose a configured role. The same preflight selects its profile and calls the released harness with a fixed read-only prompt. The probe checks the provider's result artifact for the expected response. It creates native Actions artifacts under the consumer's retention policy and consumes no issue budget.

## Development and validation

Use Node 24.18.0 and npm 12.0.2:

```sh
npm ci
npm run check
```

Build with npm run build. npm start -- <issue-number> targets the production Actions entrypoint and requires the dedicated container and verified Actions context. For local verification, use the container harness rather than supplying production credentials.

`npm run check` checks formatting, lint, types, tests, and the production build. `npm run test:container -- --platform linux/amd64` builds and exercises the real default entrypoint, bounded outcomes, users, permissions, mounts, persistence, credential exclusion and cleanup. Use `linux/arm64` on an ARM64 host. Container tests require Docker with Buildx and a local Unix-socket daemon. They create an isolated Docker client configuration for public pulls and remove only their labeled test resources, preserving host credentials, other builders, and shared caches.

PR CI runs automatically on native AMD64 and ARM64 runners. It includes controller startup and workspace isolation, investigation, bootstrap, implementation, monitored repair, and bounded Actions scenarios. The Actions fixtures exercise the production controller and the released agent contract with controlled transports and real Git commits. Both harness selections, cancellation, duplicate authorization, missing pushes, moved heads, encrypted controller recovery and current-head readiness are covered.

Bootstrap runs in three fresh containers with separate 40-minute deadlines. `bootstrap-node` retains Claude/Codex npm, Codex pnpm/Yarn and both SDK audit-rejection checks. `bootstrap-python` retains pip, Poetry and uv followed by the complete negative/recovery sequence, preserving its final Python receipt for cache and restart checks. `bootstrap-go` retains Go/CGO followed by mixed Go/Node. Each group verifies exact SDK/case outcomes and reports its own timings, source/image identity and cleanup. `--suite bootstrap` runs all three groups sequentially; use `--suite bootstrap-go` to diagnose Go independently. Separate groups add cold setup work but prevent preceding languages from consuming Go's deadline.

The full local command runs those same suites sequentially. To diagnose one suite, use `npm run test:container -- --platform linux/amd64 --suite implementation-monitor-state`. An unknown selection fails before creating resources. Each successful suite emits a JSON receipt containing its selection, scenario coverage, phase and SDK timings, tested commit, dirty-worktree flag, PR head when applicable, image ID, source/test input digest, and owned-resource cleanup. CI tests GitHub's PR merge commit; that tested commit is distinct from the PR head. A dirty local receipt identifies uncommitted work and is not proof of a published head. CI step summaries show phase timings, and architecture aggregates report job execution and runner queue time separately, with attempt attribution. Invalid timestamps are reported as unavailable rather than negative latency. SDK/lane timings overlap and must not be summed as wall time.

Actions lanes vary the coding harness and use the opposite harness for audit. A pool of at most four lanes shares the built image while each lane gets separate containers, networks, volumes and fixture state. Use `--suite actions --actions-concurrency 1` to run them serially. See [CI performance evidence](docs/ci-performance.md) for historical baseline runs.

The CI target is at most 30 minutes from validation trigger until the last required current-head CI result, including scheduling, queueing, setup, execution, scans, aggregation, and retries. It requires three representative fresh-head measurements with complete native coverage; timeouts are safety bounds, not proof of meeting the target. Preserve attempt attribution and reject inconsistent timestamps when reporting queue or execution time. Report configured automated-review latency and outcomes alongside CI; pending or unavailable required reviewers remain blocking. Human review and merge are outside the timing target. The performance evidence document records measured results and any external constraint; implementation alone does not establish success.

Before sharding, successful PR run [40071446726](https://github.com/markhuangai/opensource-repo-manager/actions/runs/40071446726) took 105m 55s on AMD64 and 90m 10s on ARM64; Repository CI elapsed was 107m 34s. Successful main run [40085201361](https://github.com/markhuangai/opensource-repo-manager/actions/runs/40085201361) took 108m 10s and 90m 2s, respectively. The AMD64 implementation phase consumed 62m 52s and 64m 17s, while image build and initial setup took about one minute. The PR head's push-to-CI completion was 110m 17s, and the last required Codex completion signal appeared after 170m 25s. GitHub does not expose that provider's queue/execution breakdown. Final-head measurements and any remaining external constraints belong in the delivery's PR timing report; these baseline figures do not claim a measured improvement.

Validate workflow syntax with actionlint 1.7.12 and prove bounded default startup through container tests. Services own decisions, repositories own persistence, and adapters own external I/O; GitHub reads and SQLite repositories are injected into the intake service at those boundaries.

If the Docker CLI runs in a development container whose `/tmp` differs from the daemon's filesystem, set `TMPDIR` to a writable directory shared with the daemon, for example `TMPDIR="$PWD/node_modules" npm run test:container -- --platform linux/amd64` when the workspace is shared. All read-only harness inputs are staged under the owned temporary directory, so the source worktree itself need not be shared. Transport fixtures run inside test containers and do not require a shared localhost network namespace.

## AI pull request review

Trusted maintainer PRs start review through `pull_request_target`; other-author and fork PRs use successful PR CodeQL completion. CI, CodeQL, and the direct review route subscribe to `opened`, `synchronize`, `reopened`, `ready_for_review`, and `edited`. Retargeting an unchanged PR to `main` registers validation; title/body edits also rerun CI. Existing current-head review statuses suppress duplicate reviews. Trigger changes in the trusted review workflow take effect after human merge. A manual dispatch accepts an open PR number. The initial workflow bootstrap had a one-time activation exception; later PRs require their own successful review status. Ordinary CI remains automatic, with no review-first request controller.

The AI reviewer follows `v1-prerelease` and uses Claude, a variable-configurable model defaulting to `auto`, effort `xhigh`, six isolated goals, 200 turns per goal, a 50-minute review limit, and no automatic approval. Its goals cover design, security, reliability, public contracts, scope/operations, and test assurance. It first reinspects claimed fixes, then independently sweeps the full change. It runs separately from builds with a pristine checkout and read-only tools. Per-PR concurrency, duplicate suppression, and exact-head status fencing prevent stale success. Incomplete reviews publish a blocking error status; a successful workflow job alone does not prove review completion.

The workflow resolves its endpoint once with `${{ vars.AI_ENDPOINT || secrets.AI_ENDPOINT }}` and its model with `${{ vars.AI_REVIEW_MODEL || 'auto' }}`. Validation and the action use those same resolved settings. Operators can change these native Actions expressions to reference custom variable/secret names or use a committed value. This reviewer does not use the maintenance configuration resolver. Authentication remains in `LOCAL_AI_SECRET` and `PR_REVIEW_PAT`, plus `PROJECT_MEMORY_MCP_ENDPOINT` and this repository's `PROJECT_MEMORY_MCP_TOKEN`. Before live activation, supply the missing project token through GitHub Secrets and verify the PAT covers this repository. Interactive review needs Contents and Pull requests read/write, Commit statuses write, and Issues read for linked-issue context. Use a project-scoped read-only memory credential; only `recall_memory` is granted. Do not reuse another project's token. Missing configuration fails visibly. Secrets and repository settings are managed by the maintainer, not this delivery.

## Security boundaries

Run the native agent jobs on disposable runners. The upstream Codex and Claude processes have full access within their runner job. Treat code, instructions and native configuration accessible to that job accordingly. The native session, checkpoint and result artifacts can contain source and conversation data. Review who can download them under the consumer's Actions permissions and retention policy before installation.

The controller keeps its publication and signing credentials separate from those jobs. Coding receives the branch-restricted credential and other phases receive the read credential. Work-branch pushes are visible immediately. Maintain GitHub rules for the controller and work-branch namespaces. Human review and merge remain required.

Controller toolchain commands run without service credentials. Standard Docker still shares the host kernel and allows direct egress. Root toolchain installation trusts the configured distribution, mise and upstream tool vendors.

## License

[Apache-2.0](LICENSE).
