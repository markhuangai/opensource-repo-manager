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
  it("forks a pending secret prefix without changing the original or another fork", () => {
    const stream = createKnownSecretChecker([
      "prefix-canary",
      "prefix-candy",
    ]).createStream();
    expect(stream.push("prefix-ca")).toBe(false);
    expect(stream.pending).toBe(true);
    const matching = stream.fork(),
      benign = stream.fork();
    expect(benign.push("t!")).toBe(false);
    expect(benign.pending).toBe(false);
    expect(matching.push("nary")).toBe(true);
    expect(stream.pending).toBe(true);
    expect(stream.push("ndy")).toBe(true);
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
  it.each(["0", "1", "info", "owner/repo"])(
    "preserves public structured provenance independently of secret %s",
    (secret) => {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { createKnownSecretChecker, createSafeLogger } from './src/logging/redact.ts';
        const logger = createSafeLogger(createKnownSecretChecker([process.argv[1], 'private-settings-canary']));
        const record = {event:'configuration_load_failed',level:'error',repository:'owner/repo',run_id:'100',run_attempt:'1',issue_number:'70',source_sha:'a01'.repeat(13)+'a',cause:'source_missing',name:'MODEL',line:10,column:1,elapsed_ms:101};
        logger.infoPublic({...record, level:'info', event:'configuration_resolved', schema_version:1, secret:'private-settings-canary', configuration:{token:'private-settings-canary'}});
        logger.errorPublic(record);
        logger.error('private-settings-canary');
      `,
          secret,
        ],
        { cwd: new URL("../", import.meta.url), encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      const info = JSON.parse(result.stdout.trim()),
        [error, privateText] = result.stderr.trim().split("\n");
      expect(info).toMatchObject({
        event: "configuration_resolved",
        level: "info",
        repository: "owner/repo",
        run_id: "100",
        run_attempt: "1",
        issue_number: "70",
        schema_version: 1,
        elapsed_ms: 101,
      });
      expect(JSON.parse(error)).toMatchObject({
        event: "configuration_load_failed",
        level: "error",
        run_id: "100",
        run_attempt: "1",
        issue_number: "70",
        source_sha: "a01".repeat(13) + "a",
        cause: "source_missing",
        name: "MODEL",
        line: 10,
        column: 1,
        elapsed_ms: 101,
      });
      expect(result.stdout + result.stderr).not.toContain(
        "private-settings-canary",
      );
      expect(info).not.toHaveProperty("secret");
      expect(info).not.toHaveProperty("configuration");
      expect(privateText).toBe("[redacted]");
    },
  );
  it("bounds public records at field boundaries and reports omitted metadata", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createKnownSecretChecker, createSafeLogger } from './src/logging/redact.ts';
      const logger = createSafeLogger(createKnownSecretChecker([]), true);
      logger.infoPublic({event:'configuration_load_failed',level:'error',run_id:'100',cause:'source_missing',recovery:'x'.repeat(4096)});
    `,
      ],
      { cwd: new URL("../", import.meta.url), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeLessThanOrEqual(2049);
    expect(JSON.parse(result.stderr.trim())).toEqual({
      event: "configuration_load_failed",
      level: "error",
      run_id: "100",
      cause: "source_missing",
      omitted_fields: ["recovery"],
    });
  });
});
