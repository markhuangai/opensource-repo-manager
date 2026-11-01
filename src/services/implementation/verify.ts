import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  digest,
  RuntimeError,
  workerLimits,
  type ArtifactManifest,
} from "../../domain/agents.ts";
import type { Store } from "../../repositories/store.ts";
import type { Supervisor } from "../../runtime/supervisor.ts";
import { protectedPath } from "../../adapters/github/git.ts";
import {
  commandDirectory,
  dependencyExclusions,
} from "../bootstrap/environment.ts";
import { walkTree } from "../workspaces/files.ts";
import type { Implementation, VerificationReceipt } from "./contracts.ts";

export function artifactFiles(manifest: ArtifactManifest) {
  return digest(
    [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)),
  );
}

export function candidateChanges(
  base: ArtifactManifest,
  candidate: ArtifactManifest,
  paths: readonly string[],
) {
  if (digest(base.source) !== digest(candidate.source))
    throw new RuntimeError("artifact_source_mismatch");
  const before = new Map(base.files.map((file) => [file.path, file]));
  const after = new Map(candidate.files.map((file) => [file.path, file]));
  const changes = [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) =>
      digest(before.get(path) ?? null) !== digest(after.get(path) ?? null),
  );
  if (!changes.length) throw new RuntimeError("implementation_no_change");
  for (const path of changes) {
    if (protectedPath(path))
      throw new RuntimeError("publication_path_protected");
    if (!paths.some((scope) => path === scope || path.startsWith(scope + "/")))
      throw new RuntimeError("implementation_out_of_scope");
  }
  return changes;
}

export async function captureBaseline(
  supervisor: Supervisor,
  store: Store,
  jobId: number,
  signal: AbortSignal,
  publishedHead?: string,
) {
  const request = supervisor.request(jobId, "audit");
  return supervisor.withJobLease(request, signal, (lease) =>
    supervisor.bootstrapWorkspace(
      lease,
      request,
      async (workspace, runId) => {
        const manifest = await supervisor.workspaces.freeze(
          {
            run_id: runId,
            job_id: request.job_id,
            revision: request.revision,
            source: request.workspace.source,
          },
          workspace.workspace,
          workerLimits(store.snapshot(request.snapshot_digest)).storage,
          lease.signal,
        );
        return store.recordArtifact(manifest);
      },
      publishedHead,
    ),
  );
}

export async function assertWorkspace(
  workspace: string,
  manifest: ArtifactManifest,
) {
  const paths = manifest.files.map((file) => file.path),
    expected = new Set(paths),
    excluded = dependencyExclusions(paths);
  await walkTree(workspace, async (_path, reference, stat) => {
    if (reference.split("/").includes(".git") || excluded(reference))
      return false;
    if (!stat.isDirectory() && !expected.has(reference))
      throw new RuntimeError("implementation_source_mutated");
  });
  for (const file of manifest.files) {
    let parent = workspace;
    for (const part of file.path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new RuntimeError("implementation_source_mutated");
    }
    const path = join(workspace, file.path),
      stat = await lstat(path);
    if (file.kind === "link") {
      if (!stat.isSymbolicLink() || (await readlink(path)) !== file.target)
        throw new RuntimeError("implementation_source_mutated");
      continue;
    }
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o111 ? 0o755 : 0o644) !== file.mode
    )
      throw new RuntimeError("implementation_source_mutated");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      if (hash.digest("hex") !== file.digest)
        throw new RuntimeError("implementation_source_mutated");
    } finally {
      await handle.close();
    }
  }
}

export async function verifyCandidate(
  supervisor: Supervisor,
  store: Store,
  record: Implementation,
  signal: AbortSignal,
  save: (receipt: VerificationReceipt) => void,
) {
  if (
    !record.scope ||
    !record.scope_digest ||
    !record.artifact_digest ||
    !record.audit_id ||
    !record.candidate_bootstrap
  )
    throw new RuntimeError("implementation_audit_missing");
  const audit = record.audits.find((item) => item.id === record.audit_id);
  if (
    !audit?.result.approved ||
    audit.result.findings.length ||
    audit.result.scope_digest !== record.scope_digest ||
    audit.result.artifact_digest !== record.artifact_digest ||
    store.run(audit.run_id)?.status !== "completed"
  )
    throw new RuntimeError("implementation_audit_mismatch");
  const request = {
    ...supervisor.request(
      record.job_id,
      "audit",
      undefined,
      record.artifact_digest,
    ),
    bootstrap_receipt: record.candidate_bootstrap,
  };
  const bootstrap = supervisor.bootstrap.receipt(request);
  const manifest = store.artifact(
    record.artifact_digest,
    record.job_id,
    record.revision,
  );
  let receipt: VerificationReceipt | undefined;
  try {
    await supervisor.withJobLease(request, signal, (lease) =>
      supervisor.bootstrapWorkspace(
        lease,
        request,
        async (workspace, runId) => {
          receipt = {
            id: randomUUID(),
            job_id: record.job_id,
            revision: record.revision,
            scope_digest: record.scope_digest!,
            artifact_digest: record.artifact_digest!,
            source: record.source,
            audit_id: record.audit_id!,
            bootstrap_receipt: bootstrap.id,
            run_id: runId,
            environment: bootstrap.environment!,
            environment_digest: digest({
              plan: bootstrap.plan_digest,
              environment: bootstrap.environment,
              managers: bootstrap.manager_locks,
            }),
            commands: [],
            state: "running",
            started_at: Date.now(),
            finished_at: null,
            evidence_id: null,
          };
          save(receipt);
          await assertWorkspace(workspace.workspace, manifest);
          const setup = await supervisor.bootstrap.materialize(
            request,
            workspace,
            runId,
            lease.signal,
            (argv, cwd, environment, operation) =>
              supervisor.bootstrapCommand(
                lease,
                request,
                workspace,
                bootstrap.id,
                runId,
                argv,
                cwd,
                environment,
                operation,
              ),
          );
          await assertWorkspace(workspace.workspace, manifest);
          for (const [index, command] of record.scope!.checks.entries()) {
            const output = await supervisor.bootstrapCommand(
              lease,
              request,
              workspace,
              bootstrap.id,
              runId,
              command.argv,
              await commandDirectory(workspace.workspace, command.cwd),
              setup.environment,
              `implementation-test-${index}`,
              true,
            );
            const actual = store
              .bootstrapCommands(bootstrap.id)
              .filter(
                (item) => item.operation === `implementation-test-${index}`,
              )
              .at(-1);
            if (
              !actual ||
              actual.uid !== 10002 ||
              actual.finished_at === null ||
              actual.exit_code !== output.exit_code
            )
              throw new RuntimeError("implementation_test_receipt_missing");
            receipt.commands.push({ ...actual, cwd: command.cwd });
            save(receipt);
            await assertWorkspace(workspace.workspace, manifest);
            if (output.exit_code !== 0)
              throw new RuntimeError("implementation_test_failed");
          }
        },
      ),
    );
    if (!receipt || store.run(receipt.run_id)?.status !== "completed")
      throw new RuntimeError("implementation_test_receipt_missing");
    receipt.state = "passed";
    receipt.finished_at = Date.now();
    save(receipt);
    return receipt;
  } catch (error) {
    if (receipt) {
      receipt.state = signal.aborted ? "interrupted" : "failed";
      receipt.finished_at = Date.now();
      save(receipt);
    }
    throw error;
  }
}
