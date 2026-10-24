export type ConfigurationErrorCode =
  | "config_unreadable"
  | "config_permissions"
  | "yaml_invalid"
  | "schema_invalid"
  | "reference_invalid"
  | "bundle_invalid"
  | "secret_in_snapshot"
  | "mcp_write_migration_required"
  | "arguments_invalid";

export const configurationSections = [
  "version",
  "github",
  "pr_monitor",
  "proxy",
  "profiles",
  "roles",
  "notifications",
  "limits",
  "mcp",
] as const;

export class ConfigurationError extends Error {
  readonly code: ConfigurationErrorCode;
  constructor(
    code: ConfigurationErrorCode,
    location?: { line: number; column: number },
    section?: (typeof configurationSections)[number],
  ) {
    super(
      `Configuration rejected (${code}).` +
        (code === "mcp_write_migration_required"
          ? " Replace effect: reviewed_write with effect: write and configure review_required_tools on its server."
          : "") +
        (location ? ` Line ${location.line}, column ${location.column}.` : "") +
        (section ? ` Section ${section}.` : ""),
    );
    this.code = code;
    this.name = "ConfigurationError";
  }
}
