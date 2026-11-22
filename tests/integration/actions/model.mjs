import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const fixtureSource = {
  ".node-version": "24.18.0\n",
  "bug.mjs": "export const increment = (value) => value + 2;\n",
  "repro.mjs":
    "import assert from 'node:assert/strict'; import { increment } from './bug.mjs'; assert.equal(increment(1), 2);\n",
  "README.md": "The supported increment(value) function adds one.\n",
};

export { fixtureSource };

export async function model({ text, mode, turn, root, git }) {
  const content = text
    .split("Task data (not authorization):\n")[1]
    .split("\n")[0];
  const { role, input } = JSON.parse(content);
  assert.equal(role, turn.role);
  const { task } = input;
  const response = text.includes('"properties":{"response"');
  const reply = (result) => ({
    task,
    result: response ? { response: result } : result,
  });
  assert.equal(git("rev-parse", "HEAD"), turn.starting_sha);
  const citation = (path) => ({
    kind: "source",
    path,
    start_line: 1,
    end_line: 1,
  });
  switch (task) {
    case "investigation_triage":
      if (
        mode === "clarification" &&
        !text.includes("Expected result confirmed")
      )
        return reply({
          outcome: "needs_information",
          summary: "Confirm the supported behavior.",
          questions: ["What result is expected from increment(1)?"],
          audience: "reporter_or_maintainer",
        });
      return reply({
        outcome: mode === "manual_feature" ? "manual_feature" : "investigate",
        summary: "The supplied report is about increment.",
        questions: [],
        audience: "maintainer",
      });
    case "investigation_plan":
      return reply({
        hypothesis:
          "Compare the implementation to the supported add-one contract.",
        citations: [citation("README.md"), citation("bug.mjs")],
        commands:
          mode === "reproduced"
            ? [{ argv: ["node", "repro.mjs"], cwd: "." }]
            : [],
      });
    case "investigation_result": {
      const candidate = mode !== "no_fix";
      return reply({
        outcome: candidate ? "maintenance_candidate" : "no_fix",
        objective: candidate ? "Restore the supported add-one behavior." : "",
        proof: candidate
          ? mode === "reproduced"
            ? "reproduced"
            : "source"
          : "none",
        summary: candidate
          ? "The implementation adds two, while README documents adding one."
          : "No supported maintenance fix.",
        evidence_ids: candidate ? input.evidence.map((value) => value.id) : [],
        questions: [],
        bug: candidate
          ? {
              expected_behavior: "increment adds one",
              observed_behavior: "increment adds two",
              existing_contract:
                "The repository documents the add-one behavior.",
            }
          : null,
      });
    }
    case "bootstrap_plan":
      return reply({
        version: 1,
        toolchains: [{ language: "node", version: "24.18.0" }],
        system_packages: [],
        package_managers: [],
        setup_commands: [],
        test_commands: [],
      });
    case "bootstrap_audit":
      return reply({
        approved: true,
        findings: [],
        source_digest: input.source_digest,
        plan_digest: input.plan_digest,
      });
    case "implementation_plan":
      return reply({
        acceptance: ["increment adds exactly one on supported inputs."],
        paths: ["bug.mjs", "regression.mjs"],
        checks: [{ argv: ["node", "repro.mjs"], cwd: "." }],
        regression: { argv: ["node", "regression.mjs"], cwd: "." },
      });
    case "implementation_change": {
      if (
        mode === "coding_clarification" &&
        !text.includes("Expected result confirmed")
      ) {
        await writeFile(
          join(root, "bug.mjs"),
          "export const increment = (value) => value + 1;\n",
        );
        return reply({
          outcome: "needs_information",
          summary:
            "Confirm how the existing add-one behavior should be checked.",
          questions: ["What result is expected from increment(1)?"],
          audience: "reporter_or_maintainer",
        });
      }
      const repair = input.feedback.length > 0;
      const defect =
        !repair && ["audit_rejection", "monitor_repair"].includes(mode);
      await writeFile(
        join(root, "bug.mjs"),
        defect
          ? "export const increment = (value) => value === 2 ? 99 : value + 1;\n"
          : "export const increment = (value) => value + 1;\n",
      );
      await writeFile(
        join(root, "regression.mjs"),
        `import assert from 'node:assert/strict'; import {execFileSync} from 'node:child_process'; import { increment } from './bug.mjs'; assert.notEqual(execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), '${turn.starting_sha}'); assert.equal(increment(1), 2); ${repair ? "assert.equal(increment(2), 3);" : ""}\n`,
      );
      return reply({
        summary: "Correct the add-one behavior and verify a regression.",
        title: "Fix supported increment",
        commit_message: "Fix supported increment",
      });
    }
    case "implementation_audit": {
      const reject =
        mode === "audit_rejection" &&
        git("show", "HEAD:bug.mjs").includes("99");
      return reply({
        approved: !reject,
        findings: reject
          ? [
              "The special case for input two still violates the add-one contract.",
            ]
          : [],
        scope_digest: input.scope_digest,
        artifact_digest: input.artifact_digest,
      });
    }
    case "implementation_review_feedback":
      return reply({
        dispositions: input.surfaces.map((surface) => ({
          surface_id: surface.id,
          disposition: surface.body.includes("increment(2)")
            ? "fix"
            : "informational",
          explanation: surface.body.includes("increment(2)")
            ? "The implementation returns 99 for input two."
            : "Reviewer completion signal.",
          citations: [{ path: "bug.mjs", start_line: 1, end_line: 1 }],
        })),
      });
    case "external_output_review":
      return reply({ approved: true, binding: input.binding, findings: [] });
    default:
      throw new Error(`Unexpected model phase ${task}`);
  }
}
