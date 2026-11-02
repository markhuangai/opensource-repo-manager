import { Octokit } from "@octokit/rest";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GitHubActionsSource } from "../adapters/github/actions-source.ts";
import { StateError } from "./state.ts";
import { routeActions } from "./routing.ts";
import { prepareActionsConfiguration } from "./setup.ts";
import { parseTaskRequest } from "./task.ts";
import { ConfigurationError } from "../config/errors.ts";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);
try {
  const [mode, number, ...extra] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.ORM_GITHUB_TOKEN;
  const key = process.env.ORM_SESSION_KEY;
  if (
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !token ||
    !key ||
    !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
    Buffer.from(key, "base64").toString("base64") !== key ||
    extra.length
  )
    throw new StateError("state_invalid");
  const silent = () => {};
  const source = new GitHubActionsSource(
    repository,
    new Octokit({
      auth: token,
      log: { debug: silent, info: silent, warn: silent, error: silent },
    }),
  );
  const signal = controller.signal;
  if (mode === "route" && !number) {
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
    const request = parseTaskRequest(number ? [number] : []);
    const proxyKey = process.env.ORM_PROXY_KEY;
    if (!proxyKey) throw new StateError("state_invalid");
    await prepareActionsConfiguration(
      source,
      { repository, token, proxyKey },
      signal,
    );
    delete process.env.ORM_GITHUB_TOKEN;
    delete process.env.ORM_PROXY_KEY;
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./main.js", import.meta.url)),
        String(request.issue_number),
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
  console.log(
    JSON.stringify({
      version: 1,
      outcome: "failed",
      reason:
        error instanceof StateError || error instanceof ConfigurationError
          ? error.code
          : "controller_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
}
