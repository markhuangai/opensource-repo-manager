import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { RuntimeError } from "../../domain/agents.ts";
import { immutable } from "../../config/bundles.ts";

export function compile(schema: object): ValidateFunction {
  try {
    const dialect = (schema as { $schema?: string }).$schema;
    const options = {
      strict: false,
      validateFormats: false,
      allErrors: false,
      ownProperties: true,
    };
    const ajv = dialect?.includes("draft-07")
      ? new Ajv(options)
      : new Ajv2020(options);
    const validate = ajv.compile(schema);
    if ("$async" in validate && validate.$async)
      throw new RuntimeError("mcp_schema_invalid");
    return validate;
  } catch {
    throw new RuntimeError("mcp_schema_invalid");
  }
}

export function snapshotTool(tool: Tool) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name))
    throw new RuntimeError("mcp_catalog_invalid");
  const snapshot: Tool = {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: structuredClone(tool.inputSchema),
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: structuredClone(tool.outputSchema) }),
  };
  const input = compile(snapshot.inputSchema);
  const output = snapshot.outputSchema
    ? compile(snapshot.outputSchema)
    : undefined;
  return { tool: immutable(snapshot), input, output };
}
