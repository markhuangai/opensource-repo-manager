import { Octokit } from "@octokit/rest";
import { createHash } from "node:crypto";
import { z } from "zod";
import { githubId, sha, type RepositoryIdentity } from "../../domain/jobs.ts";
import { StateError } from "../../actions/state.ts";
import { OctokitReader } from "./reader.ts";
import { OctokitWriter } from "./writer.ts";

const treeEntry = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha,
  size: z.number().int().nonnegative().optional(),
});
export type ActionsSourceFile = z.infer<typeof treeEntry>;

export class GitHubActionsSource extends OctokitWriter {
  readonly reader: OctokitReader;
  private readonly sourceCoordinates: { owner: string; repo: string };
  constructor(
    repository: string,
    private readonly api: Octokit,
  ) {
    super(repository, api, () => {});
    this.reader = new OctokitReader(repository, api);
    const [owner, repo] = repository.split("/");
    this.sourceCoordinates = { owner, repo };
  }

  async files(repository: RepositoryIdentity, signal: AbortSignal) {
    const source = await this.reader.source(repository.default_branch, signal);
    const result = z
      .object({ truncated: z.boolean(), tree: z.array(treeEntry) })
      .parse(
        (
          await this.api.request(
            "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
            {
              ...this.sourceCoordinates,
              tree_sha: source.tree_sha,
              recursive: "1",
              request: {
                signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
                redirect: "error",
              },
            },
          )
        ).data,
      );
    if (result.truncated) throw new StateError("state_size_limit");
    return { source, files: result.tree };
  }

  async blob(file: ActionsSourceFile, signal: AbortSignal) {
    if (
      file.type !== "blob" ||
      !["100644", "100755"].includes(file.mode) ||
      file.size === undefined ||
      file.size > 1024 * 1024
    )
      throw new StateError("state_invalid");
    const result = z
      .object({
        encoding: z.literal("base64"),
        size: z
          .number()
          .int()
          .nonnegative()
          .max(1024 * 1024),
        content: z.string().max(2 * 1024 * 1024),
        sha,
      })
      .parse(
        (
          await this.api.request(
            "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
            {
              ...this.sourceCoordinates,
              file_sha: file.sha,
              request: {
                signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
                redirect: "error",
              },
            },
          )
        ).data,
      );
    const bytes = Buffer.from(result.content, "base64");
    if (
      result.sha !== file.sha ||
      bytes.length !== result.size ||
      result.size !== file.size ||
      createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex") !== file.sha
    )
      throw new StateError("state_invalid");
    return bytes;
  }

  async enrolled(signal: AbortSignal) {
    const numbers: number[] = [];
    for (let page = 1; ; page++) {
      const rows = z
        .array(
          z.object({ number: githubId, pull_request: z.unknown().optional() }),
        )
        .parse(
          (
            await this.api.request("GET /repos/{owner}/{repo}/issues", {
              ...this.sourceCoordinates,
              labels: "orm:managed",
              state: "all",
              sort: "created",
              direction: "asc",
              per_page: 100,
              page,
              request: {
                signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
                redirect: "error",
              },
            })
          ).data,
        );
      numbers.push(
        ...rows.filter((row) => !row.pull_request).map((row) => row.number),
      );
      if (rows.length < 100) return [...new Set(numbers)].sort((a, b) => a - b);
    }
  }
}
