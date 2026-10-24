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
import type {
  BootstrapReceipt,
  CommandReceipt,
} from "../services/bootstrap/contracts.ts";
import {
  digest,
  RuntimeError,
  type AgentRunRecord,
  type ArtifactManifest,
  type McpCallReceipt,
} from "../domain/agents.ts";
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
      if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(version as number))
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
      if (version === 0 || version === 1)
        this.db
          .transaction(() =>
            this.db.exec(`
          CREATE TABLE runtime_leases (
            token TEXT PRIMARY KEY REFERENCES coding_lease(token) ON DELETE CASCADE,
            deadline INTEGER NOT NULL, accounted_at INTEGER NOT NULL
          );
          CREATE TABLE agent_runs (
            id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
            revision INTEGER NOT NULL, role TEXT NOT NULL, uid INTEGER NOT NULL,
            parent_id TEXT REFERENCES agent_runs(id), lease_token TEXT NOT NULL,
            binding_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
            session_id TEXT, artifact_digest TEXT,
            started_at INTEGER NOT NULL, finished_at INTEGER
          );
          CREATE UNIQUE INDEX occupied_agent_user ON agent_runs(uid) WHERE finished_at IS NULL;
          CREATE TABLE artifacts (
            digest TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id),
            job_id INTEGER NOT NULL REFERENCES jobs(id), revision INTEGER NOT NULL,
            manifest_json TEXT NOT NULL
          );
          PRAGMA user_version = 2;
        `),
          )
          .immediate();
      if (version === 0 || version === 1 || version === 2)
        this.db
          .transaction(() =>
            this.db.exec(`
          CREATE TABLE mcp_calls (
            id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id),
            job_id INTEGER NOT NULL REFERENCES jobs(id), revision INTEGER NOT NULL,
            role TEXT NOT NULL, alias TEXT NOT NULL, tool TEXT NOT NULL,
            credential_binding TEXT NOT NULL, policy_identity TEXT NOT NULL,
            catalog_identity TEXT NOT NULL, request_digest TEXT NOT NULL,
            result_digest TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
            outcome TEXT NOT NULL CHECK(outcome IN ('running','completed','tool_error','failed','cancelled','interrupted'))
          );
          PRAGMA user_version = 3;
        `),
          )
          .immediate();
      if ([0, 1, 2, 3].includes(version as number))
        this.db
          .transaction(() =>
            this.db.exec(`
          CREATE TABLE bootstrap_attempts (
            id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
            revision INTEGER NOT NULL, status TEXT NOT NULL, receipt_json TEXT NOT NULL
          );
          CREATE TABLE bootstrap_commands (
            id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES bootstrap_attempts(id),
            run_id TEXT, receipt_json TEXT NOT NULL
          );
          PRAGMA user_version = 4;
        `),
          )
          .immediate();
      if ([0, 1, 2, 3, 4].includes(version as number))
        this.db
          .transaction(() => {
            this.db.exec(`
            CREATE TABLE publication_instance (id TEXT PRIMARY KEY, retry_at INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE publication_evidence (id TEXT PRIMARY KEY, content TEXT NOT NULL);
            CREATE TABLE output_reviews (id TEXT PRIMARY KEY, content TEXT NOT NULL);
            CREATE TABLE publication_targets (job_id INTEGER PRIMARY KEY REFERENCES jobs(id), content TEXT NOT NULL);
            CREATE TABLE publication_operations (
              id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), status TEXT NOT NULL, content TEXT NOT NULL
            );
            CREATE UNIQUE INDEX pending_publication ON publication_operations(job_id)
              WHERE status NOT IN ('confirmed','blocked');
            PRAGMA user_version = 5;
          `);
            this.db
              .prepare("INSERT INTO publication_instance(id) VALUES(?)")
              .run(randomUUID());
          })
          .immediate();
      if ([0, 1, 2, 3, 4, 5].includes(version as number))
        this.db
          .transaction(() =>
            this.db.exec(`
          CREATE TABLE notification_events (id TEXT PRIMARY KEY, content TEXT NOT NULL, review_id TEXT);
          CREATE TABLE notification_deliveries (
            event_id TEXT NOT NULL REFERENCES notification_events(id), channel TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','dispatching','confirmed','failed','uncertain','held')),
            retry_at INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(event_id,channel)
          );
          CREATE INDEX notification_pending ON notification_deliveries(state,retry_at);
          CREATE TABLE notification_backoff (channel TEXT NOT NULL, binding TEXT NOT NULL, retry_at INTEGER NOT NULL, PRIMARY KEY(channel,binding));
          PRAGMA user_version = 6;
        `),
          )
          .immediate();
      if ((version as number) < 7)
        this.db
          .transaction(() =>
            this.db.exec(`
          CREATE TABLE mcp_write_operations (
            id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), revision INTEGER NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('proposed','rejected','dispatching','response_recorded','uncertain')),
            content TEXT NOT NULL
          );
          CREATE UNIQUE INDEX pending_mcp_write ON mcp_write_operations(job_id)
            WHERE state IN ('proposed','dispatching','uncertain');
          CREATE TABLE mcp_write_attempts (
            operation_id TEXT NOT NULL REFERENCES mcp_write_operations(id), number INTEGER NOT NULL,
            content TEXT NOT NULL, PRIMARY KEY(operation_id,number)
          );
          CREATE TABLE mcp_write_recovery_leases (
            token TEXT PRIMARY KEY REFERENCES coding_lease(token) ON DELETE CASCADE,
            operation_id TEXT NOT NULL UNIQUE REFERENCES mcp_write_operations(id)
          );
          PRAGMA user_version = 7;
        `),
          )
          .immediate();
      if ((version as number) < 8)
        this.db
          .transaction(() =>
            this.db.exec(`
          CREATE TABLE investigations (
            id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
            revision INTEGER NOT NULL, state TEXT NOT NULL, content TEXT NOT NULL,
            UNIQUE(job_id,revision)
          );
          CREATE TABLE investigation_evidence (
            id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
            revision INTEGER NOT NULL, content TEXT NOT NULL
          );
          CREATE TABLE mcp_read_results (id TEXT PRIMARY KEY REFERENCES mcp_calls(id), content TEXT NOT NULL);
          PRAGMA user_version = 8;
        `),
          )
          .immediate();
      if ((version as number) < 9)
        this.db
          .transaction(() =>
            this.db.exec(`
          CREATE TABLE implementations (
            id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
            revision INTEGER NOT NULL, state TEXT NOT NULL, content TEXT NOT NULL,
            UNIQUE(job_id,revision)
          );
          PRAGMA user_version = 9;
        `),
          )
          .immediate();
      if ((version as number) < 10)
        this.db
          .transaction(() =>
            this.db.exec(`
          CREATE TABLE pr_monitors (
            id TEXT PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
            state TEXT NOT NULL, content TEXT NOT NULL
          );
          CREATE TABLE pr_monitor_evidence (
            id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), content TEXT NOT NULL
          );
          CREATE TABLE pr_observations (
            job_id INTEGER NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 1, content TEXT NOT NULL,
            PRIMARY KEY(job_id,kind)
          );
          PRAGMA user_version = 10;
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

  saveBootstrap(receipt: BootstrapReceipt, lease: string) {
    if (
      !["blocked", "interrupted"].includes(receipt.status) &&
      !this.runtimeCurrent(lease)
    )
      throw new RuntimeError("revision_stale");
    const owned = this.db
      .prepare(
        "SELECT 1 FROM coding_lease WHERE token=? AND job_id=? AND revision=?",
      )
      .get(lease, receipt.job_id, receipt.revision);
    if (!owned) throw new RuntimeError("revision_stale");
    this.db
      .prepare(
        `INSERT INTO bootstrap_attempts VALUES(@id,@job_id,@revision,@status,@receipt)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,receipt_json=excluded.receipt_json`,
      )
      .run({
        id: receipt.id,
        job_id: receipt.job_id,
        revision: receipt.revision,
        status: receipt.status,
        receipt: JSON.stringify(receipt),
      });
  }

  bootstrap(id: string): BootstrapReceipt {
    const row = this.db
      .prepare("SELECT receipt_json FROM bootstrap_attempts WHERE id=?")
      .get(id) as { receipt_json: string } | undefined;
    if (!row) throw new RuntimeError("bootstrap_receipt_missing");
    return JSON.parse(row.receipt_json) as BootstrapReceipt;
  }

  recordBootstrapCommand(
    attempt: string,
    run: string | null,
    receipt: CommandReceipt,
  ) {
    this.db
      .prepare(
        `INSERT INTO bootstrap_commands VALUES(?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET receipt_json=excluded.receipt_json`,
      )
      .run(receipt.id, attempt, run, JSON.stringify(receipt));
  }

  bootstrapCommands(attempt: string): CommandReceipt[] {
    return (
      this.db
        .prepare(
          "SELECT receipt_json FROM bootstrap_commands WHERE attempt_id=? ORDER BY rowid",
        )
        .all(attempt) as { receipt_json: string }[]
    ).map((row) => JSON.parse(row.receipt_json) as CommandReceipt);
  }

  interruptBootstrap() {
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `UPDATE bootstrap_attempts SET status='interrupted',
        receipt_json=json_set(receipt_json,'$.status','interrupted','$.finished_at',?,'$.failure','bootstrap_interrupted')
        WHERE status NOT IN ('ready','blocked','interrupted')`,
          )
          .run(Date.now());
        this.db
          .prepare(
            `UPDATE bootstrap_commands SET receipt_json=json_set(receipt_json,
        '$.outcome','interrupted','$.finished_at',?) WHERE json_extract(receipt_json,'$.outcome')='running'`,
          )
          .run(Date.now());
      })
      .immediate();
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

  private markDirty(
    target: Target,
    origin: "webhook" | "reconciliation",
  ): number {
    const { generation } = this.db
      .prepare(
        "UPDATE reconciliation SET generation=generation+1 WHERE singleton=1 RETURNING generation",
      )
      .get() as { generation: number };
    this.db
      .prepare(
        `INSERT INTO dirty(kind,number,generation) VALUES(@kind,@number,@generation)
      ON CONFLICT(kind,number) DO UPDATE SET generation=excluded.generation,
      retry_at=CASE WHEN @fresh THEN 0 ELSE dirty.retry_at END,
      failure_code=CASE WHEN @fresh THEN NULL ELSE dirty.failure_code END`,
      )
      .run({ ...target, generation, fresh: Number(origin === "webhook") });
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
          const sameEvent =
            previous.event === event ||
            [previous.event, event].every(
              (value) => value === "issues" || value === "issues.reopened",
            );
          if (previous.payload_digest !== payloadDigest || !sameEvent)
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
          const generation = this.markDirty(target, "webhook");
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
        for (const number of issues)
          this.markDirty({ kind: "issue", number }, "reconciliation");
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
          this.markDirty(
            { kind: "issue", number: job.issue_number },
            "reconciliation",
          );
        for (const pull of this.ownedPulls())
          this.markDirty(
            { kind: "pull", number: pull.number! },
            "reconciliation",
          );
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

  refreshIssue(number: number): DirtyTarget {
    return {
      kind: "issue",
      number,
      generation: this.markDirty({ kind: "issue", number }, "reconciliation"),
    };
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
        if (
          previous &&
          previous.status === "pending" &&
          context.state === "open" &&
          this.db
            .prepare(
              "SELECT 1 FROM publications WHERE job_id=? AND kind='pull_request'",
            )
            .get(previous.id)
        ) {
          this.observePullJob(previous.id, "issue", context);
          this.complete(target);
          return true;
        }
        const reopened = Boolean(
          context.state === "open" &&
          this.db
            .prepare(
              `SELECT 1 FROM delivery_targets AS target JOIN inbox USING(delivery_id)
              WHERE target.kind='issue' AND target.number=? AND target.generation<=?
                AND target.done=0 AND inbox.event='issues.reopened'`,
            )
            .get(context.number, target.generation),
        );
        if (
          previous &&
          previous.status === "pending" &&
          context.state === "open" &&
          !reopened
        ) {
          const completed = this.db
            .prepare(
              `SELECT 1 FROM investigations WHERE job_id=? AND revision=? AND state='completed'
            AND json_extract(content,'$.result.outcome') IN ('needs_information','no_fix','manual_feature')`,
            )
            .get(previous.id, previous.revision);
          const prior = JSON.parse(previous.input_json) as IssueContext;
          if (
            completed &&
            inputJson({ ...context, source: prior.source }) ===
              previous.input_json
          ) {
            this.complete(target);
            return true;
          }
        }
        if (previous || context.state === "open") {
          const input = inputJson(context);
          const inputDigest = createHash("sha256").update(input).digest("hex");
          const status = context.state === "open" ? "pending" : "closed";
          this.db
            .prepare(
              `INSERT INTO jobs(issue_id,issue_number,status,input_digest,input_json,snapshot_digest,budget_json)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(issue_number) DO UPDATE SET
          revision=jobs.revision+1,status=excluded.status,input_digest=excluded.input_digest,input_json=excluded.input_json,
          phase=CASE WHEN EXISTS (SELECT 1 FROM publications WHERE job_id=jobs.id AND kind='pull_request') THEN 'remote_review'
          WHEN EXISTS (SELECT 1 FROM investigations WHERE job_id=jobs.id AND revision=jobs.revision) THEN 'investigation' ELSE jobs.phase END
          WHERE jobs.input_digest<>excluded.input_digest OR jobs.status<>excluded.status OR ?`,
            )
            .run(
              context.id,
              context.number,
              status,
              inputDigest,
              input,
              snapshot.digest,
              JSON.stringify(initialBudget),
              Number(reopened),
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
          this.observePullJob(previous.job_id, "pull", context);
        }
        this.complete(target);
        return true;
      })
      .immediate();
  }

  private observePullJob(
    jobId: number,
    kind: "issue" | "pull",
    context: IssueContext | PullContext,
  ) {
    this.db
      .prepare(
        `INSERT INTO pr_observations(job_id,kind,content) VALUES(?,?,?)
      ON CONFLICT(job_id,kind) DO UPDATE SET generation=pr_observations.generation+1,content=excluded.content
      WHERE pr_observations.content<>excluded.content`,
      )
      .run(jobId, kind, inputJson(context));
  }

  assertPublishedScope(jobId: number) {
    const job = this.jobById(jobId);
    if (!job) throw new RuntimeError("revision_stale");
    const observation = this.db
      .prepare(
        "SELECT content FROM pr_observations WHERE job_id=? AND kind='issue'",
      )
      .get(jobId) as { content: string } | undefined;
    if (!observation) return;
    const latest = JSON.parse(observation.content) as IssueContext;
    const original = JSON.parse(job.input_json) as IssueContext;
    if (
      latest.id !== original.id ||
      latest.title !== original.title ||
      latest.body !== original.body
    )
      throw new RuntimeError("pr_scope_changed");
  }

  jobs(): Job[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY id").all() as Job[];
  }
  job(number: number): Job | undefined {
    return this.db
      .prepare("SELECT * FROM jobs WHERE issue_number=?")
      .get(number) as Job | undefined;
  }

  jobById(id: number): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as
      Job | undefined;
  }

  leases() {
    return this.db.prepare("SELECT * FROM coding_lease").all() as Array<{
      slot: number;
      job_id: number;
      revision: number;
      token: string;
    }>;
  }

  startRuntimeLease(token: string, activeLimit: number): number {
    return this.db
      .transaction(() => {
        const job = this.db
          .prepare(
            `SELECT jobs.* FROM jobs JOIN coding_lease
        ON coding_lease.job_id=jobs.id AND coding_lease.revision=jobs.revision
        WHERE coding_lease.token=? AND jobs.status='pending'`,
          )
          .get(token) as Job | undefined;
        if (!job) throw new RuntimeError("revision_stale");
        const used = budgetUsage.parse(JSON.parse(job.budget_json)).active_ms;
        if (used >= activeLimit)
          throw new RuntimeError("active_budget_exhausted");
        const now = Date.now(),
          deadline = now + activeLimit - used;
        if (
          !Number.isSafeInteger(activeLimit) ||
          !Number.isSafeInteger(deadline)
        )
          throw new RuntimeError("active_budget_invalid");
        this.db
          .prepare("INSERT INTO runtime_leases VALUES(?,?,?)")
          .run(token, deadline, now);
        return deadline;
      })
      .immediate();
  }

  runtimeCurrent(token: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM coding_lease JOIN jobs
      ON jobs.id=coding_lease.job_id AND jobs.revision=coding_lease.revision
      JOIN runtime_leases ON runtime_leases.token=coding_lease.token
      WHERE coding_lease.token=? AND jobs.status='pending' AND runtime_leases.deadline>?
      AND NOT EXISTS (SELECT 1 FROM mcp_write_operations w WHERE w.job_id=jobs.id AND w.state='uncertain'
        AND NOT EXISTS (SELECT 1 FROM mcp_write_recovery_leases r WHERE r.token=coding_lease.token AND r.operation_id=w.id))`,
        )
        .get(token, Date.now()),
    );
  }

  accountActive(token: string, now = Date.now()) {
    this.db
      .transaction(() => {
        const lease = this.db
          .prepare(
            `SELECT coding_lease.job_id,runtime_leases.* FROM coding_lease
        JOIN runtime_leases ON coding_lease.token=runtime_leases.token WHERE coding_lease.token=?`,
          )
          .get(token) as
          | { job_id: number; deadline: number; accounted_at: number }
          | undefined;
        if (!lease) return;
        const until = Math.max(
          lease.accounted_at,
          Math.min(now, lease.deadline),
        );
        this.db
          .prepare(
            `UPDATE jobs SET budget_json=json_set(budget_json,'$.active_ms',
        json_extract(budget_json,'$.active_ms')+?) WHERE id=?`,
          )
          .run(until - lease.accounted_at, lease.job_id);
        this.db
          .prepare("UPDATE runtime_leases SET accounted_at=? WHERE token=?")
          .run(until, token);
      })
      .immediate();
  }

  reserveModelRequest(token: string, limit: number) {
    if (!this.runtimeCurrent(token)) return false;
    return (
      this.db
        .prepare(
          `UPDATE jobs SET budget_json=json_set(budget_json,'$.model_requests',
      json_extract(budget_json,'$.model_requests')+1) WHERE status='pending'
      AND json_extract(budget_json,'$.model_requests')<? AND EXISTS
      (SELECT 1 FROM coding_lease JOIN runtime_leases ON coding_lease.token=runtime_leases.token
       WHERE coding_lease.token=? AND coding_lease.job_id=jobs.id
       AND coding_lease.revision=jobs.revision AND runtime_leases.deadline>?)`,
        )
        .run(limit, token, Date.now()).changes === 1
    );
  }

  reserveInfrastructureRetry(jobId: number) {
    return this.db
      .transaction(() => {
        const job = this.jobById(jobId);
        if (!job) throw new RuntimeError("request_invalid");
        const usage = budgetUsage.parse(JSON.parse(job.budget_json));
        const limit = this.snapshot(job.snapshot_digest).settings.limits
          .infrastructure_retries;
        const reserved =
          !usage.infrastructure_exhausted &&
          usage.infrastructure_retries < limit;
        if (reserved) usage.infrastructure_retries++;
        else usage.infrastructure_exhausted = true;
        this.db
          .prepare("UPDATE jobs SET budget_json=? WHERE id=?")
          .run(JSON.stringify(usage), job.id);
        return reserved;
      })
      .immediate();
  }

  startRun(
    record: Pick<
      AgentRunRecord,
      | "id"
      | "job_id"
      | "revision"
      | "role"
      | "uid"
      | "parent_id"
      | "lease_token"
      | "binding_json"
    >,
  ) {
    this.db
      .transaction(() => {
        if (
          !this.runtimeCurrent(record.lease_token) ||
          (record.role !== "output_review" &&
            this.db
              .prepare("SELECT 1 FROM mcp_write_recovery_leases WHERE token=?")
              .get(record.lease_token)) ||
          !this.db
            .prepare(
              "SELECT 1 FROM coding_lease WHERE token=? AND job_id=? AND revision=?",
            )
            .get(record.lease_token, record.job_id, record.revision)
        )
          throw new RuntimeError("revision_stale");
        this.db
          .prepare(
            `INSERT INTO agent_runs(id,job_id,revision,role,uid,parent_id,lease_token,binding_json,started_at)
        VALUES(@id,@job_id,@revision,@role,@uid,@parent_id,@lease_token,@binding_json,@started_at)`,
          )
          .run({ ...record, started_at: Date.now() });
      })
      .immediate();
  }

  runs(): AgentRunRecord[] {
    return this.db
      .prepare("SELECT * FROM agent_runs ORDER BY started_at,rowid")
      .all() as AgentRunRecord[];
  }

  run(id: string): AgentRunRecord | undefined {
    return this.db.prepare("SELECT * FROM agent_runs WHERE id=?").get(id) as
      AgentRunRecord | undefined;
  }

  sessionRun(
    job: number,
    revision: number,
    role: AgentRunRecord["role"],
    session: string,
  ) {
    return this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE job_id=? AND revision=? AND role=? AND session_id=?
       ORDER BY started_at DESC,rowid DESC LIMIT 1`,
      )
      .get(job, revision, role, session) as AgentRunRecord | undefined;
  }

  startMcpCall(
    receipt: Omit<McpCallReceipt, "result_digest" | "finished_at" | "outcome">,
  ) {
    this.db
      .transaction(() => {
        const run = this.run(receipt.run_id);
        if (
          !run ||
          run.finished_at !== null ||
          run.job_id !== receipt.job_id ||
          run.revision !== receipt.revision ||
          run.role !== receipt.role ||
          !this.runtimeCurrent(run.lease_token)
        )
          throw new RuntimeError("revision_stale");
        this.db
          .prepare(
            `INSERT INTO mcp_calls
        (id,run_id,job_id,revision,role,alias,tool,credential_binding,policy_identity,catalog_identity,request_digest,started_at,outcome)
        VALUES(@id,@run_id,@job_id,@revision,@role,@alias,@tool,@credential_binding,@policy_identity,@catalog_identity,@request_digest,@started_at,'running')`,
          )
          .run(receipt);
      })
      .immediate();
  }

  finishMcpCall(
    id: string,
    outcome: Exclude<McpCallReceipt["outcome"], "running">,
    result: string | null,
  ) {
    if (
      this.db
        .prepare(
          "UPDATE mcp_calls SET outcome=?,result_digest=?,finished_at=? WHERE id=? AND outcome='running'",
        )
        .run(outcome, result, Date.now(), id).changes !== 1
    )
      throw new RuntimeError("mcp_receipt_not_active");
  }

  interruptMcpCalls() {
    this.db
      .prepare(
        "UPDATE mcp_calls SET outcome='interrupted',finished_at=? WHERE outcome='running'",
      )
      .run(Date.now());
  }

  mcpCalls(): McpCallReceipt[] {
    return this.db
      .prepare("SELECT * FROM mcp_calls ORDER BY started_at,rowid")
      .all() as McpCallReceipt[];
  }

  saveMcpReadResult(id: string, result: unknown) {
    this.db
      .prepare("INSERT INTO mcp_read_results VALUES(?,?)")
      .run(id, JSON.stringify(result));
  }

  mcpReadResult(id: string): unknown {
    const row = this.db
      .prepare("SELECT content FROM mcp_read_results WHERE id=?")
      .get(id) as { content: string } | undefined;
    if (!row) throw new RuntimeError("mcp_read_result_missing");
    return JSON.parse(row.content) as unknown;
  }

  bindRun(id: string, binding: string) {
    this.db
      .transaction(() => {
        const run = this.db
          .prepare(
            "SELECT * FROM agent_runs WHERE id=? AND finished_at IS NULL",
          )
          .get(id) as AgentRunRecord | undefined;
        if (!run || !this.runtimeCurrent(run.lease_token))
          throw new RuntimeError("revision_stale");
        this.db
          .prepare("UPDATE agent_runs SET binding_json=? WHERE id=?")
          .run(JSON.stringify({ binding }), id);
      })
      .immediate();
  }

  finishRun(
    id: string,
    status: string,
    session: string | null,
    artifact: string | null,
  ) {
    this.db
      .transaction(() => {
        const run = this.db
          .prepare("SELECT * FROM agent_runs WHERE id=?")
          .get(id) as AgentRunRecord | undefined;
        if (!run || run.finished_at !== null)
          throw new RuntimeError("run_not_active");
        if (status === "completed" && !this.runtimeCurrent(run.lease_token))
          throw new RuntimeError("revision_stale");
        this.db
          .prepare(
            "UPDATE agent_runs SET status=?,session_id=?,artifact_digest=?,finished_at=? WHERE id=?",
          )
          .run(status, session, artifact, Date.now(), id);
      })
      .immediate();
  }

  recordArtifact(manifest: ArtifactManifest): string {
    const hash = digest(manifest);
    this.db
      .transaction(() => {
        const run = this.db
          .prepare("SELECT * FROM agent_runs WHERE id=?")
          .get(manifest.run_id) as AgentRunRecord | undefined;
        if (
          !run ||
          run.job_id !== manifest.job_id ||
          run.revision !== manifest.revision ||
          !this.runtimeCurrent(run.lease_token)
        )
          throw new RuntimeError("revision_stale");
        this.db
          .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)")
          .run(
            hash,
            run.id,
            run.job_id,
            run.revision,
            JSON.stringify(manifest),
          );
      })
      .immediate();
    return hash;
  }

  artifact(hash: string, jobId: number, revision: number): ArtifactManifest {
    const row = this.db
      .prepare(
        `SELECT artifacts.manifest_json FROM artifacts JOIN agent_runs ON agent_runs.id=artifacts.run_id
      WHERE artifacts.digest=? AND artifacts.job_id=? AND artifacts.revision=? AND agent_runs.status='completed' AND agent_runs.finished_at IS NOT NULL`,
      )
      .get(hash, jobId, revision) as { manifest_json: string } | undefined;
    if (!row) throw new RuntimeError("artifact_unavailable");
    const manifest = JSON.parse(row.manifest_json) as ArtifactManifest;
    if (digest(manifest) !== hash) throw new RuntimeError("artifact_corrupt");
    return manifest;
  }

  acquireLease(jobId: number, revision: number): string | undefined {
    const token = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO coding_lease SELECT 1,id,revision,?
      FROM jobs WHERE id=? AND revision=? AND status='pending'
      AND NOT EXISTS (SELECT 1 FROM mcp_write_operations WHERE job_id=jobs.id AND state IN ('proposed','dispatching','uncertain'))`,
      )
      .run(token, jobId, revision);
    return result.changes ? token : undefined;
  }

  hasUncertainMcpWrite(jobId: number) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM mcp_write_operations WHERE job_id=? AND state='uncertain'",
        )
        .get(jobId),
    );
  }

  acquireMcpWriteRecovery(operationId: string): string | undefined {
    return this.db
      .transaction(() => {
        const token = randomUUID();
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO coding_lease
        SELECT 1,j.id,j.revision,? FROM jobs j JOIN mcp_write_operations w ON w.job_id=j.id AND w.revision=j.revision
        WHERE w.id=? AND w.state='uncertain' AND j.status='pending'`,
          )
          .run(token, operationId);
        if (!result.changes) return undefined;
        this.db
          .prepare("INSERT INTO mcp_write_recovery_leases VALUES(?,?)")
          .run(token, operationId);
        return token;
      })
      .immediate();
  }

  mcpWriteRecoveryCurrent(token: string, operationId: string) {
    return (
      this.runtimeCurrent(token) &&
      Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM mcp_write_recovery_leases WHERE token=? AND operation_id=?",
          )
          .get(token, operationId),
      )
    );
  }

  releaseLease(token: string) {
    return (
      this.db
        .prepare(
          `DELETE FROM coding_lease WHERE token=? AND NOT EXISTS
        (SELECT 1 FROM agent_runs WHERE agent_runs.lease_token=coding_lease.token AND finished_at IS NULL)`,
        )
        .run(token).changes === 1
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
