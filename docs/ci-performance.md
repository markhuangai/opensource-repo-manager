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

The native matrix still contains all nine suites on AMD64 and ARM64: core, investigation, bootstrap, actions, implementation-candidates, implementation-recovery, implementation-monitor-repair, implementation-monitor-state and implementation-monitor-mcp. Repository checks, workflow/Compose validation, both CodeQL analyses and aggregate statuses, and configured AI review remain required.

The Actions inventory retains every original scenario ID, partitioned into five chains: lifecycle (29), sessions (8), PR recovery (16), clarification (19) and clarification recovery (22). Five production-controller scenarios extend the last chain: question, unauthorized reply, resumed work, readiness and duplicate invocation. Thus each SDK proves **99 distinct scenarios**, including all original 94. Every stateful sequence remains intact. The registry and receipt validator reject missing, duplicate, substituted, failed or stale lane/scenario evidence.

Three lanes run concurrently by default inside the existing native Actions job; the profiling option accepts one through four. Each lane has separate containers/PID namespaces, volumes, network, protected configuration and upstream/artifact fixtures, and reuses the parent's built image. Docker's shared kernel can account threads for the same worker UID across containers. Test-manager affinity therefore uses at most four CPUs from the daemon's actual allowed list to bound SDK thread pools; worker identities and process limits retain their existing values. Every manager launch verifies the configured affinity, and receipts bind it to the parent alongside exact image, source commit, PR head, source/test input digest, platform and worktree state. Source changes during verification fail the run. Normal and failed lanes retain scoped ownership checks for cleanup; shared Docker caches and credentials are preserved.

Each lane prepares its own Node archive before scenario execution using the production toolchain installer. A second installation proves the archive produces identical signed-checksum and installed-file integrity receipts; a corrupted copy must fail installation. Scenario setup copies only archive bytes into each task's private download directory. Every runtime still fetches signed checksums, verifies the archive and installs its own toolchain. No installation, receipt or mutable cache is shared between lanes, and existing cache bytes are never overwritten. Lane receipts retain the archive digest and preparation timing.

## Measurement procedure

Use Node 24.18.0, npm 12.0.2 and the same source/test input digest for the local serial control and parallel comparison:

```sh
npm run test:container -- --platform linux/amd64 --suite actions --actions-concurrency 1
npm run test:container -- --platform linux/amd64 --suite actions
```

The full local gate also runs `npm run check`, every AMD64 container suite, actionlint 1.7.12 for repository and example workflows, and Compose validation. Native ARM64 proof comes from the complete PR matrix. No cached test result is accepted for changed source.

Capture setup/build, scenario and lane timings, artifact transport request bytes/durations/interruption counts, checkpoint-helper durations, sampled live container CPU/memory/PIDs and runner resources, plus teardown. Checkpoint-helper timing includes restoration, process startup and the explicit checkpoint; artifact transport timing excludes local sealing/restoration computation. These are distinct measurements and must not be added as a decomposition of total time. Concurrent lane durations likewise overlap.

For each representative fresh head, record the validation trigger before PR creation or normal push, then retain the GitHub run IDs, attempts, source head and tested merge commit. Measure through the last required current-head CI workflow/status result. Include retries, automatic restarts and repeated validation for that head. Report queue and execution separately from the total; invalid timestamp ordering makes the affected measurement unavailable, not zero. Record required Codex/CodeRabbit outcomes and their latency separately, preserving their merge gates.

Collect the Repository CI/native and CodeQL jobs through paginated GitHub API reads, their exact-head check/status results, and each native job's final JSON receipt. Bind any review workflow's trusted definition SHA separately from the reviewed PR head. Require complete unique coverage, image identities and cleanup receipts before counting a sample. Save source references and safe evidence summaries in the PR; retain raw delivery receipts without credentials.

## Results

### Local serial and parallel control

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

Four-worker diagnostics reproduced a Node thread-creation failure under shared kernel UID accounting. Three lanes are therefore the default; one through four remain explicit profiling selections. The successful gates above use the normal harness and production guards, without diagnostic hooks, relaxed limits or extended scenario deadlines.

### Fresh-head complete CI

The three fresh-head measurements are **pending**. No 30-minute complete-CI improvement is claimed yet. A failed or missing required check, incomplete coverage/cleanup, invalid source identity, or external timing constraint blocks completion rather than waiving the target.

| Sample | PR head / tested source | Native receipts | Complete CI elapsed | Review outcome / latency | Result  |
| ------ | ----------------------- | --------------- | ------------------- | ------------------------ | ------- |
| 1      | Pending                 | Pending         | Pending             | Pending                  | Pending |
| 2      | Pending                 | Pending         | Pending             | Pending                  | Pending |
| 3      | Pending                 | Pending         | Pending             | Pending                  | Pending |
