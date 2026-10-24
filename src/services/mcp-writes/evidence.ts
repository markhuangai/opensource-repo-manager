import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { PublicationGit } from "../../adapters/github/git.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import { digest, RuntimeError } from "../../domain/agents.ts";
import type { Store } from "../../repositories/store.ts";
import { PublicationRepository } from "../../repositories/publication.ts";
import { InvestigationRepository } from "../../repositories/investigation.ts";
import { PrMonitorRepository } from "../../repositories/pr-monitor.ts";
import { rootDirectory } from "../workspaces/files.ts";
import { publicationText } from "../publication/scanner.ts";
import type { ReviewedWriteInput, WriteBinding } from "./contracts.ts";

export async function resolveWriteEvidence(
  store: Store,
  secrets: SecretAccessor,
  root: string,
  binding: Pick<
    WriteBinding,
    | "job_id"
    | "revision"
    | "snapshot_digest"
    | "source"
    | "artifact_digest"
    | "repository"
  >,
  references: ReviewedWriteInput["evidence"],
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
      if (reference.kind === "job")
        result.push({
          kind: "job",
          job_id: job.id,
          revision: job.revision,
          context: JSON.parse(job.input_json) as unknown,
        });
      else if (reference.kind === "publication_evidence") {
        const evidence = new PublicationRepository(store).evidence(
          reference.id,
        );
        if (
          evidence.job_id !== job.id ||
          evidence.revision !== job.revision ||
          evidence.source_sha !== binding.source.sha ||
          evidence.artifact_digest !== binding.artifact_digest
        )
          throw new RuntimeError("mcp_write_evidence_mismatch");
        const artifact = store.artifact(
          evidence.artifact_digest,
          job.id,
          job.revision,
        );
        if (digest(artifact.source) !== digest(binding.source))
          throw new RuntimeError("mcp_write_evidence_mismatch");
        result.push({
          kind: reference.kind,
          id: reference.id,
          receipt: evidence,
        });
      } else if (reference.kind === "pr_monitor_evidence") {
        const monitors = new PrMonitorRepository(store),
          evidence = monitors.readiness(reference.id);
        const record = monitors.get(job.id);
        if (
          evidence.job_id !== job.id ||
          evidence.revision !== job.revision ||
          !record ||
          monitors.implementation(record).artifact_digest !==
            binding.artifact_digest
        )
          throw new RuntimeError("mcp_write_evidence_mismatch");
        result.push({
          kind: reference.kind,
          id: reference.id,
          receipt: evidence,
        });
      } else if (reference.kind === "investigation_evidence") {
        result.push({
          kind: reference.kind,
          id: reference.id,
          receipt: new InvestigationRepository(store).evidence(
            reference.id,
            job.id,
            job.revision,
            binding.source,
          ),
        });
      } else {
        if (reference.end_line < reference.start_line)
          throw new RuntimeError("mcp_write_evidence_range_invalid");
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
            throw new RuntimeError("mcp_write_evidence_mismatch");
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
          throw new RuntimeError("mcp_write_evidence_path_invalid");
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(
          listing[0],
        );
        if (!match || match[3] !== reference.path)
          throw new RuntimeError("mcp_write_evidence_path_invalid");
        const size = Number(
          (await git.command(["cat-file", "-s", match[2]], signal)).toString(),
        );
        if (!Number.isSafeInteger(size) || size > limit)
          throw new RuntimeError("mcp_write_evidence_limit");
        const text = publicationText(
            await git.command(["cat-file", "blob", match[2]], signal),
            reference.path,
          ),
          lines = text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        if (reference.end_line > lines.length)
          throw new RuntimeError("mcp_write_evidence_range_invalid");
        result.push({
          ...reference,
          source: binding.source,
          text: lines
            .slice(reference.start_line - 1, reference.end_line)
            .join("\n"),
        });
      }
      if (Buffer.byteLength(JSON.stringify(result)) > limit)
        throw new RuntimeError("mcp_write_evidence_limit");
    }
    return result;
  } finally {
    if (directory) await rm(directory, { recursive: true });
  }
}
