import assert from "node:assert/strict";

if (process.argv[1]?.endsWith("/actions/main.js")) {
  for (const name of [
    "ORM_BOOTSTRAP_GITHUB_TOKEN",
    "ORM_CONFIGURATION_VARIABLES",
    "ORM_CONFIGURATION_SECRETS",
  ])
    assert(
      !Object.hasOwn(process.env, name),
      "Configuration transport reached the runtime child.",
    );
  console.error(
    JSON.stringify({
      event: "configuration_environment_isolated",
      sensitive_keys_absent: true,
    }),
  );
}
