import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseActionsConfiguration } from "../src/config/schema.ts";
import { separateSecrets } from "../src/config/secrets.ts";
import { fixtureConfiguration } from "./fixtures.ts";

describe("strict protected configuration contract", () => {
  it("preserves a declared Claude alias capability model without changing the wire model", () => {
    const config = fixtureConfiguration();
    config.profiles.coding = {
      sdk: "claude",
      model: "auto",
      behaves_as: "claude-opus-4-8",
      effort: "xhigh",
    };
    expect(
      parseActionsConfiguration(stringify(config)).profiles.coding,
    ).toEqual(config.profiles.coding);
    config.profiles.review = { ...config.profiles.coding, sdk: "codex" };
    expect(() => parseActionsConfiguration(stringify(config))).toThrow(
      "schema_invalid",
    );
  });
  it("accepts the documented example with both SDKs and v1 defaults", () => {
    const config = fixtureConfiguration();
    expect(config.profiles.coding.sdk).toBe("claude");
    expect(config.profiles.review.sdk).toBe("codex");
    expect(config.limits).toEqual({
      active_slots: 1,
      active_minutes: 60,
      model_requests: 200,
      repair_cycles: 3,
      infrastructure_retries: 2,
      wait_hours: 24,
      worker_processes: 128,
      worker_output_bytes: 16 * 1024 * 1024,
      worker_storage_bytes: 4 * 1024 ** 3,
    });
  });
  for (const [sdk, efforts] of [
    ["claude", ["low", "medium", "high", "xhigh", "max"]],
    [
      "codex",
      [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
        "persistent",
      ],
    ],
  ] as const) {
    for (const effort of efforts)
      it(`accepts ${sdk}/${effort} for any phase`, () => {
        const config = fixtureConfiguration();
        Object.assign(config.profiles.coding, { sdk, effort });
        expect(
          parseActionsConfiguration(stringify(config)).profiles.coding.effort,
        ).toBe(effort);
      });
  }
  it("keeps configurable budgets and credentials outside the snapshot", () => {
    const config = fixtureConfiguration();
    config.limits.active_minutes = 30;
    config.limits.repair_cycles = 0;
    expect(
      parseActionsConfiguration(stringify(config)).limits.active_minutes,
    ).toBe(30);
    const { settings, secrets } = separateSecrets(config);
    expect(secrets.containsCredentials(settings)).toBe(false);
    expect(secrets.get("github.token")).toBe(config.github.token);
    expect(secrets.redact(config.proxy.key)).toBe("[redacted]");
  });
  const invalid = [
    [
      "unsupported version",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c, { version: 2 }),
    ],
    [
      "unknown settings",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c, { unsafe: true }),
    ],
    [
      "unknown role keys",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.roles.audit, { permissions: "root" }),
    ],
    [
      "more than one slot",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.limits, { active_slots: 2 }),
    ],
    [
      "zero active budget",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.limits, { active_minutes: 0 }),
    ],
    [
      "negative retries",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.limits, { infrastructure_retries: -1 }),
    ],
    [
      "missing profile",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.roles.audit, { profile: "missing" }),
    ],
    [
      "unsupported effort",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.profiles.coding, { effort: "ultra" }),
    ],
    [
      "unsupported SDK",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.profiles.coding, { sdk: "other" }),
    ],
    [
      "multiple repositories",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.github, { repository: ["a/b", "c/d"] }),
    ],
    [
      "credential-bearing proxy URL",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.proxy, {
          url: "https://user:password@example.invalid",
        }),
    ],
    [
      "removed notifications",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c, { notifications: {} }),
    ],
    [
      "empty credential",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.github, { token: "" }),
    ],
    [
      "escaping prompt",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.roles.audit.prompts, {
          system: "../config/actions.yml",
        }),
    ],
  ] as const;
  for (const [name, change] of invalid)
    it(`rejects ${name}`, () => {
      const config = fixtureConfiguration();
      change(config);
      expect(() => parseActionsConfiguration(stringify(config))).toThrow(
        /Configuration rejected/,
      );
    });
  for (const source of [
    "token: malformed-secret-canary\n[",
    "version: 1\nversion: 1\n",
    "version: 1\n---\nversion: 1\n",
    "!unknown malformed-secret-canary",
    "a: &a [*a]",
  ]) {
    it("rejects unsafe YAML without source lines or arbitrary keys", () => {
      expect(() => parseActionsConfiguration(source)).toThrow(
        /Configuration rejected/,
      );
      try {
        parseActionsConfiguration(source);
      } catch (error) {
        expect(String(error)).not.toContain("malformed-secret-canary");
      }
    });
  }
  it("does not echo unknown schema keys containing credentials", () => {
    const config = Object.assign(fixtureConfiguration(), {
      "synthetic-secret-canary": true,
    });
    expect(() => parseActionsConfiguration(stringify(config))).toThrow(
      "schema_invalid",
    );
    try {
      parseActionsConfiguration(stringify(config));
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-secret-canary");
    }
  });
  it("rejects collection keys without dependency warnings disclosing their contents", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { parseActionsConfiguration } from './src/config/schema.ts';
          try { parseActionsConfiguration(process.argv[1]); }
          catch (error) { console.error(error.message); process.exitCode = 1; }
        `,
        "? [parser-secret-canary]\n: true\n",
      ],
      { cwd: new URL("../", import.meta.url), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Configuration rejected");
    expect(result.stderr).not.toMatch(
      /parser-secret-canary|Keys with collection values|Warning:/,
    );
  });
  it("rejects removed command forms without echoing paths or input", () => {
    for (const args of [
      [
        "config",
        "validate",
        "--config",
        "/missing-cli-secret-canary/config.yml",
      ],
      ["--secret-cli-canary"],
    ]) {
      const result = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "src/actions/main.ts", ...args],
        {
          cwd: new URL("../", import.meta.url),
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("arguments_invalid");
      expect(result.stderr).not.toMatch(/cli-secret-canary|secret-cli-canary/);
      expect(result.stdout).not.toContain("HTTP listening");
    }
  });
});
