import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { RunSnapshot } from "../config/load.ts";
import type { SecretAccessor } from "../config/secrets.ts";
import {
  artifactManifestSchema,
  digest,
  workerLimits,
  type ArtifactManifest,
} from "../domain/agents.ts";
import { ActionsRepository } from "../repositories/actions.ts";
import { Store } from "../repositories/store.ts";
import { userProcesses } from "../runtime/process.ts";
import {
  WorkspaceService,
  validateArtifactLinks,
} from "../services/workspaces/index.ts";
import { rootDirectory } from "../services/workspaces/files.ts";
import type { ArtifactTransport } from "../adapters/github/artifacts.ts";
import type { ActionsContext } from "./context.ts";
import {
  fileDigest,
  openBundle,
  runtimeDigest,
  sealBundle,
  type ArtifactReference,
  type BundleIdentity,
} from "./bundle.ts";
import {
  StateCodec,
  StateError,
  type StateComment,
  type TaskState,
} from "./state.ts";

const sessionSchema = z.strictObject({
  checkpoint: z.strictObject({
    binding: z.string().regex(/^[a-f0-9]{64}$/),
    session: z.string().min(1).max(1024),
    workspace: artifactManifestSchema,
    transcript: artifactManifestSchema,
    conversation: z
      .strictObject({ version: z.literal(1), id: z.uuid() })
      .optional(),
  }),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
type Session = z.infer<typeof sessionSchema>;

export class ActionsArtifacts {
  readonly workspaces: WorkspaceService;
  private readonly bases = new Map<string, ArtifactManifest>();
  private readonly limit: number;
  constructor(
    readonly context: ActionsContext,
    private readonly snapshot: RunSnapshot,
    private readonly secrets: SecretAccessor,
    root: string,
    private readonly transport: ArtifactTransport,
    sourceUrl?: (repository: string) => string,
  ) {
    this.workspaces = new WorkspaceService(root, secrets, sourceUrl);
    this.limit = workerLimits(snapshot).storage;
  }

  async initialize(signal: AbortSignal) {
    await this.workspaces.initialize();
    await rootDirectory(join(this.workspaces.privateRoot, "checkpoints"));
    const directory = await this.temporary();
    try {
      await this.transport.verify(directory, signal);
    } finally {
      await rm(directory, { recursive: true });
    }
  }

  private temporary() {
    return mkdtemp(join(this.workspaces.privateRoot, "checkpoints", "stage-"));
  }

  private async idle(store: Store) {
    if (
      store.leases().length ||
      store.runs().some((run) => run.finished_at === null)
    )
      throw new StateError("session_checkpoint_busy");
    for (const uid of [10001, 10002, 10003])
      if ((await userProcesses(uid)).length)
        throw new StateError("session_checkpoint_busy");
  }

  private manifests(store: Store) {
    return (
      store.db
        .prepare("SELECT digest,manifest_json FROM artifacts ORDER BY digest")
        .all() as { digest: string; manifest_json: string }[]
    ).map((row) => {
      const manifest = JSON.parse(row.manifest_json) as ArtifactManifest;
      artifactManifestSchema.parse(manifest);
      validateArtifactLinks(manifest.files);
      if (digest(manifest) !== row.digest)
        throw new StateError("session_corrupt");
      return { digest: row.digest, manifest };
    });
  }

  private sessionRuns(store: Store) {
    return store
      .runs()
      .filter(
        (run) =>
          run.uid === 10001 &&
          run.session_id &&
          run.finished_at !== null &&
          ["completed", "limited"].includes(run.status) &&
          store.sessionRun(run.job_id, run.revision, run.role, run.session_id)
            ?.id === run.id,
      );
  }

  private session(
    content: string,
    run: ReturnType<Store["runs"]>[number],
  ): Session {
    if (Buffer.byteLength(content) > 16 * 1024 * 1024)
      throw new StateError("session_size_limit");
    const saved = JSON.parse(content) as Session;
    const result = sessionSchema.safeParse(saved);
    if (!result.success) throw new StateError("session_schema_unsupported");
    const checkpoint = saved.checkpoint;
    for (const manifest of [checkpoint.workspace, checkpoint.transcript]) {
      validateArtifactLinks(manifest.files);
      if (
        manifest.run_id !== run.id ||
        manifest.job_id !== run.job_id ||
        manifest.revision !== run.revision
      )
        throw new StateError("session_corrupt");
    }
    if (
      saved.digest !== digest(checkpoint) ||
      checkpoint.session !== run.session_id ||
      checkpoint.binding !== JSON.parse(run.binding_json).binding ||
      digest(checkpoint.workspace.source) !==
        digest(checkpoint.transcript.source) ||
      checkpoint.transcript.files.some((file) => file.kind !== "file")
    )
      throw new StateError("session_corrupt");
    return saved;
  }

  private async sourceBlobs(
    manifests: ArtifactManifest[],
    signal: AbortSignal,
  ) {
    const blobs = new Set<string>();
    for (const manifest of manifests) {
      const identity = digest(manifest.source);
      let base = this.bases.get(identity);
      if (!base) {
        base = await this.workspaces.sourceManifest(
          manifest,
          this.snapshot,
          signal,
        );
        this.bases.set(identity, base);
      }
      for (const file of base.files)
        if (file.kind === "file") blobs.add(file.digest);
    }
    return blobs;
  }

  private async scan(path: string, signal: AbortSignal) {
    const checker = this.secrets.createCredentialStream(),
      decoder = new TextDecoder();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        signal.throwIfAborted();
        size += (chunk as Buffer).length;
        if (size > this.limit) throw new StateError("session_size_limit");
        if (checker.push(decoder.decode(chunk as Buffer, { stream: true })))
          throw new StateError("session_secret");
      }
      if (checker.push(decoder.decode()))
        throw new StateError("session_secret");
    } finally {
      await file.close();
    }
  }

  async capture(
    store: Store,
    state: TaskState,
    signal: AbortSignal,
  ): Promise<ArtifactReference | undefined> {
    if (!state.job) return;
    await this.idle(store);
    const directory = await this.temporary();
    try {
      const manifests = this.manifests(store),
        sessions: Array<{ run: string; path: string; saved: Session }> = [];
      for (const run of this.sessionRuns(store)) {
        const path = join(
          this.workspaces.privateRoot,
          "sessions",
          run.id,
          "checkpoint.json",
        );
        await fileDigest(path, 16 * 1024 * 1024, signal);
        sessions.push({
          run: run.id,
          path,
          saved: this.session(await readFile(path, "utf8"), run),
        });
      }
      const sourceBlobs = await this.sourceBlobs(
        [
          ...manifests.map((item) => item.manifest),
          ...sessions.map((item) => item.saved.checkpoint.workspace),
        ],
        signal,
      );
      const blobs = new Set<string>();
      for (const manifest of [
        ...manifests.map((item) => item.manifest),
        ...sessions.flatMap((item) => [
          item.saved.checkpoint.workspace,
          item.saved.checkpoint.transcript,
        ]),
      ])
        for (const file of manifest.files)
          if (file.kind === "file" && !sourceBlobs.has(file.digest))
            blobs.add(file.digest);
      const database = join(directory, "database.sqlite");
      await store.db.backup(database);
      await chmod(database, 0o600);
      const files = [
        { name: "database.sqlite", path: database },
        ...sessions.map((item) => ({
          name: `sessions/${item.run}.json`,
          path: item.path,
        })),
        ...[...blobs].sort().map((blob) => ({
          name: `blobs/${blob}`,
          path: join(this.workspaces.privateRoot, "blobs", blob),
        })),
      ];
      for (const file of files) await this.scan(file.path, signal);
      const identity: BundleIdentity = {
        version: 1,
        repository_id: state.repository.id,
        issue_id: state.issue.id,
        task_id: state.task_id,
        checkpoint_id: randomUUID(),
        generation: state.generation,
        state_digest: digest(state),
        snapshot_digest: this.snapshot.digest,
        runtime_digest: runtimeDigest(),
        run_id: this.context.run_id,
        run_attempt: this.context.run_attempt,
      };
      const upload = join(directory, "upload");
      await mkdir(upload, { mode: 0o700 });
      const destination = join(
        upload,
        `orm-session-${identity.checkpoint_id}.orm`,
      );
      await sealBundle({
        identity,
        files,
        destination,
        secret: this.secrets.get("actions.session_key"),
        limit: this.limit,
        signal,
      });
      return await this.transport.upload(
        destination,
        identity,
        this.limit,
        signal,
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  }

  private async install(from: string, to: string, signal: AbortSignal) {
    const expected = await fileDigest(from, this.limit, signal);
    try {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, 0o400);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const actual = await fileDigest(to, this.limit, signal);
    if (actual.digest !== expected.digest || actual.size !== expected.size)
      throw new StateError("session_corrupt");
  }

  async restore(
    store: Store,
    current: StateComment,
    signal: AbortSignal,
  ): Promise<"none" | "restored" | "expired"> {
    const state = current.state,
      reference = state.session_artifact;
    if (!reference) return "none";
    if (
      reference.repository_id !== state.repository.id ||
      reference.issue_id !== state.issue.id ||
      reference.task_id !== state.task_id ||
      reference.generation >= state.generation ||
      reference.snapshot_digest !== this.snapshot.digest ||
      reference.runtime_digest !== runtimeDigest()
    )
      throw new StateError("session_incompatible");
    if (new ActionsRepository(store).local()) return "none";
    if (store.jobs().length) throw new StateError("state_local_conflict");
    await this.idle(store);
    const directory = await this.temporary();
    let checkpoint: Store | undefined;
    try {
      const download = join(directory, "download");
      await mkdir(download, { mode: 0o700 });
      const path = await this.transport.download(
        reference,
        download,
        this.limit,
        signal,
      );
      if (!path) return "expired";
      const files = await openBundle({
        path,
        reference,
        directory,
        secret: this.secrets.get("actions.session_key"),
        limit: this.limit,
        signal,
      });
      const database = files.get("database.sqlite")!;
      const inspected = new Database(database, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        if (
          inspected.pragma("user_version", { simple: true }) !==
            store.db.pragma("user_version", { simple: true }) ||
          inspected.pragma("quick_check", { simple: true }) !== "ok"
        )
          throw new StateError("session_schema_unsupported");
      } finally {
        inspected.close();
      }
      checkpoint = new Store(database);
      await this.idle(checkpoint);
      const local = new ActionsRepository(checkpoint).local();
      if (!local || local.intent) throw new StateError("session_corrupt");
      const archived = new StateCodec(
        this.secrets.get("actions.session_key"),
      ).decode(local.body, {
        repository_id: state.repository.id,
        issue_id: state.issue.id,
        comment_id: state.comment_id!,
        author_id: state.author_id,
      }).state;
      if (
        archived.task_id !== state.task_id ||
        archived.generation !== reference.generation ||
        digest(archived) !== reference.state_digest ||
        checkpoint.jobs().length !== 1 ||
        !archived.job ||
        !state.job ||
        digest({
          ...archived.job,
          phase: state.job.phase,
          status: state.job.status,
        }) !== digest(state.job) ||
        (archived.scope_digest !== null &&
          archived.scope_digest !== state.scope_digest)
      )
        throw new StateError("session_incompatible");
      for (const [name, value] of Object.entries(archived.budget))
        if (
          typeof value === "number" &&
          value > (state.budget[name as keyof typeof state.budget] as number)
        )
          throw new StateError("state_conflict");
      if (
        (state.pending &&
          !checkpoint.db
            .prepare("SELECT 1 FROM publication_operations WHERE id=?")
            .get(state.pending.id)) ||
        (state.pull && !archived.pull) ||
        (state.head && !archived.head && !state.pending)
      )
        throw new StateError("recovery_evidence_missing");
      const manifests = this.manifests(checkpoint),
        sessions: Array<{ run: string; saved: Session; path: string }> = [];
      for (const run of this.sessionRuns(checkpoint)) {
        const sessionPath = files.get(`sessions/${run.id}.json`);
        if (!sessionPath) throw new StateError("session_corrupt");
        sessions.push({
          run: run.id,
          saved: this.session(await readFile(sessionPath, "utf8"), run),
          path: sessionPath,
        });
      }
      const sourceBlobs = await this.sourceBlobs(
        [
          ...manifests.map((item) => item.manifest),
          ...sessions.map((item) => item.saved.checkpoint.workspace),
        ],
        signal,
      );
      const needed = new Set<string>([
        "database.sqlite",
        ...sessions.map((item) => `sessions/${item.run}.json`),
      ]);
      for (const manifest of [
        ...manifests.map((item) => item.manifest),
        ...sessions.flatMap((item) => [
          item.saved.checkpoint.workspace,
          item.saved.checkpoint.transcript,
        ]),
      ])
        for (const file of manifest.files)
          if (file.kind === "file" && !sourceBlobs.has(file.digest))
            needed.add(`blobs/${file.digest}`);
      if (
        files.size !== needed.size ||
        [...files.keys()].some((name) => !needed.has(name))
      )
        throw new StateError("session_corrupt");
      for (const [name, source] of files) {
        await this.scan(source, signal);
        if (name.startsWith("blobs/")) {
          if (
            (await fileDigest(source, this.limit, signal)).digest !==
            name.slice(6)
          )
            throw new StateError("session_corrupt");
          await this.install(
            source,
            join(this.workspaces.privateRoot, name),
            signal,
          );
        }
      }
      for (const item of sessions) {
        const target = join(this.workspaces.privateRoot, "sessions", item.run);
        await rootDirectory(target);
        await this.install(item.path, join(target, "checkpoint.json"), signal);
      }
      for (const item of manifests) {
        const temporary = join(directory, `manifest-${item.digest}`);
        await writeFile(temporary, JSON.stringify(item.manifest), {
          mode: 0o600,
          flag: "wx",
        });
        await this.install(
          temporary,
          join(this.workspaces.privateRoot, "manifests", item.digest),
          signal,
        );
      }
      checkpoint.close();
      checkpoint = undefined;
      new ActionsRepository(store).importCheckpoint(database, current.body);
      return "restored";
    } finally {
      checkpoint?.close();
      await rm(directory, { recursive: true });
    }
  }
}
