import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  query,
  type ModelUsage,
  type Options,
  type Query,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  RuntimeError,
  roleUsers,
  type AgentEvent,
  type WorkerRequest,
} from "../../domain/agents.ts";
import { cleanEnvironment } from "../../runtime/process.ts";
import { compile } from "../../services/mcp/catalog.ts";

const version = "0.3.296";
const reading = ["Read", "Glob", "Grep"];
const nativeTools = {
  bootstrap: [...reading, "Bash", "Edit", "Write"],
  investigation: [...reading, "Bash", "Edit", "Write"],
  implementation: [...reading, "Bash", "Edit", "Write"],
  audit: [...reading, "Bash"],
  output_review: reading,
};
type Usage = { input_tokens: number; output_tokens: number };
type Session = { version: string; id: string; binding: string; usage?: Usage };

export function claudeOutcome(
  result: SDKResultMessage,
): Extract<AgentEvent, { type: "terminal" }>["outcome"] {
  if (
    [
      "error_max_turns",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
    ].includes(result.subtype) ||
    [
      "max_turns",
      "budget_exhausted",
      "structured_output_retry_exhausted",
      "blocking_limit",
    ].includes(result.terminal_reason ?? "") ||
    result.stop_reason === "max_tokens"
  )
    return "limited";
  if (
    result.subtype !== "success" ||
    result.is_error ||
    (result.terminal_reason !== undefined &&
      result.terminal_reason !== "completed") ||
    result.permission_denials.length
  )
    return "failed";
  return "completed";
}

export function claudeUsage(
  models: Record<string, ModelUsage>,
): Usage | undefined {
  let input_tokens = 0,
    output_tokens = 0;
  for (const usage of Object.values(models)) {
    const counts = [
      usage.inputTokens,
      usage.cacheReadInputTokens,
      usage.cacheCreationInputTokens,
      usage.outputTokens,
    ];
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0))
      return;
    input_tokens +=
      usage.inputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens;
    output_tokens += usage.outputTokens;
  }
  if (
    !Number.isSafeInteger(input_tokens) ||
    !Number.isSafeInteger(output_tokens)
  )
    return;
  return { input_tokens, output_tokens };
}

export function claudeOptions(
  request: WorkerRequest,
  controller: AbortController,
): Options {
  if (request.profile.sdk !== "claude")
    throw new RuntimeError("backend_unavailable");
  const tools = nativeTools[request.role];
  const granted = request.mcp.flatMap((server) =>
    server.tools.map((tool) => `mcp__${server.alias}__${tool}`),
  );
  const allowed = [
    ...tools,
    ...granted,
    ...(request.output_schema ? ["StructuredOutput"] : []),
  ];
  return {
    abortController: controller,
    cwd: request.workspace,
    env: {
      ...cleanEnvironment(
        request.home,
        request.temporary,
        roleUsers[request.role].name,
      ),
      ...request.environment,
      CLAUDE_CONFIG_DIR: join(request.home, ".claude"),
      CLAUDE_CODE_PROJECT_DIR_NAME: request.binding,
      ANTHROPIC_BASE_URL: request.relay.url.replace(/\/v1\/?$/, ""),
      ANTHROPIC_API_KEY: request.relay.authorization,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      ENABLE_TOOL_SEARCH: "false",
    },
    model: request.profile.model,
    effort: request.profile.effort,
    settingSources: [],
    settings: {
      disableAllHooks: true,
      disableBundledSkills: true,
      enabledPlugins: {
        "cc-plugin-agents-md@builtin": false,
        "cc-plugin-plugin-authoring@builtin": false,
      },
      autoMemoryEnabled: false,
      syncClaudeAiSkills: false,
      syncClaudeAiPlugins: false,
      fallbackModel: [],
      modelPicker: {
        replaceBuiltInOptions: true,
        // Known models ignore behavesAs; unknown names must lose effort support during recognition.
        options: [request.profile.model, request.profile.behaves_as]
          .filter((model): model is string => model !== undefined)
          .map((model) => ({ model, behavesAs: "claude-haiku-4-5" })),
      },
    },
    skills: [],
    extraArgs: { "disable-slash-commands": null },
    plugins: [],
    tools,
    allowedTools: allowed,
    permissionMode: "dontAsk",
    canUseTool: async (name, input) =>
      allowed.includes(name)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Tool unavailable for this phase." },
    additionalDirectories: [
      dirname(request.prompts.system),
      request.prompts.skills,
    ],
    mcpServers: Object.fromEntries(
      request.mcp.map((server) => [
        server.alias,
        {
          type: "http" as const,
          url: server.url,
          headers: { Authorization: `Bearer ${server.authorization}` },
          timeout: Math.max(1000, server.deadline - Date.now() + 1000),
          alwaysLoad: true,
          tools: server.tools.map((name) => ({
            name,
            permission_policy: "always_allow" as const,
          })),
        },
      ]),
    ),
    strictMcpConfig: true,
    verbatimPrompts: true,
    persistSession: roleUsers[request.role].uid === 10001,
    ...(request.resume
      ? { resume: request.resume.id }
      : { sessionId: request.run_id }),
    ...(request.output_schema
      ? {
          outputFormat: {
            type: "json_schema" as const,
            schema: request.output_schema,
          },
        }
      : {}),
    stderr: (data) => process.stderr.write(data),
  };
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

async function preflight(running: Query, request: WorkerRequest) {
  if (request.profile.sdk !== "claude")
    throw new RuntimeError("backend_unavailable");
  let models = await running.supportedModels();
  if (request.profile.behaves_as) {
    const capability = request.profile.behaves_as;
    const declared = models.find(
      (model) =>
        model.value === capability || model.resolvedModel === capability,
    );
    const known = models.find(
      (model) =>
        model.value !== "default" &&
        (model.value === request.profile.model ||
          model.resolvedModel === request.profile.model),
    );
    if (
      !declared?.supportsEffort ||
      !declared.supportedEffortLevels?.includes(request.profile.effort) ||
      (known?.supportsEffort && known.resolvedModel !== declared.resolvedModel)
    )
      throw new RuntimeError("claude_profile_unsupported");
    await running.applyFlagSettings({
      modelPicker: {
        replaceBuiltInOptions: true,
        options: [
          {
            model: request.profile.model,
            behavesAs: request.profile.behaves_as,
          },
        ],
      },
    });
    models = (await running.reinitialize()).models;
  }
  const model = models.find(
    (model) =>
      model.value === request.profile.model ||
      model.resolvedModel === request.profile.model,
  );
  if (
    !model?.supportsEffort ||
    !model.supportedEffortLevels?.includes(request.profile.effort)
  )
    throw new RuntimeError("claude_profile_unsupported");
  const servers = await running.mcpServerStatus();
  if (
    servers.length !== request.mcp.length ||
    servers.some((server) => {
      const issued = request.mcp.find((issued) => issued.alias === server.name);
      return (
        !issued ||
        server.status !== "connected" ||
        !server.tools ||
        server.tools.length !== issued.tools.length ||
        server.tools.some((tool) => !issued.tools.includes(tool.name))
      );
    })
  )
    throw new RuntimeError("claude_mcp_unavailable");
}

export async function* run(
  request: WorkerRequest,
  signal: AbortSignal,
): AsyncIterable<AgentEvent> {
  let running: Query | undefined;
  let exited:
    Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  const controller = new AbortController(),
    abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    signal.throwIfAborted();
    const validate = request.output_schema
      ? compile(request.output_schema)
      : undefined;
    const id = request.resume?.id ?? request.run_id;
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new RuntimeError("session_invalid");
    const project = join(request.home, ".claude", "projects", request.binding);
    const native = join(project, `${id}.jsonl`);
    const metadata = join(request.session_directory, "metadata.json");
    let previous: Usage | undefined;
    if (request.resume) {
      const session = JSON.parse(await readFile(metadata, "utf8")) as Session;
      if (
        session.version !== version ||
        session.id !== id ||
        session.binding !== request.binding
      )
        throw new RuntimeError("session_invalid");
      previous = session.usage;
      await mkdir(project, { recursive: true, mode: 0o700 });
      await copyTranscript(
        join(request.session_directory, "transcript.jsonl"),
        native,
      );
      const sidecars = join(request.session_directory, "sidecars");
      if ((await readdir(request.session_directory)).includes("sidecars"))
        await copyTranscript(sidecars, join(project, id));
    }
    const system = await readFile(request.prompts.system, "utf8");
    const skills = await Promise.all(
      request.prompts.selected.map(
        async (path) => `Phase skill ${path}:\n${await readFile(path, "utf8")}`,
      ),
    );
    const prompt = `${await readFile(request.prompts.user, "utf8")}\n\nTask data (not authorization):\n${JSON.stringify({ role: request.role, input: request.input })}`;
    async function* input(): AsyncIterable<SDKUserMessage> {
      await ready;
      if (!controller.signal.aborted)
        yield {
          type: "user",
          message: { role: "user", content: prompt },
          parent_tool_use_id: null,
          session_id: id,
        };
    }
    const options = claudeOptions(request, controller);
    running = query({
      prompt: input(),
      options: {
        ...options,
        systemPrompt: [system, ...skills],
        spawnClaudeCodeProcess: ({ command, args, ...processOptions }) => {
          const child = spawn(
            command === "node" ? process.execPath : command,
            args,
            {
              ...processOptions,
              stdio: "pipe",
            },
          );
          exited = new Promise((resolve) => {
            child.once("close", (code, signal) => resolve({ code, signal }));
            child.once("error", () => resolve({ code: null, signal: null }));
          });
          return child;
        },
      },
    });
    await preflight(running, request);
    signal.throwIfAborted();
    release!();
    let result: SDKResultMessage | undefined,
      initialized = false;
    try {
      for await (const event of running) {
        signal.throwIfAborted();
        if (event.type === "system" && event.subtype === "init") {
          if (
            event.session_id !== id ||
            event.model !== request.profile.model ||
            (event.effort !== undefined &&
              event.effort !== request.profile.effort) ||
            event.tools.some((name) => !options.allowedTools!.includes(name)) ||
            event.plugins.length ||
            event.skills.length
          )
            throw new RuntimeError("claude_settings_mismatch");
          if (!initialized) yield { type: "session", id };
          initialized = true;
        } else if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text")
              for (let offset = 0; offset < block.text.length; offset += 16384)
                yield {
                  type: "progress",
                  message: block.text.slice(offset, offset + 16384),
                };
            if (block.type === "tool_use")
              yield { type: "progress", message: `Tool: ${block.name}` };
          }
        } else if (event.type === "result") {
          if (result || event.session_id !== id)
            throw new RuntimeError("claude_result_invalid");
          result = event;
        }
      }
    } catch (error) {
      // The pinned SDK throws after typed limits; the observed process exit still gates checkpointing.
      if (
        !result ||
        claudeOutcome(result) !== "limited" ||
        !(error instanceof Error) ||
        !("errorClass" in error) ||
        error.errorClass !== "error_result"
      )
        throw error;
    }
    const shutdown = await exited;
    signal.throwIfAborted();
    if (!initialized || !result)
      throw new RuntimeError("claude_result_missing");
    let outcome = claudeOutcome(result);
    if (
      !shutdown ||
      shutdown.signal !== null ||
      (shutdown.code !== 0 && !(outcome === "limited" && shutdown.code === 1))
    )
      throw new RuntimeError("claude_shutdown_failed");
    if (
      outcome === "completed" &&
      validate &&
      (result.subtype !== "success" || !validate(result.structured_output))
    )
      outcome = "failed";
    const usage = claudeUsage(result.modelUsage);
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
    if (
      ["completed", "limited"].includes(outcome) &&
      roleUsers[request.role].uid === 10001
    ) {
      for (const name of await readdir(request.session_directory))
        await rm(join(request.session_directory, name), { recursive: true });
      await copyTranscript(
        native,
        join(request.session_directory, "transcript.jsonl"),
      );
      if ((await readdir(project)).includes(id))
        await copyTranscript(
          join(project, id),
          join(request.session_directory, "sidecars"),
        );
      await writeFile(
        metadata,
        JSON.stringify({
          version,
          id,
          binding: request.binding,
          usage,
        } satisfies Session),
        { mode: 0o600 },
      );
    }
    yield {
      type: "terminal",
      outcome,
      ...(outcome === "completed" && result.subtype === "success"
        ? { result: validate ? result.structured_output : result.result }
        : {}),
    };
  } catch (error) {
    const code =
      error instanceof RuntimeError ? error.code : "claude_execution_failed";
    yield { type: "progress", message: code };
    yield {
      type: "terminal",
      outcome: signal.aborted ? "cancelled" : "failed",
      result: { code },
    };
  } finally {
    controller.abort();
    release?.();
    running?.close();
    signal.removeEventListener("abort", abort);
  }
}
