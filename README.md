# opensource-repo-manager

A self-hosted GitHub maintenance service for repositories whose maintainers cannot watch every issue. The planned service investigates issues, prepares tested maintenance fixes, follows pull request feedback, and notifies the maintainer when a change is ready for human review.

**Status: service scaffold implemented; maintenance automation planned.** The repository now contains a TypeScript health service, Docker/Compose deployment, checks, and GitHub workflows. The approved implementation program contains 14 issues. Issue investigation, fixes, agents, persistence, and application MCP integration remain planned. No GHCR image has been published by this change.

## Run the scaffold

Use Node 24.18.0 and npm 12.0.2:

```sh
npm ci
npm run check
npm start
```

`npm run dev` runs the source with Node's watch mode. The service listens on port 8080. `GET /healthz` returns HTTP 200 with `{"status":"ok"}`. `GET /readyz` returns HTTP 503 with `{"status":"not_ready","reason":"automation_not_implemented"}`. Docker uses liveness for its healthcheck; a healthy container does not mean maintenance automation is ready.

For Compose, create operator-owned mounts and an empty protected configuration file:

```sh
mkdir -p operator/skills operator/prompts
sudo install -d -o root -g root -m 0700 operator/config
sudo install -o root -g root -m 0600 /dev/null operator/config/config.yml
docker compose up --build
```

Compose exposes port 8080 on localhost, persists `/data`, and mounts configuration, skills, and prompts read-only. The scaffold does not yet load those files. Protected YAML loading belongs to #2. The container's root supervisor runs the health service; worker execution belongs to later issues. Its fixed `/opt/orm-runtime/bin/node` executable stays separate from future repository toolchains. The image includes Git, certificates, C build tools, process supervision, and distinct `coding`, `audit`, and `output-review` users.

## Development and validation

`npm run check` checks formatting, lint, types, tests, and the production build. `npm run test:container -- --platform linux/amd64` builds and exercises the real image with HTTP, readiness, users, permissions, mounts, persistence, secret-canary exclusion, and graceful shutdown checks. Use `linux/arm64` on an ARM64 host. Container tests require Docker with Buildx and a local Unix-socket daemon. They create an isolated Docker client configuration for public pulls and remove only their labeled test resources, preserving host credentials, other builders, and shared caches.

PR CI runs automatically and tests both architectures on native runners without application secrets or image publication. CodeQL analyzes Actions and JavaScript/TypeScript. Validate workflow syntax with actionlint 1.7.12 and Compose with `docker compose config --quiet`. Services own decisions, repositories own persistence, and adapters own external I/O; the scaffold currently needs only HTTP construction and process startup, with no empty layers.

If the Docker CLI runs in a development container whose `/tmp` differs from the daemon's filesystem, use `TMPDIR="$PWD/node_modules" npm run test:container -- --platform linux/amd64` so bind-mount fixtures reside in the shared workspace. HTTP probes run inside the production container and do not require a shared localhost network namespace.

## AI pull request review

After this workflow is merged, trusted maintainer PRs start review through `pull_request_target`; other-author and fork PRs use successful PR CodeQL completion. A manual dispatch accepts an open PR number. The initial PR adding the workflow has an approved activation exception and receives no review from this new workflow. Ordinary CI remains automatic, with no review-first request controller.

The pinned AI reviewer uses Claude, model `auto`, effort `xhigh`, six isolated goals, 200 turns per goal, a 50-minute review limit, and no automatic approval. Its goals cover design, security, reliability, public contracts, scope/operations, and test assurance. It first reinspects claimed fixes, then independently sweeps the full change. It runs separately from builds with a pristine checkout and read-only tools. Per-PR concurrency, duplicate suppression, and exact-head status fencing prevent stale success. Incomplete reviews publish a blocking error status; a successful workflow job alone does not prove review completion.

The workflow uses inherited `AI_ENDPOINT`, `LOCAL_AI_SECRET`, and `PR_REVIEW_PAT`, plus `PROJECT_MEMORY_MCP_ENDPOINT` and this repository's `PROJECT_MEMORY_MCP_TOKEN`. Before live activation, supply the missing project token through GitHub Secrets and verify the PAT covers this repository. Interactive review needs Contents and Pull requests read/write, Commit statuses write, and Issues read for linked-issue context. Use a project-scoped read-only memory credential; only `recall_memory` is granted. Do not reuse another project's token. Missing configuration fails visibly. Secrets and repository settings are managed by the maintainer, not this delivery.

## Image releases

After human merge, run the **Release** workflow from `main` with a version such as `0.1.0` or `0.1.0-rc.1`. It checks out the exact dispatch SHA, builds AMD64/ARM64, and publishes `ghcr.io/markhuangai/opensource-repo-manager:<version>` and `:sha-<full-commit-sha>`. The run log and summary retain the source SHA, version, manifest digest, platforms, and run URL. Deploy by digest when a published image is available. PR jobs never publish images, and this delivery does not run the release workflow.

## Planned workflow

1. Enroll one public or private GitHub repository, backfill its existing open issues, and receive signed webhooks for subsequent activity.
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

The planned root supervisor reads `/config/config.yml` from a read-only, root-owned mount without group or other access. The YAML may contain the GitHub token, webhook secret, model-proxy credentials, and notification credentials. `/skills` and `/prompts` are read-only operator mounts; `/data` holds persistent state.

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

Limits are configurable in YAML. Waiting for CI or reviews releases the execution slot. Backfilled issues remain queued without a daily issue quota. Exhausted budgets require an explicit operator retry. Notifications retain per-channel delivery results; ambiguous delivery can still produce duplicates.

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
