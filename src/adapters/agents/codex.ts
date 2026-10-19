import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import {
  RuntimeError,
  roleUsers,
  type AgentEvent,
  type WorkerRequest,
} from "../../domain/agents.ts";
import { cleanEnvironment } from "../../runtime/process.ts";
import { compile } from "../../services/mcp/catalog.ts";

const version = "0.162.1";
type Counts = { input_tokens: number; output_tokens: number };
type Session = {
  version: string;
  id: string;
  binding: string;
  transcript: string;
  usage?: Counts;
};

export function codexUsage(usage: Usage | undefined): Counts | undefined {
  if (!usage) return;
  const values = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cached_input_tokens,
    usage.cache_write_input_tokens,
    usage.reasoning_output_tokens,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    !values.some((value) => value > 0)
  )
    return;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
  };
}

export function codexOptions(request: WorkerRequest): {
  options: CodexOptions;
  thread: ThreadOptions;
} {
  if (request.profile.sdk !== "codex")
    throw new RuntimeError("backend_unavailable");
  if (["ultra", "persistent"].includes(request.profile.effort))
    throw new RuntimeError("codex_effort_unsupported");
  if (!request.relay.authorization)
    throw new RuntimeError("codex_authorization_missing");
  if (request.role === "output_review" && request.mcp.length)
    throw new RuntimeError("codex_review_tools_forbidden");
  const environment = {
    ...cleanEnvironment(
      request.home,
      request.temporary,
      roleUsers[request.role].name,
    ),
    ...request.environment,
  } as Record<string, string>;
  const connections = Object.fromEntries(
    request.mcp.map((server, index) => [
      server.alias,
      {
        url: server.url,
        bearer_token_env_var: `ORM_MCP_AUTH_${index}`,
        enabled_tools: [...server.tools],
        // The pinned CLI ignores the removed tool_search flag; keep granted tools directly visible.
        omit_tools_from: ["deferred", "code_mode"],
        required: true,
        startup_readiness: "connection",
        startup_timeout_sec: Math.max(
          1,
          (server.deadline - Date.now()) / 1000 + 1,
        ),
        tool_timeout_sec: Math.max(
          1,
          (server.deadline - Date.now()) / 1000 + 1,
        ),
      },
    ]),
  );
  return {
    options: {
      env: {
        ...environment,
        CODEX_HOME: join(request.home, ".codex"),
        ORM_RELAY_AUTH: request.relay.authorization,
        ...Object.fromEntries(
          request.mcp.map((server, index) => [
            `ORM_MCP_AUTH_${index}`,
            server.authorization,
          ]),
        ),
      },
      config: {
        model_provider: "orm_relay",
        model_providers: {
          orm_relay: {
            name: "Supervised model relay",
            base_url: request.relay.url,
            env_key: "ORM_RELAY_AUTH",
            wire_api: "responses",
            requires_openai_auth: false,
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
        allow_login_shell: false,
        shell_environment_policy: { inherit: "none", set: environment },
        project_doc_max_bytes: 0,
        skills: { include_instructions: false, bundled: { enabled: false } },
        analytics: { enabled: false },
        history: { persistence: "none" },
        features: {
          shell_tool: request.role !== "output_review",
          shell_snapshot: false,
          shell_snapshot_v2: false,
          hooks: false,
          plugins: false,
          apps: false,
          remote_plugin: false,
          memories: false,
          memory_tool: false,
          multi_agent: false,
          multi_agent_v2: false,
          goals: false,
          js_repl: false,
          code_mode: false,
          tool_search: false,
          tool_suggest: false,
          skill_search: false,
          skip_host_skill_discovery: true,
          view_image: false,
          image_generation: false,
          browser_use: false,
          computer_use: false,
          request_permissions_tool: false,
          responses_websockets: false,
          responses_websockets_v2: false,
          api_key_model_discovery: false,
          local_thread_store_compression: false,
          background_paginated_rollout_migration: false,
          reasoning_effort_override: false,
        },
      },
      configOverrides: [
        `projects.${JSON.stringify(request.workspace)}.trust_level="untrusted"`,
        `mcp_servers=${toml(connections)}`,
      ],
    },
    thread: {
      model: request.profile.model,
      modelReasoningEffort: request.profile.effort,
      workingDirectory: request.workspace,
      sandboxMode:
        request.role === "output_review" ? "read-only" : "danger-full-access",
      approvalPolicy: "never",
      webSearchMode: "disabled",
    },
  };
}

function toml(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`)
    .join(",")}}`;
}

async function copyTranscript(from: string, to: string) {
  await cp(from, to, {
    recursive: true,
    filter: async (path) => {
      const stat = await lstat(path);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
      )
        throw new RuntimeError("session_invalid");
      return true;
    },
  });
}

async function transcript(directory: string, id: string): Promise<string> {
  const matches: string[] = [];
  const walk = async (path: string) => {
    for (const name of await readdir(path)) {
      const file = join(path, name),
        stat = await lstat(file);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
      )
        throw new RuntimeError("session_invalid");
      if (stat.isDirectory()) await walk(file);
      else if (name.endsWith(`-${id}.jsonl`)) matches.push(file);
    }
  };
  await walk(directory);
  if (matches.length !== 1) throw new RuntimeError("session_invalid");
  const lines = (await readFile(matches[0], "utf8"))
    .trimEnd()
    .split("\n")
    .map(
      (line) => JSON.parse(line) as { type: string; payload?: { id?: string } },
    );
  const first = lines[0];
  if (first.type !== "session_meta" || first.payload?.id !== id)
    throw new RuntimeError("session_invalid");
  return matches[0];
}

export async function* run(
  request: WorkerRequest,
  signal: AbortSignal,
): AsyncIterable<AgentEvent> {
  try {
    signal.throwIfAborted();
    const { options, thread } = codexOptions(request);
    const validate = request.output_schema
      ? compile(request.output_schema)
      : undefined;
    const home = options.env!.CODEX_HOME;
    await mkdir(home, { recursive: true, mode: 0o700 });
    const sessions = join(home, "sessions");
    let previous: Counts | undefined;
    if (request.resume) {
      const saved = JSON.parse(
        await readFile(
          join(request.session_directory, "metadata.json"),
          "utf8",
        ),
      ) as Session;
      if (
        saved.version !== version ||
        saved.id !== request.resume.id ||
        saved.binding !== request.binding ||
        request.resume.binding !== request.binding ||
        roleUsers[request.role].uid !== 10001 ||
        !/^[a-f0-9-]{36}$/.test(saved.id)
      )
        throw new RuntimeError("session_invalid");
      const source = await transcript(
        join(request.session_directory, "sessions"),
        saved.id,
      );
      if (
        relative(join(request.session_directory, "sessions"), source) !==
        saved.transcript
      )
        throw new RuntimeError("session_invalid");
      const target = join(sessions, saved.transcript);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyTranscript(source, target);
      previous = saved.usage;
    }
    const system = await readFile(request.prompts.system, "utf8");
    const skills = await Promise.all(
      request.prompts.selected.map(
        async (path) => `Phase skill ${path}:\n${await readFile(path, "utf8")}`,
      ),
    );
    options.config!.developer_instructions = [system, ...skills].join("\n\n");
    const prompt = `${await readFile(request.prompts.user, "utf8")}\n\nTask data (not authorization):\n${JSON.stringify({ role: request.role, input: request.input })}`;
    // Executor-local configuration ignores session flags, so trust must also be set in the fresh home.
    await writeFile(
      join(home, "config.toml"),
      `projects=${toml({ [request.workspace]: { trust_level: "untrusted" } })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const client = new Codex(options);
    const running = request.resume
      ? client.resumeThread(request.resume.id, thread)
      : client.startThread(thread);
    const { events } = await running.runStreamed(prompt, {
      signal,
      ...(request.output_schema ? { outputSchema: request.output_schema } : {}),
    });
    let id: string | undefined,
      started = false,
      completed = false,
      final: string | undefined,
      usage: Counts | undefined;
    for await (const event of events) {
      signal.throwIfAborted();
      if (event.type === "thread.started") {
        if (
          id ||
          !/^[a-f0-9-]{36}$/.test(event.thread_id) ||
          (request.resume && event.thread_id !== request.resume.id)
        )
          throw new RuntimeError("codex_session_invalid");
        id = event.thread_id;
        yield { type: "session", id };
      } else if (event.type === "turn.started") {
        if (!id || started || completed)
          throw new RuntimeError("codex_event_invalid");
        started = true;
      } else if (event.type === "turn.completed") {
        if (!started || completed)
          throw new RuntimeError("codex_result_invalid");
        completed = true;
        usage = codexUsage(event.usage);
      } else if (event.type === "error" || event.type === "turn.failed") {
        throw new RuntimeError("codex_turn_failed");
      } else if (
        ["item.started", "item.updated", "item.completed"].includes(event.type)
      ) {
        if (!("item" in event)) throw new RuntimeError("codex_event_invalid");
        const item = event.item;
        if (event.type === "item.completed" && item.type === "error") {
          yield { type: "progress", message: "codex_warning" };
          continue;
        }
        if (!started) throw new RuntimeError("codex_event_invalid");
        if (
          completed &&
          !(event.type === "item.completed" && item.type === "agent_message")
        )
          throw new RuntimeError("codex_event_after_result");
        if (event.type === "item.completed" && item.type === "agent_message") {
          if (typeof item.text !== "string")
            throw new RuntimeError("codex_result_invalid");
          final = item.text;
          for (let offset = 0; offset < item.text.length; offset += 16384)
            yield {
              type: "progress",
              message: item.text.slice(offset, offset + 16384),
            };
        } else if (event.type === "item.started")
          yield { type: "progress", message: `Tool: ${item.type}` };
      } else throw new RuntimeError("codex_event_invalid");
    }
    signal.throwIfAborted();
    if (!id || !completed || final === undefined)
      throw new RuntimeError("codex_result_missing");
    const result: unknown = validate ? JSON.parse(final) : final;
    if (validate && !validate(result))
      throw new RuntimeError("codex_output_invalid");
    if (
      usage &&
      (!request.resume || previous) &&
      usage.input_tokens >= (previous?.input_tokens ?? 0) &&
      usage.output_tokens >= (previous?.output_tokens ?? 0)
    )
      yield {
        type: "usage",
        input_tokens: usage.input_tokens - (previous?.input_tokens ?? 0),
        output_tokens: usage.output_tokens - (previous?.output_tokens ?? 0),
      };
    if (roleUsers[request.role].uid === 10001) {
      const native = await transcript(sessions, id);
      for (const name of await readdir(request.session_directory))
        await rm(join(request.session_directory, name), { recursive: true });
      const name = relative(sessions, native);
      const target = join(request.session_directory, "sessions", name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyTranscript(native, target);
      await writeFile(
        join(request.session_directory, "metadata.json"),
        JSON.stringify({
          version,
          id,
          binding: request.binding,
          transcript: name,
          usage,
        } satisfies Session),
        { mode: 0o600 },
      );
    }
    yield { type: "terminal", outcome: "completed", result };
  } catch (error) {
    const code =
      error instanceof RuntimeError ? error.code : "codex_execution_failed";
    yield { type: "progress", message: code };
    yield {
      type: "terminal",
      outcome: signal.aborted ? "cancelled" : "failed",
      result: { code },
    };
  }
}
