import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Usage } from "@openai/codex-sdk";
import type { WorkerRequest } from "../../../src/domain/agents.ts";
import {
  codexOptions,
  codexUsage,
  run,
} from "../../../src/adapters/agents/codex.ts";

const request: WorkerRequest = {
  job_id: 1,
  revision: 1,
  snapshot_digest: "snapshot",
  role: "implementation",
  run_id: "11111111-1111-4111-8111-111111111111",
  workspace: "/workspace",
  home: "/home/worker",
  temporary: "/tmp/worker",
  session_directory: "/session",
  binding: "a".repeat(64),
  deadline: Date.now() + 900000,
  profile: { sdk: "codex", model: "gpt-5.5", effort: "xhigh" },
  prompts: {
    system: "/bundle/system.md",
    user: "/bundle/user.md",
    skills: "/bundle/skills",
    selected: [],
  },
  relay: { url: "http://127.0.0.1:1234/v1", authorization: "short-lived" },
  mcp: [
    {
      alias: "context",
      url: "http://127.0.0.1:5678/mcp",
      authorization: "scoped",
      tools: ["read"],
      deadline: Date.now() + 900000,
    },
  ],
};

async function collect(iterable: ReturnType<typeof run>) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Codex worker policy", () => {
  it("builds isolated provider and shell environments with exact MCP grants", () => {
    const { options, thread } = codexOptions(request);
    expect(options.env).not.toHaveProperty("GH_TOKEN");
    expect(options.env?.ORM_RELAY_AUTH).toBe("short-lived");
    expect(options.config?.shell_environment_policy).toMatchObject({
      inherit: "none",
    });
    expect(
      JSON.stringify(options.config?.shell_environment_policy),
    ).not.toContain("short-lived");
    expect(
      JSON.stringify(options.config?.shell_environment_policy),
    ).not.toContain("scoped");
    expect(options.configOverrides?.[1]).toContain('"enabled_tools"=["read"]');
    expect(options.configOverrides?.[1]).not.toContain("scoped");
    expect(thread).toMatchObject({
      model: "gpt-5.5",
      modelReasoningEffort: "xhigh",
      approvalPolicy: "never",
      webSearchMode: "disabled",
    });
  });
  it("rejects aliases before inference and denies output reviewer shell, writes and MCP", () => {
    for (const effort of ["ultra", "persistent"] as const)
      expect(() =>
        codexOptions({
          ...request,
          profile: { sdk: "codex", model: "gpt-5.5", effort },
        }),
      ).toThrow(/codex_effort_unsupported/);
    const { options, thread } = codexOptions({
      ...request,
      role: "output_review",
      mcp: [],
    });
    expect(thread.sandboxMode).toBe("read-only");
    expect(options.config?.features).toMatchObject({
      shell_tool: false,
      multi_agent: false,
      hooks: false,
    });
    expect(() => codexOptions({ ...request, role: "output_review" })).toThrow(
      /codex_review_tools_forbidden/,
    );
  });
  it("returns an explicit failure when ephemeral authorization is missing", async () => {
    const events = await collect(
      run(
        { ...request, relay: { ...request.relay, authorization: "" } },
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)).toEqual({
      type: "terminal",
      outcome: "failed",
      result: { code: "codex_authorization_missing" },
    });
  });
  it("rejects missing, mismatched, corrupt, and linked checkpoints before inference", async () => {
    const root = await mkdtemp(join(tmpdir(), "orm-codex-session-"));
    const selected = {
      ...request,
      home: join(root, "home"),
      session_directory: join(root, "session"),
      resume: { id: request.run_id, binding: request.binding },
    };
    try {
      await mkdir(selected.session_directory);
      const execute = () =>
        collect(run(selected, new AbortController().signal));
      expect((await execute()).at(-1)).toMatchObject({ outcome: "failed" });
      for (const changes of [
        { version: "old" },
        { id: "other" },
        { binding: "changed" },
      ]) {
        await writeFile(
          join(selected.session_directory, "metadata.json"),
          JSON.stringify({
            version: "0.162.1",
            id: request.run_id,
            binding: request.binding,
            transcript: `rollout-${request.run_id}.jsonl`,
            ...changes,
          }),
        );
        const sessions = join(selected.session_directory, "sessions");
        await mkdir(sessions, { recursive: true });
        await writeFile(
          join(sessions, `rollout-${request.run_id}.jsonl`),
          `{"type":"session_meta","payload":{"id":"${request.run_id}"}}\n`,
        );
        expect((await execute()).at(-1)).toEqual({
          type: "terminal",
          outcome: "failed",
          result: { code: "session_invalid" },
        });
      }
      const native = join(
        selected.session_directory,
        "sessions",
        `rollout-${request.run_id}.jsonl`,
      );
      await writeFile(
        join(selected.session_directory, "metadata.json"),
        JSON.stringify({
          version: "0.162.1",
          id: request.run_id,
          binding: request.binding,
          transcript: `rollout-${request.run_id}.jsonl`,
        }),
      );
      await writeFile(
        native,
        `{"type":"session_meta","payload":{"id":"${request.run_id}"}}\n{corrupt\n`,
      );
      expect((await execute()).at(-1)).toEqual({
        type: "terminal",
        outcome: "failed",
        result: { code: "codex_execution_failed" },
      });
      await rm(native);
      await symlink(join(root, "elsewhere"), native);
      expect((await execute()).at(-1)).toEqual({
        type: "terminal",
        outcome: "failed",
        result: { code: "session_invalid" },
      });
    } finally {
      await rm(root, { recursive: true });
    }
  });
});

describe("Codex cumulative usage", () => {
  it("keeps cached/reasoning subsets inside totals and preserves unknown usage", () => {
    const usage = {
      input_tokens: 20,
      cached_input_tokens: 3,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 2,
    };
    expect(codexUsage(usage)).toEqual({ input_tokens: 20, output_tokens: 5 });
    expect(codexUsage(undefined)).toBeUndefined();
    expect(codexUsage({ ...usage, input_tokens: NaN })).toBeUndefined();
    expect(
      codexUsage({ ...usage, input_tokens: Number.MAX_SAFE_INTEGER + 1 }),
    ).toBeUndefined();
    expect(
      codexUsage({
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 0,
      } as Usage),
    ).toBeUndefined();
  });
});
