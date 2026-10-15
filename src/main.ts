#!/opt/orm-runtime/bin/node
import { parseArgs } from "node:util";
import { ConfigurationError } from "./config/errors.ts";
import { loadProtectedConfiguration } from "./config/load.ts";
import { startHttpService } from "./http/server.ts";
import {
  createKnownSecretChecker,
  createSafeLogger,
} from "./logging/redact.ts";

let logger = createSafeLogger(createKnownSecretChecker([]));
try {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs({
      options: { config: { type: "string", default: "/config/config.yml" } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    throw new ConfigurationError("arguments_invalid");
  }
  const command = args.positionals.join(" ");
  if (
    !["", "serve", "config validate"].includes(command) ||
    typeof args.values.config !== "string"
  )
    throw new ConfigurationError("arguments_invalid");
  const loaded = await loadProtectedConfiguration(args.values.config);
  logger = createSafeLogger(loaded.secrets);
  if (command === "config validate")
    logger.info("Configuration and workflow bundles are valid.");
  else await startHttpService(logger);
} catch (error) {
  logger.error(
    error instanceof ConfigurationError
      ? error.message
      : "Configuration loading failed.",
  );
  process.exitCode = 1;
}
