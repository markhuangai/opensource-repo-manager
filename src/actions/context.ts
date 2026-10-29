import { ConfigurationError } from "../config/errors.ts";

export type ActionsContext = Readonly<{
  repository: string;
  repository_id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  results_url: string;
}>;

export function captureActionsContext(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const count = (name: string) => {
    const value = environment[name];
    if (
      !value ||
      !/^[1-9][0-9]*$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new ConfigurationError("actions_context_invalid");
    return Number(value);
  };
  const token = environment.ACTIONS_RUNTIME_TOKEN;
  const repository = environment.GITHUB_REPOSITORY;
  const sha = environment.GITHUB_SHA;
  let results: URL;
  try {
    results = new URL(environment.ACTIONS_RESULTS_URL ?? "");
  } catch {
    throw new ConfigurationError("actions_context_invalid");
  }
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    !token ||
    token.length > 65536 ||
    /\s/.test(token) ||
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !sha ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    results.protocol !== "https:" ||
    !results.hostname.endsWith(".actions.githubusercontent.com") ||
    results.port ||
    results.username ||
    results.password ||
    results.search ||
    results.hash ||
    results.pathname !== "/"
  )
    throw new ConfigurationError("actions_context_invalid");
  const context: ActionsContext = {
    repository,
    repository_id: count("GITHUB_REPOSITORY_ID"),
    run_id: count("GITHUB_RUN_ID"),
    run_attempt: count("GITHUB_RUN_ATTEMPT"),
    head_sha: sha,
    results_url: results.origin,
  };
  delete environment.ACTIONS_RUNTIME_TOKEN;
  delete environment.ACTIONS_RESULTS_URL;
  return { context, token };
}
