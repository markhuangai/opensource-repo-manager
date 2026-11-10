import { createWriteStream } from "node:fs";
import { createApiDiagnostics, apiFailureId } from "../../logging/api.ts";
import { createKnownSecretChecker } from "../../logging/redact.ts";
import { observeArtifactHttp } from "./artifact-http.ts";

if (process.getuid?.() !== 0) throw new Error("supervisor_requires_root");
process.umask(0o077);
const output = createWriteStream("/dev/null", { fd: 3 });
const diagnosticOutput = createWriteStream("/dev/null", { fd: 4 });
const diagnostics = createApiDiagnostics(
  createKnownSecretChecker([
    process.env.ACTIONS_RUNTIME_TOKEN ?? "",
    process.env.ORM_ARTIFACT_TOKEN ?? "",
  ]),
  {},
  (line) => {
    diagnosticOutput.write(line + "\n");
  },
);
let exchange: ReturnType<typeof diagnostics.start> | undefined;
let restore: (() => void) | undefined;
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new Error("request_limit");
  }
  const request = JSON.parse(input) as {
    operation: "upload" | "download" | "list";
    name: string;
    directory: string;
    path: string;
    id: number;
    digest: string;
    run: number;
  };
  exchange = diagnostics.start("artifact", request.operation);
  restore = observeArtifactHttp(diagnostics, exchange.id);
  const { DefaultArtifactClient } = await import("@actions/artifact");
  const client = new DefaultArtifactClient();
  let result: unknown;
  if (request.operation === "upload") {
    result = await client.uploadArtifact(
      request.name,
      [request.path],
      request.directory,
      { retentionDays: 14, skipArchive: true },
    );
  } else if (request.operation === "download") {
    const [repositoryOwner, repositoryName] =
      process.env.GITHUB_REPOSITORY!.split("/");
    result = await client.downloadArtifact(request.id, {
      path: request.directory,
      skipDecompress: true,
      expectedHash: `sha256:${request.digest}`,
      findBy: {
        token: process.env.ORM_ARTIFACT_TOKEN!,
        repositoryOwner,
        repositoryName,
        workflowRunId: request.run,
      },
    });
  } else if (request.operation === "list") {
    const listed = await client.listArtifacts();
    result = { count: listed.artifacts.length };
  } else throw new Error("request_invalid");
  output.end(JSON.stringify({ result }));
  exchange.finish();
} catch (error) {
  exchange?.fail(error);
  output.end(
    JSON.stringify({
      error: "session_transport_unavailable",
      request_id: apiFailureId(error),
    }),
  );
  process.exitCode = 1;
} finally {
  restore?.();
  diagnosticOutput.end();
}
