import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  parseActionsConfiguration,
  parseConfiguration,
} from "../src/config/schema.ts";
import { separateSecrets } from "../src/config/secrets.ts";
import {
  assertTaskStore,
  parseTaskRequest,
  taskExitCode,
  taskOutcome,
} from "../src/actions/task.ts";
import { Store } from "../src/repositories/store.ts";
import { InvestigationRepository } from "../src/repositories/investigation.ts";
import { IntakeService } from "../src/services/intake.ts";
import {
  fixtureConfiguration,
  fixtureGitHub,
  fixtureSnapshot,
} from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";

function actionsConfig() {
  const service = fixtureConfiguration();
  const config = {
    version: service.version,
    github: {
      repository: service.github.repository,
      token: service.github.token,
    },
    proxy: service.proxy,
    profiles: service.profiles,
    roles: structuredClone(service.roles),
    pr_monitor: service.pr_monitor,
    limits: service.limits,
  };
  for (const role of Object.values(config.roles))
    Reflect.deleteProperty(role, "mcp");
  return config;
}

describe("protected Actions configuration", () => {
  it("reuses core settings without inventing service credentials", () => {
    const input = actionsConfig();
    const config = parseActionsConfiguration(stringify(input));
    expect(config.limits).toEqual(input.limits);
    expect(config.pr_monitor).toEqual(input.pr_monitor);
    expect(
      Object.values(config.notifications).every((channel) => !channel.enabled),
    ).toBe(true);
    expect(config.mcp.servers).toEqual({});
    const { secrets, settings } = separateSecrets(config);
    expect(secrets.get("github.token")).toBe(input.github.token);
    expect(secrets.get("proxy.key")).toBe(input.proxy.key);
    expect(() => secrets.get("github.webhook_secret")).toThrow(
      "reference_invalid",
    );
    expect(secrets.containsCredentials(settings)).toBe(false);
    expect(() => parseConfiguration(stringify(input))).toThrow(
      "schema_invalid",
    );
  });
  for (const field of [
    "notifications",
    "mcp",
    "webhook_secret",
    "role_mcp",
    "profile",
    "policy",
  ])
    it(`rejects invalid Actions ${field}`, () => {
      const config = actionsConfig();
      if (field === "webhook_secret")
        Object.assign(config.github, { webhook_secret: "not-supported" });
      else if (field === "role_mcp")
        Object.assign(config.roles.investigation, { mcp: {} });
      else if (field === "profile") config.roles.audit.profile = "missing";
      else if (field === "policy")
        config.pr_monitor.required_checks = ["CI", "CI"];
      else Object.assign(config, { [field]: {} });
      expect(() => parseActionsConfiguration(stringify(config))).toThrow();
    });
  it("keeps service-only notification validation mandatory", () => {
    const config = fixtureConfiguration();
    config.notifications = {
      discord: { enabled: false },
      smtp: { enabled: false },
      webhook: { enabled: false },
    };
    expect(() => parseConfiguration(stringify(config))).toThrow(
      "schema_invalid",
    );
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orm-actions-unit-"));
  const github = await fixtureGitHub();
  const loaded = await fixtureSnapshot();
  const store = new Store(join(root, "state", "manager.sqlite"));
  const intake = new IntakeService(
    store,
    github.reader,
    loaded.snapshot,
    loaded.secrets,
    { info() {}, error() {} },
  );
  cleanups.push(async () => {
    await intake.stop();
    store.close();
    await github.close();
    await rm(root, { recursive: true });
  });
  return {
    github,
    loaded,
    store,
    intake,
    signal: new AbortController().signal,
  };
}

describe("bounded task selection and outcomes", () => {
  it("returns verified closure without creating a job for a newly selected closed issue", async () => {
    const f = await setup();
    f.github.state.issues[1].state = "closed";
    expect(await f.intake.enrollIssue(1, f.signal)).toMatchObject({
      id: 1001,
      number: 1,
      state: "closed",
    });
    expect(f.store.jobs()).toEqual([]);
  });
  it.each([
    [],
    ["0"],
    ["-1"],
    ["1.5"],
    ["01"],
    ["1", "2"],
    ["9007199254740992"],
  ])("rejects invalid request %j", (...args: string[]) => {
    expect(() => parseTaskRequest(args)).toThrow("arguments_invalid");
  });
  it("admits only the selected issue without discovery or notification wakeups", async () => {
    const f = await setup();
    f.github.state.issues[2] = makeIssue(2);
    const request = parseTaskRequest(["2"]);
    assertTaskStore(f.store, request, "owner/repo");
    await f.intake.enrollIssue(2, f.signal);
    expect(f.store.jobs().map((job) => job.issue_number)).toEqual([2]);
    expect(
      f.github.requests.some((entry) =>
        /^\/repos\/owner\/repo\/issues(?:\?|$)/.test(entry.url!),
      ),
    ).toBe(false);
    expect(
      f.github.requests.some((entry) =>
        /\/issues\/1(?:\/|\?|$)/.test(entry.url!),
      ),
    ).toBe(false);
    expect(() =>
      assertTaskStore(f.store, { issue_number: 1 }, "owner/repo"),
    ).toThrow("task_state_invalid");
    expect(() => assertTaskStore(f.store, request, "foreign/repo")).toThrow(
      "task_state_invalid",
    );
    expect(f.intake.enrolled()).toBe(true);
    expect(taskOutcome(f.store, request, true)).toBeUndefined();
  });
  it.each([
    ["needs_information", "waiting", "needs_information"],
    ["manual_feature", "out_of_scope", "manual_feature"],
    ["no_fix", "no_fix", "no_fix"],
    ["blocked", "blocked", "investigation_blocked"],
  ] as const)("preserves %s as %s", async (outcome, expected, reason) => {
    const f = await setup();
    await f.intake.enrollIssue(1, f.signal);
    const repository = new InvestigationRepository(f.store);
    const record = repository.ensure(f.store.job(1)!);
    record.stage = "completed";
    record.result = {
      outcome,
      summary: "Fixture outcome",
      objective: "",
      proof: "none",
      evidence_ids: [],
      questions: [],
    };
    repository.save(record);
    const result = taskOutcome(f.store, { issue_number: 1 }, true)!;
    expect(result).toMatchObject({
      outcome: expected,
      reason,
      repository: "owner/repo",
      issue_number: 1,
    });
    expect(taskExitCode(result)).toBe(expected === "blocked" ? 1 : 0);
  });
  it("returns deferred work without treating an unopened or unvalidated PR as ready", async () => {
    const f = await setup();
    await f.intake.enrollIssue(1, f.signal);
    const repository = new InvestigationRepository(f.store);
    const record = repository.ensure(f.store.job(1)!);
    record.stage = "blocked";
    record.retry_stage = "inspecting";
    record.retry_at = Date.now() + 60_000;
    repository.save(record);
    expect(taskOutcome(f.store, { issue_number: 1 }, true)).toMatchObject({
      outcome: "waiting",
      reason: "retry_scheduled",
      retry_at: record.retry_at,
    });
    f.store.db.prepare("UPDATE jobs SET phase='remote_review'").run();
    expect(taskOutcome(f.store, { issue_number: 1 }, true)).toBeUndefined();
    expect(taskOutcome(f.store, { issue_number: 1 }, false)).toMatchObject({
      outcome: "waiting",
      reason: "monitor_disabled",
    });
    f.github.state.issues[1].state = "closed";
    await f.intake.refresh(1, f.signal, false);
    expect(taskOutcome(f.store, { issue_number: 1 }, true)).toMatchObject({
      outcome: "closed",
      reason: "issue_closed",
    });
  });
});
