import { describe, expect, it } from "vitest";
import {
  containerSuites,
  implementationScenarios,
  implementationSdks,
  selectContainerSuites,
  verifyImplementationReceipts,
} from "../scripts/container-suites.mjs";

describe("container suite selection", () => {
  it("keeps the default command complete on both native architectures", () => {
    for (const [arch, platform] of [
      ["x64", "linux/amd64"],
      ["arm64", "linux/arm64"],
    ]) {
      expect(selectContainerSuites([], arch)).toEqual({
        platform,
        suites: containerSuites,
      });
      expect(
        selectContainerSuites(["--platform", platform, "--suite", "all"], arch),
      ).toEqual({ platform, suites: containerSuites });
    }
    expect(containerSuites).toHaveLength(9);
    expect(new Set(containerSuites).size).toBe(9);
    expect(implementationSdks).toEqual(["codex", "claude"]);
  });

  for (const suite of containerSuites) {
    it(`selects only ${suite} without changing the complete registry`, () => {
      expect(
        selectContainerSuites(["--suite", suite, "--platform", "linux/arm64"]),
      ).toEqual({ platform: "linux/arm64", suites: [suite] });
      const selected = selectContainerSuites([]);
      selected.suites.pop();
      expect(containerSuites).toHaveLength(9);
    });
  }

  for (const args of [
    ["--suite"],
    ["--suite", "missing"],
    ["--platform", "linux/s390x"],
    ["--suite", "core", "--suite", "bootstrap"],
    ["--platform", "linux/amd64", "--platform", "linux/arm64"],
    ["--unknown", "core"],
    ["core"],
    ["--suite", "core", "extra"],
  ]) {
    it(`rejects invalid selection ${JSON.stringify(args)}`, () => {
      expect(() => selectContainerSuites(args)).toThrow();
    });
  }
});

function receipt(suite, sdk) {
  return {
    suite,
    sdk,
    implementation: "passed",
    cleanup: "passed",
    scenarios: [{ sdk, regression: "passed" }],
    completed_scenarios: implementationScenarios[suite].map((id) => ({
      id,
      duration_ms: 1,
    })),
  };
}

describe("implementation coverage receipts", () => {
  it("registers every planned scenario group without duplicate scenario IDs", () => {
    expect(
      Object.fromEntries(
        Object.entries(implementationScenarios).map(([suite, ids]) => [
          suite,
          ids.length,
        ]),
      ),
    ).toEqual({
      "implementation-candidates": 17,
      "implementation-recovery": 6,
      "implementation-monitor-repair": 6,
      "implementation-monitor-state": 7,
      "implementation-monitor-mcp": 2,
    });
    for (const ids of Object.values(implementationScenarios))
      expect(new Set(ids).size).toBe(ids.length);
  });

  for (const suite of Object.keys(implementationScenarios)) {
    it(`requires complete distinct SDK coverage for ${suite}`, () => {
      const receipts = implementationSdks.map((sdk) => receipt(suite, sdk));
      expect(() => verifyImplementationReceipts(suite, receipts)).not.toThrow();
      expect(() =>
        verifyImplementationReceipts(suite, receipts.slice(0, 1)),
      ).toThrow();
      expect(() =>
        verifyImplementationReceipts(suite, [receipts[0], receipts[0]]),
      ).toThrow();
      expect(() =>
        verifyImplementationReceipts(suite, [...receipts, receipts[0]]),
      ).toThrow();
      expect(() =>
        verifyImplementationReceipts(suite, [receipts[0]], ["codex"]),
      ).not.toThrow();
      expect(() =>
        verifyImplementationReceipts(suite, receipts, ["codex", "codex"]),
      ).toThrow();
    });

    for (const [name, corrupt] of [
      ["missing scenario", (proof) => proof.completed_scenarios.pop()],
      [
        "duplicate scenario",
        (proof) => proof.completed_scenarios.push(proof.completed_scenarios[0]),
      ],
      [
        "substituted scenario",
        (proof) => {
          proof.completed_scenarios[0].id = "unregistered";
        },
      ],
      [
        "wrong suite",
        (proof) => {
          proof.suite = "core";
        },
      ],
      [
        "wrong SDK",
        (proof) => {
          proof.sdk = "other";
        },
      ],
      [
        "failed implementation",
        (proof) => {
          proof.implementation = "failed";
        },
      ],
      [
        "failed cleanup",
        (proof) => {
          proof.cleanup = "failed";
        },
      ],
      [
        "empty proof",
        (proof) => {
          proof.scenarios = [];
        },
      ],
      [
        "foreign SDK proof",
        (proof) => {
          proof.scenarios[0].sdk = "other";
        },
      ],
      [
        "missing timing",
        (proof) => {
          delete proof.completed_scenarios[0].duration_ms;
        },
      ],
      [
        "invalid timing",
        (proof) => {
          proof.completed_scenarios[0].duration_ms = -1;
        },
      ],
    ]) {
      it(`rejects ${name} in ${suite}`, () => {
        const receipts = implementationSdks.map((sdk) => receipt(suite, sdk));
        corrupt(receipts[1]);
        expect(() => verifyImplementationReceipts(suite, receipts)).toThrow();
      });
    }
  }
});
