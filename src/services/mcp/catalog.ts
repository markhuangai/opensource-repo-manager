import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { RE2JS } from "re2js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { RuntimeError } from "../../domain/agents.ts";
import { immutable } from "../../config/bundles.ts";
import { reviewedWriteInput } from "../mcp-writes/contracts.ts";
import { z } from "zod";

export function compile(schema: object): ValidateFunction {
  try {
    const dialect = (schema as { $schema?: string }).$schema;
    const options = {
      strict: false,
      validateFormats: false,
      allErrors: false,
      ownProperties: true,
      code: {
        regExp: Object.assign(
          (pattern: string) => RE2JS.compile(RE2JS.translateRegExp(pattern)),
          {
            code: "((pattern) => RE2JS.compile(RE2JS.translateRegExp(pattern)))",
          },
        ),
      },
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

export function writeTool(tool: Tool, reviewed: boolean, key?: string) {
  let schema = structuredClone(tool.inputSchema) as Record<string, unknown>;
  if (key || reviewed) {
    const visit = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(visit);
      if (!value || typeof value !== "object") return false;
      return Object.entries(value).some(
        ([name, item]) =>
          [
            "$ref",
            "$dynamicRef",
            "$recursiveRef",
            "$id",
            "$anchor",
            "$dynamicAnchor",
          ].includes(name) || visit(item),
      );
    };
    if (visit(schema)) throw new RuntimeError("mcp_schema_projection_unsafe");
  }
  if (key) {
    const supported = new Set([
      "$schema",
      "type",
      "properties",
      "required",
      "additionalProperties",
      "minProperties",
      "maxProperties",
      "title",
      "description",
      "default",
      "examples",
      "$comment",
    ]);
    if (Object.keys(schema).some((name) => !supported.has(name)))
      throw new RuntimeError("mcp_schema_projection_unsafe");
    const properties = schema.properties as Record<string, object> | undefined;
    const keySchema = properties?.[key] as Record<string, unknown> | undefined;
    const keyKeywords = new Set([
      "type",
      "minLength",
      "maxLength",
      "title",
      "description",
      "default",
      "examples",
      "$comment",
      "format",
    ]);
    if (
      !properties ||
      !Object.hasOwn(properties, key) ||
      !keySchema ||
      keySchema.type !== "string" ||
      Object.keys(keySchema).some((name) => !keyKeywords.has(name)) ||
      (typeof schema.maxProperties === "number" && schema.maxProperties < 1) ||
      !compile(properties[key])("00000000-0000-4000-8000-000000000000")
    )
      throw new RuntimeError("mcp_schema_projection_unsafe");
    delete properties[key];
    if (Array.isArray(schema.required))
      schema.required = schema.required.filter((name) => name !== key);
    for (const name of ["minProperties", "maxProperties"])
      if (typeof schema[name] === "number")
        schema[name] = Math.max(0, schema[name] - 1);
    schema.not = { required: [key] };
  }
  if (reviewed) {
    const envelope = z.toJSONSchema(reviewedWriteInput, { target: "draft-7" });
    const dialect = schema.$schema;
    delete envelope.$schema;
    delete schema.$schema;
    schema = {
      ...envelope,
      ...(dialect ? { $schema: dialect } : {}),
      properties: { ...envelope.properties, arguments: schema },
    };
  }
  return snapshotTool({ ...tool, inputSchema: schema as Tool["inputSchema"] });
}
