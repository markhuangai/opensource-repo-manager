import { compile } from "../src/adapters/agents/schema.ts";
import { describe, expect, it } from "vitest";
import {
  agentEventSchema,
  workerEnvelopeSchema,
  workerLimits,
} from "../src/domain/agents.ts";
import { fixtureSnapshot } from "./fixtures.ts";

describe("worker protocol", () => {
  it("validates actual event shapes and rejects escaped artifacts and invented authority", () => {
    expect(
      agentEventSchema.parse({
        type: "usage",
        input_tokens: 12,
        output_tokens: 4,
      }),
    ).toEqual({ type: "usage", input_tokens: 12, output_tokens: 4 });
    for (const event of [
      { type: "artifact", path: "../config/actions.yml" },
      { type: "artifact", path: "/config/actions.yml" },
      { type: "progress", message: "text", approved: true },
      { type: "terminal", outcome: "success" },
      { type: "usage", input_tokens: -1, output_tokens: 0 },
      { type: "session", id: "../other-session" },
    ])
      expect(agentEventSchema.safeParse(event).success).toBe(false);
    expect(
      workerEnvelopeSchema.safeParse({
        run_id: "fake",
        job_id: 1,
        revision: 1,
        event: { type: "terminal", outcome: "completed" },
      }).success,
    ).toBe(false);
  });
  it("uses the validated worker limits", async () => {
    const { snapshot } = await fixtureSnapshot();
    expect(workerLimits(snapshot)).toEqual({
      processes: 128,
      output: 16 * 1024 * 1024,
      storage: 4 * 1024 ** 3,
    });
  });
});

describe("structured agent output validation", () => {
  it("validates without coercion or mutation and isolates repeated schema IDs", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "same",
      type: "object",
      properties: { count: { type: "integer", default: 3 } },
      required: ["count"],
      additionalProperties: false,
    };
    const validate = compile(schema),
      data = { count: "3" };
    expect(validate(data)).toBe(false);
    expect(data).toEqual({ count: "3" });
    expect(validate({ count: 3 })).toBe(true);
    expect(compile({ $id: "same", type: "string" })("valid")).toBe(true);
  });
  it("rejects external, asynchronous and unsupported regex schemas", () => {
    for (const schema of [
      { $ref: "https://untrusted.invalid/schema" },
      { $async: true, type: "object" },
      { type: "string", pattern: "(?=unsafe)" },
    ])
      expect(() => compile(schema)).toThrow("output_schema_invalid");
    const validate = compile({ type: "string", pattern: "^(a+)+$" });
    expect(validate("a".repeat(100000) + "!")).toBe(false);
    expect(compile({ type: "string", pattern: "é" })("café")).toBe(true);
  });
});
