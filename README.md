# opensource-repo-manager

A self-hosted GitHub maintenance service for repositories whose maintainers cannot watch every issue. The planned service investigates issues, prepares tested maintenance fixes, follows pull request feedback, and notifies the maintainer when a change is ready for human review.

**Status: protected configuration, durable GitHub intake, and worker runtime implemented; maintenance automation planned.** The service verifies one public/private GitHub repository, backfills open issues, receives signed webhooks, and persists deduplicated pending workflows in SQLite. The runtime provides unprivileged workers, source workspaces, a scoped model relay, and immutable artifacts. Vendor SDK adapters, issue investigation, fixes, GitHub publication, and application MCP transport remain planned. No GHCR image has been published by this change.

## Run the service

Use Node 24.18.0 and npm 12.0.2:

```sh
npm ci
npm run check
```

`npm run dev` runs the source with Node's watch mode; `npm start` runs the production build. Both require valid protected configuration and bundles before opening HTTP. The fixed paths are `/config/config.yml`, `/prompts`, and `/skills`; use the container setup below to provide them. The service listens on port 8080. `GET /healthz` returns HTTP 200 with `{"status":"ok"}`. `GET /readyz` returns HTTP 503 with `status: not_ready`, `reason: automation_not_implemented`, and safe intake state and queue counts. Docker uses liveness for its healthcheck; a healthy container does not mean maintenance automation is ready.

For Compose, install the sample bundles and protected configuration, then replace the placeholder repository, credentials, proxy endpoint, model IDs, and notification settings:

```sh
mkdir -p operator/skills operator/prompts
cp -R examples/workflow/skills/. operator/skills/
cp -R examples/workflow/prompts/. operator/prompts/
sudo install -d -o root -g root -m 0700 operator/config
sudo install -o root -g root -m 0600 config.example.yml operator/config/config.yml
sudoedit operator/config/config.yml
docker compose up --build
```

Compose exposes port 8080 on localhost, persists `/data`, and mounts configuration, skills, and prompts read-only. The root supervisor validates and snapshots those files, recovers interrupted worker leases, and starts a loopback model relay before starting HTTP. Its fixed `/opt/orm-runtime/bin/node` executable stays separate from future repository toolchains. The image includes Git, certificates, C build tools, process supervision, and distinct `coding`, `audit`, and `output-review` users.

## Protected configuration and workflow bundles

`config.example.yml` is the version 1 contract. Unknown fields and unsupported versions fail; there is no environment-variable interpolation, credential fallback, include processing, or automatic migration. Use a fine-grained GitHub PAT for the single `owner/repository`, a webhook secret, and a mandatory CPA-compatible HTTP(S) URL/key. Configuration validation is offline. After HTTP starts, enrollment verifies GitHub access and reads repository metadata; model availability, notification delivery, and MCP connections remain planned.

The configuration must be a root-owned regular file with owner-read permission and no group/other permissions. Its immediate directory must be root-owned without group/other write permission. Symlinks are rejected, including parent components. Keep the deployment mount read-only; `0400` or `0600` files in a `0700` directory are recommended. Worker users cannot read the configuration. An empty file or the old `{}` scaffold fixture is no longer valid.

The application runs only as a service. It accepts no commands or arguments and has no `orm` executable, offline validation command, or pause/resume feature. Startup validates protected configuration and all selected bundles before opening HTTP. Rejection exits with code 1. Diagnostics report fixed codes and safe section/line locations, excluding source lines, arbitrary input names, credentials, and filesystem paths.

Each named profile requires `sdk`, `model`, and `effort`. Every phase selects a profile independently: `bootstrap`, `investigation`, `implementation`, `audit`, and `output_review`. Claude accepts `low`, `medium`, `high`, `xhigh`, and `max`; Codex accepts `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`. These are SDK-level values; a model may support a subset. The future adapters must validate model compatibility without silently changing the selected model or effort. See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [Claude effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).

`roles.<role>.prompts.system` and `.user` name UTF-8 files relative to `/prompts`. `roles.<role>.skills` lists directories relative to `/skills`, each with a `SKILL.md`. The loader copies all regular files below each selected skill directory, including contained reference files and binary assets. It never follows Markdown links or executes a bundle file while loading. Absolute paths, `..`, symlinks, missing files, writable-by-group/other bundle content, and known credentials in content or metadata are rejected. Files are limited to 1 MiB each, with a 16 MiB aggregate loading limit across roles; configuration YAML is limited to 1 MiB and bounded alias expansion.

The loader exposes a deeply frozen, JSON-safe `RunSnapshot` with a digest, role profiles, prompt text, and skill bytes encoded as base64 with per-file digests. `snapshot.settings` is supervisor metadata and includes non-secret upstream configuration; pass only `snapshot.roles[role]` to a future worker. Role projections exclude upstream endpoints, credentials, notification destinations, and authentication headers. The separate root-only `SecretAccessor` supplies credentials and known-secret checks; it is not part of the snapshot. Known-secret checks detect configured values, not arbitrary unknown secrets.

Configuration and bundle content load once at startup. Restart to load edits; previously captured snapshots remain self-contained and unchanged. Each issue workflow keeps its original persisted snapshot even after restart or later activity; newly discovered workflows capture the current snapshot. Sample skills are authoring examples, not implemented maintenance workflows.

At least one notification channel must be enabled in every valid configuration. Supported shapes under `notifications` are `discord: { enabled: true, webhook_url }`, `smtp: { enabled: true, host, port, secure, username, password, from, to }`, and `webhook: { enabled: true, url, headers }`. Disabled channels contain only `enabled: false`. Notification connections and delivery remain planned.

`limits` uses `active_slots: 1`, `active_minutes: 60`, `model_requests: 200`, `repair_cycles: 3`, `infrastructure_retries: 2`, `wait_hours: 24`, and `reconciliation_minutes: 5` by default. Worker defaults are `worker_processes: 128`, `worker_output_bytes: 16777216` (16 MiB aggregate protocol/stdout/stderr), and `worker_storage_bytes: 4294967296` (4 GiB monitored workspace/home/temp usage). The slot count is fixed at one; other budgets are configurable positive integers, with zero permitted for repairs/retries. The runtime enforces active time, model requests and worker limits. Autonomous phase controllers remain planned; backfilled jobs stay pending and exhausted budgets do not reset on restart.

### Optional HTTP MCP configuration

Omitting `mcp`, or leaving its registries empty, preserves the GitHub-only contract. The schema supports fixed Streamable HTTP endpoints with optional protected static headers. Proxy and MCP endpoint URLs cannot contain query strings; keep authentication in the protected key/header fields. HTTPS is required unless a server explicitly sets `allow_plain_http: true`. Credentials in URL userinfo, stdio commands, OAuth settings, unsupported effects, and inferred annotation-based authority are rejected. Header values cannot contain CR/LF or NUL.

Replace the example's `mcp` block with a server registry such as:

```yaml
mcp:
  credentials:
    service:
      headers:
        Authorization: Bearer REPLACE_MCP_SERVICE_TOKEN
  servers:
    project_context:
      transport: streamable_http
      url: https://tools.example.invalid/mcp
      credential_ref: service
      tools:
        read_record:
          effect: read
        store_record:
          effect: reviewed_write
          idempotency_argument: operation_key
```

Add `mcp: { project_context: { tools: [read_record, store_record] } }` to an existing role definition to grant those exact tools. An omitted grant denies access; wildcard and unknown names fail. Mixed read/write tools must declare `reviewed_write`. The optional idempotency argument names a top-level string argument whose replay contract the operator has verified; declaring it is not proof that the server actually supports safe retries. `output_review` cannot receive any MCP tool grant.

For Dense-Mem, the same registry can use these declarations with a project-scoped credential and endpoint:

```yaml
tools:
  recall_memory:
    effect: read
  trace_memory:
    effect: read
  remember:
    effect: reviewed_write
    idempotency_argument: idempotency_key
```

Grant only the required exact names to each phase. Runtime behavior does not depend on these example names. Server aliases, grants, effects, and non-secret credential references are captured in supervisor snapshots; protected header values remain separate.

The `mcp` defaults are `initialization_timeout_seconds: 30`, `call_timeout_seconds: 300`, and `max_request_bytes`, `max_response_bytes`, and `max_catalog_bytes` each set to `1048576`. Timeouts must be positive integers; sizes can be lowered but cannot exceed 1 MiB. The future gateway must initialize assigned capabilities before a phase starts, block unavailable capabilities, include write review within the call deadline, and cap it by the remaining job budget. Running-job grants cannot expand through reconfiguration.

## GitHub intake and durable work

Give the fine-grained PAT access to exactly the configured repository, including Metadata, Issues, Contents, Pull requests, and Checks read permissions. The supervisor uses Octokit with fixed GitHub API routes. Repository identity is verified against GitHub's immutable ID; replacing the configured repository while retaining its database blocks enrollment. The default branch is refreshed during reconciliation. Private API access uses the protected PAT without placing it in URLs, persisted inputs, or worker snapshots.

Configure a GitHub webhook with JSON content, your configured webhook secret, and an externally reachable HTTPS URL ending in `/webhooks/github`. Compose binds HTTP to localhost, so arrange HTTPS ingress separately. Select Issues, Issue comments, Pull requests, Pull request reviews, Pull request review comments, Check runs, Check suites, and Statuses. The service does not create or change webhooks itself.

The endpoint verifies the HMAC-SHA256 signature over the exact request bytes and checks repository identity. It accepts at most 1 MiB per request. A successful HTTP 202 means the delivery and its work signals committed to SQLite. Replay is idempotent; reusing a delivery ID for different bytes returns 409. Invalid signatures return 401, foreign repositories return 403, malformed events return 400, and unverified enrollment or unavailable persistence returns 503. Unsupported signed events and unrelated PRs are recorded without creating work.

Enrollment backfills every open issue, filtering PRs from GitHub's mixed issue listing. Persisted page progress survives interruption. Reconciliation repeats every `limits.reconciliation_minutes` (five by default), revisits known workflows for closure, and recovers missed activity. Repeated scans also repair pagination shifts. Events cause authoritative reads rather than trusting stale payload state. A genuinely new signed delivery clears an obsolete target deferral; replay and periodic rediscovery preserve it. Repository-wide authentication and rate-limit backoff still applies. Closure and reopening update the same workflow with revision fencing; ordinary activity preserves snapshots and budget usage. Unsupported investigation phases remain pending and consume no coding lease.

Only PRs recorded as instance-owned are processed. Recorded outbound object IDs distinguish this instance's comments from genuine human comments made with the same PAT account. Ownership and publication receipts are persistence contracts for later tickets; this service makes no GitHub writes. A changed PR context advances the associated job revision and persists current-head context without claiming readiness.

State lives in `/data/state/manager.sqlite`, inside a supervisor-owned `0700` directory with `0600` database files. SQLite uses WAL, full synchronous commits, prepared statements, transactions, and additive versioned migrations. Schema version 2 adds runtime/session/artifact receipts while preserving version 1 jobs, budgets and snapshots. Workers cannot access this state. Newer unsupported schemas are rejected. Backups must include committed WAL state; use a consistent SQLite backup or stop the container before copying the complete state directory. Preserve the data volume on rollback. Startup terminates interrupted role processes and verifies cleanup before releasing their coding leases; active time is conservatively charged through the recovery point or original deadline.

`/healthz` remains process liveness. `/readyz` keeps automation unavailable while reporting intake `starting`, `ready`, or `degraded`, a fixed failure reason, and pending/inbox/failure counts. It exposes no repository names or issue contents. Authentication, rate-limit, and network failures preserve pending work and retry on the reconciliation schedule, respecting provider backoff. Secret-bearing input remains pending with a safe diagnostic. Stop/start the container to stop/restart the service; restarts preserve jobs, receipts, budgets, and snapshots.

## Supervised worker runtime

The runtime supports the dedicated Linux container with exclusive `coding` (10001), `audit` (10002), and `output-review` (10003) identities. Do not share its PID namespace with host processes or unrelated services. `AgentRunner.run(request, AbortSignal)` streams validated progress, usage, artifact, session and terminal events. SDK modules are registered by supervisor composition and load only inside the unprivileged worker. No vendor adapter is registered yet, so an execution request reports `backend_unavailable`; intake does not dispatch jobs automatically.

Each run receives a fresh disk-backed home, workspace and temporary folder under `/data/runtime/runs`, with read-only materialized operator bundles. Supervisor-authenticated Git fetches retain the pinned commit and all reachable ancestors in protected staging. Worker checkouts receive fresh Git configuration and independent objects, with no PAT, upstream key or retained credential helper. Submodules, LFS downloads and repository setup are not automatic. Workers launch with explicit UID/GID drops, cleared groups/capabilities, no-new-privileges, clean environments and process limits. Parent and detached descendants are terminated before an account is reused.

The model relay listens only on loopback. Short-lived run authorization grants the configured profile's Messages/token-counting or Responses/compaction HTTP routes. The supervisor supplies upstream authentication, rejects redirects and WebSockets, persists a shared request reservation before forwarding, and aborts cancelled, expired or stale work. Failed requests still consume reservations. Worker output is untrusted; a clean exit and terminal event alone do not approve publication.

After process cleanup, candidate files are copied into supervisor-owned digest-addressed blobs and manifests. Root never reads worker Git configuration. Escaping symlinks, hardlinks and special files are rejected; safe relative symlinks are preserved without following them. Accepted receipts bind the artifact to its job/revision and source commit. Session identities are fenced by source, role, profile, prompt snapshot and MCP policy/catalog identities. Vendor-specific resume data belongs to the SDK adapters.

The optional `McpSessionProvider` supplies only scoped loopback connection descriptors. Empty grants need no provider; configured grants require one. Cancellation, phase completion, revision changes and cleanup revoke sessions. An independent audit/output reviewer can run in the parent's existing lease while the requesting coding process tree is suspended. The reviewer uses fresh workspace/context and immutable input, with the parent budget still enforced.

Disk usage is checked every second, including source staging, workspace/home/temp folders and role-owned shared temporary files. Exceeding a configured threshold cancels the run; monitoring errors fail closed. These are soft limits on ordinary disk storage, with no tmpfs requirement or hard filesystem quota. A rapid writer can exceed a threshold before detection and fill shared storage. Preserve space for state and artifacts when sizing the data volume. Stop workers and revoke authorization before rollback; retain the schema-2 database and runtime receipts rather than downgrading persisted state.

## Development and validation

`npm run check` checks formatting, lint, types, tests, and the production build. `npm run test:container -- --platform linux/amd64` builds and exercises the real image with HTTP, readiness, users, permissions, mounts, persistence, secret-canary exclusion, signed webhooks, interrupted backfill recovery, and graceful shutdown checks. Use `linux/arm64` on an ARM64 host. Container tests require Docker with Buildx and a local Unix-socket daemon. They create an isolated Docker client configuration for public pulls and remove only their labeled test resources, preserving host credentials, other builders, and shared caches.

PR CI runs automatically and tests both architectures on native runners without application secrets or image publication. CodeQL analyzes Actions and JavaScript/TypeScript. Validate workflow syntax with actionlint 1.7.12 and Compose with `docker compose config --quiet`. Services own decisions, repositories own persistence, and adapters own external I/O; GitHub reads and SQLite repositories are injected into the intake service at those boundaries.

If the Docker CLI runs in a development container whose `/tmp` differs from the daemon's filesystem, use `TMPDIR="$PWD/node_modules" npm run test:container -- --platform linux/amd64` so bind-mount fixtures reside in the shared workspace. HTTP probes run inside the production container and do not require a shared localhost network namespace.

## AI pull request review

Trusted maintainer PRs start review through `pull_request_target`; other-author and fork PRs use successful PR CodeQL completion. CI, CodeQL, and the direct review route subscribe to `opened`, `synchronize`, `reopened`, `ready_for_review`, and `edited`. Retargeting an unchanged PR to `main` registers validation; title/body edits also rerun CI. Existing current-head review statuses suppress duplicate reviews. Trigger changes in the trusted review workflow take effect after human merge. A manual dispatch accepts an open PR number. The initial workflow bootstrap had a one-time activation exception; later PRs require their own successful review status. Ordinary CI remains automatic, with no review-first request controller.

The AI reviewer follows `v1-prerelease` and uses Claude, model `auto`, effort `xhigh`, six isolated goals, 200 turns per goal, a 50-minute review limit, and no automatic approval. Its goals cover design, security, reliability, public contracts, scope/operations, and test assurance. It first reinspects claimed fixes, then independently sweeps the full change. It runs separately from builds with a pristine checkout and read-only tools. Per-PR concurrency, duplicate suppression, and exact-head status fencing prevent stale success. Incomplete reviews publish a blocking error status; a successful workflow job alone does not prove review completion.

The workflow uses inherited `AI_ENDPOINT`, `LOCAL_AI_SECRET`, and `PR_REVIEW_PAT`, plus `PROJECT_MEMORY_MCP_ENDPOINT` and this repository's `PROJECT_MEMORY_MCP_TOKEN`. Before live activation, supply the missing project token through GitHub Secrets and verify the PAT covers this repository. Interactive review needs Contents and Pull requests read/write, Commit statuses write, and Issues read for linked-issue context. Use a project-scoped read-only memory credential; only `recall_memory` is granted. Do not reuse another project's token. Missing configuration fails visibly. Secrets and repository settings are managed by the maintainer, not this delivery.

## Image releases

After human merge, run the **Release** workflow from `main` with a version such as `0.1.0` or `0.1.0-rc.1`. It checks out the exact dispatch SHA, builds AMD64/ARM64, and publishes `ghcr.io/markhuangai/opensource-repo-manager:<version>` and `:sha-<full-commit-sha>`. The run log and summary retain the source SHA, version, manifest digest, platforms, and run URL. Deploy by digest when a published image is available. PR jobs never publish images, and this delivery does not run the release workflow.

## Planned workflow

1. Enrollment, open-issue backfill, signed webhooks, and durable pending workflows are implemented. The following execution stages remain planned.
2. Prepare the repository environment and investigate each issue. Maintain one reviewed status comment with findings, evidence, progress, and a later PR link.
3. For a confirmed maintenance problem, implement an issue-scoped fix, obtain an independent audit, and run real repository checks and regression tests.
4. Scan and review the exact candidate before committing it to a new branch and opening a non-draft pull request. Monitor feedback and CI, applying bounded corrections.
5. Notify the maintainer through Discord, SMTP, or an HTTP webhook when the current PR head passes the configured automation gates. A human reviews and merges the change.

Feature requests receive investigation and a maintainer handoff; feature implementation remains manual in v1. Discussions and other authors' pull requests are outside v1. Readiness for human review requires current-head evidence; opening a PR alone does not establish readiness.

## Approved design

| Area              | Planned choice and rationale                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deployment        | One Docker container per repository, with persistent data and a versioned GHCR image. Separate instances fit a shared Docker host.                                                                                                                                             |
| Service           | TypeScript on Node 24 LTS, Fastify, SQLite in WAL mode, npm, and Vitest. Services own use cases, repositories own persistence, and adapters handle external integrations. Use constructor injection and interfaces at those boundaries.                                        |
| Agent engines     | Both Claude Agent SDK and Codex SDK implement one streaming `AgentRunner` contract. Each role selects its SDK, model, and reasoning effort independently. A required CLIProxyAPI-compatible proxy supplies model access.                                                       |
| GitHub access     | A fine-grained personal access token supports the single configured repository. Durable inbox, job, and outbox records reconcile retries, missed events, and restart recovery. Recorded object IDs distinguish this instance's activity from the token owner's human activity. |
| Environment setup | AI proposes structured system-package and exact Go, Node, or Python version requests. Fixed trusted installers and pinned mise perform privileged setup; repository dependency scripts run unprivileged. V1 supports public dependencies.                                      |

The service will ship unattended workflow skills derived from the SDLC development loop. Operators can mount and edit system prompts, user prompts, and skills. Each job receives an immutable snapshot so later edits do not change a running job. Application code enforces authority, audit, test, and publication gates.

## Planned MCP integrations

Operators will configure generic remote Streamable HTTP MCP servers and grant exact tools to each agent role. MCP is optional. V1 supports unauthenticated endpoints or protected bearer/API-key headers; local stdio servers and OAuth flows are deferred. SDKs connect through a supervised gateway that holds upstream credentials and enforces each job's permissions.

Each configured tool declares a read or reviewed-write effect. Writes require scans and independent review of the exact destination and arguments. The reviewer runs within the requesting job's lease and has no MCP access. Recovery replays a write only when the operator has declared a supported idempotency argument; uncertain unkeyed writes pause for inspection.

Dense-Mem will be a configuration example and integration fixture. The same runtime supports differently named tools on other compatible HTTP servers. Operators must use appropriate server-side credential scope and trust the configured tool's declared behavior; tool annotations and prompt text are not authorization boundaries.

## Configuration and security boundaries

The root supervisor reads `/config/config.yml` from a read-only, root-owned mount without group or other access. The YAML contains protected GitHub, webhook, model-proxy, notification, and optional MCP credentials. `/skills` and `/prompts` are read-only operator mounts; `/data` holds protected state/artifacts and separate disk-backed worker folders. The worker supervisor and model relay are implemented; vendor SDKs and the MCP gateway remain planned.

Separate coding, audit, and output-review users receive clean environments and credential-free workspaces. A supervisor-owned model relay injects upstream credentials outside SDK processes, and only the supervisor publishes to GitHub. Issue text, comments, repository instructions, command output, and agent results remain untrusted inputs.

Publication requires deterministic secret scans, independent review of model-written external content, and receipts bound to the exact artifact and job revision. Changed candidates invalidate prior audit and test receipts. New PR heads invalidate prior readiness. Fixed operational notices use validated safe templates.

### Accepted risks

- Agents retain direct outbound networking. They can upload agent-readable private source; output review and separate Unix users do not prevent that. Operators accept this exposure when enrolling a private repository.
- Docker shares the host kernel. Separate users protect service credentials under the intended process boundary, but do not guarantee protection from container or kernel escapes. The deployment uses standard Docker capabilities without a Docker socket, privileged mode, host networking, or `NET_ADMIN`.
- Privileged package and toolchain installation trusts the configured distribution, mise, and upstream vendors. Structured requests, fixed sources, and installation receipts limit the path; arbitrary AI-generated root shell commands and repository-provided root hooks are excluded.

V1 preserves human merge authority and other actors' work. Automatic merging, force pushes, repository-setting changes, private registry credentials, and approval of privileged workflows are outside its scope.

## Planned operating limits

| Setting                          | Default    |
| -------------------------------- | ---------- |
| Active execution slots           | 1          |
| Active work per job              | 60 minutes |
| Proxied model requests per job   | 200        |
| Repair cycles per job            | 3          |
| Transient infrastructure retries | 2          |
| CI and review wait               | 24 hours   |
| Reconciliation interval          | 5 minutes  |

Limits are configurable in YAML. Waiting for CI or reviews releases the execution slot. Backfilled issues remain queued without a daily issue quota. Exhausted budgets remain blocked; restarting the service does not reset them. This ticket adds no manual retry interface. Notifications retain per-channel delivery results; ambiguous delivery can still produce duplicates.

## Implementation roadmap

Program: `opensource-repo-manager-v1-20261013T234247Z`. All tickets are planned and occupy serialized waves 0–13. GitHub issue bodies are the execution contracts; native GitHub blocked-by relationships are the dependency authority.

| Ticket | Issue                                                                                                                                        | Native blocker |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| T01    | [Initialize the TypeScript service, Docker image, and CI](https://github.com/markhuangai/opensource-repo-manager/issues/1)                   | None           |
| T02    | [Load protected YAML configuration and immutable workflow bundles](https://github.com/markhuangai/opensource-repo-manager/issues/2)          | #1             |
| T03    | [Enroll one GitHub repository and persist webhook and backlog work](https://github.com/markhuangai/opensource-repo-manager/issues/3)         | #2             |
| T04    | [Supervise unprivileged agents and keep service credentials isolated](https://github.com/markhuangai/opensource-repo-manager/issues/4)       | #3             |
| T13    | [Add a scoped HTTP MCP gateway for agent roles](https://github.com/markhuangai/opensource-repo-manager/issues/13)                            | #4             |
| T05    | [Integrate Claude Agent SDK with the supervised worker contract](https://github.com/markhuangai/opensource-repo-manager/issues/5)            | #13            |
| T06    | [Integrate Codex SDK with the same supervised worker contract](https://github.com/markhuangai/opensource-repo-manager/issues/6)              | #5             |
| T07    | [Bootstrap Go, Node, and Python repositories from AI-generated setup plans](https://github.com/markhuangai/opensource-repo-manager/issues/7) | #6             |
| T08    | [Gate and reconcile every GitHub publication](https://github.com/markhuangai/opensource-repo-manager/issues/8)                               | #7             |
| T09    | [Deliver durable Discord, SMTP, and HTTP webhook notifications](https://github.com/markhuangai/opensource-repo-manager/issues/9)             | #8             |
| T14    | [Review and reconcile configured MCP writes](https://github.com/markhuangai/opensource-repo-manager/issues/14)                               | #9             |
| T10    | [Investigate issues and maintain one reviewed status comment](https://github.com/markhuangai/opensource-repo-manager/issues/10)              | #14            |
| T11    | [Turn confirmed maintenance issues into audited and tested pull requests](https://github.com/markhuangai/opensource-repo-manager/issues/11)  | #10            |
| T12    | [Monitor PR feedback and current-head CI until human review is ready](https://github.com/markhuangai/opensource-repo-manager/issues/12)      | #11            |

Each ticket requires a separate implementation instruction and one reviewed PR. A closed blocker alone is insufficient: its required PR must be verified as merged on remote `main`. The first human merge gate is T01 before T02 can start. Investigation activates with T10, PR creation with T11, and readiness monitoring with T12.

Approved decisions, rationales, accepted risks, and verified milestones are retained in the project's memory. They describe planned architecture until implementation evidence proves otherwise; the GitHub issue contracts govern execution.

## License

[Apache-2.0](LICENSE).
