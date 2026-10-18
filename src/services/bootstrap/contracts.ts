import { z } from "zod";
import { isContainedReference } from "../../config/files.ts";
import type { AgentRunRequest } from "../../domain/agents.ts";

const version = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const directory = z
  .string()
  .max(4096)
  .refine((value) => value === "." || isContainedReference(value));
const argument = z
  .string()
  .min(1)
  .max(65536)
  .refine((value) => !value.includes("\0"));
export const commandSchema = z.strictObject({
  cwd: directory,
  argv: z.array(argument).min(1).max(256),
});
export const bootstrapPlanSchema = z
  .strictObject({
    version: z.literal(1),
    toolchains: z
      .array(
        z.strictObject({ language: z.enum(["go", "node", "python"]), version }),
      )
      .min(1)
      .max(3),
    system_packages: z
      .array(
        z
          .string()
          .min(2)
          .max(128)
          .regex(/^[a-z0-9][a-z0-9+.-]*[a-z0-9+]$/),
      )
      .max(64),
    package_managers: z
      .array(
        z.strictObject({
          name: z.enum(["npm", "pnpm", "yarn", "pip", "poetry", "uv"]),
          version,
          cwd: directory,
        }),
      )
      .max(32),
    setup_commands: z.array(commandSchema).max(64),
    test_commands: z
      .array(
        commandSchema.extend({
          execution: z.enum(["local", "remote"]),
          platform: z.enum(["linux", "windows", "macos"]),
        }),
      )
      .max(64),
  })
  .superRefine((plan, context) => {
    if (
      new Set(plan.toolchains.map((tool) => tool.language)).size !==
      plan.toolchains.length
    )
      context.addIssue({ code: "custom", message: "Duplicate language" });
    const versions = new Map<string, string>();
    const directories = new Set<string>();
    for (const manager of plan.package_managers) {
      const language = ["npm", "pnpm", "yarn"].includes(manager.name)
        ? "node"
        : "python";
      if (
        !plan.toolchains.some((tool) => tool.language === language) ||
        (versions.has(manager.name) &&
          versions.get(manager.name) !== manager.version)
      )
        context.addIssue({ code: "custom", message: "Incompatible manager" });
      versions.set(manager.name, manager.version);
      const directory = `${language}/${manager.cwd}`;
      if (directories.has(directory))
        context.addIssue({
          code: "custom",
          message: "Duplicate dependency manager",
        });
      directories.add(directory);
    }
    if (
      plan.test_commands.some(
        (command) =>
          command.platform === "windows" && command.execution !== "remote",
      )
    )
      context.addIssue({
        code: "custom",
        message: "Windows validation is remote",
      });
  });
export const bootstrapAuditSchema = z.strictObject({
  approved: z.boolean(),
  plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
  source_digest: z.string().regex(/^[a-f0-9]{64}$/),
  findings: z.array(z.string().max(4096)).max(64),
});
export type BootstrapPlan = z.infer<typeof bootstrapPlanSchema>;
export type BootstrapCommand = z.infer<typeof commandSchema>;
export type BootstrapAudit = z.infer<typeof bootstrapAuditSchema>;
export type Inspection = {
  fingerprints: Record<string, string>;
  source_files: string[];
};
export type CommandReceipt = {
  id: string;
  operation: string;
  argv: string[];
  cwd: string;
  uid: number;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  output_digest: string | null;
  output_bytes: number;
  outcome: "running" | "completed" | "failed" | "interrupted";
};
export type InstalledTool = {
  language: BootstrapPlan["toolchains"][number]["language"];
  version: string;
  path: string;
  integrity: string;
  node_signature?: string;
};
export type ToolEnvironment = {
  platform: string;
  mise: string;
  installer_integrity: string;
  packages: string;
  package_versions: string;
  tools: InstalledTool[];
};
export type BootstrapReceipt = {
  id: string;
  job_id: number;
  revision: number;
  source: AgentRunRequest["workspace"];
  snapshot_digest: string;
  status:
    | "planning"
    | "auditing"
    | "installing"
    | "setup"
    | "ready"
    | "blocked"
    | "interrupted";
  failure: string | null;
  inspection: Inspection | null;
  plan: BootstrapPlan | null;
  plan_digest: string | null;
  audit: {
    result: BootstrapAudit;
    run_id: string;
    profile: AgentRunRequest["profile"];
  } | null;
  environment: ToolEnvironment | null;
  manager_locks: Record<string, Record<string, string>>;
  started_at: number;
  finished_at: number | null;
};
