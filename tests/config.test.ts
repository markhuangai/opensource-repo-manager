import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseConfiguration } from "../src/config/schema.ts";
import { separateSecrets } from "../src/config/secrets.ts";
import { fixtureConfiguration, fixtureMcp } from "./fixtures.ts";

describe("strict protected configuration contract", () => {
  it("preserves a declared Claude alias capability model without changing the wire model", () => {
    const config = fixtureConfiguration();
    config.profiles.coding = {
      sdk: "claude",
      model: "auto",
      behaves_as: "claude-opus-4-8",
      effort: "xhigh",
    };
    expect(parseConfiguration(stringify(config)).profiles.coding).toEqual(
      config.profiles.coding,
    );
    config.profiles.review = { ...config.profiles.coding, sdk: "codex" };
    expect(() => parseConfiguration(stringify(config))).toThrow(
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
      reconciliation_minutes: 5,
      worker_processes: 128,
      worker_output_bytes: 16 * 1024 * 1024,
      worker_storage_bytes: 4 * 1024 ** 3,
    });
    expect(config.mcp).toEqual({
      credentials: {},
      servers: {},
      initialization_timeout_seconds: 30,
      call_timeout_seconds: 300,
      max_request_bytes: 1048576,
      max_response_bytes: 1048576,
      max_catalog_bytes: 1048576,
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
          parseConfiguration(stringify(config)).profiles.coding.effort,
        ).toBe(effort);
      });
  }
  it.each([
    "smtp .example.invalid",
    "smtp/example.invalid",
    "smtp\0.example.invalid",
  ])("rejects malformed SMTP host %j", (host) => {
    const config = fixtureConfiguration();
    config.notifications.smtp = {
      enabled: true,
      host,
      port: 465,
      secure: true,
      username: "smtp-user-canary",
      password: "smtp-password-canary",
      from: "orm@example.invalid",
      to: ["maintainer@example.invalid"],
    };
    expect(() => parseConfiguration(stringify(config))).toThrow(
      "schema_invalid",
    );
  });
  it("accepts all enabled notification channel types and configurable budgets", () => {
    const config = fixtureConfiguration();
    config.notifications.discord = {
      enabled: true,
      webhook_url:
        "https://discord.com/api/webhooks/example/notification-secret",
    };
    config.notifications.smtp = {
      enabled: true,
      host: "smtp.example.invalid",
      port: 465,
      secure: true,
      username: "smtp-user-canary",
      password: "smtp-password-canary",
      from: "orm@example.invalid",
      to: ["maintainer@example.invalid"],
    };
    config.limits.active_minutes = 30;
    config.limits.repair_cycles = 0;
    const parsed = parseConfiguration(stringify(config));
    expect(parsed.notifications.smtp).toEqual(config.notifications.smtp);
    expect(parsed.limits.active_minutes).toBe(30);
    const { settings, secrets } = separateSecrets(config);
    expect(JSON.stringify(settings)).not.toMatch(
      /notification-secret|smtp-password-canary|maintainer@example/,
    );
    expect(secrets.contains("smtp-password-canary")).toBe(true);
    expect(secrets.containsCredentials("smtp-password-canary")).toBe(true);
    expect(secrets.containsCredentials("smtp-user-canary")).toBe(false);
    expect(secrets.redact("smtp-user-canary")).toBe("[redacted]");
    config.notifications.smtp.password = "smtp-user-canary";
    expect(
      separateSecrets(config).secrets.containsCredentials("smtp-user-canary"),
    ).toBe(true);
    expect(secrets.get("notifications.smtp.password")).toBe(
      "smtp-password-canary",
    );
  });
  it.each([
    "Host",
    "content-type",
    "IDEMPOTENCY-KEY",
    "Connection",
    "Transfer-Encoding",
  ])("rejects notification transport header %s", (name) => {
    const config = fixtureConfiguration();
    config.notifications.webhook = {
      enabled: true,
      url: "https://notify.example.invalid",
      headers: { [name]: "fixture" },
    };
    expect(() => parseConfiguration(stringify(config))).toThrow(
      "schema_invalid",
    );
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
      "all notifications disabled",
      (c: ReturnType<typeof fixtureConfiguration>) =>
        Object.assign(c.notifications, { webhook: { enabled: false } }),
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
          system: "../config/config.yml",
        }),
    ],
  ] as const;
  for (const [name, change] of invalid)
    it(`rejects ${name}`, () => {
      const config = fixtureConfiguration();
      change(config);
      expect(() => parseConfiguration(stringify(config))).toThrow(
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
      expect(() => parseConfiguration(source)).toThrow(
        /Configuration rejected/,
      );
      try {
        parseConfiguration(source);
      } catch (error) {
        expect(String(error)).not.toContain("malformed-secret-canary");
      }
    });
  }
  it("does not echo unknown schema keys containing credentials", () => {
    const config = Object.assign(fixtureConfiguration(), {
      "synthetic-secret-canary": true,
    });
    expect(() => parseConfiguration(stringify(config))).toThrow(
      "schema_invalid",
    );
    try {
      parseConfiguration(stringify(config));
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
          import { parseConfiguration } from './src/config/schema.ts';
          try { parseConfiguration(process.argv[1]); }
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
      const result = spawnSync(process.execPath, ["src/main.ts", ...args], {
        cwd: new URL("../", import.meta.url),
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Configuration rejected");
      expect(result.stderr).not.toMatch(/cli-secret-canary|secret-cli-canary/);
      expect(result.stdout).not.toContain("HTTP listening");
    }
  });
});

describe("generic HTTP MCP policy configuration", () => {
  it("defaults review to skipped and validates exact per-server write lists", () => {
    const config = fixtureMcp();
    for (const list of [undefined, [], ["store_record"]]) {
      const source = JSON.parse(JSON.stringify(config));
      source.mcp.servers.context.review_required_tools = list;
      expect(
        parseConfiguration(stringify(source)).mcp.servers.context
          .review_required_tools,
      ).toEqual(list ?? []);
    }
    for (const list of [
      ["store_record", "store_record"],
      ["missing"],
      ["read_record"],
    ]) {
      config.mcp.servers.context.review_required_tools = list;
      expect(() => parseConfiguration(stringify(config))).toThrow(
        "schema_invalid",
      );
    }
  });
  it("rejects the obsolete declaration with a safe migration instruction", () => {
    const config = JSON.parse(JSON.stringify(fixtureMcp()));
    config.mcp.servers.context.tools.store_record.effect = "reviewed_write";
    expect(() => parseConfiguration(stringify(config))).toThrow(
      "Replace effect: reviewed_write with effect: write and configure review_required_tools",
    );
  });
  it("accepts generic read/write grants, static headers and binding identity without secrets", () => {
    const parsed = parseConfiguration(stringify(fixtureMcp()));
    const { settings, secrets } = separateSecrets(parsed);
    expect(settings.mcp.servers.context.credential_ref).toBe("service");
    expect(settings.mcp.servers.context.tools.store_record).toEqual({
      effect: "write",
      idempotency_argument: "operation_key",
    });
    expect(JSON.stringify(settings)).not.toContain("mcp-credential-canary");
    expect(JSON.stringify(secrets)).not.toContain("mcp-credential-canary");
    expect(secrets.mcpHeaders("service").Authorization).toBe(
      "Bearer mcp-credential-canary",
    );
    expect(secrets.contains("mcp-credential-canary")).toBe(true);
  });
  it("supports an explicitly allowed unauthenticated HTTP server", () => {
    const config = fixtureMcp();
    config.mcp.servers.context.url = "http://fixture:8080/mcp";
    config.mcp.servers.context.allow_plain_http = true;
    delete config.mcp.servers.context.credential_ref;
    expect(
      parseConfiguration(stringify(config)).mcp.servers.context.credential_ref,
    ).toBeUndefined();
  });
  it("accepts the Dense-Mem example without provider-specific policy code", () => {
    const config = fixtureMcp();
    config.mcp.servers.context.tools = {
      recall_memory: { effect: "read" },
      trace_memory: { effect: "read" },
      remember: {
        effect: "write",
        idempotency_argument: "idempotency_key",
      },
    };
    config.roles.investigation.mcp.context.tools = [
      "recall_memory",
      "trace_memory",
      "remember",
    ];
    const parsed = parseConfiguration(stringify(config));
    expect(parsed.mcp.servers.context.tools.remember).toEqual({
      effect: "write",
      idempotency_argument: "idempotency_key",
    });
  });
  it("freezes credential bindings independently of later source-object mutation", () => {
    const config = fixtureMcp();
    const { secrets } = separateSecrets(config);
    config.mcp.credentials.service.headers.Authorization =
      "Bearer rotated-secret-canary";
    expect(secrets.mcpHeaders("service").Authorization).toBe(
      "Bearer mcp-credential-canary",
    );
    expect(() =>
      Object.assign(secrets.mcpHeaders("service"), {
        Authorization: "changed",
      }),
    ).toThrow();
  });
  const changes = [
    [
      "plain HTTP without opt-in",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.mcp.servers.context.url = "http://fixture/mcp";
      },
    ],
    [
      "URL credentials",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.mcp.servers.context.url = "https://user:secret@fixture/mcp";
      },
    ],
    [
      "missing credential binding",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.mcp.servers.context.credential_ref = "missing";
      },
    ],
    [
      "missing server grant",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.roles.audit.mcp.missing = { tools: ["read_record"] };
      },
    ],
    [
      "missing tool grant",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.roles.audit.mcp.context = { tools: ["missing"] };
      },
    ],
    [
      "wildcard grants",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.roles.audit.mcp.context = { tools: ["*"] };
      },
    ],
    [
      "reviewer grants",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.roles.output_review.mcp.context = { tools: ["read_record"] };
      },
    ],
    [
      "duplicate grants",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.roles.audit.mcp.context = { tools: ["read_record", "read_record"] };
      },
    ],
    [
      "unsupported transport",
      (c: ReturnType<typeof fixtureMcp>) => {
        Object.assign(c.mcp.servers.context, {
          transport: "stdio",
          command: "sh",
        });
      },
    ],
    [
      "OAuth configuration",
      (c: ReturnType<typeof fixtureMcp>) => {
        Object.assign(c.mcp.servers.context, { oauth: true });
      },
    ],
    [
      "inferred tool authority",
      (c: ReturnType<typeof fixtureMcp>) => {
        Object.assign(c.mcp.servers.context.tools.read_record, {
          annotations: { readOnlyHint: true },
        });
      },
    ],
    [
      "idempotency on a read",
      (c: ReturnType<typeof fixtureMcp>) => {
        Object.assign(c.mcp.servers.context.tools.read_record, {
          idempotency_argument: "key",
        });
      },
    ],
    [
      "unknown effect",
      (c: ReturnType<typeof fixtureMcp>) => {
        Object.assign(c.mcp.servers.context.tools.store_record, {
          effect: "mixed",
        });
      },
    ],
    [
      "zero timeout",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.mcp.call_timeout_seconds = 0;
      },
    ],
    [
      "oversized bound",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.mcp.max_request_bytes = 1048577;
      },
    ],
    [
      "header injection",
      (c: ReturnType<typeof fixtureMcp>) => {
        c.mcp.credentials.service.headers.Authorization =
          "secret\r\nHost: wrong";
      },
    ],
  ] as const;
  for (const [name, change] of changes)
    it(`rejects ${name}`, () => {
      const config = fixtureMcp();
      change(config);
      expect(() => parseConfiguration(stringify(config))).toThrow(
        /Configuration rejected/,
      );
    });
  it("accepts positive timeout overrides and lower request/response/catalog bounds", () => {
    const config = fixtureMcp();
    Object.assign(config.mcp, {
      initialization_timeout_seconds: 5,
      call_timeout_seconds: 90,
      max_request_bytes: 4096,
      max_response_bytes: 8192,
      max_catalog_bytes: 16384,
    });
    expect(parseConfiguration(stringify(config)).mcp.call_timeout_seconds).toBe(
      90,
    );
  });
  it("rejects credential-bearing and ordinary endpoint URL queries", () => {
    const config = fixtureMcp();
    config.mcp.servers.context.url =
      "https://fixture/mcp?api_key=embedded-secret-canary";
    expect(() => parseConfiguration(stringify(config))).toThrow(
      "schema_invalid",
    );
    config.mcp.servers.context.url = "https://fixture/mcp?api-version=1";
    expect(() => parseConfiguration(stringify(config))).toThrow(
      "schema_invalid",
    );
  });
  for (const parameter of [
    "key",
    "x-api-key",
    "X-Amz-Signature",
    "client_secret",
    "refresh_token",
  ])
    for (const target of ["proxy", "mcp"])
      it(`rejects ${parameter} authentication queries in ${target} endpoints`, () => {
        const config = fixtureMcp();
        const endpoint = `https://fixture.invalid/mcp?${parameter}=query-credential-canary`;
        if (target === "proxy") config.proxy.url = endpoint;
        else config.mcp.servers.context.url = endpoint;
        expect(() => parseConfiguration(stringify(config))).toThrow(
          "schema_invalid",
        );
      });
});
