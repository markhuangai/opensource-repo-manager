import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseActionsConfiguration } from "../src/config/schema.ts";
import { separateSecrets } from "../src/config/secrets.ts";
import { ConfigurationError } from "../src/config/errors.ts";
import {
  fixtureConfiguration,
  fixtureConfigurationSources,
} from "./fixtures.ts";
import { parseRepositoryActionsConfiguration } from "../src/config/schema.ts";
import {
  parseConfigurationSources,
  sourceContextBytes,
} from "../src/config/sources.ts";

function repositoryConfiguration() {
  const config = fixtureConfiguration();
  return {
    version: config.version,
    github: { token: { from_secret: "ORM_GITHUB_TOKEN" } },
    session_key: { from_secret: "ORM_SESSION_KEY" },
    profiles: config.profiles,
    roles: config.roles,
    limits: config.limits,
    pr_monitor: config.pr_monitor,
  };
}

describe("repository configuration sources", () => {
  const parse = (
    input = repositoryConfiguration(),
    sources = fixtureConfigurationSources(),
  ) =>
    parseRepositoryActionsConfiguration(
      stringify(input),
      "owner/repo",
      sources,
    );

  it("selects named harness profiles from trusted sources while requiring secret provenance", () => {
    const input = repositoryConfiguration();
    Object.assign(input.roles.implementation, {
      profile: { from_variable: "CODING_PROFILE" },
    });
    Object.assign(input.limits, {
      agent_runs: { from_variable: "AGENT_RUNS", format: "json" },
    });
    const sources = fixtureConfigurationSources();
    const variables = { CODING_PROFILE: "review", AGENT_RUNS: "16" };
    const { configuration } = parse(input, { ...sources, variables });
    expect(
      configuration.profiles[configuration.roles.implementation.profile],
    ).toEqual({ sdk: "codex" });
    expect(configuration.limits.agent_runs).toBe(16);
    Object.assign(input.github, { token: { from_variable: "TOKEN" } });
    expect(() =>
      parse(input, {
        ...sources,
        variables: { ...variables, TOKEN: "fixture-unsafe-token" },
      }),
    ).toThrow("source_reference_invalid");
    for (const session_key of [
      sources.secrets.ORM_SESSION_KEY,
      { from_variable: "KEY" },
    ]) {
      expect(() =>
        parse(Object.assign(repositoryConfiguration(), { session_key }), {
          ...sources,
          variables: { KEY: sources.secrets.ORM_SESSION_KEY },
        }),
      ).toThrow("source_reference_invalid");
    }
  });
  it("retains source locations through profile and cross-field policy validation", () => {
    const defaults = fixtureConfigurationSources();
    for (const [selector, expected, observed] of [
      ["AUDIT_PROFILE", "existing_profile", "unknown_profile"],
      [
        "LOCAL_ONLY",
        "operator_policy_without_remote_checks",
        "incompatible_policy",
      ],
      ["CHECKS", "unique_check_names", "duplicate_check_names"],
    ]) {
      const input = repositoryConfiguration();
      if (selector === "AUDIT_PROFILE")
        Object.assign(input.roles.audit, {
          profile: { from_variable: selector },
        });
      else if (selector === "LOCAL_ONLY")
        Object.assign(input.pr_monitor, {
          local_checks_only: { from_variable: selector, format: "json" },
        });
      else
        Object.assign(input.pr_monitor, {
          required_checks: { from_variable: selector, format: "json" },
        });
      let error: unknown;
      try {
        parse(input, {
          ...defaults,
          variables: {
            AUDIT_PROFILE: "private-profile-canary",
            LOCAL_ONLY: "true",
            CHECKS: '["same","same"]',
          },
        });
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(ConfigurationError);
      if (!(error instanceof ConfigurationError)) throw error;
      expect(error.diagnostic).toMatchObject({
        source: "variable",
        name: selector,
        expected,
        observed,
        line: expect.any(Number),
        column: expect.any(Number),
      });
      expect(JSON.stringify(error)).not.toContain("private-profile-canary");
    }
  });

  it("identifies contributing references on duplicate collection members", () => {
    const defaults = fixtureConfigurationSources();
    for (const kind of ["checks", "reviewers"]) {
      const input = repositoryConfiguration();
      if (kind === "checks")
        Object.assign(input.pr_monitor, {
          required_checks: [
            { from_variable: "CHECK_A" },
            { from_variable: "CHECK_B" },
          ],
        });
      else
        Object.assign(input.pr_monitor, {
          automated_reviewers: [
            { login: { from_variable: "LOGIN_A" }, signal: "github_review" },
            { login: { from_variable: "LOGIN_B" }, signal: "github_review" },
          ],
        });
      let error: unknown;
      try {
        parse(input, {
          ...defaults,
          variables: {
            CHECK_A: "same",
            CHECK_B: "same",
            LOGIN_A: "Reviewer",
            LOGIN_B: "reviewer",
          },
        });
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(ConfigurationError);
      if (!(error instanceof ConfigurationError)) throw error;
      expect(error.diagnostic).toMatchObject({
        source: "variable",
        name: kind === "checks" ? "CHECK_B" : "LOGIN_B",
        expected: kind === "checks" ? "unique_check_names" : "unique_reviewers",
        observed:
          kind === "checks" ? "duplicate_check_names" : "duplicate_reviewers",
        line: expect.any(Number),
        column: expect.any(Number),
      });
    }
  });

  it("bounds decoded expansion and nesting before constructing the complete result", () => {
    const defaults = fixtureConfigurationSources();
    const input = repositoryConfiguration();
    Object.assign(input.profiles, {
      review: { from_variable: "DEEP", format: "json" },
    });
    expect(() =>
      parse(input, {
        ...defaults,
        variables: { DEEP: "[".repeat(40) + "0" + "]".repeat(40) },
      }),
    ).toThrow("source_value_invalid");
    Object.assign(input.profiles, {
      review: Array.from({ length: 40 }, () => ({
        from_variable: "EXPANSION",
      })),
    });
    expect(() =>
      parse(input, {
        ...defaults,
        variables: { EXPANSION: "x".repeat(32 * 1024) },
      }),
    ).toThrow("source_value_invalid");
  });

  it("rejects unsafe contexts and recursive or oversized input without echoing private content", () => {
    for (const context of [
      '{"SECRET":',
      '{"SECRET":7}',
      "[]",
      '{"Name":"x","NAME":"y"}',
      "secret-canary".repeat(sourceContextBytes),
    ]) {
      expect(() => parseConfigurationSources("{}", context)).toThrow(
        "source_context_invalid",
      );
      try {
        parseConfigurationSources("{}", context);
      } catch (error) {
        expect(String(error)).not.toContain("secret-canary");
      }
    }
    expect(() =>
      parseRepositoryActionsConfiguration(
        "cycle: &cycle {next: *cycle}\n" + stringify(repositoryConfiguration()),
        "owner/repo",
        fixtureConfigurationSources(),
      ),
    ).toThrow("source_value_invalid");
    const input = repositoryConfiguration();
    Object.assign(input.profiles.coding, {
      model: { from_variable: "__proto__" },
    });
    expect(() => parse(input)).toThrow("source_missing");
  });
});

describe("strict protected configuration contract", () => {
  it("accepts the documented example with both SDKs and v2 limits", () => {
    const config = fixtureConfiguration();
    expect(config.profiles.coding.sdk).toBe("claude");
    expect(config.profiles.review.sdk).toBe("codex");
    expect(config.limits).toEqual({
      active_slots: 1,
      active_minutes: 60,
      agent_runs: 200,
      repair_cycles: 3,
      infrastructure_retries: 2,
      wait_hours: 24,
      worker_processes: 128,
      worker_output_bytes: 16 * 1024 * 1024,
      worker_storage_bytes: 4 * 1024 ** 3,
    });
  });
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
    expect(secrets.redact(config.github.token)).toBe("[redacted]");
  });
  const invalid = [
    [
      "unsupported version",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c, { version: 1 }),
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
      "removed inline relay settings",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c, {
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
