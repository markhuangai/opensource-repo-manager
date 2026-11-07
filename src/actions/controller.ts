import { Octokit } from "@octokit/rest";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GitHubActionsSource } from "../adapters/github/actions-source.ts";
import { StateError } from "./state.ts";
import { routeActions } from "./routing.ts";
import {
  prepareActionsConfiguration,
  readActionsConfiguration,
} from "./setup.ts";
import { parseTaskRequest } from "./task.ts";
import { ConfigurationError } from "../config/errors.ts";
import { parseConfigurationSources } from "../config/sources.ts";
import { roleNames, type Role } from "../config/schema.ts";
import { testAiConfiguration } from "./test-ai.ts";
import {
  createKnownSecretChecker,
  createSafeLogger,
} from "../logging/redact.ts";
import { IntakeError } from "../domain/jobs.ts";

const controller = new AbortController();
const started = performance.now();
let operation = "configuration_load";
let logger = createSafeLogger(createKnownSecretChecker([]), true);
const correlation = {
  repository: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
    process.env.GITHUB_REPOSITORY ?? "",
  )
    ? process.env.GITHUB_REPOSITORY
    : undefined,
  run_id: /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? "")
    ? process.env.GITHUB_RUN_ID
    : undefined,
  run_attempt: /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")
    ? process.env.GITHUB_RUN_ATTEMPT
    : undefined,
  issue_number: /^[1-9][0-9]*$/.test(process.argv[3] ?? "")
    ? process.argv[3]
    : undefined,
};
const cancel = () => controller.abort();
process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);
try {
  const [mode, number, ...extra] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const bootstrapToken = process.env.ORM_BOOTSTRAP_GITHUB_TOKEN;
  if (
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !bootstrapToken ||
    extra.length ||
    !["route", "run", "test-ai"].includes(mode) ||
    (mode === "route" && number) ||
    (mode === "test-ai" &&
      (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
        !roleNames.includes(number as Role)))
  )
    throw new StateError("state_invalid");
  const silent = () => {};
  const sources = parseConfigurationSources(
    process.env.ORM_CONFIGURATION_VARIABLES,
    process.env.ORM_CONFIGURATION_SECRETS,
  );
  logger = createSafeLogger(
    createKnownSecretChecker([
      bootstrapToken,
      ...Object.values(sources.secrets),
    ]),
    true,
  );
  const client = (token: string) =>
    new GitHubActionsSource(
      repository,
      new Octokit({
        auth: token,
        log: { debug: silent, info: silent, warn: silent, error: silent },
      }),
    );
  const signal = controller.signal;
  const request =
    mode === "run" ? parseTaskRequest(number ? [number] : []) : undefined;
  const bootstrap = client(bootstrapToken);
  const loaded = await readActionsConfiguration(
    bootstrap,
    repository,
    sources,
    signal,
  );
  if (String(loaded.repository.id) !== process.env.GITHUB_REPOSITORY_ID)
    throw new StateError("state_invalid");
  logger = createSafeLogger(
    createKnownSecretChecker([
      bootstrapToken,
      ...Object.values(sources.secrets),
      ...loaded.configuration.redaction_values,
    ]),
    true,
  );
  for (const source of loaded.sources)
    logger.infoPublic({
      event: "configuration_source_resolved",
      level: "info",
      ...correlation,
      repository,
      operation,
      source_sha: loaded.pinned.source.sha,
      schema_version: loaded.configuration.version,
      ...source,
      elapsed_ms: Math.round(performance.now() - started),
    });
  logger.infoPublic({
    event: "configuration_resolved",
    level: "info",
    ...correlation,
    repository,
    operation,
    source_sha: loaded.pinned.source.sha,
    schema_version: loaded.configuration.version,
    elapsed_ms: Math.round(performance.now() - started),
  });
  delete process.env.ORM_BOOTSTRAP_GITHUB_TOKEN;
  delete process.env.ORM_CONFIGURATION_VARIABLES;
  delete process.env.ORM_CONFIGURATION_SECRETS;
  const source = client(loaded.configuration.github.token);
  const key = loaded.sessionKey;
  if (mode === "test-ai") {
    if (
      process.env.GITHUB_REF !==
      `refs/heads/${loaded.repository.default_branch}`
    )
      throw new StateError("state_invalid");
    operation = "ai_test";
    const result = await testAiConfiguration(
      loaded.configuration,
      number as Role,
      loaded.pinned.source,
      signal,
    );
    console.log(JSON.stringify(result));
    process.exitCode = result.outcome === "completed" ? 0 : 1;
  } else if (mode === "route" && !number) {
    operation = "route";
    const payload = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH ?? "/event.json", "utf8"),
    );
    console.log(
      JSON.stringify(
        await routeActions(
          source,
          {
            event: process.env.GITHUB_EVENT_NAME ?? "",
            payload,
            repository,
            sessionKey: key,
            issueNumber: process.env.ORM_ISSUE_NUMBER,
            ref: process.env.GITHUB_REF,
          },
          signal,
        ),
      ),
    );
  } else if (mode === "run") {
    operation = "configuration_prepare";
    await prepareActionsConfiguration(bootstrap, loaded, signal);
    operation = "task_execution";
    process.env.ORM_SESSION_KEY = key;
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./main.js", import.meta.url)),
        String(request!.issue_number),
      ],
      { stdio: "inherit", env: process.env },
    );
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    signal.removeEventListener("abort", stop);
  } else throw new StateError("state_invalid");
} catch (error) {
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  const reason =
    error instanceof StateError ||
    error instanceof ConfigurationError ||
    error instanceof IntakeError
      ? error.code
      : operation === "configuration_load" && (status === 401 || status === 403)
        ? "github_access_denied"
        : "controller_failed";
  logger.errorPublic({
    event:
      operation === "configuration_load"
        ? "configuration_load_failed"
        : "controller_failed",
    level: "error",
    operation,
    ...correlation,
    cause: reason,
    outcome: "failed",
    recovery:
      operation === "configuration_load"
        ? "Check the named configuration source and GitHub read access on the default branch, then rerun."
        : "Inspect the operation and cause, correct the configuration or runtime failure, then rerun.",
    ...(error instanceof ConfigurationError ? error.diagnostic : {}),
    elapsed_ms: Math.round(performance.now() - started),
  });
  console.log(
    JSON.stringify({
      version: 1,
      outcome: "failed",
      reason,
    }),
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
}
