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
    proxy: { url: config.proxy.url, key: { from_secret: "ORM_PROXY_KEY" } },
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

  it("resolves the supplied example, shared variables, and referenced SDKs before validation", () => {
    const input = repositoryConfiguration();
    Object.assign(input.proxy, { url: { from_secret: "PROXY_URL" } });
    Object.assign(input.profiles.coding, {
      sdk: { from_variable: "CODING_SDK" },
      model: { from_variable: "CODING_MODEL" },
      effort: { from_variable: "CODING_MODEL_EFFORT" },
    });
    Object.assign(input.profiles.review, {
      model: { from_variable: "REVIEW_MODEL" },
      effort: { from_variable: "CODING_MODEL_EFFORT" },
    });
    const sources = fixtureConfigurationSources();
    const result = parse(input, {
      ...sources,
      variables: { ...sources.variables, CODING_SDK: "claude" },
    });
    expect(result.configuration.profiles).toEqual(
      fixtureConfiguration().profiles,
    );
    expect(result.configuration.proxy.url).toBe(sources.secrets.PROXY_URL);
    expect(result.sessionKey).toBe(sources.secrets.ORM_SESSION_KEY);
    expect(
      result.sources.filter((source) => source.name === "CODING_MODEL_EFFORT"),
    ).toHaveLength(2);
    expect(result.sources.every((source) => source.line && source.column)).toBe(
      true,
    );
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

  it("preserves literals even when both stores contain competing values", () => {
    const input = repositoryConfiguration();
    const sources = fixtureConfigurationSources();
    const result = parse(input, {
      ...sources,
      variables: { ...sources.variables, PROXY_URL: "https://other.invalid" },
      secrets: { ...sources.secrets, CODING_MODEL: "other-model" },
    });
    expect(result.configuration.proxy.url).toBe(input.proxy.url);
    expect(result.configuration.profiles).toEqual(input.profiles);
  });

  it("selects only the named namespace, without fallback, and accepts case-insensitive names", () => {
    const input = repositoryConfiguration();
    Object.assign(input.profiles.coding, {
      model: { from_variable: "coding_model" },
    });
    Object.assign(input.profiles.review, {
      model: { from_secret: "CODING_MODEL" },
    });
    const defaults = fixtureConfigurationSources();
    const sources = {
      ...defaults,
      secrets: { ...defaults.secrets, CODING_MODEL: "private-review-model" },
    };
    const result = parse(input, sources).configuration;
    expect(result.profiles.coding.model).toBe(defaults.variables.CODING_MODEL);
    expect(result.profiles.review.model).toBe("private-review-model");
    const variables = { ...defaults.variables };
    delete variables.CODING_MODEL;
    expect(() => parse(input, { ...sources, variables })).toThrow(
      "source_missing",
    );
    expect(() => parse(input, defaults)).toThrow("source_missing");
  });

  it("decodes JSON false, zero, arrays, and objects without resolving references inside returned data", () => {
    const input = repositoryConfiguration();
    Object.assign(input.pr_monitor, {
      enabled: { from_variable: "ENABLED", format: "json" },
    });
    Object.assign(input.limits, {
      repair_cycles: { from_variable: "REPAIRS", format: "json" },
    });
    Object.assign(input.roles.implementation, {
      skills: { from_variable: "SKILLS", format: "json" },
    });
    Object.assign(input.profiles, {
      review: { from_variable: "PROFILE", format: "json" },
    });
    const sources = fixtureConfigurationSources();
    const variables = {
      ...sources.variables,
      ENABLED: "false",
      REPAIRS: "0",
      SKILLS: JSON.stringify(["example", "implement"]),
      PROFILE: JSON.stringify({ sdk: "codex", model: "123", effort: "high" }),
    };
    const result = parse(input, { ...sources, variables }).configuration;
    expect(result.pr_monitor.enabled).toBe(false);
    expect(result.limits.repair_cycles).toBe(0);
    expect(result.roles.implementation.skills).toEqual([
      "example",
      "implement",
    ]);
    expect(result.profiles.review.model).toBe("123");
    variables.PROFILE = JSON.stringify({
      sdk: "codex",
      model: { from_secret: "ORM_GITHUB_TOKEN" },
      effort: "high",
    });
    expect(() => parse(input, { ...sources, variables })).toThrow(
      "schema_invalid",
    );
  });

  it("keeps unformatted external text unchanged and rejects invalid formats and domain values", () => {
    const input = repositoryConfiguration();
    const sources = fixtureConfigurationSources();
    Object.assign(input.profiles.coding, { model: { from_variable: "MODEL" } });
    expect(
      parse(input, { ...sources, variables: { MODEL: "123" } }).configuration
        .profiles.coding.model,
    ).toBe("123");
    for (const model of [
      { from_variable: "MODEL", from_secret: "MODEL" },
      { from_variable: "MODEL", format: "yaml" },
      { from_variable: "MODEL", unknown: true },
      { from_variable: 7 },
    ]) {
      Object.assign(input.profiles.coding, { model });
      expect(() =>
        parse(input, { ...sources, variables: { MODEL: "123" } }),
      ).toThrow("Configuration rejected");
    }
    Object.assign(input.profiles.coding, {
      model: "literal",
      effort: { from_variable: "EFFORT" },
    });
    expect(() =>
      parse(input, { ...sources, variables: { EFFORT: "ultra" } }),
    ).toThrow("schema_invalid");
    Object.assign(input.profiles.coding, { effort: "high" });
    Object.assign(input.limits, {
      repair_cycles: { from_variable: "COUNT", format: "json" },
    });
    expect(() =>
      parse(input, { ...sources, variables: { COUNT: "not-json-canary" } }),
    ).toThrow("source_value_invalid");
    expect(() =>
      parse(input, { ...sources, variables: { COUNT: '"0"' } }),
    ).toThrow("schema_invalid");
  });

  it("requires secret provenance for every authentication field, including referenced objects", () => {
    const defaults = fixtureConfigurationSources();
    for (const field of ["github", "proxy", "session_key"] as const) {
      for (const value of [
        "committed-credential",
        { from_variable: "TOKEN" },
      ]) {
        const input = repositoryConfiguration();
        if (field === "session_key")
          Object.assign(input, { session_key: value });
        else
          Object.assign(input[field], {
            [field === "github" ? "token" : "key"]: value,
          });
        expect(() =>
          parse(input, {
            ...defaults,
            variables: { TOKEN: defaults.secrets.ORM_GITHUB_TOKEN },
          }),
        ).toThrow("source_reference_invalid");
      }
    }
    const input = repositoryConfiguration();
    Object.assign(input, {
      github: { from_secret: "GITHUB_CONFIG", format: "json" },
    });
    expect(
      parse(input, {
        ...defaults,
        secrets: {
          ...defaults.secrets,
          GITHUB_CONFIG: JSON.stringify({
            token: defaults.secrets.ORM_GITHUB_TOKEN,
          }),
        },
      }).configuration.github.repository,
    ).toBe("owner/repo");
    Object.assign(input, {
      github: { from_variable: "GITHUB_CONFIG", format: "json" },
    });
    expect(() =>
      parse(input, {
        ...defaults,
        variables: {
          GITHUB_CONFIG: JSON.stringify({
            token: defaults.secrets.ORM_GITHUB_TOKEN,
          }),
        },
      }),
    ).toThrow("source_reference_invalid");
  });

  it("keeps private setting redaction separate from authentication scanning", () => {
    const input = repositoryConfiguration();
    Object.assign(input.profiles.coding, {
      model: { from_secret: "PRIVATE_MODEL" },
    });
    const defaults = fixtureConfigurationSources();
    const { configuration } = parse(input, {
      ...defaults,
      secrets: { ...defaults.secrets, PRIVATE_MODEL: "private-model-canary" },
    });
    const { settings, secrets } = separateSecrets(configuration);
    expect(settings.profiles.coding.model).toBe("private-model-canary");
    expect(secrets.containsCredentials(settings)).toBe(false);
    expect(
      secrets.redact("private-model-canary " + configuration.proxy.url),
    ).toBe("[redacted] [redacted]");
    expect(settings).not.toHaveProperty("redaction_values");
    expect(secrets.containsCredentials(configuration.github.token)).toBe(true);
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
  it("accepts proxy model IDs without capability declarations and rejects the retired field", () => {
    const config = fixtureConfiguration();
    config.profiles.coding = {
      sdk: "claude",
      model: "proxy/custom-model",
      effort: "xhigh",
    };
    expect(
      parseActionsConfiguration(stringify(config)).profiles.coding,
    ).toEqual(config.profiles.coding);
    Object.assign(config.profiles.coding, { behaves_as: "claude-opus-4-8" });
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
