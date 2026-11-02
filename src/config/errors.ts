export type ConfigurationErrorCode =
  | "config_unreadable"
  | "config_permissions"
  | "yaml_invalid"
  | "schema_invalid"
  | "reference_invalid"
  | "bundle_invalid"
  | "secret_in_snapshot"
  | "arguments_invalid"
  | "session_key_invalid"
  | "actions_context_invalid";

export const configurationSections = [
  "version",
  "github",
  "pr_monitor",
  "proxy",
  "profiles",
  "roles",
  "limits",
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
        (location ? ` Line ${location.line}, column ${location.column}.` : "") +
        (section ? ` Section ${section}.` : ""),
    );
    this.code = code;
    this.name = "ConfigurationError";
  }
}
