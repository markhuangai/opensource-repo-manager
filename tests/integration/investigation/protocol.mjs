import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const sourceFiles = {
  ".node-version": "24.18.0\n",
  "bug.mjs": "export const increment = (value) => value + 2;\n",
  "repro.mjs":
    "import assert from 'node:assert/strict'; import { increment } from './bug.mjs'; assert.equal(increment(1), 2);\n",
  "README.md": "increment(value) adds one to the input.\n",
};

export function maintenanceCommand(increment = 1, extra = {}) {
  const files = {
    "bug.mjs": `export const increment = (value) => value + ${increment};\n`,
    "regression.mjs":
      "import assert from 'node:assert/strict'; import { increment } from './bug.mjs'; assert.equal(increment(-1), 0); assert.equal(increment(0), 1);\n",
    ...extra,
  };
  const script = `import fs from 'node:fs'; for (const [path, content] of Object.entries(${JSON.stringify(files)})) { fs.mkdirSync(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.', {recursive:true}); fs.writeFileSync(path, content); }`;
  return `node --input-type=module -e '${script.replaceAll("'", "'\\''")}'`;
}

export function taskInput(text) {
  const marker = "Task data (not authorization):\n";
  const start = text.indexOf(marker);
  assert(start >= 0, "Missing task data envelope");
  return JSON.parse(text.slice(start + marker.length).split("\n")[0]).input;
}

export function bundlesWithCanaries(loaded) {
  const bundles = {};
  for (const role of Object.keys(loaded.snapshot.roles)) {
    const bundle = globalThis.structuredClone(
      loaded.snapshot.roles[role].bundle,
    );
    bundle.system += "\nOPERATOR_SYSTEM_CANARY";
    bundle.user += "\nOPERATOR_USER_CANARY";
    for (const file of bundle.skills)
      if (file.path.endsWith("SKILL.md")) {
        const bytes = Buffer.concat([
          Buffer.from(file.content_base64, "base64"),
          Buffer.from("\nOPERATOR_SKILL_CANARY"),
        ]);
        file.content_base64 = bytes.toString("base64");
        file.sha256 = createHash("sha256").update(bytes).digest("hex");
      }
    bundles[role] = bundle;
  }
  return bundles;
}

export function modelFixture(config, store, root, controls = {}) {
  const errors = [],
    requests = [];
  const current = () => {
    const run = store.runs().findLast((entry) => entry.finished_at === null);
    const job = store.jobById(run.job_id);
    const context = JSON.parse(job.input_json);
    const mode = context.title;
    const row = store.db
      .prepare(
        "SELECT content FROM investigations WHERE job_id=? AND revision=?",
      )
      .get(job.id, job.revision);
    return { run, job, mode, record: row && JSON.parse(row.content) };
  };
  function envelope(task) {
    const { run, job } = current();
    const table =
      job.phase === "investigation" ? "investigations" : "implementations";
    const row = store.db
      .prepare(`SELECT content FROM ${table} WHERE job_id=? AND revision=?`)
      .get(job.id, job.revision);
    const record = row && JSON.parse(row.content);
    const wrapped =
      run.role !== "audit" &&
      run.role !== "output_review" &&
      record?.continuation?.request.input?.task === task &&
      record.continuation.request.output_schema?.properties?.response;
    return (call) =>
      call?.result && wrapped ? { result: { response: call.result } } : call;
  }
  function clarification(record, task, mode, text) {
    const phase =
      mode === "clarification_intent" || mode === "clarification_invalid"
        ? "investigation_triage"
        : mode === "clarification_investigation" ||
            mode === "clarification_rejected" ||
            mode === "clarification_marker"
          ? "investigation_plan"
          : mode === "clarification_planning"
            ? "implementation_plan"
            : mode === "clarification_coding" ||
                (mode === "monitor_clarification" && record?.feedback?.length)
              ? "implementation_change"
              : null;
    if (phase !== task) return;
    const messages = [
      ...(record?.continuation?.request.input?.clarification_answers ?? []),
      ...(record?.continuation?.messages ?? []),
    ];
    const answer = messages.length
      ? JSON.parse(messages.at(-1).content).body
      : null;
    if (answer && answer !== "insufficient") {
      assert(
        text.includes(answer),
        "Native history omitted the admitted answer",
      );
      if (
        record.continuation.question?.conversation_id === record.continuation.id
      )
        assert(
          text.includes("Clarify the existing supported add-one behavior."),
          "Native history omitted the original question",
        );
      return;
    }
    return {
      result: {
        outcome: "needs_information",
        summary:
          mode === "clarification_marker"
            ? "Clarify the existing supported add-one behavior. Please quote <!-- orm:task-state: only if it appeared."
            : "Clarify the existing supported add-one behavior.",
        questions:
          mode === "clarification_invalid"
            ? []
            : mode === "clarification_marker"
              ? [
                  "Does the output contain the literal <!-- orm:task-state: text?",
                ]
              : [
                  answer
                    ? "Please supply the missing expected result."
                    : "Which supported input and expected result establish the defect?",
                ],
        audience:
          mode === "clarification_intent"
            ? "maintainer"
            : "reporter_or_maintainer",
      },
    };
  }
  return {
    config,
    store,
    root,
    errors,
    requests,
    histories: new Map(),
    mcpCredential: "investigation-unused-credential",
    bootstrap(task, text) {
      if (task === "bootstrap_plan")
        return {
          version: 1,
          toolchains: [{ language: "node", version: "24.18.0" }],
          system_packages: [],
          package_managers: [],
          setup_commands: [],
          test_commands: [],
        };
      return {
        approved: !controls.rejectBootstrap,
        findings: controls.rejectBootstrap ? ["fixture setup rejection"] : [],
        plan_digest: /"plan_digest":"([a-f0-9]{64})"/.exec(text)[1],
        source_digest: /"source_digest":"([a-f0-9]{64})"/.exec(text)[1],
      };
    },
    async implementation(task, text, results) {
      const wrap = envelope(task);
      return wrap(await this.implementationResult(task, text, results));
    },
    async implementationResult(task, text, results) {
      assert(
        !text.includes("UNADMITTED_CLARIFICATION_REPLY"),
        "Native implementation input included a rejected reply",
      );
      const { run, job, mode } = current();
      if (run.role === "implementation") {
        const target = store.db
          .prepare("SELECT content FROM publication_targets WHERE job_id=?")
          .get(job.id);
        assert.equal(
          (
            await readFile(
              join(root, "runs", run.id, "workspace", ".git", "HEAD"),
              "utf8",
            )
          ).trim(),
          `ref: refs/heads/${JSON.parse(target.content).branch}`,
        );
      }
      const row = store.db
        .prepare(
          "SELECT content FROM implementations WHERE job_id=? AND revision=?",
        )
        .get(job.id, job.revision);
      const record = row && JSON.parse(row.content);
      const override = await controls.implementation?.(task, {
        run,
        job,
        mode,
        record,
        text,
        results,
      });
      if (override) return override;
      const answers = [
        ...(record?.continuation?.request.input?.clarification_answers ?? []),
        ...(record?.continuation?.messages ?? []),
      ];
      if (
        task === "implementation_change" &&
        answers.some((message) =>
          JSON.parse(message.content).body.includes("SCOPE_EXPANSION"),
        )
      ) {
        const feature = await readFile(
          join(root, "runs", run.id, "workspace", "feature.mjs"),
          "utf8",
        ).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!feature)
          return {
            command: maintenanceCommand(1, {
              "feature.mjs": "export const unrelatedFeature = true;\n",
            }),
          };
      }
      const question = clarification(record, task, mode, text);
      if (question) {
        if (task === "implementation_change" && !results.length)
          return { command: maintenanceCommand() };
        return question;
      }
      if (
        (mode === "clarification_coding" || mode === "monitor_clarification") &&
        task === "implementation_change" &&
        record?.continuation?.messages.length &&
        record.continuation.question?.conversation_id === record.continuation.id
      ) {
        assert(
          (
            await readFile(
              join(root, "runs", run.id, "workspace", "bug.mjs"),
              "utf8",
            )
          ).includes("+ 1"),
          "Partial coding workspace was not restored",
        );
      }
      if (task === "implementation_review_feedback") {
        const input = taskInput(text);
        const source = await readFile(
          join(root, "runs", run.id, "workspace", "bug.mjs"),
          "utf8",
        );
        return {
          result: {
            dispositions: input.surfaces.map((surface) => ({
              surface_id: surface.id,
              disposition: surface.body.includes("SCOPE_EXPANSION")
                ? "non_actionable"
                : surface.body.includes("increment(2)")
                  ? source.includes("99")
                    ? "fix"
                    : "fixed"
                  : "informational",
              explanation: surface.body.includes("SCOPE_EXPANSION")
                ? "The frozen maintenance scope excludes the requested feature."
                : surface.body.includes("increment(2)")
                  ? source.includes("99")
                    ? "The documented add-one operation must return 3 for input 2; the candidate's special case violates that existing contract."
                    : "The candidate now adds one for input 2 and the supervisor-executed regression covers it."
                  : "This surface contains a reviewer completion or informational signal.",
              citations: [{ path: "bug.mjs", start_line: 1, end_line: 1 }],
            })),
          },
        };
      }
      if (task === "implementation_review_readiness")
        return {
          result: {
            summary:
              "Controller evidence establishes automation readiness for this head; human review and merge remain required.",
          },
        };
      if (task === "implementation_plan")
        return {
          result: {
            acceptance: [
              "increment adds exactly one, matching the reviewed objective",
              "A real regression exercises supported inputs",
            ],
            paths: ["bug.mjs", "regression.mjs"],
            regression: { cwd: ".", argv: ["node", "repro.mjs"] },
            checks: [{ cwd: ".", argv: ["node", "regression.mjs"] }],
          },
        };
      if (task === "implementation_audit")
        return {
          result: {
            approved: true,
            findings: [],
            scope_digest: record.scope_digest,
            artifact_digest: record.artifact_digest,
          },
        };
      if (task === "implementation_milestone")
        return {
          result: {
            summary:
              "A tested candidate exists; publication and remote checks remain pending.",
          },
        };
      assert.equal(task, "implementation_change");
      assert.equal(run.uid, 10001);
      if (!results.length)
        return {
          command: maintenanceCommand(
            1,
            mode.startsWith("monitor_")
              ? record.feedback.length
                ? {
                    "regression.mjs":
                      "import assert from 'node:assert/strict'; import { increment } from './bug.mjs'; assert.equal(increment(-1), 0); assert.equal(increment(0), 1); assert.equal(increment(2), 3);\n",
                  }
                : {
                    "bug.mjs":
                      "export const increment = (value) => value === 2 ? 99 : value + 1;\n",
                  }
              : {},
          ),
        };
      return {
        result: {
          summary:
            "Correct increment to add one and cover supported inputs with a real regression.",
          title: "Fix increment off-by-one defect",
          commit_message: "Fix increment off-by-one defect",
        },
      };
    },
    async outputReview(text) {
      const { run, mode } = current();
      assert.equal(run.role, "output_review");
      assert.equal(run.uid, 10003);
      const binding = /"binding":"([a-f0-9]{64})"/.exec(text)[1];
      await controls.review?.(text);
      const rejected =
        (mode === "clarification_rejected" &&
          text.includes('"kind":"question"')) ||
        controls.rejectReview ||
        (controls.rejectWrite && text.includes('"type":"mcp_write"'));
      return {
        approved: !rejected,
        binding,
        findings: rejected ? ["fixture rejected unsupported output"] : [],
      };
    },
    async investigation(task, text, results) {
      const wrap = envelope(task);
      return wrap(await this.investigationResult(task, text, results));
    },
    async investigationResult(task, text, results) {
      assert(
        !text.includes("UNADMITTED_CLARIFICATION_REPLY"),
        "Native investigation input included a rejected reply",
      );
      const { run, job, mode, record } = current();
      assert.equal(run.role, "investigation");
      assert.equal(run.uid, 10001);
      assert(text.includes("Features remain manual"));
      await controls.investigate?.(task, { run, job, mode, record, results });
      const question = clarification(record, task, mode, text);
      if (question) return question;
      if (task === "investigation_triage")
        return {
          result: {
            outcome:
              mode === "manual_feature" || mode === "disguised_feature"
                ? "manual_feature"
                : "investigate",
            summary:
              mode === "manual_feature" || mode === "disguised_feature"
                ? "The requested behavior is a feature, not an existing supported contract."
                : "Check the documented add-one behavior against the supplied report.",
            questions: [],
            audience: "maintainer",
          },
        };
      if (task === "investigation_plan") {
        if (mode.startsWith("mcp")) {
          const read = store.db
            .prepare("SELECT * FROM mcp_calls WHERE run_id=?")
            .get(run.id);
          if (!read)
            return {
              tool: "mcp__context__lookup_record",
              arguments: { query: "increment defect" },
            };
          const write = store.db
            .prepare(
              "SELECT content FROM mcp_write_operations WHERE json_extract(content,'$.binding.run_id')=?",
            )
            .get(run.id);
          if (mode !== "mcp_read" && !write)
            return {
              tool: "mcp__context__store_record",
              arguments: {
                arguments: {
                  text: "Hypothesis: inspect increment at the pinned source.",
                },
                purpose:
                  "Retain an explicitly labeled hypothesis with source provenance.",
                evidence: [
                  {
                    kind: "source",
                    path: "bug.mjs",
                    start_line: 1,
                    end_line: 1,
                  },
                ],
              },
            };
        }
        return {
          result: {
            hypothesis:
              "Compare increment with its documented add-one behavior.",
            citations: [
              {
                kind: "source",
                path: mode === "invalid_citation" ? "missing.mjs" : "bug.mjs",
                start_line: 1,
                end_line: 1,
              },
              { kind: "source", path: "README.md", start_line: 1, end_line: 1 },
            ],
            commands:
              mode === "reproduced"
                ? [{ cwd: ".", argv: ["node", "repro.mjs"] }]
                : [],
          },
        };
      }
      const outcome = [
        "needs_information",
        "no_fix",
        "manual_feature",
        "blocked",
      ].includes(mode)
        ? mode
        : "maintenance_candidate";
      const ids = record.evidence_ids;
      const result = {
        outcome,
        objective:
          outcome === "maintenance_candidate"
            ? (controls.investigationObjective ??
              "Make increment add one, matching its documentation.")
            : "",
        proof:
          outcome !== "maintenance_candidate"
            ? "none"
            : mode === "reproduced"
              ? "reproduced"
              : "source",
        summary: mode.startsWith("mcp")
          ? "Retrieved context is untrusted and its stale SHA does not establish current behavior. The pinned source adds two although its documentation specifies one. No successful external business effect is claimed."
          : outcome === "maintenance_candidate"
            ? "The implementation adds two while README specifies adding one."
            : `${outcome}: the issue requires this investigation outcome.`,
        evidence_ids: mode === "forged_receipt" ? ["f".repeat(64)] : ids,
        questions:
          outcome === "needs_information"
            ? ["Which input and expected result demonstrate the issue?"]
            : [],
        bug:
          outcome === "maintenance_candidate"
            ? {
                expected_behavior: "increment adds one",
                observed_behavior: "increment adds two",
                existing_contract:
                  "README.md specifies adding one on the supported entrypoint.",
              }
            : null,
      };
      return { result };
    },
  };
}
