import assert from "node:assert/strict";

export const actionsScenarios = {
  lifecycle: [
    "publication",
    "ready",
    "monitor-backoff",
    "publication-backoff",
    "needs_information",
    "manual_feature",
    "no_fix",
    "issue_closed",
    "investigation_blocked",
    "cancellation",
    "no-progress",
    "foreign-state",
    "arguments_invalid",
    "intake_failed",
    "diagnostic-list",
    "diagnostic-metadata",
    "diagnostic-cancelled",
    "older-artifact-publication-authority",
    "fresh-owned-pr",
    "fresh-terminal",
    "fresh-question",
    "unpublished-interruption",
    "artifact-changed-configuration",
    "artifact-changed-source",
    "fresh-unpublished",
    "rebuilt-retained-ready",
    "lost-pull-response",
    "fresh-lost-pull",
    "retained-closed-after-main-advances",
    "closed-after-main-advances",
    "edited-comment",
    "missing-comment",
  ],
  sessions: [
    "session-seed",
    "session-foreign",
    "session-corrupt",
    "session-missing-runtime",
    "session-wrong-key",
    "session-resumed",
    "session-expired",
    "session-deleted",
  ],
  "pr-recovery": [
    "recovery-seed",
    "recovery-ready",
    "recover-owned-expired",
    "recover-repeat-expired",
    "recover-owned-deleted",
    "recover-repeat-deleted",
    "publication-recovery-notification-seed",
    "publication-recovery-notification-interrupted",
    "publication-recovery-notification-recovered",
    "publication-recovery-thread_reply-seed",
    "publication-recovery-thread_reply-interrupted",
    "publication-recovery-thread_reply-recovered",
    "publication-recovery-branch-seed",
    "publication-recovery-branch-interrupted",
    "publication-recovery-branch-second-interruption",
    "publication-recovery-branch-recovered",
  ],
  clarification: [
    "clarify-40-question",
    "clarify-40-unauthorized",
    "clarify-40-insufficient",
    "clarify-40-duplicate",
    "clarify-40-resumed",
    "clarify-41-question",
    "clarify-41-unauthorized",
    "clarify-41-resumed",
    "clarify-42-question",
    "clarify-42-unauthorized",
    "clarify-42-resumed",
    "clarify-43-question",
    "clarify-43-unauthorized",
    "clarify-43-resumed",
    "clarify-44-question",
    "clarify-44-repair-question",
    "clarify-44-unauthorized",
    "clarify-44-resumed",
    "clarify-45-question",
  ],
  "clarification-recovery": [
    "clarify-46-question",
    "clarify-46-resumed",
    "clarify-47-question",
    "clarify-47-unauthorized",
    "clarify-47-resumed",
    "clarify-48-question",
    "clarify-48-unauthorized",
    "clarify-48-resumed",
    "clarify-49-question",
    "clarify-49-legacy-reissued",
    "clarify-49-unauthorized",
    "clarify-49-resumed",
    "clarify-50-question",
    "clarify-53-question",
    "clarify-54-question",
    "clarify-54-unauthorized",
    "clarify-54-resumed",
    "question-boundary-checkpoint-restored",
    "question-boundary-checkpoint-answered",
    "question-boundary-checkpoint-duplicate",
    "question-boundary-dispatch-restored",
    "question-boundary-dispatch-duplicate",
    "controller-question",
    "controller-ai-test",
    "controller-ai-test-invalid-role",
    "controller-ai-test-nonmanual",
    "controller-ai-test-missing-source",
    "controller-missing-configuration",
    "controller-typed-zero-secret",
    "controller-typed-one-secret",
    "controller-missing-source",
    "controller-invalid-json",
    "controller-variable-credential",
    "controller-invalid-profile",
    "controller-invalid-policy",
    "controller-duplicate-checks",
    "controller-bootstrap-denied",
    "controller-repository-mismatch",
    "controller-unauthorized",
    "controller-resumed",
    "controller-ready",
    "controller-duplicate",
  ],
};
export const actionsGroups = Object.keys(actionsScenarios);

export const implementationScenarios = {
  "implementation-candidates": [
    "publication",
    "source-only",
    "manual-feature",
    ...[
      "scope",
      "protected",
      "audit_mismatch",
      "audit_mutation",
      "test_mutation",
      "test_addition",
      "failed_tests",
      "audit_rejection",
    ].map((mode) => `rejection-${mode}`),
    "audit-receipts",
    "active-budget",
    "publication-review",
    "drift-base",
    "drift-human_branch",
    "pre-monitor-readiness",
  ],
  "implementation-recovery": [
    "publication-restart",
    "lost-pull-response",
    "issue-closed",
    "issue-revised",
    "pre-monitor-readiness",
  ],
  "implementation-monitor-repair": [
    "reviewed-repair",
    "repair-scope-edit",
    "local-checks-only",
    "disabled-monitor",
    "policy-reload",
    "human-head-handoff",
  ],
  "implementation-monitor-state": [
    "readiness-transient-recovery",
    "concurrent-observation",
    "restart-thread_reply",
    "restart-thread_resolution",
    "repair-budget-and-ci-failure",
    "stale-readiness-comment",
    "wait-budget-and-required-receipts",
  ],
};

export const bootstrapScenarios = {
  "bootstrap-node": {
    claude: { npm: "passed", "audit-rejection": "blocked" },
    codex: {
      npm: "passed",
      pnpm: "passed",
      "yarn-classic": "passed",
      "yarn-modern": "passed",
      "audit-rejection": "blocked",
    },
  },
  "bootstrap-python": {
    codex: {
      pip: "passed",
      poetry: "passed",
      uv: "passed",
      "tracked-node-modules": "blocked",
      "manager-directory-symlink": "blocked",
      "manager-lock-symlink": "blocked",
      "private-registry": "blocked",
      "missing-lock": "blocked",
      "root-script": "blocked",
      "package-unavailable": "blocked",
      "toolchain-unavailable": "blocked",
      "lock-mutation": "blocked",
      "stale-lock": "blocked",
      "nested-pins-mutation": "blocked",
      "cancellation-and-concurrency": "passed",
      "stale-revision": "passed",
      "cache-tampering": "blocked",
      "installer-limits": "blocked",
      "partial-install": "blocked",
      "restart-recovery": "passed",
    },
  },
  "bootstrap-go": { codex: { "go-cgo": "passed", mixed: "passed" } },
};

export const containerSuites = [
  "core",
  "investigation",
  ...Object.keys(bootstrapScenarios),
  "actions",
  ...Object.keys(implementationScenarios),
];
export const implementationSdks = ["codex", "claude"];

export function selectContainerSuites(args, arch = process.arch) {
  let platform = `linux/${arch === "x64" ? "amd64" : arch}`;
  let suite = "all";
  const actions = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    assert(
      [
        "--platform",
        "--suite",
        "--actions-concurrency",
        "--actions-sdk",
        "--actions-group",
      ].includes(flag) &&
        value &&
        !seen.has(flag),
      "Usage: npm run test:container -- [--platform linux/amd64|linux/arm64] [--suite all|bootstrap|SUITE] [--actions-concurrency 1..4] [--actions-sdk SDK --actions-group GROUP]",
    );
    seen.add(flag);
    if (flag === "--platform") platform = value;
    else if (flag === "--suite") suite = value;
    else if (flag === "--actions-concurrency") {
      assert(
        /^[1-4]$/.test(value),
        "Actions concurrency must be between one and four",
      );
      actions.actionsConcurrency = Number(value);
    } else if (flag === "--actions-sdk") {
      assert(implementationSdks.includes(value), "Unknown Actions SDK");
      actions.actionsSdk = value;
    } else {
      assert(actionsGroups.includes(value), "Unknown Actions scenario group");
      actions.actionsGroup = value;
    }
  }
  assert(
    ["linux/amd64", "linux/arm64"].includes(platform),
    "Unsupported test platform",
  );
  assert(
    suite === "all" || suite === "bootstrap" || containerSuites.includes(suite),
    "Unknown container suite",
  );
  assert(
    !Object.keys(actions).length || suite === "actions",
    "Actions selectors require the actions suite",
  );
  assert(
    Boolean(actions.actionsSdk) === Boolean(actions.actionsGroup),
    "Select an Actions SDK and group together",
  );
  return {
    platform,
    suites:
      suite === "all"
        ? [...containerSuites]
        : suite === "bootstrap"
          ? Object.keys(bootstrapScenarios)
          : [suite],
    ...actions,
  };
}

export function verifyBootstrapReceipt(suite, receipt) {
  assert(Object.hasOwn(bootstrapScenarios, suite), "Unknown bootstrap suite");
  assert.equal(receipt.suite, suite);
  assert.equal(receipt.bootstrap, "passed");
  assert.equal(receipt.cleanup, "passed");
  assert.equal(receipt.malicious_mise, "passed");
  if (suite === "bootstrap-node")
    assert.equal(receipt.audit_rejection, "passed");
  assert(Array.isArray(receipt.cases), "Bootstrap case evidence is missing");
  assert.deepEqual(
    receipt.cases
      .map((item) => `${item?.sdk}/${item?.fixture}:${item?.outcome}`)
      .sort(),
    Object.entries(bootstrapScenarios[suite])
      .flatMap(([sdk, fixtures]) =>
        Object.entries(fixtures).map(
          ([fixture, outcome]) => `${sdk}/${fixture}:${outcome}`,
        ),
      )
      .sort(),
    "Incomplete, duplicate or unexpected bootstrap coverage or outcomes",
  );
}

export function selectActionsCpuSet(available) {
  assert.equal(typeof available, "string", "Missing allowed CPUs");
  const selected = [];
  for (const part of available.trim().split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    assert(match, "Invalid allowed CPUs");
    const first = Number(match[1]),
      last = Number(match[2] ?? match[1]);
    assert(
      Number.isSafeInteger(first) &&
        Number.isSafeInteger(last) &&
        last >= first,
      "Invalid allowed CPU range",
    );
    for (let cpu = first; cpu <= last && selected.length < 4; cpu++)
      if (!selected.includes(cpu)) selected.push(cpu);
  }
  return selected.join(",");
}

export async function runActionsChains(concurrency, run) {
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4);
  const pending = [
    "clarification-recovery",
    "pr-recovery",
    "clarification",
    "lifecycle",
    "sessions",
  ].flatMap((group) => implementationSdks.map((sdk) => ({ sdk, group })));
  const active = new Set();
  const counts = new Map(implementationSdks.map((sdk) => [sdk, 0]));
  const errors = [];
  while (pending.length || active.size) {
    while (!errors.length && active.size < concurrency) {
      const index = pending.findIndex(({ sdk }) => counts.get(sdk) < 2);
      if (index === -1) break;
      const [task] = pending.splice(index, 1);
      counts.set(task.sdk, counts.get(task.sdk) + 1);
      const promise = Promise.resolve()
        .then(() => run(task))
        .catch((error) => errors.push(error))
        .finally(() => {
          counts.set(task.sdk, counts.get(task.sdk) - 1);
          active.delete(promise);
        });
      active.add(promise);
    }
    if (!active.size) break;
    await Promise.race(active);
  }
  if (errors.length)
    throw new AggregateError(errors, "Actions scenario lane failed");
}

export function verifyActionsReceipts(receipts, identity) {
  assert.equal(
    selectActionsCpuSet(identity.actions_cpu_set),
    identity.actions_cpu_set,
  );
  assert.equal(
    receipts.length,
    implementationSdks.length * actionsGroups.length,
    "Missing or duplicate Actions lane",
  );
  for (const sdk of implementationSdks)
    for (const group of actionsGroups) {
      const matches = receipts.filter(
        (row) =>
          row.bounded_actions?.length === 1 &&
          row.bounded_actions[0].sdk === sdk &&
          row.bounded_actions[0].group === group,
      );
      assert.equal(
        matches.length,
        1,
        `Missing or duplicate ${sdk}/${group} lane`,
      );
      const receipt = matches[0],
        proof = receipt.bounded_actions[0];
      for (const key of [
        "source_sha",
        "pr_head_sha",
        "platform",
        "image_id",
        "input_digest",
        "dirty_worktree",
        "actions_cpu_set",
      ])
        assert.equal(
          receipt[key],
          identity[key],
          `Wrong ${key} for ${sdk}/${group}`,
        );
      assert.equal(receipt.suite, "actions");
      assert.equal(receipt.cleanup, "passed");
      assert.equal(
        receipt.protected_configuration_and_bounded_startup,
        "parent-image-verified",
      );
      assert.equal(proof.actions, "passed");
      assert.equal(proof.cpu_set, identity.actions_cpu_set);
      assert.equal(proof.toolchain_cache.seeded_installation, "verified");
      assert.equal(proof.toolchain_cache.corrupted_archive, "rejected");
      for (const key of ["digest", "node_signature", "installation_integrity"])
        assert.match(proof.toolchain_cache[key], /^[a-f0-9]{64}$/);
      assert.deepEqual(
        proof.completed_scenarios.map((row) => row.id).sort(),
        [...actionsScenarios[group]].sort(),
        `Incomplete or duplicate ${sdk}/${group} coverage`,
      );
      assert(
        proof.completed_scenarios.every(
          (row) => Number.isFinite(row.duration_ms) && row.duration_ms >= 0,
        ),
        "Missing Actions scenario timing",
      );
      assert(
        Array.isArray(proof.resource_samples) &&
          proof.resource_samples.length > 0,
        "Missing Actions resource observations",
      );
      if (group === "lifecycle") {
        assert.equal(proof.credential_exclusion, "passed");
        assert.equal(proof.no_public_listener, "passed");
        assert.equal(proof.unrelated_issue, "untouched");
      }
      if (group === "sessions")
        assert.equal(proof.native_session_artifacts, "passed");
    }
}

export function verifyImplementationReceipts(
  suite,
  receipts,
  sdks = implementationSdks,
) {
  assert(
    Object.hasOwn(implementationScenarios, suite),
    "Unknown implementation suite",
  );
  assert(
    sdks.length > 0 &&
      new Set(sdks).size === sdks.length &&
      sdks.every((sdk) => implementationSdks.includes(sdk)),
    "Invalid SDK selection",
  );
  assert.equal(
    receipts.length,
    sdks.length,
    "Missing or duplicate SDK receipt",
  );
  for (const sdk of sdks) {
    const matches = receipts.filter((receipt) => receipt.sdk === sdk);
    assert.equal(matches.length, 1, `Missing or duplicate ${sdk} receipt`);
    const receipt = matches[0];
    assert.equal(receipt.suite, suite);
    assert.equal(receipt.implementation, "passed");
    assert.equal(receipt.cleanup, "passed");
    assert(
      receipt.scenarios.length > 0 &&
        receipt.scenarios.every((item) => item.sdk === sdk),
      "SDK proof is missing or belongs to another SDK",
    );
    assert.deepEqual(
      receipt.completed_scenarios.map((item) => item.id).sort(),
      [...implementationScenarios[suite]].sort(),
      "Incomplete or duplicate scenario coverage",
    );
    assert(
      receipt.completed_scenarios.every(
        (item) => Number.isFinite(item.duration_ms) && item.duration_ms >= 0,
      ),
      "Missing scenario timing",
    );
  }
}
