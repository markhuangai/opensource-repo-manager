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
  | "actions_context_invalid"
  | "source_context_invalid"
  | "source_reference_invalid"
  | "source_missing"
  | "source_value_invalid";

export const configurationSections = [
  "version",
  "github",
  "pr_monitor",
  "proxy",
  "profiles",
  "roles",
  "limits",
  "session_key",
] as const;

export type ConfigurationDiagnostic = {
  source_sha?: string;
  source?: "variable" | "secret";
  name?: string;
  expected?: string;
  observed?: string;
};

export class ConfigurationError extends Error {
  readonly code: ConfigurationErrorCode;
  readonly diagnostic: ConfigurationDiagnostic & {
    line?: number;
    column?: number;
    section?: (typeof configurationSections)[number];
  };
  constructor(
    code: ConfigurationErrorCode,
    location?: { line: number; column: number },
    section?: (typeof configurationSections)[number],
    diagnostic: ConfigurationDiagnostic = {},
  ) {
    super(
      `Configuration rejected (${code}).` +
        (location ? ` Line ${location.line}, column ${location.column}.` : "") +
        (section ? ` Section ${section}.` : ""),
    );
    this.code = code;
    this.diagnostic = { ...location, section, ...diagnostic };
    this.name = "ConfigurationError";
  }
}
