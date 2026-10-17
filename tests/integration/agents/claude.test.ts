import { describe, expect, it } from "vitest";
import type {
  SDKResultMessage,
  ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  claudeOptions,
  claudeOutcome,
  claudeUsage,
} from "../../../src/adapters/agents/claude.ts";
import type { WorkerRequest } from "../../../src/domain/agents.ts";

const result = (changes: Record<string, unknown>) =>
  ({
    subtype: "success",
    is_error: false,
    permission_denials: [],
    stop_reason: "end_turn",
    ...changes,
  }) as unknown as SDKResultMessage;
describe("Claude result normalization", () => {
  it("never promotes error, interrupted, denied, or limited outcomes to completion", () => {
    expect(claudeOutcome(result({}))).toBe("completed");
    for (const changes of [
      { is_error: true },
      { subtype: "error_during_execution" },
      { terminal_reason: "aborted_tools" },
      { permission_denials: [{}] },
    ])
      expect(claudeOutcome(result(changes))).toBe("failed");
    for (const changes of [
      { subtype: "error_max_turns" },
      { subtype: "error_max_budget_usd" },
      { subtype: "error_max_structured_output_retries" },
      { stop_reason: "max_tokens" },
    ])
      expect(claudeOutcome(result(changes))).toBe("limited");
  });
  it("counts cached input and refuses unknown or unsafe token totals", () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 3,
    } as ModelUsage;
    expect(claudeUsage({ one: usage, two: usage })).toEqual({
      input_tokens: 30,
      output_tokens: 10,
    });
    expect(
      claudeUsage({ one: { ...usage, outputTokens: NaN } }),
    ).toBeUndefined();
    expect(
      claudeUsage({ one: { ...usage, inputTokens: Number.MAX_SAFE_INTEGER } }),
    ).toBeUndefined();
  });
});

describe("Claude worker policy", () => {
  const request = {
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
    profile: {
      sdk: "claude",
      model: "auto",
      behaves_as: "claude-opus-4-8",
      effort: "xhigh",
    },
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
  } as WorkerRequest;
  it("does not inherit ambient credentials and refuses invented tool permissions", async () => {
    const options = claudeOptions(request, new AbortController());
    expect(options.env).not.toHaveProperty("GH_TOKEN");
    expect(options.env?.ANTHROPIC_API_KEY).toBe("short-lived");
    expect(options.model).toBe("auto");
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    const decision = await options.canUseTool!(
      "mcp__context__hidden",
      {},
      {
        signal: new AbortController().signal,
        toolUseID: "test",
        requestId: "test",
      },
    );
    expect(decision?.behavior).toBe("deny");
    const server = options.mcpServers!.context;
    expect(server.type === "http" && server.timeout).toBeGreaterThan(300000);
  });
  it("gives independent roles fresh persistence and narrower native tools", () => {
    for (const role of ["audit", "output_review"] as const) {
      const options = claudeOptions(
        { ...request, role, mcp: [] },
        new AbortController(),
      );
      expect(options.persistSession).toBe(false);
      expect(options.tools).not.toContain("Write");
      expect(options.tools).not.toContain("Edit");
      expect((options.tools as string[]).includes("Bash")).toBe(
        role === "audit",
      );
    }
  });
});
