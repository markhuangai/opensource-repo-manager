import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createKnownSecretChecker } from "../src/logging/redact.ts";

describe("known-secret checks and actual logging", () => {
  it("detects credentials in nested values and keys, including bearer payloads", () => {
    const checker = createKnownSecretChecker([
      "secret-canary",
      "Bearer header-canary",
    ]);
    expect(checker.contains({ data: [{ value: "header-canary" }] })).toBe(true);
    expect(checker.contains({ "prefix-secret-canary": 1 })).toBe(true);
    expect(checker.contains({ allowed: "ordinary evidence" })).toBe(false);
    expect(checker.redact("secret-canary header-canary")).toBe(
      "[redacted] [redacted]",
    );
  });
  it("redacts actual stdout/stderr before bounding output", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createKnownSecretChecker, createSafeLogger } from './src/logging/redact.ts';
      const logger = createSafeLogger(createKnownSecretChecker(['logging-secret-canary']));
      logger.info('prefix logging-secret-canary suffix');
      logger.error('x'.repeat(2030) + 'logging-secret-canary' + 'x'.repeat(3000));
    `,
      ],
      { cwd: new URL("../", import.meta.url), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("prefix [redacted] suffix\n");
    expect(result.stderr).not.toContain("logging-secret-canary");
    expect(result.stderr.length).toBeLessThanOrEqual(2049);
  });
});
