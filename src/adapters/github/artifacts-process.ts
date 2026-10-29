import { createWriteStream } from "node:fs";
import { DefaultArtifactClient } from "@actions/artifact";

if (process.getuid?.() !== 0) throw new Error("supervisor_requires_root");
process.umask(0o077);
const output = createWriteStream("/dev/null", { fd: 3 });
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
} catch {
  output.end(JSON.stringify({ error: "session_transport_unavailable" }));
  process.exitCode = 1;
}
