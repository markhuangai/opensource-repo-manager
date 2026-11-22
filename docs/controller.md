# Maintenance controller

The production image processes one selected issue in a dedicated container PID namespace. The caller supplies the verified Actions run identity, artifact runtime token and results URL, and session key. Services decide how to advance the task, repositories persist state, and adapters handle GitHub and other external I/O. [Entrypoint](../src/actions/main.ts) · [Runtime composition](../src/runtime/application.ts)

## Intake and recovery

Enrollment verifies the repository and reads the selected issue. A per-issue generation prevents old refresh results from overwriting newer ones. The controller identifies its own comments by ID so a human comment from the same PAT account can still supply input. Closing an issue cancels its work. Scope changes and default-branch changes invalidate affected investigations and candidates.

A signed issue comment records phase authorization, budgets, dispatch identity, and publication ownership. At idle boundaries the controller encrypts its SQLite backup and verification inputs in an Actions artifact with 14-day retention. The comment binds the checkpoint to its run, attempt, artifact ID, digest, and expiry. On resume, the controller checks provenance and reconciles publication before making new changes. Expired or deleted evidence requires fresh verification within the remaining budget.

SQLite uses WAL, full synchronous commits, prepared statements, and transactions under a supervisor-owned `0700` directory with `0600` files. Schema 13 opens fresh and schema-13 databases. Other versions fail without migration or reset. Preserve committed WAL state in backups. When restoring, the authenticated issue comment governs budgets and publication state. [Task state](../src/actions/state.ts) · [Checkpoints](../src/actions/artifacts.ts) · [Store](../src/repositories/store.ts)

Each run writes a JSON outcome to stdout. Waiting for an agent (`waiting/agent_run`), an answer (`waiting/needs_information`), or CI (`waiting/remote_checks`) exits zero. Blocked and failed runs exit nonzero. `ready/human_review` hands the PR to a maintainer. [Task outcomes](../src/actions/task.ts)

## Investigation and clarification

The investigation agent reads pinned source and proposes citations or reproduction commands. The supervisor resolves citations from Git objects and runs reproduction commands in a fresh workspace under the coding UID. It records the command, working directory, source revision, exit status, and bounded output. A nonzero reproduction exit can be evidence of a bug.

The possible investigation outcomes are `maintenance_candidate`, `needs_information`, `no_fix`, `manual_feature`, and `blocked`. A maintenance candidate requires a concrete objective and either recorded reproduction or independently reviewed source evidence. Source-only findings are identified as **not reproduced**. The scanner and independent output review check the findings before publication. A confirmed candidate advances to implementation.

Clarification uses a reviewed question and eligible replies from the reporter or a maintainer. The accepted answers become input to a fresh agent run. Completed information requests, no-fix findings, and feature handoffs can be revisited after issue edits, human comments, or reopening. Classified infrastructure failures have bounded retries. [Investigation](../src/services/investigation/index.ts) · [Clarification](../src/services/clarification.ts)

## Agent execution and repository setup

The controller pins the phase instructions and starting commit and invokes `agent-remote-dev@v1.0.0`. Its preflight checks the signed turn, caller and provider revisions, dispatch identity, run ID, and attempt before selecting the native profile. Plans over the provider's 65,535-byte inline limit travel in a digest-verified Actions artifact. The controller validates the result and completed checkpoint manifest against the authorized run. [Agent authorization](../src/actions/authorize-agent.ts) · [Native execution](../src/runtime/remote-agents.ts)

When project commands need tools, `Supervisor.bootstrap.prepare(request, signal)` returns a setup receipt. The bootstrap agent proposes exact tool and package-manager versions, distro packages, setup commands, and local and remote tests. A fresh audit approves the source and plan digests before installation. The supervisor owns shared, read-only toolchains. Each run gets private writable dependencies and caches. Setup must preserve source manifests and lockfiles.

The image pins mise v2026.10.9 by architecture and configures its built-in installers with download verification, safe mode, and hooks and plugins disabled. Node requires signature and checksum checks. Python requires artifact attestations for supported precompiled versions. APT uses trusted image sources and fixed commands with a no-removal policy. Root tool installation trusts those distributors and upstream vendors. Worker commands run without service credentials on separate coding and verification UIDs. UID-wide cleanup is verified before reuse. Disk limits are monitored soft limits.

Setup receipts bind source, prompts, plan and audit, platform, lockfile and installer fingerprints, versions, and command results. Changed identities invalidate reuse. Interrupted installs are recorded and partial installations block reuse. Before manual recovery, disable consumer dispatch, cancel active invocations, verify worker cleanup, and preserve the acknowledged checkpoint. Inspect damaged package or tool state before touching shared installations or caches. [Bootstrap](../src/services/bootstrap/index.ts) · [Toolchains](../src/adapters/toolchains/index.ts)

## Implementation and publication

Implementation freezes the objective, acceptance criteria, editable paths, and discovered local checks. Coding pushes one commit to the assigned `orm-work/<task>/<turn>` branch with a regression test. Its parent is the frozen source for the first fix or the last verified PR head for an update. Repairs can carry corrections from a rejected tree into a new candidate on that parent.

A fresh audit inspects the entire candidate commit. After that audit passes, the supervisor checks out the same SHA and runs repository checks under the unprivileged verification UID (10002). Receipts record commands, working directories, environment and source identity, exit codes, and output digests. Source integrity is checked around setup and every command. Audit or test failures can return to coding within the lifetime repair budget. Each changed candidate needs a new audit and tests. [Implementation](../src/services/implementation/index.ts) · [Verification](../src/services/implementation/verify.ts)

Investigation, implementation, and PR monitoring send their findings, status updates, replies, and change proposals to `Supervisor.publication.publish(proposal, signal)`. Its `recordEvidence` operation binds immutable evidence to the job, revision, source, and artifact. The output reviewer checks the exact proposed payload, destination, evidence, and job snapshot. Structured strings and keys receive known-secret and pinned Gitleaks 8.30.1 checks using supervisor-controlled rules. The scanner decodes YAML scalars, including folded values and duplicate keys. YAML artifacts must parse completely. The limits are 1 MiB per text field and 32 MiB in aggregate, with bounded depth and node counts. Incomplete scans block publication. Heuristic scanning can miss unknown secrets.

After reviewing the payload and checking the work branch still points to the verified SHA, the controller fast-forwards its separate `orm/**` PR branch and opens or updates one non-draft PR for the issue. The PR includes the issue-closing reference and audit and test summary. Protected paths, changed binaries, unsupported Git object types, or unexpected branch changes block publication.

Each write records its intent first. After an interruption, `publication.reconcile(operationId, signal)` uses exact markers, IDs, bytes, and remote heads to identify the result. An ambiguous create blocks another create until the controller can establish what happened. Confirmed replays return the stored receipt. Provider backoff persists across restarts. The controller preserves the reviewed issue summary and its inspected SHA across stage updates. Human edits to or deletion of an owned status comment block further publication. [Publisher](../src/services/publication/index.ts) · [Output review](../src/services/publication/review.ts) · [Scanner](../src/services/publication/scanner.ts)

## PR feedback and readiness

The monitor follows only PRs recorded as owned by this instance. It pages through comments, reviews, threads and replies, reactions, check attempts, and statuses. It combines GitHub requirements with configured checks and reviewer signals. Human waiting releases the runner. CI wait, repair, and infrastructure budgets survive restarts and new commits.

Feedback is assessed against the frozen scope and candidate. Dispositions require candidate citations or recorded audit and test evidence. Resolving a thread or marking it outdated is insufficient. Valid corrections return through implementation, independent audit, local tests, scanning, and output review before the next fast-forward. The publication journal also records replies and supported thread resolutions.

Before publishing readiness the controller revalidates GitHub for the current PR head. A new head or changed policy requires fresh evidence. The issue status and a deduplicated readiness comment identify the handoff. The maintainer verifies the merge candidate, completes human review, and merges. [Readiness policy](../src/services/pr-monitor/policy.ts) · [Monitor](../src/services/pr-monitor/index.ts)
