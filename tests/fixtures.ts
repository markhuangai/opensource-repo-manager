import { readFileSync } from "node:fs";
import { parseConfiguration } from "../src/config/schema.ts";

export function fixtureConfiguration() {
  return parseConfiguration(
    readFileSync(new URL("../config.example.yml", import.meta.url), "utf8"),
  );
}

export function fixtureMcp() {
  const config = fixtureConfiguration();
  config.mcp.credentials.service = {
    headers: { Authorization: "Bearer mcp-credential-canary" },
  };
  config.mcp.servers.context = {
    transport: "streamable_http",
    url: "https://tools.example.invalid/mcp",
    allow_plain_http: false,
    credential_ref: "service",
    tools: {
      read_record: { effect: "read" },
      store_record: {
        effect: "reviewed_write",
        idempotency_argument: "operation_key",
      },
    },
  };
  config.roles.investigation.mcp.context = {
    tools: ["read_record", "store_record"],
  };
  return config;
}
