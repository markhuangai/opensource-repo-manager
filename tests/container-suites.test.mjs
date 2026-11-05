import { describe, expect, it } from "vitest";
import {
  containerSuites,
  implementationScenarios,
  implementationSdks,
  selectContainerSuites,
  verifyImplementationReceipts,
  actionsScenarios,
  actionsGroups,
  verifyActionsReceipts,
  selectActionsCpuSet,
  runActionsChains,
} from "../scripts/container-suites.mjs";
import { setTimeout as delay } from "node:timers/promises";

describe("Actions chain scheduling", () => {
  for (const concurrency of [1, 2, 3, 4])
    it(`runs every intact chain with ${concurrency} lanes and at most two per SDK`, async () => {
      const counts = { codex: 0, claude: 0 };
      const started = [];
      let active = 0,
        peak = 0;
      await runActionsChains(concurrency, async ({ sdk, group }) => {
        counts[sdk]++;
        active++;
        peak = Math.max(peak, active);
        expect(counts[sdk]).toBeLessThanOrEqual(2);
        expect(active).toBeLessThanOrEqual(concurrency);
        started.push(`${sdk}/${group}`);
        await delay(sdk === "codex" ? 2 : 1);
        active--;
        counts[sdk]--;
      });
      expect(peak).toBe(concurrency);
      expect(started.slice(0, 2)).toEqual([
        "codex/clarification-recovery",
        "claude/clarification-recovery",
      ]);
      expect(started.sort()).toEqual(
        actionsGroups
          .flatMap((group) =>
            implementationSdks.map((sdk) => `${sdk}/${group}`),
          )
          .sort(),
      );
      expect(active).toBe(0);
    });

  it("stops dispatch after failure and drains all active chains before rejecting", async () => {
    const release = Promise.withResolvers();
    const started = [],
      completed = [];
    let settled = false;
    const running = runActionsChains(4, async ({ sdk, group }) => {
      started.push(`${sdk}/${group}`);
      if (sdk === "codex" && group === "clarification-recovery")
        throw new Error("lane failed");
      await release.promise;
      completed.push(`${sdk}/${group}`);
    }).finally(() => {
      settled = true;
    });
    const rejected = expect(running).rejects.toThrow(
      "Actions scenario lane failed",
    );
    await delay(10);
    expect(started).toHaveLength(4);
    expect(settled).toBe(false);
    release.resolve();
    await rejected;
    expect(started).toHaveLength(4);
    expect(completed).toHaveLength(3);
  });
});

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
    expect(containerSuites).toHaveLength(8);
    expect(new Set(containerSuites).size).toBe(8);
    expect(implementationSdks).toEqual(["codex", "claude"]);
  });

  for (const suite of containerSuites) {
    it(`selects only ${suite} without changing the complete registry`, () => {
      expect(
        selectContainerSuites(["--suite", suite, "--platform", "linux/arm64"]),
      ).toEqual({ platform: "linux/arm64", suites: [suite] });
      const selected = selectContainerSuites([]);
      selected.suites.pop();
      expect(containerSuites).toHaveLength(8);
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

describe("Actions worker CPU selection", () => {
  for (const [available, expected] of [
    ["0-31", "0,1,2,3"],
    ["0-1", "0,1"],
    ["8", "8"],
    ["4,8-9,16-20", "4,8,9,16"],
    ["1,1-2,2-3", "1,2,3"],
    [" 8-11\n", "8,9,10,11"],
  ])
    it(`selects only allowed CPUs from ${JSON.stringify(available)}`, () => {
      expect(selectActionsCpuSet(available)).toBe(expected);
    });

  for (const available of [
    undefined,
    "",
    "1-0",
    "-1",
    "0-3,invalid",
    "9007199254740992",
  ])
    it(`rejects invalid allowed CPUs ${JSON.stringify(available)}`, () => {
      expect(() => selectActionsCpuSet(available)).toThrow();
    });
});

describe("Actions lane coverage and identity", () => {
  const identity = {
    source_sha: "a".repeat(40),
    pr_head_sha: "b".repeat(40),
    platform: "linux/arm64",
    image_id: `sha256:${"c".repeat(64)}`,
    input_digest: "d".repeat(64),
    dirty_worktree: false,
    actions_cpu_set: "0,1,2,3",
  };
  const lanes = () =>
    actionsGroups.flatMap((group) =>
      implementationSdks.map((sdk) => ({
        ...identity,
        suite: "actions",
        cleanup: "passed",
        protected_configuration_and_bounded_startup: "parent-image-verified",
        bounded_actions: [
          {
            sdk,
            group,
            actions: "passed",
            cpu_set: identity.actions_cpu_set,
            toolchain_cache: {
              seeded_installation: "verified",
              corrupted_archive: "rejected",
              digest: "e".repeat(64),
              node_signature: "f".repeat(64),
              installation_integrity: "a".repeat(64),
            },
            resource_samples: [
              {
                scenario: actionsScenarios[group][0],
                observed_at: "2026-11-02T00:00:00.000Z",
                CPUPerc: "1.0%",
                MemUsage: "32MiB / 4GiB",
              },
            ],
            completed_scenarios: actionsScenarios[group].map((id) => ({
              id,
              duration_ms: 1,
            })),
            credential_exclusion: "passed",
            no_public_listener: "passed",
            unrelated_issue: "untouched",
            native_session_artifacts: "passed",
          },
        ],
      })),
    );
  it("preserves the complete original scenario inventory in five independent chains", () => {
    expect(
      Object.fromEntries(
        actionsGroups.map((group) => [group, actionsScenarios[group].length]),
      ),
    ).toEqual({
      lifecycle: 29,
      sessions: 8,
      "pr-recovery": 16,
      clarification: 19,
      "clarification-recovery": 35,
    });
    const all = Object.values(actionsScenarios).flat();
    expect(all.filter((id) => !id.startsWith("controller-"))).toHaveLength(94);
    expect(all).toHaveLength(107);
    expect(new Set(all).size).toBe(107);
    expect(() => verifyActionsReceipts(lanes(), identity)).not.toThrow();
  });
  it("supports a serial profiling mode and bounded parallelism", () => {
    for (const count of [1, 2, 3, 4])
      expect(
        selectContainerSuites([
          "--suite",
          "actions",
          "--actions-concurrency",
          String(count),
        ]),
      ).toMatchObject({ actionsConcurrency: count });
    expect(
      selectContainerSuites([
        "--suite",
        "actions",
        "--actions-sdk",
        "codex",
        "--actions-group",
        "sessions",
      ]),
    ).toMatchObject({ actionsSdk: "codex", actionsGroup: "sessions" });
    for (const args of [
      ["--actions-concurrency", "1"],
      ["--suite", "core", "--actions-concurrency", "1"],
      ["--suite", "actions", "--actions-concurrency", "5"],
      ["--suite", "actions", "--actions-concurrency", "0"],
      ["--suite", "actions", "--actions-sdk", "codex"],
      ["--suite", "actions", "--actions-group", "sessions"],
      [
        "--suite",
        "actions",
        "--actions-sdk",
        "other",
        "--actions-group",
        "sessions",
      ],
    ])
      expect(() => selectContainerSuites(args)).toThrow();
  });
  for (const [name, corrupt] of [
    [
      "missing shared startup proof",
      (rows) => {
        delete rows[0].protected_configuration_and_bounded_startup;
      },
    ],
    [
      "wrong worker CPU affinity",
      (rows) => {
        rows[0].bounded_actions[0].cpu_set = "4";
      },
    ],
    [
      "wrong lane CPU affinity",
      (rows) => {
        rows[0].actions_cpu_set = "4";
      },
    ],
    ["missing lane", (rows) => rows.pop()],
    ["duplicate lane", (rows) => rows.push(rows[0])],
    [
      "unverified cached installation",
      (rows) => {
        rows[0].bounded_actions[0].toolchain_cache.seeded_installation =
          "failed";
      },
    ],
    [
      "accepted corrupted archive",
      (rows) => {
        rows[0].bounded_actions[0].toolchain_cache.corrupted_archive =
          "accepted";
      },
    ],
    [
      "missing archive identity",
      (rows) => {
        delete rows[0].bounded_actions[0].toolchain_cache.digest;
      },
    ],
    [
      "substituted lane",
      (rows) => {
        rows[0] = rows[1];
      },
    ],
    [
      "missing scenario",
      (rows) => rows[0].bounded_actions[0].completed_scenarios.pop(),
    ],
    [
      "duplicate scenario",
      (rows) =>
        rows[0].bounded_actions[0].completed_scenarios.push(
          rows[0].bounded_actions[0].completed_scenarios[0],
        ),
    ],
    [
      "failed lane",
      (rows) => {
        rows[0].bounded_actions[0].actions = "failed";
      },
    ],
    [
      "failed cleanup",
      (rows) => {
        rows[0].cleanup = "failed";
      },
    ],
    [
      "missing timing",
      (rows) => {
        delete rows[0].bounded_actions[0].completed_scenarios[0].duration_ms;
      },
    ],
    [
      "empty resource observations",
      (rows) => {
        rows[0].bounded_actions[0].resource_samples = [];
      },
    ],
    [
      "missing resource observations",
      (rows) => {
        delete rows[0].bounded_actions[0].resource_samples;
      },
    ],
    [
      "missing credential proof",
      (rows) => {
        delete rows[0].bounded_actions[0].credential_exclusion;
      },
    ],
    ...Object.keys(identity).map((key) => [
      `stale ${key}`,
      (rows) => {
        rows[0][key] = "stale";
      },
    ]),
  ])
    it(`rejects ${name}`, () => {
      const rows = lanes();
      corrupt(rows);
      expect(() => verifyActionsReceipts(rows, identity)).toThrow();
    });
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
      "implementation-recovery": 5,
      "implementation-monitor-repair": 6,
      "implementation-monitor-state": 7,
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
