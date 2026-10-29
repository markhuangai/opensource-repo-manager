import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { StateError } from "../domain/durability.ts";
export { StateError } from "../domain/durability.ts";
import {
  budgetUsage,
  githubId,
  repositoryIdentity,
  sha,
} from "../domain/jobs.ts";
import { investigationResultSchema } from "../services/investigation/contracts.ts";
import { implementationPlanSchema } from "../services/implementation/contracts.ts";
import { commandSchema } from "../services/bootstrap/contracts.ts";
import { artifactReferenceSchema } from "./bundle.ts";

const count = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const stateSource = z.strictObject({
  default_branch: z.string().min(1).max(1024),
  sha,
  tree_sha: sha,
});
export const durableScope = z.strictObject({
  job_id: githubId,
  revision: githubId,
  investigation_id: z.uuid(),
  source: stateSource,
  snapshot_digest: hash,
  objective: z.string().max(4096),
  plan: implementationPlanSchema,
  checks: z.array(commandSchema),
  remote_checks: z.array(z.json()),
});
const ownedPull = z.strictObject({
  id: githubId,
  number: githubId,
  author_id: githubId,
  head: sha,
  base: z.string().min(1).max(1024),
  title_digest: hash,
  body_digest: hash,
});
const publication = z.strictObject({
  id: hash,
  revision: githubId,
  kind: z.enum([
    "investigation",
    "investigation_stage",
    "status",
    "pr_stage",
    "feedback",
    "notice",
    "change",
  ]),
  actor: z.strictObject({ id: githubId, login: z.string().min(1).max(128) }),
  source: stateSource,
  branch: z.string().min(1).max(1024),
  commit: sha.nullable(),
  review_id: z.uuid(),
  review_binding: hash,
  policy_identity: z.string().min(1).max(256),
  status: z.enum([
    "reviewed",
    "dispatching",
    "uncertain",
    "confirmed",
    "blocked",
  ]),
  retry_at: count,
  retry_pending: z.boolean(),
  steps: z
    .array(
      z.strictObject({
        kind: z.enum([
          "comment",
          "branch",
          "pull",
          "feedback_reply",
          "thread_resolution",
        ]),
        state: z.enum(["prepared", "dispatching", "uncertain", "confirmed"]),
        before_digest: hash,
        after_digest: hash,
        object_id: githubId.nullable(),
        thread_id: z.string().max(256).nullable(),
        title_digest: hash.nullable(),
        body_digest: hash.nullable(),
      }),
    )
    .max(5),
});
export const taskStateSchema = z.strictObject({
  version: z.literal(1),
  repository: repositoryIdentity.strict(),
  issue: z.strictObject({ id: githubId, number: githubId }),
  task_id: z.uuid(),
  publication_instance: z.uuid(),
  comment_id: githubId.nullable(),
  author_id: githubId,
  generation: count,
  initializing: z.boolean(),
  job: z
    .strictObject({
      id: githubId,
      revision: githubId,
      phase: z.enum(["investigation", "implementation", "remote_review"]),
      status: z.enum(["pending", "closed"]),
      input_digest: hash,
      issue_digest: hash,
      snapshot_digest: hash,
      source: stateSource,
    })
    .nullable(),
  budget: budgetUsage,
  limits: z.strictObject({
    active_ms: count,
    model_requests: count,
    repair_cycles: count,
    infrastructure_retries: count,
    wait_ms: count,
  }),
  active: z.strictObject({ accounted_at: count, deadline: count }).nullable(),
  wait_accounted_at: count.nullable(),
  retry_at: count,
  findings: investigationResultSchema.nullable(),
  scope: durableScope.nullable(),
  scope_digest: hash.nullable(),
  question: z
    .strictObject({
      questions: z.array(z.string().min(1).max(1024)).max(8),
      input_digest: hash,
    })
    .nullable(),
  outcome: z
    .enum([
      "waiting",
      "ready",
      "out_of_scope",
      "no_fix",
      "closed",
      "blocked",
      "failed",
    ])
    .nullable(),
  reason: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .nullable(),
  branch: z.string().min(1).max(1024),
  head: sha.nullable(),
  pull: ownedPull.nullable(),
  pending: publication.nullable(),
  session_artifact: artifactReferenceSchema.nullable(),
});
export type TaskState = z.infer<typeof taskStateSchema>;
export type DurablePublication = NonNullable<TaskState["pending"]>;
export type StateComment = {
  state: TaskState;
  narrative: string;
  body: string;
};
export const stateMarker = "<!-- orm:task-state:";
export const stateBytes = 32 * 1024;
export const commentBytes = 60 * 1024;

export class StateCodec {
  private readonly key: Buffer;
  constructor(sessionKey: string) {
    this.key = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(sessionKey, "base64"),
        "orm/actions/v1",
        "task-state-authentication/v1",
        32,
      ),
    );
  }

  private mac(content: string, narrative: string, initialization: boolean) {
    return createHmac("sha256", this.key)
      .update(
        JSON.stringify([
          initialization ? "initialization" : "canonical",
          content,
          narrative,
        ]),
      )
      .digest();
  }

  encode(input: TaskState, narrative: string): string {
    if (narrative.includes(stateMarker)) throw new StateError("state_invalid");
    const parsed = taskStateSchema.safeParse(input);
    if (!parsed.success) throw new StateError("state_invalid");
    const state = parsed.data;
    this.validateInitialization(state);
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > stateBytes)
      throw new StateError("state_size_limit");
    const content = Buffer.from(serialized).toString("base64url");
    const body = `${narrative}\n\n${stateMarker}v1:${content}:${this.mac(content, narrative, state.initializing).toString("base64url")} -->`;
    if (Buffer.byteLength(body) > commentBytes)
      throw new StateError("state_size_limit");
    return body;
  }

  decode(
    body: string,
    identity: {
      repository_id: number;
      issue_id: number;
      comment_id: number;
      author_id: number;
    },
  ): StateComment {
    if (Buffer.byteLength(body) > commentBytes)
      throw new StateError("state_size_limit");
    const match =
      /^(.*)\n\n<!-- orm:task-state:v1:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+) -->$/s.exec(
        body,
      );
    if (!match || match[1].includes(stateMarker))
      throw new StateError("state_invalid");
    const [, narrative, content, signature] = match;
    const bytes = Buffer.from(content, "base64url");
    if (bytes.length > stateBytes || bytes.toString("base64url") !== content)
      throw new StateError("state_size_limit");
    let state: TaskState;
    try {
      state = taskStateSchema.parse(
        JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
      );
    } catch {
      throw new StateError("state_invalid");
    }
    this.validateInitialization(state);
    const expected = this.mac(content, narrative, state.initializing),
      actual = Buffer.from(signature, "base64url");
    if (
      actual.length !== expected.length ||
      actual.toString("base64url") !== signature ||
      !timingSafeEqual(actual, expected) ||
      state.repository.id !== identity.repository_id ||
      state.issue.id !== identity.issue_id ||
      state.author_id !== identity.author_id ||
      (!state.initializing && state.comment_id !== identity.comment_id)
    )
      throw new StateError("state_invalid");
    return { state, narrative, body };
  }

  private validateInitialization(state: TaskState) {
    if (state.initializing) {
      if (
        state.comment_id !== null ||
        state.generation !== 0 ||
        state.job !== null ||
        state.active !== null ||
        state.pending !== null ||
        state.pull !== null ||
        state.head !== null ||
        state.scope !== null ||
        state.findings !== null ||
        state.session_artifact !== null ||
        Object.values(state.budget).some(Boolean)
      )
        throw new StateError("state_invalid");
    } else if (state.comment_id === null || state.generation === 0)
      throw new StateError("state_invalid");
  }
}
