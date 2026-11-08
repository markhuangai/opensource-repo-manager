# Complete CI performance

Issue [#58](https://github.com/markhuangai/opensource-repo-manager/issues/58) requires complete CI feedback within 30 minutes on at least three representative fresh heads. Coverage, native architectures, SDK paths, security/review requirements, budgets, isolation and cleanup remain mandatory. This document distinguishes measurements from pending validation.

## Verified baseline

PR [#57](https://github.com/markhuangai/opensource-repo-manager/pull/57), head `95b0644b18f939339e48e248a4d6a0c437f30872`, completed Repository CI [run 41287859879](https://github.com/markhuangai/opensource-repo-manager/actions/runs/41287859879) on attempt 2. Its reported attempt window was `2026-11-01T11:31:05Z` to `12:43:51Z`, or **72m 46s**.

The successful [ARM64 Actions job](https://github.com/markhuangai/opensource-repo-manager/actions/runs/41287859879/job/124835399668) ran from `11:31:12Z` to `12:43:33Z`, or **72m 21s**. Its valid reported queue interval was five seconds. Other reused job records had inconsistent created/start/completion ordering and cannot establish valid queue measurements.

| ARM64 phase              | Duration |
| ------------------------ | -------: |
| Production image build   |   1m 27s |
| Codex Actions scenarios  |  33m 10s |
| Claude Actions scenarios |  35m 52s |
| Initial production setup |      21s |
| Cleanup                  |      27s |

The receipt identified tested merge commit `853eb63e093f9c180b775d379815f5bd0740d4d5`, image `sha256:c4ea3dd430ec2274d53f9e6356629159bf14b20969cff072b17b278d88e0d4fa`, successful cleanup and 94 scenarios for each SDK. The original run's creation-to-final-success interval across attempts and intervening time is not one attempt's execution or queue duration. The earlier full-suite baseline remains in the README.

One historical configured AI-review run for the same PR took about 42 minutes. Container improvements alone therefore do not prove the complete target; mandatory review outcomes and their latency must remain visible.

## Coverage and execution

The native matrix contains ten suites on AMD64 and ARM64: core, investigation, bootstrap-node, bootstrap-python, bootstrap-go, actions, implementation-candidates, implementation-recovery, implementation-monitor-repair and implementation-monitor-state. Repository checks, workflow and bounded startup validation, both CodeQL analyses and aggregate statuses, and configured AI review remain required.

Bootstrap is partitioned into Node (7 SDK/case outcomes), Python plus the intact negative/recovery sequence (20), and Go/CGO plus mixed Go/Node (2). Each group has a fresh container and state, the original 40-minute deadline, exact coverage validation, and source/image/cleanup receipts. Node keeps both SDK audit rejections; Python keeps the previous successful Python receipt used by integrity and restart checks. The local aggregate selector `--suite bootstrap` runs all groups. Cold setup is repeated, so report measured group and total timings rather than claiming an unmeasured speedup.

The Actions inventory retains every original scenario ID, partitioned into five chains: lifecycle (29), sessions (8), PR recovery (16), clarification (19) and clarification recovery (22). Five production-controller scenarios extend the last chain: question, unauthorized reply, resumed work, readiness and duplicate invocation. Thus each SDK proves **99 distinct scenarios**, including all original 94. Every stateful sequence remains intact. The registry and receipt validator reject missing, duplicate, substituted, failed or stale lane/scenario evidence.

Four lanes run concurrently by default inside the existing native Actions job, with at most two chains per SDK; the profiling option accepts one through four. The longest measured chains start first. A failed lane stops new dispatch while active lanes finish and clean up. Each lane has separate containers/PID namespaces, volumes, network, protected configuration and upstream/artifact fixtures, and reuses the parent's built image. Docker's shared kernel can account threads for the same worker UID across containers. Test-manager affinity therefore uses at most four CPUs from the daemon's actual allowed list to bound SDK thread pools; worker identities and process limits retain their existing values. Every manager launch verifies the configured affinity, and receipts bind it to the parent alongside exact image, source commit, PR head, source/test input digest, platform and worktree state. Source changes during verification fail the run. Normal and failed lanes retain scoped ownership checks for cleanup; shared Docker caches and credentials are preserved.

Each lane prepares its own Node archive before scenario execution using the production toolchain installer. A second installation proves the archive produces identical signed-checksum and installed-file integrity receipts; a corrupted copy must fail installation. Scenario setup copies only archive bytes into each task's private download directory. Every runtime still fetches signed checksums, verifies the archive and installs its own toolchain. No installation, receipt or mutable cache is shared between lanes, and existing cache bytes are never overwritten. Lane receipts retain the archive digest and preparation timing.

## Measurement procedure

Use Node 24.18.0, npm 12.0.2 and the same source/test input digest for the local serial control and parallel comparison:

```sh
npm run test:container -- --platform linux/amd64 --suite actions --actions-concurrency 1
npm run test:container -- --platform linux/amd64 --suite actions
```

The full local gate also runs `npm run check`, every AMD64 container suite, actionlint 1.7.12 for repository and example workflows, and bounded startup proof. Native ARM64 proof comes from the complete PR matrix. No cached test result is accepted for changed source.

Capture setup/build, scenario and lane timings, artifact transport request bytes/durations/interruption counts, checkpoint-helper durations, sampled live container CPU/memory/PIDs and runner resources, plus teardown. Checkpoint-helper timing includes restoration, process startup and the explicit checkpoint; artifact transport timing excludes local sealing/restoration computation. These are distinct measurements and must not be added as a decomposition of total time. Concurrent lane durations likewise overlap.

For each representative fresh head, record the validation trigger before PR creation or normal push, then retain the GitHub run IDs, attempts, source head and tested merge commit. Measure through the last required current-head CI workflow/status result. Include retries, automatic restarts and repeated validation for that head. Report queue and execution separately from the total; invalid timestamp ordering makes the affected measurement unavailable, not zero. Record required Codex/CodeRabbit outcomes and their latency separately, preserving their merge gates.

Collect the Repository CI/native and CodeQL jobs through paginated GitHub API reads, their exact-head check/status results, and each native job's final JSON receipt. Bind any review workflow's trusted definition SHA separately from the reviewed PR head. Require complete unique coverage, image identities and cleanup receipts before counting a sample. Save source references and safe evidence summaries in the PR; retain raw delivery receipts without credentials.

## Results

### Historical local serial and three-lane control

Both AMD64 runs passed on the same uncommitted source/test input, digest `b9a0d6e26f57ebedd88c16cb041b3ec23aab85e3e2a052d885310c910b03f35b`, based on commit `bc7e5825e7de052c03d1e805f1f139832eec197c`. Each proved all 198 unique scenarios, 99 per SDK across ten chains, with unchanged source and matching source/image/affinity receipts. These are local measurements, not complete CI results.

| Measurement                         |   One lane | Three lanes |
| ----------------------------------- | ---------: | ----------: |
| Non-overlapping parent phases       | 139m 26.1s |   74m 11.7s |
| Actions pool                        |  137m 6.6s |   71m 45.3s |
| Image build                         |      10.8s |       18.5s |
| Sampled live container observations |        201 |         280 |
| Artifact transport requests         |      3,382 |       3,382 |
| Cleanup                             |     Passed |      Passed |

Parent totals use monotonic phase durations for setup, context exclusion, build, startup, the Actions pool, shutdown and cleanup. Overlapping lane timings are excluded. The measured parent-phase ratio is 1.88. Both runs used the same 32-CPU, 62.75-GiB host and manager affinity `0,1,2,3`; Docker build caches were reused. Independent inventory readback found no resources for either Actions parent's eleven possible owner labels.

The serial image was `sha256:b423ce5d0142116948f597ef468890ba2e1208cc61a52f1eec8e24996b329d17`; the parallel image was `sha256:7d35f5e6fb17a45ee9ba7aa4d2ec901d0811b23125ccda1b4a46a3be1f19aea6`. Each run built its own labeled image. Archive fixtures, installed toolchains and mutable storage remained private to each lane.

The complete local nine-suite AMD64 command also passed both SDKs on unchanged input in 185m 21.0s. Independent cleanup verified all 99 possible owner labels empty. This sequential full-command duration is separate from the Actions comparison and from the native CI matrix.

Unrestricted four-Codex diagnostics reproduced a Node thread-creation failure under shared kernel UID accounting. A later diagnostic held two Codex and two Claude workers simultaneously with the unchanged process limit of 128, reaching a sampled UID total of 116 threads. That startup trial does not prove full-suite safety or throughput. The correction caps active chains at two per SDK and retains affinity bounds; fresh normal gates remain required.

A five-invocation lifecycle profile recorded 408 Docker inspections taking 25.43 seconds in a 137.51-second window. Actions now waits asynchronously for container exit, preserving its 300-second watchdog, periodic resource observations and exit/OOM/PID assertions. Timeout or sampler failure kills and reaps the Docker wait client. Real Docker cases cover already-exited containers, watchdog expiry and sampler failure. Identical generic startup/removed-command cases run once in the parent against the shared image; child receipts explicitly identify the parent image proof. Each child retains its own configuration, fixtures, service startup and runtime assertions.

### Current local serial and four-lane control

The correction passed both AMD64 runs on unchanged source/test input, digest `3d4cff9ed6433fcc52e97ca30a22262642cb75bd5339aba41880dd1d090524fc`, based on published head `06b214006475ece1783a611d59f6e77cf812fc3b`. Both proved **198 unique scenarios**, 99 per SDK across ten isolated chains, with matching source, input, image and affinity receipts. Four lanes, capped at two per SDK, passed the complete Actions pool. These dirty-worktree measurements do not establish fresh-head CI performance.

| Measurement                         |   One lane | Four lanes |
| ----------------------------------- | ---------: | ---------: |
| Non-overlapping parent phases       | 127m 31.4s |  60m 30.2s |
| Actions pool                        | 124m 56.6s |  57m 34.6s |
| Image build                         |      11.4s |      23.6s |
| Sampled live container observations |        176 |        301 |
| Artifact transport requests         |      3,382 |      3,382 |
| Cleanup                             |     Passed |     Passed |

The parent-phase ratio is **2.108**, excluding overlapping lane timings. The one-lane command took 127m 31.7s overall. Its image was `sha256:70f1515a80a7525e192ced30f5a81652d2fcc3314e81bb208c07afe891b74737`; the four-lane Actions image was `sha256:825a8db60b6c5b8cc863d9c5c90af987ebb1c3d38bfadf3ec3bb42784470fc62`. Independent readback found all eleven possible owner labels empty for each Actions parent. Real Docker watchdog and sampler-failure cases passed with no wait clients left running.

The local host reports 32 logical CPUs and 62.75 GiB RAM. Selected logical CPUs `0,1,2,3` map to two physical cores, with SMT siblings `0-1` and `2-3`. The agent-command cgroup reported `cpu.max = max 100000`; container ancestor quotas were not inventoried. These observations describe this local control, not native CI runner topology or quotas.

The complete nine-suite AMD64 command passed both SDKs on the same unchanged input in **194m 37.5s**. Independent cleanup readback found all 99 possible owner labels empty. `npm run check` passed all **810 tests**, formatting, lint, types and build; actionlint **1.7.12** and `docker compose config --quiet` passed. The sequential full-command duration remains separate from the Actions comparison and the native CI matrix.

### Fresh-head complete CI

Three successful fresh-head measurements are **pending**. The first published head passed functional gates but failed the timing target: **51m 41.8s**, from the original validation trigger through the last required result, including an automatic restart after CodeRabbit edited the PR description. No 30-minute complete-CI improvement is claimed yet. A failed or missing required check, incomplete coverage/cleanup, invalid source identity, or external timing constraint blocks completion rather than waiving the target.

| Sample          | PR head / tested source | Native receipts | Complete CI elapsed | Review outcome / latency                                                   | Result        |
| --------------- | ----------------------- | --------------- | ------------------- | -------------------------------------------------------------------------- | ------------- |
| Failed baseline | `06b2140` / `78f61ff`   | All 18 verified | 51m 41.8s           | Codex no findings; CodeRabbit finding withdrawn; configured AI no findings | Failed target |
| 1               | Pending                 | Pending         | Pending             | Pending                                                                    | Pending       |
| 2               | Pending                 | Pending         | Pending             | Pending                                                                    | Pending       |
| 3               | Pending                 | Pending         | Pending             | Pending                                                                    | Pending       |

The successful replacement [Repository CI run 41431186089](https://github.com/markhuangai/opensource-repo-manager/actions/runs/41431186089) retained all nine suites on both native architectures; [CodeQL run 41431186028](https://github.com/markhuangai/opensource-repo-manager/actions/runs/41431186028) and [configured AI review 41430711551](https://github.com/markhuangai/opensource-repo-manager/actions/runs/41430711551) passed. AMD64 Actions took 45m 22.1s in non-overlapping parent phases; ARM64 took 38m 21.4s. The original cancelled jobs have no harness cleanup receipts. Their logs show orphan-process termination, and GitHub documents fresh ephemeral hosted VMs; provider teardown is the available cleanup evidence for those cancelled jobs, without an independent resource inventory. All 18 successful replacement jobs have passing harness cleanup receipts.

A later description edit triggered another validation of the same `06b2140` head and older `b9a0d6e2…` input: [Repository CI 41445687960](https://github.com/markhuangai/opensource-repo-manager/actions/runs/41445687960) and [CodeQL 41445687833](https://github.com/markhuangai/opensource-repo-manager/actions/runs/41445687833) passed, with all 18 native receipts verified. The final required result was `2026-11-02T13:30:30Z`, extending that head's window from its original `10:40:33.242556Z` trigger to **2h 49m 56.8s**. This repeated same-head validation is not a fresh sample. Its AMD64 Actions parent took 55m 16.9s; ARM64 took 40m 4.3s. Both runs reported four logical CPUs and approximately 16 GB RAM; their physical CPU topology was not recorded. The configured AI resolver [41445688788](https://github.com/markhuangai/opensource-repo-manager/actions/runs/41445688788) recognized the existing review. PR description edits are therefore avoided during subsequent timing samples.

## Actions-only runtime coverage ownership

Historical timings above describe the pre-removal implementation. The current runtime uses the default Actions entrypoint and retains all 99 Actions scenarios per SDK. Every Actions chain must include a real resource observation; empty observations fail receipt validation.

| Retained behavior                                                                                                           | Current owner                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Successful, waiting, failed and cancelled default startup; no public listener; authentic task ownership                     | actions suite: lifecycle chain and parent startup cases                                                       |
| Native session restoration, append-only replies, artifact expiry/deletion, owned PR recovery, readiness deduplication       | actions suite: sessions, pr-recovery, clarification and clarification-recovery chains, unchanged scenario IDs |
| UID isolation, credential exclusion, worker cleanup, SDK restrictions, schema validation, publication scans/review          | core suite and runtime/agent/schema unit tests                                                                |
| Audited toolchains and dependencies, bounded setup, cancellation and stale work                                             | bootstrap-node, bootstrap-python and bootstrap-go suites                                                      |
| Source citations, reproduction, source-only audit, reviewed status, closure, post-publication failures and restart recovery | investigation suite; explicit selected-issue refresh replaces service intake                                  |
| Candidate audit/tests, changed scope, publication recovery and current-head repair                                          | implementation-candidates, implementation-recovery and implementation-monitor-repair suites                   |
| Readiness transient reads/restart, stale-head suppression, wait budgets and missing evidence                                | implementation-monitor-state suite; GitHub comments replace external-channel assertions                       |
| Monotonic refresh generations, overlapping reads, close/reopen and ownership filtering                                      | intake and storage unit tests                                                                                 |
| Directory tree entries, prompt/skill overrides, truncated tree failure                                                      | actions-routing tests through the real GitHub adapter                                                         |
| Native image startup, missing credentials, bounded failure, executable/platform identity                                    | release workflow script transport tests and native release smoke                                              |

Retired cases cover public health/readiness listeners, signed webhook intake/replay, backfill cursors, service schedulers, old-schema migrations, external MCP reads/writes and external notification delivery. The implementation-monitor-mcp suite and MCP milestone case are removed. Mixed cases retain their publication, status, audit, budget and recovery assertions under the owners above. No production task uses the test-only component fixture as its entrypoint.
