import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, join, parse, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { immutable } from "../config/bundles.ts";
import type { RunSnapshot } from "../config/load.ts";
import {
  budgetUsage,
  initialBudget,
  IntakeError,
  type BudgetUsage,
  type DirtyTarget,
  type IssueContext,
  type Job,
  type Publication,
  type PullContext,
  type RepositoryIdentity,
  type Target,
} from "../domain/jobs.ts";

function inputJson(context: IssueContext | PullContext) {
  // Owned comments can change GitHub timestamps without changing workflow inputs.
  return JSON.stringify({ ...context, updated_at: undefined });
}

function protectDatabase(path: string) {
  let current = parse(path).root;
  for (const part of relative(current, path).split("/")) {
    current = join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink())
      throw new IntakeError("storage_permissions");
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid!() ||
    parent.mode & 0o077
  )
    throw new IntakeError("storage_permissions");
  if (!existsSync(path)) {
    closeSync(
      openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_RDWR,
        0o600,
      ),
    );
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.uid !== process.getuid!() || file.mode & 0o077)
    throw new IntakeError("storage_permissions");
}

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    path = resolve(path);
    protectDatabase(path);
    this.db = new Database(path);
    try {
      const version = this.db.pragma("user_version", { simple: true });
      if (version !== 0 && version !== 1)
        throw new IntakeError("schema_unsupported");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      if (version === 0)
        this.db
          .transaction(() =>
            this.db.exec(`
        CREATE TABLE repository (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          id INTEGER NOT NULL UNIQUE, full_name TEXT NOT NULL,
          default_branch TEXT NOT NULL, private INTEGER NOT NULL
        );
        CREATE TABLE snapshots (digest TEXT PRIMARY KEY, content TEXT NOT NULL);
        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL UNIQUE,
          issue_number INTEGER NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 1,
          phase TEXT NOT NULL DEFAULT 'investigation',
          status TEXT NOT NULL CHECK(status IN ('pending','closed')),
          input_digest TEXT NOT NULL, input_json TEXT NOT NULL,
          snapshot_digest TEXT NOT NULL REFERENCES snapshots(digest),
          budget_json TEXT NOT NULL
        );
        CREATE TABLE inbox (
          delivery_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL,
          event TEXT NOT NULL, received_at INTEGER NOT NULL, processed INTEGER NOT NULL
        );
        CREATE TABLE dirty (
          kind TEXT NOT NULL CHECK(kind IN ('issue','pull')), number INTEGER NOT NULL,
          generation INTEGER NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0,
          failure_code TEXT, PRIMARY KEY(kind,number)
        );
        CREATE TABLE delivery_targets (
          delivery_id TEXT NOT NULL REFERENCES inbox(delivery_id),
          kind TEXT NOT NULL, number INTEGER NOT NULL, generation INTEGER NOT NULL,
          done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(delivery_id,kind,number)
        );
        CREATE TABLE reconciliation (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), page INTEGER NOT NULL,
          last_completed_at INTEGER, generation INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO reconciliation(singleton,page) VALUES(1,1);
        CREATE TABLE coding_lease (
          slot INTEGER PRIMARY KEY CHECK(slot=1), job_id INTEGER NOT NULL REFERENCES jobs(id),
          revision INTEGER NOT NULL, token TEXT NOT NULL UNIQUE
        );
        CREATE TABLE publications (
          operation_key TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
          revision INTEGER NOT NULL, kind TEXT NOT NULL, object_id TEXT NOT NULL,
          number INTEGER, head_sha TEXT, receipt_json TEXT NOT NULL, context_json TEXT,
          UNIQUE(kind,object_id)
        );
        PRAGMA user_version = 1;
      `),
          )
          .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  repository(): RepositoryIdentity | undefined {
    const row = this.db
      .prepare(
        "SELECT id,full_name,default_branch,private FROM repository WHERE singleton=1",
      )
      .get() as
      (Omit<RepositoryIdentity, "private"> & { private: number }) | undefined;
    return row && { ...row, private: Boolean(row.private) };
  }

  enroll(repository: RepositoryIdentity) {
    this.db
      .transaction(() => {
        const previous = this.repository();
        if (previous && previous.id !== repository.id)
          throw new IntakeError("repository_changed");
        this.db
          .prepare(
            `INSERT INTO repository VALUES(1,@id,@full_name,@default_branch,@private)
        ON CONFLICT(singleton) DO UPDATE SET full_name=excluded.full_name,
        default_branch=excluded.default_branch, private=excluded.private`,
          )
          .run({ ...repository, private: Number(repository.private) });
      })
      .immediate();
  }

  saveSnapshot(snapshot: RunSnapshot) {
    this.db
      .prepare("INSERT OR IGNORE INTO snapshots VALUES(?,?)")
      .run(snapshot.digest, JSON.stringify(snapshot));
  }

  snapshot(digest: string): RunSnapshot {
    const row = this.db
      .prepare("SELECT content FROM snapshots WHERE digest=?")
      .get(digest) as { content: string } | undefined;
    if (!row) throw new IntakeError("snapshot_missing");
    return immutable(JSON.parse(row.content) as RunSnapshot);
  }

  private markDirty(target: Target): number {
    const { generation } = this.db
      .prepare(
        "UPDATE reconciliation SET generation=generation+1 WHERE singleton=1 RETURNING generation",
      )
      .get() as { generation: number };
    this.db
      .prepare(
        `INSERT INTO dirty(kind,number,generation) VALUES(@kind,@number,@generation)
      ON CONFLICT(kind,number) DO UPDATE SET generation=excluded.generation`,
      )
      .run({ ...target, generation });
    return generation;
  }

  accept(
    delivery: string,
    payloadDigest: string,
    event: string,
    targets: Target[],
  ) {
    return this.db
      .transaction(() => {
        const previous = this.db
          .prepare("SELECT payload_digest,event FROM inbox WHERE delivery_id=?")
          .get(delivery) as
          { payload_digest: string; event: string } | undefined;
        if (previous) {
          if (
            previous.payload_digest !== payloadDigest ||
            previous.event !== event
          )
            throw new IntakeError("delivery_conflict");
          return false;
        }
        this.db
          .prepare("INSERT INTO inbox VALUES(?,?,?,?,?)")
          .run(
            delivery,
            payloadDigest,
            event,
            Date.now(),
            Number(targets.length === 0),
          );
        for (const target of targets) {
          const generation = this.markDirty(target);
          this.db
            .prepare(
              "INSERT OR IGNORE INTO delivery_targets(delivery_id,kind,number,generation) VALUES(?,?,?,?)",
            )
            .run(delivery, target.kind, target.number, generation);
        }
        return true;
      })
      .immediate();
  }

  cursor() {
    return this.db
      .prepare(
        "SELECT page,last_completed_at FROM reconciliation WHERE singleton=1",
      )
      .get() as { page: number; last_completed_at: number | null };
  }

  discover(issues: number[], page: number, finished: boolean) {
    this.db
      .transaction(() => {
        for (const number of issues) this.markDirty({ kind: "issue", number });
        this.db
          .prepare(
            "UPDATE reconciliation SET page=?,last_completed_at=CASE WHEN ? THEN ? ELSE last_completed_at END WHERE singleton=1",
          )
          .run(finished ? 1 : page + 1, Number(finished), Date.now());
      })
      .immediate();
  }

  reconcileKnown() {
    this.db
      .transaction(() => {
        for (const job of this.jobs())
          this.markDirty({ kind: "issue", number: job.issue_number });
        for (const pull of this.ownedPulls())
          this.markDirty({ kind: "pull", number: pull.number! });
      })
      .immediate();
  }

  nextDirty(): DirtyTarget | undefined {
    return this.db
      .prepare(
        "SELECT kind,number,generation FROM dirty WHERE retry_at<=? ORDER BY rowid LIMIT 1",
      )
      .get(Date.now()) as DirtyTarget | undefined;
  }

  defer(target: DirtyTarget, code: string, retryAt: number) {
    this.db
      .prepare(
        "UPDATE dirty SET retry_at=@retryAt,failure_code=@code WHERE kind=@kind AND number=@number AND generation=@generation",
      )
      .run({ ...target, code, retryAt });
  }

  nextRetry(): number | undefined {
    const row = this.db
      .prepare("SELECT min(retry_at) AS retry_at FROM dirty WHERE retry_at>0")
      .get() as { retry_at: number | null };
    return row.retry_at ?? undefined;
  }

  private complete(target: DirtyTarget) {
    this.db
      .prepare(
        "DELETE FROM dirty WHERE kind=@kind AND number=@number AND generation=@generation",
      )
      .run(target);
    this.db
      .prepare(
        "UPDATE delivery_targets SET done=1 WHERE kind=@kind AND number=@number AND generation<=@generation",
      )
      .run(target);
    this.db
      .prepare(
        `UPDATE inbox SET processed=1 WHERE processed=0 AND NOT EXISTS
      (SELECT 1 FROM delivery_targets WHERE delivery_targets.delivery_id=inbox.delivery_id AND done=0)`,
      )
      .run();
  }

  private isCurrent(target: DirtyTarget) {
    const row = this.db
      .prepare(
        "SELECT generation FROM dirty WHERE kind=@kind AND number=@number",
      )
      .get(target) as { generation: number } | undefined;
    return row?.generation === target.generation;
  }

  applyIssue(
    target: DirtyTarget,
    context: IssueContext,
    snapshot: RunSnapshot,
  ) {
    return this.db
      .transaction(() => {
        if (!this.isCurrent(target)) return false;
        const previous = this.job(context.number);
        if (previous && previous.issue_id !== context.id)
          throw new IntakeError("issue_identity_changed");
        if (previous || context.state === "open") {
          const input = inputJson(context);
          const inputDigest = createHash("sha256").update(input).digest("hex");
          const status = context.state === "open" ? "pending" : "closed";
          this.db
            .prepare(
              `INSERT INTO jobs(issue_id,issue_number,status,input_digest,input_json,snapshot_digest,budget_json)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(issue_number) DO UPDATE SET
          revision=jobs.revision+1,status=excluded.status,input_digest=excluded.input_digest,input_json=excluded.input_json
          WHERE jobs.input_digest<>excluded.input_digest OR jobs.status<>excluded.status`,
            )
            .run(
              context.id,
              context.number,
              status,
              inputDigest,
              input,
              snapshot.digest,
              JSON.stringify(initialBudget),
            );
        }
        this.complete(target);
        return true;
      })
      .immediate();
  }

  applyPull(target: DirtyTarget, context: PullContext) {
    return this.db
      .transaction(() => {
        if (!this.isCurrent(target)) return false;
        const previous = this.ownedPull(target.number);
        if (!previous || previous.object_id !== String(context.id))
          throw new IntakeError("pull_not_owned");
        const input = inputJson(context);
        if (input !== previous.context_json) {
          this.db
            .prepare(
              "UPDATE publications SET head_sha=?,context_json=? WHERE operation_key=?",
            )
            .run(context.head_sha, input, previous.operation_key);
          this.db
            .prepare("UPDATE jobs SET revision=revision+1 WHERE id=?")
            .run(previous.job_id);
        }
        this.complete(target);
        return true;
      })
      .immediate();
  }

  jobs(): Job[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY id").all() as Job[];
  }
  job(number: number): Job | undefined {
    return this.db
      .prepare("SELECT * FROM jobs WHERE issue_number=?")
      .get(number) as Job | undefined;
  }

  acquireLease(jobId: number, revision: number): string | undefined {
    const token = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO coding_lease SELECT 1,id,revision,?
      FROM jobs WHERE id=? AND revision=? AND status='pending'`,
      )
      .run(token, jobId, revision);
    return result.changes ? token : undefined;
  }

  releaseLease(token: string) {
    return (
      this.db.prepare("DELETE FROM coding_lease WHERE token=?").run(token)
        .changes === 1
    );
  }

  updateBudget(
    jobId: number,
    revision: number,
    token: string,
    usage: BudgetUsage,
  ) {
    const parsed = budgetUsage.parse(usage);
    return (
      this.db
        .prepare(
          `UPDATE jobs SET budget_json=? WHERE id=? AND revision=? AND EXISTS
      (SELECT 1 FROM coding_lease WHERE job_id=jobs.id AND revision=jobs.revision AND token=?)`,
        )
        .run(JSON.stringify(parsed), jobId, revision, token).changes === 1
    );
  }

  recordPublication(record: Omit<Publication, "context_json">) {
    this.db
      .transaction(() => {
        const job = this.db
          .prepare("SELECT revision FROM jobs WHERE id=?")
          .get(record.job_id) as { revision: number } | undefined;
        if (job?.revision !== record.revision)
          throw new IntakeError("revision_stale");
        const previous = this.db
          .prepare("SELECT * FROM publications WHERE operation_key=?")
          .get(record.operation_key) as Publication | undefined;
        if (previous) {
          if (
            Object.entries(record).some(
              ([key, value]) => previous[key as keyof Publication] !== value,
            )
          )
            throw new IntakeError("publication_conflict");
          return;
        }
        this.db
          .prepare(
            `INSERT INTO publications(operation_key,job_id,revision,kind,object_id,number,head_sha,receipt_json)
        VALUES(@operation_key,@job_id,@revision,@kind,@object_id,@number,@head_sha,@receipt_json)`,
          )
          .run(record);
      })
      .immediate();
  }

  owns(kind: Publication["kind"], id: number) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM publications WHERE kind=? AND object_id=?")
        .get(kind, String(id)),
    );
  }
  ownedPull(number: number): Publication | undefined {
    return this.db
      .prepare(
        "SELECT * FROM publications WHERE kind='pull_request' AND number=?",
      )
      .get(number) as Publication | undefined;
  }
  ownedPulls(): Publication[] {
    return this.db
      .prepare("SELECT * FROM publications WHERE kind='pull_request'")
      .all() as Publication[];
  }
  counts() {
    return {
      pending: (
        this.db
          .prepare("SELECT count(*) AS n FROM jobs WHERE status='pending'")
          .get() as { n: number }
      ).n,
      inbox: (
        this.db
          .prepare("SELECT count(*) AS n FROM inbox WHERE processed=0")
          .get() as { n: number }
      ).n,
      failed: (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM dirty WHERE failure_code IS NOT NULL",
          )
          .get() as { n: number }
      ).n,
    };
  }
}
