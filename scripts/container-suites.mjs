import assert from "node:assert/strict";

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
    "mcp-milestone-recovery",
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
    "stale-notification",
    "wait-budget-and-legacy-receipts",
  ],
  "implementation-monitor-mcp": [
    "readiness-mcp-generic",
    "readiness-mcp-dense",
  ],
};

export const containerSuites = [
  "core",
  "investigation",
  "bootstrap",
  "actions",
  ...Object.keys(implementationScenarios),
];
export const implementationSdks = ["codex", "claude"];

export function selectContainerSuites(args, arch = process.arch) {
  let platform = `linux/${arch === "x64" ? "amd64" : arch}`;
  let suite = "all";
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    assert(
      ["--platform", "--suite"].includes(flag) && value && !seen.has(flag),
      "Usage: npm run test:container -- [--platform linux/amd64|linux/arm64] [--suite all|SUITE]",
    );
    seen.add(flag);
    if (flag === "--platform") platform = value;
    else suite = value;
  }
  assert(
    ["linux/amd64", "linux/arm64"].includes(platform),
    "Unsupported test platform",
  );
  assert(
    suite === "all" || containerSuites.includes(suite),
    "Unknown container suite",
  );
  return { platform, suites: suite === "all" ? [...containerSuites] : [suite] };
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
