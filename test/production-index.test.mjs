// test/production-index.test.mjs — fix-cycle-2 (closes QG gate 4). Automated regression pin for
// VC-5: index/index.json (the PRODUCTION catalog) must ship with zero real entries until story
// 055.W3.3's CI invariant suite lands. .github/workflows/ci.yml already has a dedicated bash step
// enforcing this on every push; this test covers the SAME invariant inside the `node --test` suite
// so it also fails loudly in any environment that runs the test suite without the full ci.yml
// pipeline (e.g. a contributor running `node --test test/` locally before pushing).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const productionIndexPath = join(here, "..", "index", "index.json");

test("index/index.json (production) has zero entries — VC-5, story 055.W3.1", () => {
  const data = JSON.parse(readFileSync(productionIndexPath, "utf8"));
  assert.equal(data.schema_version, "1.0.0");
  assert.deepEqual(data.entries, [], "the production catalog must stay empty until 055.W3.3's D24 invariant CI exists — see README.md 'Why the production index is empty'");
});
