import { readFileSync } from "node:fs";
import { parseRepositoryActionsConfiguration } from "../src/config/schema.ts";
import { parseConfigurationSources } from "../src/config/sources.ts";
import { loadWorkflowBundles } from "../src/config/bundles.ts";
import { createRunSnapshot } from "../src/config/load.ts";
import { separateSecrets } from "../src/config/secrets.ts";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Octokit } from "@octokit/rest";
import { OctokitReader } from "../src/adapters/github/reader.ts";
import { githubFixtureRequest, githubFixtureState } from "./fixtures/github.ts";

export function fixtureConfigurationSources() {
  return parseConfigurationSources(
    "{}",
    JSON.stringify({
      ORM_GITHUB_TOKEN: "github-fixture-token",
      ORM_SESSION_KEY: Buffer.alloc(32, 13).toString("base64"),
    }),
  );
}

export function fixtureConfiguration() {
  return parseRepositoryActionsConfiguration(
    readFileSync(
      new URL("../examples/actions/orm.yml", import.meta.url),
      "utf8",
    ),
    "owner/repo",
    fixtureConfigurationSources(),
  ).configuration;
}

export async function fixtureSnapshot(
  model = "fixture-model",
  config = fixtureConfiguration(),
) {
  const { settings, secrets } = separateSecrets(config);
  const bundles = await loadWorkflowBundles(settings, secrets, {
    prompts: fileURLToPath(
      new URL("../examples/workflow/prompts", import.meta.url),
    ),
    skills: fileURLToPath(
      new URL("../examples/workflow/skills", import.meta.url),
    ),
  });
  const fixtureBundles = {
    ...bundles,
    implementation: {
      ...bundles.implementation,
      system: bundles.implementation.system + "\n" + model,
    },
  };
  return {
    snapshot: createRunSnapshot(settings, fixtureBundles, secrets),
    secrets,
  };
}

export async function fixtureGitHub() {
  const state = githubFixtureState();
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    ifNoneMatch: string | undefined;
    status?: number;
  }> = [];
  let beforeRequest: ((url: string) => Promise<void>) | undefined;
  const server = createServer(async (request, response) => {
    const captured: (typeof requests)[number] = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      ifNoneMatch: request.headers["if-none-match"],
    };
    requests.push(captured);
    response.on("finish", () => {
      captured.status = response.statusCode;
    });
    await beforeRequest?.(request.url!);
    await githubFixtureRequest(request, response, state);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture address unavailable");
  const client = new Octokit({
    auth: state.token,
    baseUrl: `http://127.0.0.1:${address.port}`,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  return {
    state,
    requests,
    reader: new OctokitReader("owner/repo", client),
    client,
    beforeRequest(callback: typeof beforeRequest) {
      beforeRequest = callback;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
