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
      { type: "artifact", path: "../config/config.yml" },
      { type: "artifact", path: "/config/config.yml" },
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
  it("uses compatible defaults for old snapshots without changing their bytes", async () => {
    const { snapshot } = await fixtureSnapshot();
    const old = JSON.parse(JSON.stringify(snapshot));
    delete old.settings.limits.worker_processes;
    delete old.settings.limits.worker_output_bytes;
    delete old.settings.limits.worker_storage_bytes;
    const before = JSON.stringify(old);
    expect(workerLimits(old)).toEqual({
      processes: 128,
      output: 16 * 1024 * 1024,
      storage: 4 * 1024 ** 3,
    });
    expect(JSON.stringify(old)).toBe(before);
    expect(workerLimits(snapshot)).toEqual({
      processes: 128,
      output: 16 * 1024 * 1024,
      storage: 4 * 1024 ** 3,
    });
  });
});
