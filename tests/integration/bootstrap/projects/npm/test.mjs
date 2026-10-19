import assert from "node:assert/strict";
import fs from "node:fs";
import isNumber from "is-number";
assert(isNumber(42));
assert.equal(fs.readFileSync(".setup-uid", "utf8"), String(process.getuid()));
fs.writeFileSync(".tests-ran", "passed");
