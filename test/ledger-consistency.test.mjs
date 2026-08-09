// test/ledger-consistency.test.mjs — story 055.W3.3. Unit coverage for
// scripts/check-ledger-consistency.mjs's exported pure function: proves a hand-edited index entry
// (one that never went through publisher/publish.mjs, so it never got the publish-time checks) is
// still caught by re-deriving checks (a)/(b) purely from committed data.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkIndexAgainstLedger } from "../scripts/check-ledger-consistency.mjs";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function baseLedger() {
  return {
    schema_version: "1.0.0",
    plugins: {
      "aiox-enterprise": {
        status: "active",
        first_published_at: "t1",
        retired_at: null,
        retired_reason: null,
        history: [{ version: "1.0.0", digest: DIGEST_A, published_at: "t1" }],
      },
      "gone-plugin": {
        status: "retired",
        first_published_at: "t0",
        retired_at: "t5",
        retired_reason: "abandoned",
        history: [{ version: "1.0.0", digest: DIGEST_B, published_at: "t0" }],
      },
    },
  };
}

describe("checkIndexAgainstLedger — structural re-check independent of publish-time", () => {
  test("a clean, ledger-consistent index has zero violations", () => {
    const index = { entries: [{ plugin_id: "aiox-enterprise", version: "1.0.0", digest: { value: DIGEST_A } }] };
    assert.deepEqual(checkIndexAgainstLedger(index, baseLedger()), []);
  });

  test("a hand-edited entry republishing under a name the ledger marked retired is caught (check b, bypassing publish.mjs entirely)", () => {
    const index = { entries: [{ plugin_id: "gone-plugin", version: "2.0.0", digest: { value: "c".repeat(64) } }] };
    const errors = checkIndexAgainstLedger(index, baseLedger());
    assert.equal(errors.length, 1);
    assert.match(errors[0], /retired/);
  });

  test("a hand-edited entry whose digest was already recorded under a different plugin_id is caught (check a, bypassing publish.mjs entirely)", () => {
    const index = { entries: [{ plugin_id: "some-other-name", version: "1.0.0", digest: { value: DIGEST_A } }] };
    const errors = checkIndexAgainstLedger(index, baseLedger());
    assert.equal(errors.length, 1);
    assert.match(errors[0], /already published under a DIFFERENT plugin_id \("aiox-enterprise"\)/);
  });

  test("an empty index against a non-empty ledger has zero violations (production index today)", () => {
    assert.deepEqual(checkIndexAgainstLedger({ entries: [] }, baseLedger()), []);
  });
});
