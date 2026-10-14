export type ConfigurationErrorCode =
  | "config_unreadable"
  | "config_permissions"
  | "yaml_invalid"
  | "schema_invalid"
  | "reference_invalid"
  | "bundle_invalid"
  | "secret_in_snapshot"
  | "arguments_invalid";

export const configurationSections = [
  "version",
  "github",
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
        (location ? ` Line ${location.line}, column ${location.column}.` : "") +
        (section ? ` Section ${section}.` : ""),
    );
    this.code = code;
    this.name = "ConfigurationError";
  }
}
