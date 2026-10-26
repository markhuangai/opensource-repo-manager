# opensource-repo-manager

A self-hosted GitHub maintenance service for repositories whose maintainers cannot watch every issue. The service investigates issues, prepares tested maintenance fixes, follows pull request feedback, and notifies the maintainer when a change is ready for human review.

**Status: automatic investigation, audited/tested PR publication, and PR feedback/readiness monitoring implemented.** The service verifies one public/private GitHub repository, backfills open issues, receives signed webhooks, and persists deduplicated pending workflows in SQLite. The runtime provides unprivileged workers, source workspaces, scoped model/MCP gateways, and immutable artifacts. Claude and Codex SDK adapters, audited bootstrap, and callable reviewed GitHub publication are implemented; durable notifications and automatic issue investigation are implemented; maintenance fixes and first PR publication are implemented; PR feedback and current-head readiness monitoring are implemented. No GHCR image has been published by this change.

## Run the service

Use Node 24.18.0 and npm 12.0.2:

```sh
npm ci
npm run check
```

`npm run dev` runs the source with Node's watch mode; `npm start` runs the production build. Both require valid protected configuration and bundles before opening HTTP. The fixed paths are `/config/config.yml`, `/prompts`, and `/skills`; use the container setup below to provide them. The service listens on port 8080. `GET /healthz` returns HTTP 200 with `{"status":"ok"}`. `GET /readyz` returns HTTP 200 with `status: ready` once intake, the coordinator, notifications and PR monitoring are running; startup, unavailable infrastructure or disabled monitoring returns HTTP 503 with a fixed safe reason and aggregate counts. Docker uses liveness for its healthcheck; a healthy container does not mean maintenance automation is ready.

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

`config.example.yml` is the version 1 contract. Unknown fields and unsupported versions fail; there is no environment-variable interpolation, credential fallback, include processing, or automatic migration. Use a fine-grained GitHub PAT for the single `owner/repository`, a webhook secret, and a mandatory CPA-compatible HTTP(S) URL/key. Configuration validation is offline. After HTTP starts, enrollment verifies GitHub access and reads repository metadata. Assigned MCP servers initialize before worker launch; Claude capability checks run inside its worker before task submission; notification delivery is callable through the supervisor.

The configuration must be a root-owned regular file with owner-read permission and no group/other permissions. Its immediate directory must be root-owned without group/other write permission. Symlinks are rejected, including parent components. Keep the deployment mount read-only; `0400` or `0600` files in a `0700` directory are recommended. Worker users cannot read the configuration. An empty file or the old `{}` scaffold fixture is no longer valid.

The application runs only as a service. It accepts no commands or arguments and has no `orm` executable, offline validation command, or pause/resume feature. Startup validates protected configuration and all selected bundles before opening HTTP. Rejection exits with code 1. Diagnostics report fixed codes and safe section/line locations, excluding source lines, arbitrary input names, credentials, and filesystem paths.

Each named profile requires `sdk`, `model`, and `effort`. Every phase selects a profile independently: `bootstrap`, `investigation`, `implementation`, `audit`, and `output_review`. Claude accepts `low`, `medium`, `high`, `xhigh`, and `max`; Codex accepts `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`. These are SDK-level values; a model may support a subset. The Claude adapter validates SDK-reported model/effort compatibility before submitting the task. For a proxy alias such as `model: auto`, add `behaves_as: claude-opus-4-8` (or the known Claude model whose capabilities the operator promises the alias supports). This changes client capability handling, while the alias remains the model sent to the proxy; unsupported combinations fail without fallback. The Codex adapter forwards `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` exactly. It rejects `ultra` and `persistent` before inference because the pinned CLI rewrites those aliases; provider/model errors fail without changing model or effort. See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [Claude effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).

`roles.<role>.prompts.system` and `.user` name UTF-8 files relative to `/prompts`. `roles.<role>.skills` lists directories relative to `/skills`, each with a `SKILL.md`. The loader copies all regular files below each selected skill directory, including contained reference files and binary assets. It never follows Markdown links or executes a bundle file while loading. Absolute paths, `..`, symlinks, missing files, writable-by-group/other bundle content, and known credentials in content or metadata are rejected. Files are limited to 1 MiB each, with a 16 MiB aggregate loading limit across roles; configuration YAML is limited to 1 MiB and bounded alias expansion.

The loader exposes a deeply frozen, JSON-safe `RunSnapshot` with a digest, role profiles, prompt text, and skill bytes encoded as base64 with per-file digests. `snapshot.settings` is supervisor metadata and includes non-secret upstream configuration; pass only `snapshot.roles[role]` to a future worker. Role projections exclude upstream endpoints, credentials, notification destinations, and authentication headers. The separate root-only `SecretAccessor` supplies credentials and known-secret checks; it is not part of the snapshot. Known-secret checks detect configured values, not arbitrary unknown secrets.

Configuration and bundle content load once at startup. Restart to load edits; previously captured snapshots remain self-contained and unchanged. Each issue workflow keeps its original persisted snapshot even after restart or later activity; newly discovered workflows capture the current snapshot. The mounted investigation, implementation, audit, review-feedback and output-review examples support the complete workflow. Readiness policy is supervisor configuration: after restart, edits apply to existing PR monitors and invalidate their prior readiness evidence without changing coding snapshots, model profiles or MCP grants.

At least one notification channel must be enabled in every valid configuration. Supported shapes under `notifications` are `discord: { enabled: true, webhook_url }`, `smtp: { enabled: true, host, port, secure, username, password, from, to }`, and `webhook: { enabled: true, url, headers }`. Disabled channels contain only `enabled: false`. Investigation automatically enqueues information requests, manual feature handoffs, and blocked-work notices through the durable notification service.

`limits` uses `active_slots: 1`, `active_minutes: 60`, `model_requests: 200`, `repair_cycles: 3`, `infrastructure_retries: 2`, `wait_hours: 24`, and `reconciliation_minutes: 5` by default. Worker defaults are `worker_processes: 128`, `worker_output_bytes: 16777216` (16 MiB aggregate protocol/stdout/stderr), and `worker_storage_bytes: 4294967296` (4 GiB monitored workspace/home/temp usage). The slot count is fixed at one; other budgets are configurable positive integers, with zero permitted for repairs/retries. The runtime enforces active time, model requests and worker limits. Investigation dispatches backfilled jobs automatically; confirmed maintenance candidates continue through implementation and PR monitoring. Exhausted budgets do not reset on restart or issue activity.

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
      review_required_tools: [store_record]
      tools:
        read_record:
          effect: read
        store_record:
          effect: write
          idempotency_argument: operation_key
```

Add `mcp: { project_context: { tools: [read_record, store_record] } }` to an existing role definition to grant those exact tools. An omitted grant denies access; wildcard and unknown names fail. `review_required_tools` is an exact-name server policy applying to all granted roles. Omission or `[]` skips independent model review. Duplicate names, unknown tools, and read tools in this list are rejected. Every write retains deterministic secret scanning, credential isolation, authority checks, and durable receipts. Tool annotations cannot grant access, require review, or authorize replay. `output_review` cannot receive MCP grants.

**Breaking configuration conversion:** replace `effect: reviewed_write` with `effect: write` and list tools that need review in their server's `review_required_tools`. There is no compatibility alias. Stored snapshots and receipts retain their original policy; an incompatible old job is blocked rather than silently converted.

For Dense-Mem, the same registry can use these declarations with a project-scoped credential and endpoint:

```yaml
review_required_tools: [remember]
tools:
  recall_memory:
    effect: read
  trace_memory:
    effect: read
  remember:
    effect: write
    idempotency_argument: idempotency_key
```

Treat MCP integrations as operator-trusted. Do not grant tools or provider credentials that bypass this repository's GitHub publication gates or human merge authority. Grant only the required exact names to each phase. Runtime behavior does not depend on these example names. Server aliases, grants, effects, and non-secret credential references are captured in supervisor snapshots; protected header values remain separate.

The `mcp` defaults are `initialization_timeout_seconds: 30`, `call_timeout_seconds: 300`, and `max_request_bytes`, `max_response_bytes`, and `max_catalog_bytes` each set to `1048576`. Timeouts must be positive integers; sizes can be lowered but cannot exceed 1 MiB. One initialization deadline covers the handshake and complete paginated catalog. Each call has its own deadline, capped by the remaining job budget; progress cannot extend it. The gateway validates JSON Schema arguments without coercion or remote schema downloads, bounds HTTP/SSE input, and rejects redirects on every method. Transport-control headers cannot be used as authentication headers.

Sessions and validators are isolated by run, job, revision, role, alias, and credential binding even when aliases share an endpoint. Workers receive only loopback URLs, short-lived bearer authorization, exact tool names, and the parent deadline. Cancellation, phase/revision changes, completion, catalog-change notifications, and cleanup revoke authorization. A fresh session rediscovers the catalog; changed policy, credentials, or catalog identity invalidates resume. Restarting with an incompatible assigned policy blocks an old job instead of expanding its grants. Known-secret checks cover arguments and worker-visible descriptions, schemas, progress, results, and errors. Returned resource links are data and are never followed automatically.

A listed write uses this worker input (the generated idempotency property is hidden):

```json
{
  "arguments": {
    "text": "The captured issue requests a documentation correction."
  },
  "purpose": "Save the requested correction in project knowledge",
  "evidence": [{ "kind": "job" }]
}
```

Unlisted writes use ordinary provider arguments, such as `{ "text": "A proposed agent claim" }`. Skipped model review does not establish that a claim is supported. List knowledge-writing tools when independent factual review is required. The same behavior applies to `store_record`, Dense-Mem `remember`, or any other configured tool name.

Reviewed evidence references are `{ "kind": "job" }`, `{ "kind": "source", "path": "README.md", "start_line": 1, "end_line": 5 }`, or `{ "kind": "publication_evidence", "id": "<controller receipt digest>" }`. The controller resolves captured issue context, pinned source bytes, and matching publication audit/test evidence. Worker proof text, arbitrary URLs, escaping paths, symlinks, unsupported binary files, and mismatched receipts are rejected. Review covers the frozen destination, final injected arguments, purpose, evidence, and policy. Coding and audit requesters are suspended under their actual UID while a separate, MCP-free reviewer shares the existing lease and budgets.

Declare `idempotency_argument` only when the operator has verified that the provider guarantees safe replay of the same request/key for the entire recovery period. The controller generates the key, rejects worker substitution, and validates injected arguments against the original provider schema. Unsafe schema projection fails before discovery; schemas with references or identity anchors cannot currently be enveloped, and hidden-key projection supports plain object properties, required names, additional properties, and property counts. The hidden key must be a string property accepting generated 36-character UUIDs without enum, const, pattern, or conditional restrictions. There are no transport reconnect retries or automatic retries of tool/domain errors.

Supervisor code exposes `supervisor.mcpWrites.receipt(operationId)`, `.status()`, and `.recover(operationId, signal)`. No worker tool or HTTP mutation endpoint exposes recovery. Receipts distinguish `proposed`, `rejected`, `dispatching`, `response_recorded`, and `uncertain`; `review` explicitly records `required` or `not_required`. Returned `_meta["opensource-repo-manager/receipt"]` is controller-owned. `response_recorded` means a bounded provider response or safe MCP error was retained, not that a business effect succeeded. Structured content and tool-error flags remain provider data.

For an uncertain effect, stop and inspect the retained operation and provider state. Do not resubmit replacement arguments. The job remains durably blocked across issue revisions, with a stable needs-attention notification and aggregate `mcp_writes` readiness counts. Callable recovery returns an already recorded result, or rechecks authority, credentials, catalog, policy, the original deadline, and remaining budgets before a keyed replay. Required review is renewed under an operation-bound lease. Unkeyed uncertainty cannot be replayed automatically; denied recovery retains the block. Startup records interruptions and enqueues operational notices. Investigation may attempt recovery of an uncertain write once through its existing operation ID and safe replay policy. If a worker result was interrupted after a write, the investigation remains explicitly blocked rather than repeating the worker and its mutations. Notification failure remains visible and confirmed channels are retained.

Remove write grants and stop dispatch before rollback. Preserve schema-10 operations, attempts, reviews, results, and unresolved job blocks. Older binaries may reject the upgraded database. Use a compatible roll-forward or an explicitly approved restoration procedure. Reverting code cannot undo external effects; corrective writes need explicit operator direction.

## GitHub intake and durable work

Give the fine-grained PAT access to exactly the configured repository, including Metadata and Checks read permissions, plus Issues, Contents, and Pull requests read/write permissions for the callable publisher. Workflow-write permission is not required or used. The supervisor uses Octokit with fixed GitHub API routes. Repository identity is verified against GitHub's immutable ID; replacing the configured repository while retaining its database blocks enrollment. The default branch is refreshed during reconciliation. Private API access uses the protected PAT without placing it in URLs, persisted inputs, or worker snapshots.

Configure a GitHub webhook with JSON content, your configured webhook secret, and an externally reachable HTTPS URL ending in `/webhooks/github`. Compose binds HTTP to localhost, so arrange HTTPS ingress separately. Select Issues, Issue comments, Pull requests, Pull request reviews, Pull request review comments, Check runs, Check suites, and Statuses. The service does not create or change webhooks itself.

The endpoint verifies the HMAC-SHA256 signature over the exact request bytes and checks repository identity. It accepts at most 1 MiB per request. A successful HTTP 202 means the delivery and its work signals committed to SQLite. Replay is idempotent; reusing a delivery ID for different bytes returns 409. Invalid signatures return 401, foreign repositories return 403, malformed events return 400, and unverified enrollment or unavailable persistence returns 503. Unsupported signed events and unrelated PRs are recorded without creating work.

Enrollment backfills every open issue, filtering PRs from GitHub's mixed issue listing. Persisted page progress survives interruption. Reconciliation repeats every `limits.reconciliation_minutes` (five by default), revisits known workflows for closure, and recovers missed activity. Repeated scans also repair pagination shifts. Events cause authoritative reads rather than trusting stale payload state. A genuinely new signed delivery clears an obsolete target deferral; replay and periodic rediscovery preserve it. Repository-wide authentication and rate-limit backoff still applies. Closure and reopening update the same workflow with revision fencing; ordinary activity preserves snapshots and budget usage. Investigation dispatch starts after enrollment and is awakened by reconciled issue activity. Waiting and completed investigations consume no coding lease.

Only PRs recorded as instance-owned are processed. Recorded outbound object IDs distinguish this instance's comments from genuine human comments made with the same PAT account. The investigation coordinator invokes the publisher, which records owned object IDs and confirmed write receipts. Pending comment writes are reconciled before intake applies affected issue activity. After publication, issue/PR activity is stored as separate observation generations without advancing the frozen coding revision. Observed remote heads never replace the last confirmed publisher head. Changed issue scope or an unexpected branch head blocks further automated repairs.

State lives in `/data/state/manager.sqlite`, inside a supervisor-owned `0700` directory with `0600` database files. SQLite uses WAL, full synchronous commits, prepared statements, transactions, and additive versioned migrations. Schema version 10 preserves earlier jobs, budgets, snapshots, runtime, MCP, bootstrap, publication, notification, investigation and implementation records, and adds PR monitor checkpoints, immutable readiness evidence and separate observation generations. Investigation MCP reads retain bounded scanned provider results with controller receipt IDs; other read callers retain digests. Scanned write arguments, evidence and bounded provider responses are retained for operation-ID recovery; authentication is never stored. Interrupted reads are never replayed. Interrupted writes become uncertain and block their job until an authorized safe recovery records a response. Workers cannot access this state. Newer unsupported schemas are rejected. Backups must include committed WAL state; use a consistent SQLite backup or stop the container before copying the complete state directory. Preserve the data volume on rollback. Startup terminates interrupted role processes and verifies cleanup before releasing their coding leases; active time is conservatively charged through the recovery point or original deadline.

`/healthz` remains process liveness. `/readyz` returns HTTP 200 after enrollment when the complete service is running and its shared runtime is available; startup, disabled monitoring and unavailable infrastructure return HTTP 503. It reports safe service states, fixed failure reasons and counts without repository names or issue contents. Authentication, rate-limit, and network failures preserve pending work and retry on the reconciliation schedule, respecting provider backoff. Secret-bearing input remains pending with a safe diagnostic. Stop/start the container to stop/restart the service; restarts preserve jobs, receipts, budgets, and snapshots.

## Automatic issue investigation

After enrollment, the service consumes new and backfilled issues through one execution slot. Each investigation reads pinned source, proposes citations and optional reproduction commands, obtains audited setup when needed, and executes reproduction under the coding UID in a fresh source workspace. Nonzero reproduction exits are recorded with command, environment, source, revision, and bounded output; they are not confused with setup success. Source citations are resolved from supervisor-controlled Git objects. Model claims and SDK transcripts alone are not evidence.

Structured outcomes are `maintenance_candidate`, `needs_information`, `no_fix`, `manual_feature`, and `blocked`. Maintenance requires a concrete objective and supervisor-recorded reproduction or independently reviewed source proof. Source-only findings say **not reproduced**. The exact findings and evidence pass the existing scanner and independent output review before publication. A confirmed publication queues maintenance with `phase: implementation`; the same serialized coordinator automatically consumes that handoff. Features remain manual even when a maintainer accepts the idea. Information requests, feature handoffs, and blockers produce deduplicated needs-attention notifications.

The publisher updates one durable instance-owned comment. Fixed stage templates retain the exact previously reviewed summary, its original inspected SHA, and an owned PR reference when available. Changed narrative requires new review. Pending comment writes are reconciled before applying issue activity, so a response-loss webhook cannot become fresh human input. A genuine comment by the PAT owner is still input. Closed issues cancel work and retain their last comment. Human edits or deletion of the owned comment block publication instead of being overwritten or replaced.

Completed information/no-fix/feature investigations rerun only after issue edits, human comments, or reopening. A default-branch change invalidates active investigations and queued maintenance handoffs. Snapshots and lifetime budgets survive all revisions and restarts. Model/review/evidence failures stay blocked; only classified transient failures receive bounded infrastructure retries. Stopping the service cancels active work while retaining checkpoints. An interrupted worker that may already have mutated external data is not repeated automatically.

Investigation uses only its configured MCP grants. Returned context is checked against current source, and generic `investigation_evidence` references can support configured write review. Bounded provider results and controller receipts are retained; `response_recorded` does not assert a successful business effect. Uncertain writes hold the job and recover only by their original operation ID under the existing deadline, policy, and retry budget. Recovery never creates another issue comment.

`/readyz` includes safe investigation counts and reason codes; an individual waiting or blocked issue does not make healthy service infrastructure unavailable. Stop the service before rollback and preserve the schema-10 volume, evidence, comments, and queued handoffs. Older binaries cannot read schema 10; do not downgrade or delete durable state.

## Automatic maintenance implementation

Confirmed reproduced and reviewed source-only maintenance candidates enter a durable implementation pipeline. The coordinator freezes the original objective, acceptance criteria, edit paths and discovered local checks before coding. A job-owned branch starts from the recorded default-branch SHA in a credential-free workspace. The implementation role adds a real regression; a fresh independent audit inspects the entire immutable candidate. Features, unrelated/protected edits, weakened checks and mismatched receipts cannot advance.

After a matching audit, the supervisor restores that candidate and executes Linux-local repository checks under the audit verification UID (10002), separately from coding workers. Receipts identify commands, working directories, environment identity, source/artifact/scope digests, actual exits and bounded output digests. Source integrity is checked around setup and every command. Failed tests or audit findings can return to implementation within the lifetime repair budget (three by default); changed candidates require fresh audit and test evidence. Missing local infrastructure blocks the job. Discovered remote-only checks remain explicitly pending.

The existing scanner and output review gate the exact candidate before normal publication to the recorded instance-owned branch and one non-draft PR. The PR includes the issue-closing reference and audit/test summary. One owned issue comment reports the actual stage and retained investigation evidence. Successful publication enters `remote_review`, releases the execution slot and hands the PR to durable CI/review monitoring. Ready notifications require current-head evidence. `/readyz` reports operational service readiness with safe implementation counts. No automatic merge occurs.

Checkpoints retain completed audits, tests and publication operation IDs across retries and shutdown. Publication response loss is reconciled before more mutation; unexpected human branch changes and default-branch drift block publication. Closed or revised issues cancel the old candidate. Once an owned PR exists, subsequent issue/PR activity stays in remote waiting rather than creating another first-publication pipeline. Uncertain configured MCP writes retain tested-candidate evidence and block the job; safe recovery uses the original operation ID and never replays a worker that may already have written. Denied writes and provider errors remain explicit receipts, not successful-save claims. Operator-mounted example implement/audit skills and exact role grants configure model behavior; repository text and recalled context cannot expand the frozen scope.

Stop the service before rollback and retain schema-10 state, artifacts, source branches and receipts. Do not downgrade the database, delete published work or reset budgets. Existing shared-kernel, direct-egress and audited root-installation limitations still apply.

## PR feedback and current-head readiness

After first publication, the supervisor monitors only PRs recorded as owned by this instance. Signed review/check/status webhooks trigger authoritative reads; five-minute reconciliation recovers missed activity. Full REST/GraphQL pagination includes conversation comments, reviews, review threads, every nested reply, reactions, check attempts and statuses. Waiting releases the coding slot. A separate lifetime 24-hour wait budget includes downtime; restarts, new commits and policy edits do not reset it. Active/model limits, the three-repair ceiling and two infrastructure retries remain shared with the original job.

`pr_monitor` defaults to `enabled: true`, `requirements_source: github`, empty `required_checks` and `automated_reviewers`, and `local_checks_only: false`. The monitor reads legacy branch protection and applicable rulesets and combines discovered required checks with operator additions. Required source/integration identities are retained. Unknown/inaccessible requirements block readiness. To attest a complete checklist when discovery is unavailable or includes an unsupported automation rule, explicitly select `requirements_source: operator` and supply `required_checks`. Known discovered checks remain mandatory. An empty result set is never success; explicit local-checks-only policy is accepted only when no GitHub CI requirement or unknown requirement exists. The example lists this repository's additional CI/security/review gates. `{pr}` in a configured name expands to the owned PR number.

`automated_reviewers` entries contain `login` and `signal: github_review|codex|coderabbit`. Generic reviews must name the current SHA. Codex and CodeRabbit support their bounded no-findings signals only from the verified bot identities during the current head's review cycle. A newer in-progress indicator, absent completion, unavailable reviewer, quota/rate limit, failed, cancelled, neutral, skipped or pending required check blocks readiness. A CodeRabbit rate-limit notice is not a completed review in this service. Human approval remains a separate merge gate and is never granted by the monitor. The service does not trigger/retry remote workflows or update the base branch automatically.

The implementation role assesses each actionable surface against the frozen scope and actual candidate. Candidate-file citations and controller audit/test receipts support dispositions; thread resolution and outdated anchors alone establish no fix. Assessment cannot change source. Valid corrections return to the existing implementation/audit/unprivileged-test/scanner/output-review pipeline, then advance the owned branch normally. Feedback replies and supported resolutions use the durable publication journal. Interrupted effects are observed by exact IDs/markers before any further mutation. Unknown scope, human branch changes, insufficient CI evidence, exhausted budgets and timeouts remain visible operator handoffs.

When every current-head gate and finding disposition is complete, the existing owned issue comment says **Automation clean; awaiting human review**. A durable ready event identifies the head and readiness verification generation. Check/review activity or changed policy invalidates the evidence; each delivery attempt revalidates GitHub and holds stale events. Already confirmed channels retain their receipts. A ready notification is not permission to merge and does not prove the branch is current with then-current main; the maintainer must validate the merge candidate and required human review.

Readiness notes can use the implementation role's exact configured MCP grants and `pr_monitor_evidence` references. The controller resolves the head, policy, check/review and finding receipts; recalled text cannot replace them. Generic tools and the Dense-Mem example use the same runtime. Server-enforced credentials establish project scope; arbitrary tool arguments and provider claims cannot grant it. Denial, write-review rejection, provider error and uncertain dispatch remain explicit receipts. A retained HTTP response is not proof of a successful business effect. Uncertain writes stop the job; safe recovery uses the original operation ID, idempotency key, deadline and remaining budget while preserving completed GitHub work.

### Operator recovery

Stop the service before replacing credentials, policy or bundles. Restart loads protected configuration, reconciles interrupted workers/publications and resumes durable waiting. Readiness-policy edits revalidate existing monitors; coding scopes, profiles and grants stay pinned. Missing candidate/publication proof in older records blocks repairs instead of fabricating new audit receipts. For a human head change, scope dispute or exhausted budget, inspect the protected receipts and take over the existing PR; there is no automatic retry CLI or budget reset. To stop monitoring/fix dispatch for rollback, set `pr_monitor.enabled: false` and restart, retaining the data volume and all PRs/branches. Older binaries reject schema 10; use a compatible roll-forward or an explicitly approved consistent backup restoration.

Use a repository-scoped fine-grained PAT with Metadata, Checks and Commit statuses read access, Issues/Contents/Pull requests read/write, and the read access required for the chosen protection/ruleset discovery route. Actions read access is needed for operator inspection of CI diagnostics; workflow write/approval authority is unused. If protection requirements cannot be read, explicitly configure the complete checklist rather than expanding worker credentials. Keep PAT, webhook, notification and MCP credentials in the root-owned read-only mount; workers never receive them. Preserve `/data` and SQLite WAL consistently during backup. Installation, webhook event selection and accepted root-installation, direct-egress and shared-kernel risks remain as documented below.

## Supervised worker runtime

The runtime supports the dedicated Linux container with exclusive `coding` (10001), `audit` (10002), and `output-review` (10003) identities. Do not share its PID namespace with host processes or unrelated services. `AgentRunner.run(request, AbortSignal)` streams validated progress, usage, artifact, session and terminal events. SDK modules are registered by supervisor composition and load only inside the unprivileged worker. Production registers Claude Agent SDK 0.3.296 and Codex SDK/CLI 0.162.1. The root process registers their module paths and imports no vendor SDK. The investigation coordinator dispatches enrolled issues through this runtime.

Each run receives a fresh disk-backed home, workspace and temporary folder under `/data/runtime/runs`, with read-only materialized operator bundles. Supervisor-authenticated Git fetches retain the pinned commit and all reachable ancestors in protected staging. Worker checkouts receive fresh Git configuration and independent objects, with no PAT, upstream key or retained credential helper. Submodules and LFS downloads are not automatic. Repository setup uses the callable audited bootstrap stage described below; the investigation coordinator requests setup when reproduction needs a project environment. Workers launch with explicit UID/GID drops, cleared groups/capabilities, no-new-privileges, clean environments and process limits. Parent and detached descendants are terminated before an account is reused.

The model relay listens only on loopback. Short-lived run authorization grants the configured profile's Messages/token-counting or Responses/compaction HTTP routes. The supervisor supplies upstream authentication, rejects redirects and WebSockets, persists a shared request reservation before forwarding, and aborts cancelled, expired or stale work. Failed requests still consume reservations. Worker output is untrusted; a clean exit and terminal event alone do not approve publication.

After process cleanup, candidate files are copied into supervisor-owned digest-addressed blobs and manifests. Root never reads worker Git configuration. Escaping symlinks, hardlinks and special files are rejected; safe relative symlinks are preserved without following them. Accepted receipts bind the artifact to its job/revision and source commit. Session identities are fenced by source, role, profile, prompt snapshot and MCP policy/catalog identities. Claude exports only native transcripts and contained sidecars into a run-private session folder; Codex exports the matching native JSONL transcript and version/binding/usage metadata. After UID-wide process cleanup, root seals conversation and workspace manifests under protected `private/sessions` storage. Completed coding runs and clean Claude SDK-limited runs may resume with matching input and optional `output_schema`; consumed request/time budgets remain charged. Codex failed or supervisor-limited runs create no new checkpoint. A limited checkpoint is never a publishable artifact. Failed, cancelled, stale, crashed, or cleanup-failed runs cannot supply a new checkpoint. Missing/corrupt checkpoints, SDK-version changes, or binding changes fail explicitly; older session-ID-only receipts are not resumable. Independent reviews always start fresh.

Claude loads the selected immutable system/user prompts and phase skill files explicitly. Repository/user settings, hooks, plugins, automatic skills/memory, SDK delegation, and interactive permission escalation are disabled. Coding roles receive Bash, Read, Glob, Grep, Edit, and Write; audit receives Bash and the reading tools; output review receives only Read, Glob, and Grep. The SDK receives strict HTTP MCP configuration, exact gateway grants, and client deadlines covering the gateway deadline. These SDK controls complement the supervisor and gateway boundaries. Optional caller-owned JSON output schemas are validated locally; SDK errors, missing/invalid output, cancellation, and limits cannot become successful terminal results. Usage includes cached input tokens and subtracts known prior-session totals rather than counting resumed history again.

Codex uses a custom Responses provider over HTTP/SSE with WebSockets and transport retries disabled. A fresh Codex home and explicit untrusted-project settings prevent repository configuration from adding providers, hooks, MCP servers, skills or plugins. It loads the operator prompts and selected skills explicitly. Shell commands receive a separate clean environment without relay/MCP authorization or login-shell inheritance. Coding and audit execute within the existing container UID/workspace boundary; Codex's additional shell sandbox is disabled for these roles. Output review consumes the supplied payload and supporting evidence, with shell/MCP access disabled and native file writes denied by a read-only policy. Codex drains the event stream through successful process exit and validates structured output locally before completing. Native usage is cumulative: cached input and reasoning output are already included in totals, known prior totals are subtracted on resume, and unknown usage is omitted.

The optional `McpSessionProvider` supplies only scoped loopback connection descriptors. Empty grants need no provider; configured grants require one. Cancellation, phase completion, revision changes and cleanup revoke sessions. An independent audit/output reviewer can run in the parent's existing lease while the requesting coding or audit process tree is suspended. The reviewer uses fresh workspace/context and immutable input, with the parent budget still enforced.

Disk usage is checked every second, including source staging, workspace/home/temp folders, role-owned shared temporary files and open deleted files. Verified Git objects move into the fresh checkout without duplication. A credential-free trusted probe uses the worker's effective identity to inspect deleted files while retaining protected root real/saved identities; workers cannot signal or inspect the probe. Deleted mappings without a measurable descriptor and other monitoring errors cancel the run. Exceeding a configured threshold also cancels the run. These are soft limits on ordinary disk storage, with no tmpfs requirement or hard filesystem quota. A rapid writer can exceed a threshold before detection and fill shared storage. Installer storage accounting bounds growth during each operation; operators size retained toolchain and download storage separately. Preserve space for state and artifacts when sizing the data volume. Stop workers and revoke authorization before rollback; retain the schema-10 database and call/runtime/bootstrap/publication receipts rather than downgrading persisted state.

## Development and validation

`npm run check` checks formatting, lint, types, tests, and the production build. `npm run test:container -- --platform linux/amd64` builds and exercises the real image with HTTP, readiness, users, permissions, mounts, persistence, secret-canary exclusion, signed webhooks, interrupted backfill recovery, and graceful shutdown checks. Use `linux/arm64` on an ARM64 host. Container tests require Docker with Buildx and a local Unix-socket daemon. They create an isolated Docker client configuration for public pulls and remove only their labeled test resources, preserving host credentials, other builders, and shared caches.

PR CI runs automatically and tests both architectures on native runners without application secrets or image publication. Eight suites run on each architecture: `core`, `investigation`, `bootstrap`, `implementation-candidates`, `implementation-recovery`, `implementation-monitor-repair`, `implementation-monitor-state`, and `implementation-monitor-mcp`. Both SDKs run in separate containers for every implementation suite, with fresh fixture state between suites and intact state within recovery sequences. `Container smoke (amd64)` and `Container smoke (arm64)` require all eight suites' latest executions to succeed; `Repository CI` also requires the repository checks and complete container matrix. CodeQL and configured reviewers remain separate required gates.

The full local command runs those same suites sequentially. To diagnose one suite, use `npm run test:container -- --platform linux/amd64 --suite implementation-monitor-state`. An unknown selection fails before creating resources. Each successful suite emits a JSON receipt containing its selection, scenario coverage, phase and SDK timings, tested commit, dirty-worktree flag, PR head when applicable, image ID, and owned-resource cleanup. CI tests GitHub's PR merge commit; that tested commit is distinct from the PR head. A dirty local receipt identifies uncommitted work and is not proof of a published head. CI step summaries show phase timings, and architecture aggregates report job execution and runner queue time separately. SDK timings overlap and must not be summed as wall time.

The feedback targets are at most 30 minutes per successful CI job and 60 minutes from a PR head update until every required current-head check and reviewer has completed. Timeouts remain safety bounds, not evidence that these targets were met. Compare successful runs using phase receipts and the Actions job `created_at`, `started_at`, and `completed_at` timestamps. Use the repository push activity timestamp and the last required check/reviewer completion for end-to-end latency, including scheduling delays, runner queue time, and retries. A pending or unavailable required reviewer remains blocking.

Before sharding, successful PR run [40071446726](https://github.com/markhuangai/opensource-repo-manager/actions/runs/40071446726) took 105m 55s on AMD64 and 90m 10s on ARM64; Repository CI elapsed was 107m 34s. Successful main run [40085201361](https://github.com/markhuangai/opensource-repo-manager/actions/runs/40085201361) took 108m 10s and 90m 2s, respectively. The AMD64 implementation phase consumed 62m 52s and 64m 17s, while image build and initial setup took about one minute. The PR head's push-to-CI completion was 110m 17s, and the last required Codex completion signal appeared after 170m 25s. GitHub does not expose that provider's queue/execution breakdown. Final-head measurements and any remaining external constraints belong in the delivery's PR timing report; these baseline figures do not claim a measured improvement.

Validate workflow syntax with actionlint 1.7.12 and Compose with `docker compose config --quiet`. Services own decisions, repositories own persistence, and adapters own external I/O; GitHub reads and SQLite repositories are injected into the intake service at those boundaries.

If the Docker CLI runs in a development container whose `/tmp` differs from the daemon's filesystem, set `TMPDIR` to a writable directory shared with the daemon, for example `TMPDIR="$PWD/node_modules" npm run test:container -- --platform linux/amd64` when the workspace is shared. All read-only harness inputs are staged under the owned temporary directory, so the source worktree itself need not be shared. HTTP probes run inside the production container and do not require a shared localhost network namespace.

## AI pull request review

Trusted maintainer PRs start review through `pull_request_target`; other-author and fork PRs use successful PR CodeQL completion. CI, CodeQL, and the direct review route subscribe to `opened`, `synchronize`, `reopened`, `ready_for_review`, and `edited`. Retargeting an unchanged PR to `main` registers validation; title/body edits also rerun CI. Existing current-head review statuses suppress duplicate reviews. Trigger changes in the trusted review workflow take effect after human merge. A manual dispatch accepts an open PR number. The initial workflow bootstrap had a one-time activation exception; later PRs require their own successful review status. Ordinary CI remains automatic, with no review-first request controller.

The AI reviewer follows `v1-prerelease` and uses Claude, model `auto`, effort `xhigh`, six isolated goals, 200 turns per goal, a 50-minute review limit, and no automatic approval. Its goals cover design, security, reliability, public contracts, scope/operations, and test assurance. It first reinspects claimed fixes, then independently sweeps the full change. It runs separately from builds with a pristine checkout and read-only tools. Per-PR concurrency, duplicate suppression, and exact-head status fencing prevent stale success. Incomplete reviews publish a blocking error status; a successful workflow job alone does not prove review completion.

The workflow uses inherited `AI_ENDPOINT`, `LOCAL_AI_SECRET`, and `PR_REVIEW_PAT`, plus `PROJECT_MEMORY_MCP_ENDPOINT` and this repository's `PROJECT_MEMORY_MCP_TOKEN`. Before live activation, supply the missing project token through GitHub Secrets and verify the PAT covers this repository. Interactive review needs Contents and Pull requests read/write, Commit statuses write, and Issues read for linked-issue context. Use a project-scoped read-only memory credential; only `recall_memory` is granted. Do not reuse another project's token. Missing configuration fails visibly. Secrets and repository settings are managed by the maintainer, not this delivery.

## Image releases

After human merge, run the **Release** workflow from `main` with a version such as `0.1.0` or `0.1.0-rc.1`. It checks out the exact dispatch SHA, builds AMD64/ARM64, and publishes `ghcr.io/markhuangai/opensource-repo-manager:<version>` and `:sha-<full-commit-sha>`. The run log and summary retain the source SHA, version, manifest digest, platforms, and run URL. Deploy by digest when a published image is available. PR jobs never publish images, and this delivery does not run the release workflow.

## Maintenance workflow

1. Enrollment, open-issue backfill, signed webhooks, and durable investigation workflows are implemented.
2. Investigate each issue, prepare the environment when reproducing, and maintain one reviewed status comment.
3. For a confirmed maintenance problem, implement an issue-scoped fix, obtain an independent audit, and run real repository checks and regression tests.
4. Scan and review the exact candidate before committing it to a new branch and opening a non-draft pull request. Monitor feedback and CI, applying bounded corrections.
5. Notify the maintainer through Discord, SMTP, or an HTTP webhook when the current PR head passes the configured automation gates. A human reviews and merges the change.

Feature requests receive investigation and a maintainer handoff; feature implementation remains manual in v1. Discussions and other authors' pull requests are outside v1. Readiness for human review requires current-head evidence; opening a PR alone does not establish readiness.

## Approved design

| Area              | Choice and rationale                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deployment        | One Docker container per repository, with persistent data and a versioned GHCR image. Separate instances fit a shared Docker host.                                                                                                                                             |
| Service           | TypeScript on Node 24 LTS, Fastify, SQLite in WAL mode, npm, and Vitest. Services own use cases, repositories own persistence, and adapters handle external integrations. Use constructor injection and interfaces at those boundaries.                                        |
| Agent engines     | Both Claude Agent SDK and Codex SDK implement one streaming `AgentRunner` contract. Each role selects its SDK, model, and reasoning effort independently. A required CLIProxyAPI-compatible proxy supplies model access.                                                       |
| GitHub access     | A fine-grained personal access token supports the single configured repository. Durable inbox, job, and outbox records reconcile retries, missed events, and restart recovery. Recorded object IDs distinguish this instance's activity from the token owner's human activity. |
| Environment setup | AI proposes structured system-package and exact Go, Node, or Python version requests. Fixed trusted installers and pinned mise perform privileged setup; repository dependency scripts run unprivileged. V1 supports public dependencies.                                      |

The service ships unattended workflow skills derived from the SDLC development loop. Operators can mount and edit system prompts, user prompts, and skills. Each job receives an immutable coding snapshot; readiness-policy edits apply to existing PRs after restart. Application code enforces authority, audit, test, and publication gates.

## Audited repository bootstrap

`Supervisor.bootstrap.prepare(request, signal)` prepares the pinned source and returns a durable setup receipt. Internal callers attach its ID as `bootstrap_receipt` to later agent requests. Investigation and maintenance call this capability when their commands require project tools. There is no bootstrap HTTP route. Operational readiness uses the complete service state; a setup failure blocks the affected job.

The configured bootstrap SDK inspects source and proposes a strict structured plan. A fresh audit worker independently approves the exact source and plan digests before installation. Plans contain exact Go/Node/Python versions, signed distro package names, exact package-manager versions, unprivileged setup commands, and proposed local/remote test commands. Bootstrap verifies tools and setup; investigation owns project test execution. Windows requirements remain recorded remote checks.

Mise v2026.10.9 is pinned by architecture-specific checksums. Its built-in installers run in private supervisor configuration with safe mode, hooks/plugins/default packages disabled, and download verification enabled. Node signature/checksum checks and Python artifact attestations are required; unsupported precompiled versions fail without source-build fallback. APT accepts package names through fixed commands, trusted image sources, and no-removal policy. Distro and toolchain vendors remain trusted privileged-code suppliers.

Public Go modules, npm, pnpm, Yarn Classic/current Yarn, pip/venv, Poetry, and uv are supported. Package managers install as workers in private run directories. Standard sources are the public Go proxy/checksum service, npm/Yarn registries, and PyPI. Existing usable locks or complete pinned requirements are required when dependencies are needed; missing/stale locks, credentials, custom registries, unavailable versions, and failed setup block explicitly. npm's `private: true` publishing flag does not by itself indicate private dependencies.

Shared toolchains are supervisor-owned and read-only. Each coding/audit run receives independent writable dependency environments and caches. Setup cannot change manifest or lockfile fingerprints. Generated dependency state is excluded from artifacts and rebuilt on fresh/resumed runs; existing source is preserved. Supervisor and SDK launchers retain the fixed runtime while project commands use verified tool paths.

Receipts bind job/revision, pinned source/artifact, prompt snapshot, plan/audit, manifest/lock fingerprints, platform, package inventory, installer/tool integrity, exact versions, and actual command results. Changed identities invalidate reuse and resume. Installation intent precedes mutation; interruptions remain recorded and partial/unverified installations block reuse. Inspect damaged package or tool state before retrying; do not remove shared packages or caches automatically. Stop the service to prevent new work during operator recovery.

## Reviewed GitHub publication

`Supervisor.publication.publish(proposal, signal)` is a callable supervisor capability. It accepts status text, structured investigation findings, fixed investigation/PR-stage updates, reviewed feedback replies and resolutions, a fixed operational-notice reason, or a change proposal with a frozen artifact, expected bot head, and supervisor-recorded audit/test evidence IDs. `recordEvidence(evidence, signal)` scans and stores immutable evidence bound to the job/revision, source and artifact. The maintenance pipeline supplies independent audit and actual supervisor-executed test evidence; worker claims alone are not receipts. Investigation, implementation and PR monitoring invoke this publication gate; there is no HTTP mutation endpoint.

`publication.outputReview.review(request, signal)` and `verify(receiptId, request)` provide the reusable external-output gate. The request binds destination identity, exact payload, evidence, artifact, policy and job snapshot. Structured strings and keys receive known-secret and pinned Gitleaks 8.30.1 checks. Scanner rules and ignores come from isolated supervisor storage; repository suppressions and inline allow comments have no authority. Scan/review errors block publication with safe codes. Unknown secrets can still evade heuristic detection.

Decoded YAML scalar scanning includes duplicate keys, plain and quoted folding, and block scalars. YAML artifacts must parse completely. Scanner inputs are limited to 1 MiB per text field and 32 MiB in aggregate, with bounded document depth and node counts; incomplete coverage blocks publication.

Every generated payload uses a fresh `output_review` context without write credentials or MCP access. Nested review suspends the requesting coding or audit process and shares its existing lease and time/model budgets. Changed payloads or destinations invalidate approval. Fixed notices for model unavailability, budget exhaustion and publication blockage use checked templates without a model request. Select the sample `output-review` skill in the operator bundle; existing snapshots retain their original bundles.

The publisher preserves one owned status comment and one owned open PR per issue. Its branch namespace derives from the persisted instance ID and issue number. It rejects default/protected branches, branch rules, workflow/action definitions, CODEOWNERS, Dependabot configuration and submodule changes. Ordinary GitHub documentation and templates remain eligible. New/changed files must be UTF-8 text or contained symlinks; changed binaries and archives block explicitly. Unchanged binary blobs already on the remote remain intact.

After digest and link validation, a clean supervisor-owned Git repository constructs one commit from final blobs with filters and hooks excluded. Worker history is never imported. Commit attribution uses the authenticated PAT account and its GitHub noreply address; timestamp and metadata are frozen before transmission. Only normal branch advances are supported. Source drift, human edits, missing/closed owned objects, and changed heads block further writes.

Publication intent precedes each transmission. Exact markers, IDs, bytes and remote heads reconcile confirmed effects, including after restart or a changed job revision. `publication.reconcile(operationId, signal)` observes an interrupted operation without transmitting another write. An absent object after an ambiguous create remains uncertain; another create is blocked until inspection. Confirmed operation replay returns its stored receipt. Intake-observed heads never replace the last confirmed publisher head.

Publication and reconciliation serialize per issue. Provider backoff persists across restarts, and subsequent safe observation retries consume the job's infrastructure retry budget. Legacy ownership without confirmed target state blocks new objects. Reviewed PR title/body changes may reuse the confirmed branch head without creating a commit.

Retain schema-10 state, artifacts and receipts during rollback. Stop the service before reverting the publisher. Reverting code does not remove comments, branches, commits or PRs. A compatible restarted service reports operational readiness; disabling PR monitoring returns HTTP 503. Human review and merge remain required.

## Durable operator notifications

`Supervisor.notifications.prepare(event)` freezes canonical payloads and destination bindings for the currently configured channels. Events identify the repository, existing job/revision, issue, optional owned PR/head, occurrence time, outcome and fixed reason code. `ready_for_review` requires an owned PR/head, a matching controller readiness receipt and the `automation_clean` reason. The PR monitor supplies and revalidates that evidence before every transmission; notification delivery cannot invent readiness. Delivery does not evaluate CI or review results. Other events use `needs_attention` with a supported fixed reason. Callers must retain the same event ID and occurrence time across replay; conflicting content under an existing ID is rejected.

Default messages use fixed status text and canonical GitHub links, excluding issue titles, private source and raw logs. A bounded optional `narrative` requires an approved receipt for the exact `prepared.review` request from `publication.outputReview.review`. Pass its ID as `{ review_id }` to `notifications.enqueue(prepared, options, signal)`. The enqueue acknowledgement means the event and all selected channel rows committed to SQLite. `receipt(eventId)` exposes each channel's attempt history and outcome to supervisor callers. Fixed notices need no model request or coding lease, including when job budgets are exhausted.

The service starts its notification dispatcher after HTTP opens and cancels active sockets before closing the database. Each channel operates independently. Schema 6 preserves existing state and adds notification events, channel receipts and provider backoff. Every attempt is recorded before transmission; confirmed channels and SMTP recipients are not resent after restart. Failed and ambiguous transmissions get two retries, after 5 and 30 seconds, with a 30-second deadline per attempt. Rate-limit instructions extend the delay and persist per destination across events and restarts. Notification attempts have their own fixed ceiling and do not consume or reset coding budgets.

Webhook POSTs contain JSON `version: 1`, a stable `event_id`, repository/issue/optional PR references, outcome, reason, occurrence time and optional reviewed summary. `Idempotency-Key` contains the same event ID. Discord messages contain that identity and disable all mentions. All HTTP redirects are rejected. Protected webhook headers may supply authentication but cannot override transport framing, content type or idempotency. SMTP uses Nodemailer with certificate verification, implicit TLS when `secure: true`, and mandatory STARTTLS otherwise. SMTP authentication is never sent over plaintext. Credentials, destinations and raw provider diagnostics remain in supervisor-owned configuration; delivery receipts contain fixed codes and recipient indices rather than addresses or server text.

Ambiguous SMTP and Discord deliveries can produce duplicates: stable Message-IDs and event IDs do not guarantee provider deduplication. Attempt uncertainty remains recorded even when a later retry is confirmed; exhausted ambiguous deliveries remain `uncertain`. Permanent refusals become `failed`. Stale job revisions and changed or disabled destinations become `held`; restoring configuration does not release historical held messages. Stop the service and inspect retained state before deciding how to handle them. There is no automatic historical resend, notification-test command, application CLI, or mutation endpoint.

`GET /readyz` reports operational readiness and aggregate/per-channel notification state, counts and safe reason codes. Full receipts are retained in the protected SQLite database. Preserve schema-10 state on rollback; disabling a channel retains its events and receipts. Production-container tests deliver only to local HTTP and SMTP/TLS fixtures and verify the existing output-review gate through both SDKs.

## HTTP MCP integrations

Operators can configure generic remote Streamable HTTP MCP servers and grant exact reads and writes to each agent role. MCP is optional. The gateway supports unauthenticated endpoints or protected bearer/API-key headers; local stdio servers and OAuth flows are deferred. Both registered SDK adapters consume supervisor-issued gateway descriptors and exact tool grants.

Tool schemas support JSON Schema 2020-12 (the default) and draft-07. Other dialects fail explicitly. Schema patterns use RE2 to keep untrusted validation from blocking the supervisor; unsupported regex features such as lookaround and backreferences fail schema compilation. External schema references are never fetched.

Each session admits at most 16 concurrent tool calls; callers receive an explicit concurrency error until capacity is available. Requested progress notifications and the final result share the configured response byte budget. If even a required error envelope cannot fit that bound, the gateway revokes the session.

Each configured tool declares a read or write effect. Every write uses deterministic scans and durable dispatch; the server `review_required_tools` list selects independent review. The reviewer shares the requesting job's lease without MCP access. Uncertain unkeyed effects require operator inspection.

Dense-Mem is a configuration example and integration fixture. The same runtime supports differently named tools on other compatible HTTP servers. Operators must use appropriate server-side credential scope and trust the configured tool's declared behavior; tool annotations and prompt text are not authorization boundaries.

## Configuration and security boundaries

The root supervisor reads `/config/config.yml` from a read-only, root-owned mount without group or other access. The YAML contains protected GitHub, webhook, model-proxy, notification, and optional MCP credentials. `/skills` and `/prompts` are read-only operator mounts; `/data` holds protected state/artifacts and separate disk-backed worker folders. The worker supervisor, model relay, scoped MCP gateway with selectively reviewed writes, both SDK adapters, and automatic investigation are implemented; maintenance implementation and first PR publication are implemented; PR feedback and current-head readiness monitoring are implemented.

Separate coding, audit, and output-review users receive clean environments and credential-free workspaces. A supervisor-owned model relay injects upstream credentials outside SDK processes, and only the supervisor publishes to GitHub. Issue text, comments, repository instructions, command output, and agent results remain untrusted inputs.

Publication requires deterministic secret scans, independent review of model-written external content, and receipts bound to the exact artifact and job revision. Changed candidates invalidate prior audit and test receipts. New PR heads invalidate prior readiness. Fixed operational notices use validated safe templates.

### Accepted risks

- Agents retain direct outbound networking. They can upload agent-readable private source; output review and separate Unix users do not prevent that. Operators accept this exposure when enrolling a private repository.
- Docker shares the host kernel. Separate users protect service credentials under the intended process boundary, but do not guarantee protection from container or kernel escapes. The deployment uses standard Docker capabilities without a Docker socket, privileged mode, host networking, or `NET_ADMIN`.
- Privileged package and toolchain installation trusts the configured distribution, mise, and upstream vendors. Structured requests, fixed sources, and installation receipts limit the path; arbitrary AI-generated root shell commands and repository-provided root hooks are excluded.

V1 preserves human merge authority and other actors' work. Automatic merging, force pushes, repository-setting changes, private registry credentials, and approval of privileged workflows are outside its scope.

## Operating limits

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

Program: `opensource-repo-manager-v1-20261013T234247Z`. The program defines serialized waves 0–13. GitHub issue bodies are the execution contracts; native GitHub blocked-by relationships are the dependency authority.

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
| T14    | [Dispatch configured MCP writes with selective review and recovery](https://github.com/markhuangai/opensource-repo-manager/issues/14)        | #9             |
| T10    | [Investigate issues and maintain one reviewed status comment](https://github.com/markhuangai/opensource-repo-manager/issues/10)              | #14            |
| T11    | [Turn confirmed maintenance issues into audited and tested pull requests](https://github.com/markhuangai/opensource-repo-manager/issues/11)  | #10            |
| T12    | [Monitor PR feedback and current-head CI until human review is ready](https://github.com/markhuangai/opensource-repo-manager/issues/12)      | #11            |

Each ticket requires a separate implementation instruction and one reviewed PR. A closed blocker alone is insufficient: its required PR must be verified as merged on remote `main`. The first human merge gate is T01 before T02 can start. Investigation activates with T10, PR creation with T11, and readiness monitoring with T12.

Approved decisions, rationales, accepted risks, and verified milestones are retained in the project's memory. They describe planned architecture until implementation evidence proves otherwise; the GitHub issue contracts govern execution.

## License

[Apache-2.0](LICENSE).
