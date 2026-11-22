# opensource-repo-manager

Open Source Repo Manager (ORM) investigates issues in your GitHub repository. When it finds a bug in existing behavior, it can prepare a fix, have a separate agent audit it, run the project's checks, and open a pull request. ORM follows CI and review feedback on that PR. Your maintainers review and merge the result. Feature requests stay with your team.

## Install in your repository

The examples run on GitHub.com with Issues and Actions enabled, using disposable `ubuntu-24.04` runners with Docker and Buildx. ORM can set up local checks for Go, Node.js, and Python projects with public dependencies. [Supported dependencies and task limits](examples/actions/README.md#task-limits-and-recovery)

Configure access as described below and install these files on your repository's default branch.

| Example                                             | Destination                         | Purpose                                                     |
| --------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| [maintenance.yml](examples/actions/maintenance.yml) | `.github/workflows/maintenance.yml` | Starts or resumes work on an issue                          |
| [orm-agent.yml](examples/actions/orm-agent.yml)     | `.github/workflows/orm-agent.yml`   | Runs the agent assigned to each phase                       |
| [orm.yml](examples/actions/orm.yml)                 | `.github/orm.yml`                   | Selects agent profiles, required reviewers, and task limits |
| [remote-dev.yml](examples/actions/remote-dev.yml)   | `.remote-dev.yml`                   | Lists the accounts allowed to dispatch agents               |
| [test-ai.yml](examples/actions/test-ai.yml)         | `.github/workflows/test-ai.yml`     | Optional workflow to verify your AI configuration           |

1. Set up the controller token, session key, agent tokens, and AI provider secrets. Restrict the coding identity to pushing `orm-work/**` branches. Reserve the default branch, workflow files, and `orm/**` PR branches for the controller and maintainers. [Credentials and branch rules](examples/actions/README.md#credentials-and-branch-rules)
2. In `.remote-dev.yml`, replace `REPLACE_WITH_ORM_CONTROLLER_LOGIN` with the controller token owner's GitHub login. If someone else will run the AI configuration test, add their login too. Each listed account needs write access. Keep `auto-continue: false`.
3. In `.github/orm.yml`, choose the profiles and review signals your repository uses. The example uses Claude for coding and Codex for audit. It also expects PR feedback from both Codex and CodeRabbit. List only the automated reviewers you require. [Profiles and PR checks](examples/actions/README.md#profiles-and-pr-checks)

The example workflows follow `@v1-prerelease`. To pin a version, use the same published ORM release tag in each caller. The workflow selects the matching container image by digest. [Versions and upgrades](examples/actions/README.md#versions-and-upgrades)

Native agent jobs have full access within their runner. Their Actions artifacts can contain source code and conversation history. Check who can download artifacts from your repository before enabling the workflows.

## Verify the setup

If you installed the test workflow, open **Actions → Test AI configuration → Run workflow** on the default branch. With the example profiles, run it once for `implementation` (Claude) and once for `audit` (Codex). Each run sends a read-only prompt and checks for the exact reply `ORM probe completed.` A passing probe consumes no issue budget.

## Run your first issue

Open a new issue describing the behavior you expected and what happened. New issues enroll automatically. To use an existing open issue, select **Actions → Repository maintenance → Run workflow** on the default branch and enter its number in `issue-number`.

Follow ORM's status comment on the issue. If it asks for information, answer in a new comment and keep the `orm:managed` label and ORM's comments intact. Each controller run releases its runner while it waits for an agent, a reply, or CI. Issue and PR activity, agent completion, and a 15-minute schedule resume work.

When a fix is ready, the PR includes its audit and test results. ORM reports readiness for the current PR commit after the required checks and reviews complete. Review the change and merge it through your normal process. [Troubleshoot a run](examples/actions/README.md#troubleshoot-a-run)

[Maintainer documentation](docs/README.md) · [Apache-2.0 license](LICENSE)
