import {
  conversationSchema,
  digest,
  RuntimeError,
  type AgentEvent,
  type AgentRunRequest,
  type Conversation,
} from "../domain/agents.ts";
import type { Store } from "./store.ts";

type Terminal = Extract<AgentEvent, { type: "terminal" }>;
export type ConversationCheckpoint = {
  version: 1;
  id: string;
  request_digest: string;
  messages: Array<{ id: string; digest: string }>;
  run_id: string;
  terminal: Terminal;
};

export class ConversationRepository {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  get(id: string): ConversationCheckpoint | undefined {
    const row = this.store.db
      .prepare("SELECT content FROM agent_conversations WHERE id=?")
      .get(id) as { content: string } | undefined;
    return row && (JSON.parse(row.content) as ConversationCheckpoint);
  }

  private identity(request: AgentRunRequest) {
    return digest({
      version: 1,
      id: request.conversation!.id,
      job: request.job_id,
      revision: request.revision,
      role: request.role,
      workspace: request.workspace,
      snapshot: request.snapshot_digest,
      profile: request.profile,
      input: request.input,
      output_schema: request.output_schema,
      bootstrap: request.bootstrap_receipt,
    });
  }

  prepare(request: AgentRunRequest):
    | {
        conversation: Conversation;
        previous?: ConversationCheckpoint;
        duplicate?: Terminal;
      }
    | undefined {
    if (!request.conversation) return;
    const parsed = conversationSchema.safeParse(request.conversation);
    if (!parsed.success || ["audit", "output_review"].includes(request.role))
      throw new RuntimeError("conversation_invalid");
    const conversation = parsed.data;
    const previous = this.get(conversation.id);
    if (Boolean(request.resume) !== Boolean(previous))
      throw new RuntimeError("conversation_missing");
    if (previous) {
      const run = this.store.run(previous.run_id);
      if (
        previous.version !== 1 ||
        previous.request_digest !== this.identity(request) ||
        !run ||
        run.session_id !== request.resume!.id ||
        run.finished_at === null ||
        JSON.parse(run.binding_json).binding !== request.resume!.binding ||
        !["completed", "limited"].includes(run.status)
      )
        throw new RuntimeError("conversation_mismatch");
    }
    const acknowledged = new Map(
      previous?.messages.map((message) => [message.id, message.digest]),
    );
    const seen = new Map<string, string>();
    const messages = conversation.messages.filter((message) => {
      if (
        message.digest !== digest(message.content) ||
        (seen.has(message.id) && seen.get(message.id) !== message.digest) ||
        (acknowledged.has(message.id) &&
          acknowledged.get(message.id) !== message.digest)
      )
        throw new RuntimeError("conversation_message_conflict");
      if (seen.has(message.id)) return false;
      seen.set(message.id, message.digest);
      return !acknowledged.has(message.id);
    });
    if ((previous?.messages.length ?? 0) + messages.length > 100000)
      throw new RuntimeError("conversation_limit");
    return {
      conversation: { ...conversation, messages },
      previous,
      ...(previous && !messages.length ? { duplicate: previous.terminal } : {}),
    };
  }

  complete(request: AgentRunRequest, run: string, terminal: Terminal) {
    const prepared = this.prepare(request);
    if (!prepared || prepared.duplicate) return;
    const checkpoint: ConversationCheckpoint = {
      version: 1,
      id: prepared.conversation.id,
      request_digest: this.identity(request),
      messages: [
        ...(prepared.previous?.messages ?? []),
        ...prepared.conversation.messages.map(({ id, digest }) => ({
          id,
          digest,
        })),
      ],
      run_id: run,
      terminal,
    };
    const content = JSON.stringify(checkpoint);
    if (Buffer.byteLength(content) > 16 * 1024 * 1024)
      throw new RuntimeError("conversation_limit");
    this.store.db
      .prepare(
        "INSERT INTO agent_conversations(id,job_id,revision,content) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content",
      )
      .run(checkpoint.id, request.job_id, request.revision, content);
  }
}
