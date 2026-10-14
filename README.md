# opensource-repo-manager

A self-hosted GitHub maintenance service for repositories whose maintainers cannot watch every issue. The planned service investigates issues, prepares tested maintenance fixes, follows pull request feedback, and notifies the maintainer when a change is ready for human review.

**Status: planned, not implemented.** This repository currently contains documentation and an Apache-2.0 license. The approved implementation program is published as 12 GitHub issues. There is no runnable application, container release, or installation command yet.

## Planned workflow

1. Enroll one public or private GitHub repository, backfill its existing open issues, and receive signed webhooks for subsequent activity.
2. Prepare the repository environment and investigate each issue. Maintain one reviewed status comment with findings, evidence, progress, and a later PR link.
3. For a confirmed maintenance problem, implement an issue-scoped fix, obtain an independent audit, and run real repository checks and regression tests.
4. Scan and review the exact candidate before committing it to a new branch and opening a non-draft pull request. Monitor feedback and CI, applying bounded corrections.
5. Notify the maintainer through Discord, SMTP, or an HTTP webhook when the current PR head passes the configured automation gates. A human reviews and merges the change.

Feature requests receive investigation and a maintainer handoff; feature implementation remains manual in v1. Discussions and other authors' pull requests are outside v1. Readiness for human review requires current-head evidence; opening a PR alone does not establish readiness.

## Approved design

| Area | Planned choice and rationale |
| --- | --- |
| Deployment | One Docker container per repository, with persistent data and a versioned GHCR image. Separate instances fit a shared Docker host. |
| Service | TypeScript on Node 24 LTS, Fastify, SQLite in WAL mode, npm, and Vitest. Services own use cases, repositories own persistence, and adapters handle external integrations. Use constructor injection and interfaces at those boundaries. |
| Agent engines | Both Claude Agent SDK and Codex SDK implement one streaming `AgentRunner` contract. Each role selects its SDK, model, and reasoning effort independently. A required CLIProxyAPI-compatible proxy supplies model access. |
| GitHub access | A fine-grained personal access token supports the single configured repository. Durable inbox, job, and outbox records reconcile retries, missed events, and restart recovery. Recorded object IDs distinguish this instance's activity from the token owner's human activity. |
| Environment setup | AI proposes structured system-package and exact Go, Node, or Python version requests. Fixed trusted installers and pinned mise perform privileged setup; repository dependency scripts run unprivileged. V1 supports public dependencies. |

The service will ship unattended workflow skills derived from the SDLC development loop. Operators can mount and edit system prompts, user prompts, and skills. Each job receives an immutable snapshot so later edits do not change a running job. Application code enforces authority, audit, test, and publication gates.

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

| Setting | Default |
| --- | --- |
| Active execution slots | 1 |
| Active work per job | 60 minutes |
| Proxied model requests per job | 200 |
| Repair cycles per job | 3 |
| Transient infrastructure retries | 2 |
| CI and review wait | 24 hours |
| Reconciliation interval | 5 minutes |

Limits are configurable in YAML. Waiting for CI or reviews releases the execution slot. Backfilled issues remain queued without a daily issue quota. Exhausted budgets require an explicit operator retry. Notifications retain per-channel delivery results; ambiguous delivery can still produce duplicates.

## Implementation roadmap

Program: `opensource-repo-manager-v1-20261013T234247Z`. All tickets are planned and occupy serialized waves 0–11. GitHub issue bodies are the execution contracts; native GitHub blocked-by relationships are the dependency authority.

| Ticket | Issue | Native blocker |
| --- | --- | --- |
| T01 | [Initialize the TypeScript service, Docker image, and CI](https://github.com/markhuangai/opensource-repo-manager/issues/1) | None |
| T02 | [Load protected YAML configuration and immutable workflow bundles](https://github.com/markhuangai/opensource-repo-manager/issues/2) | #1 |
| T03 | [Enroll one GitHub repository and persist webhook and backlog work](https://github.com/markhuangai/opensource-repo-manager/issues/3) | #2 |
| T04 | [Supervise unprivileged agents and keep service credentials isolated](https://github.com/markhuangai/opensource-repo-manager/issues/4) | #3 |
| T05 | [Integrate Claude Agent SDK with the supervised worker contract](https://github.com/markhuangai/opensource-repo-manager/issues/5) | #4 |
| T06 | [Integrate Codex SDK with the same supervised worker contract](https://github.com/markhuangai/opensource-repo-manager/issues/6) | #5 |
| T07 | [Bootstrap Go, Node, and Python repositories from AI-generated setup plans](https://github.com/markhuangai/opensource-repo-manager/issues/7) | #6 |
| T08 | [Gate and reconcile every GitHub publication](https://github.com/markhuangai/opensource-repo-manager/issues/8) | #7 |
| T09 | [Deliver durable Discord, SMTP, and HTTP webhook notifications](https://github.com/markhuangai/opensource-repo-manager/issues/9) | #8 |
| T10 | [Investigate issues and maintain one reviewed status comment](https://github.com/markhuangai/opensource-repo-manager/issues/10) | #9 |
| T11 | [Turn confirmed maintenance issues into audited and tested pull requests](https://github.com/markhuangai/opensource-repo-manager/issues/11) | #10 |
| T12 | [Monitor PR feedback and current-head CI until human review is ready](https://github.com/markhuangai/opensource-repo-manager/issues/12) | #11 |

Each ticket requires a separate implementation instruction and one reviewed PR. A closed blocker alone is insufficient: its required PR must be verified as merged on remote `main`. The first human merge gate is T01 before T02 can start. Investigation activates with T10, PR creation with T11, and readiness monitoring with T12.

Approved decisions, rationales, accepted risks, and verified milestones are retained in the project's memory. They describe planned architecture until implementation evidence proves otherwise; the GitHub issue contracts govern execution.

## License

[Apache-2.0](LICENSE).
