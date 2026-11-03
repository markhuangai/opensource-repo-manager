import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { PublicationGit } from "../../adapters/github/git.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import { digest, RuntimeError } from "../../domain/agents.ts";
import type { Store } from "../../repositories/store.ts";
import { rootDirectory } from "../workspaces/files.ts";
import { publicationText } from "../publication/scanner.ts";
import type { SourceMetadata } from "../../domain/jobs.ts";
import type { InvestigationPlan } from "./contracts.ts";

export async function resolveSourceEvidence(
  store: Store,
  secrets: SecretAccessor,
  root: string,
  binding: {
    job_id: number;
    revision: number;
    snapshot_digest: string;
    source: SourceMetadata;
    repository: string;
  },
  references: InvestigationPlan["citations"],
  limit: number,
  signal: AbortSignal,
  sourceUrl?: (repository: string) => string,
) {
  const job = store.jobById(binding.job_id);
  if (
    !job ||
    job.revision !== binding.revision ||
    job.snapshot_digest !== binding.snapshot_digest ||
    digest((JSON.parse(job.input_json) as { source: unknown }).source) !==
      digest(binding.source)
  )
    throw new RuntimeError("revision_stale");
  let directory: string | undefined, git: PublicationGit | undefined;
  const result: unknown[] = [];
  try {
    for (const reference of references) {
      signal.throwIfAborted();
      if (reference.end_line < reference.start_line)
        throw new RuntimeError("investigation_evidence_range_invalid");
      if (!git) {
        await rootDirectory(root);
        directory = await mkdtemp(join(root, "evidence-"));
        await rmdir(directory);
        git = new PublicationGit(
          directory,
          secrets,
          binding.repository,
          sourceUrl,
        );
        await git.initialize(binding.source.sha, signal);
        const tree = (
          await git.command(
            ["rev-parse", `${binding.source.sha}^{tree}`],
            signal,
          )
        )
          .toString()
          .trim();
        if (tree !== binding.source.tree_sha)
          throw new RuntimeError("investigation_evidence_mismatch");
      }
      const listing = (
        await git.command(
          [
            "--literal-pathspecs",
            "ls-tree",
            "-z",
            binding.source.sha,
            "--",
            reference.path,
          ],
          signal,
        )
      )
        .toString()
        .split("\0")
        .filter(Boolean);
      if (listing.length !== 1)
        throw new RuntimeError("investigation_evidence_path_invalid");
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(
        listing[0],
      );
      if (!match || match[3] !== reference.path)
        throw new RuntimeError("investigation_evidence_path_invalid");
      const size = Number(
        (await git.command(["cat-file", "-s", match[2]], signal)).toString(),
      );
      if (!Number.isSafeInteger(size) || size > limit)
        throw new RuntimeError("investigation_evidence_limit");
      const text = publicationText(
          await git.command(["cat-file", "blob", match[2]], signal),
          reference.path,
        ),
        lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (reference.end_line > lines.length)
        throw new RuntimeError("investigation_evidence_range_invalid");
      result.push({
        ...reference,
        source: binding.source,
        text: lines
          .slice(reference.start_line - 1, reference.end_line)
          .join("\n"),
      });
      if (Buffer.byteLength(JSON.stringify(result)) > limit)
        throw new RuntimeError("investigation_evidence_limit");
    }
    return result;
  } finally {
    if (directory) await rm(directory, { recursive: true });
  }
}
