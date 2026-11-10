import { Octokit } from "@octokit/rest";
import { createKnownSecretChecker } from "../../logging/redact.ts";
import {
  createApiDiagnostics,
  observeApiFetch,
  type ApiDiagnostics,
} from "../../logging/api.ts";

export function createGitHubClient(
  repository: string,
  token: string,
  diagnostics = createApiDiagnostics(createKnownSecretChecker([token]), {
    repository,
  }),
  baseUrl?: string,
  credentialSource = "github.token",
) {
  const silent = () => {};
  const client = new Octokit({
    auth: token,
    baseUrl,
    log: { debug: silent, info: silent, warn: silent, error: silent },
  });
  instrumentGitHub(client, diagnostics, credentialSource);
  return client;
}

export function instrumentGitHub(
  client: Octokit,
  diagnostics: ApiDiagnostics,
  credentialSource = "github.token",
) {
  client.hook.wrap("request", async (request, options) => {
    const endpoint = client.request.endpoint.parse(options);
    const route = new URL(endpoint.url, "https://api.github.com").pathname;
    const query = typeof options.query === "string" ? options.query : "";
    const graphqlOperation =
      query.match(/\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ??
      query.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    const operation = `${options.method} ${route}${route === "/graphql" && graphqlOperation ? ` ${graphqlOperation}` : ""}`;
    const exchange = diagnostics.start("github", operation, {
      method: options.method,
      route,
      credential_source: credentialSource,
    });
    try {
      // Earlier Octokit hooks bind this options object before invoking the fetch observer.
      options.request = {
        ...options.request,
        fetch: observeApiFetch(
          options.request?.fetch ?? globalThis.fetch,
          exchange,
        ),
      };
      const result = await request(options);
      const data = result.data as { errors?: unknown[] } | undefined;
      if (route === "/graphql" && data?.errors?.length)
        exchange.fail(new Error("GitHub GraphQL response contains errors."), {
          status: result.status,
          headers: result.headers,
          body: data.errors,
        });
      else exchange.finish(result.status, result.headers);
      return result;
    } catch (error) {
      const value = error as {
        status?: number;
        response?: {
          status?: number;
          headers?: Record<string, unknown>;
          data?: unknown;
        };
      };
      if (value.status === 304) exchange.finish(304);
      else
        exchange.fail(error, {
          status: value.response?.status,
          headers: value.response?.headers,
          body: value.response?.data,
        });
      throw error;
    }
  });
}
