import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
assert.equal(require("is-number/package.json").version, "6.0.0");
assert.equal(require("is-number")(42), true);
