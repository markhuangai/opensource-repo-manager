import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { RE2JS } from "re2js";
import { RuntimeError } from "../../domain/agents.ts";

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
      throw new RuntimeError("output_schema_invalid");
    return validate;
  } catch {
    throw new RuntimeError("output_schema_invalid");
  }
}
