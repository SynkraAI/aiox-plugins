// test/validate-index.test.mjs — fix-cycle-2 (closes QG gate 4). Exercises the CI-side gate
// (validateIndexData, exported for testing) directly, without touching disk, proving publish-time
// and CI-time checks share the exact same underlying lib/entry-schema.mjs logic.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateIndexData } from "../scripts/validate-index.mjs";

const DIGEST = "9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a";
const GOOD_HOST = "pub-42179e62dc3040138151ec33229dd073.r2.dev";

function entry(overrides = {}) {
  return {
    schema_version: "1.0.0",
    plugin_id: "aiox-enterprise",
    version: "0.0.0-fixture",
    tiers: ["enterprise"],
    digest: { algorithm: "sha256", value: DIGEST },
    artifact: {
      mirror_url: `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
      r2_key: `plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
    },
    publisher: { subject: "acct_test" },
    published_at: "2026-08-09T00:00:00.000Z",
    license: { spdx_or_path: "MIT" },
    ...overrides,
  };
}

describe("validateIndexData", () => {
  test("a well-formed index with one valid entry: zero violations", () => {
    const data = { schema_version: "1.0.0", generated_at: "x", entries: [entry()] };
    assert.deepEqual(validateIndexData(data, "test.json"), []);
  });

  test("the production-shape empty index (VC-5): zero violations", () => {
    const data = { schema_version: "1.0.0", generated_at: null, entries: [] };
    assert.deepEqual(validateIndexData(data, "index/index.json"), []);
  });

  test("wrong top-level schema_version is flagged", () => {
    const data = { schema_version: "0.9.0", entries: [] };
    const errs = validateIndexData(data, "test.json");
    assert.ok(errs.some((e) => e.includes("schema_version must be '1.0.0'")));
  });

  test("entries not an array short-circuits with exactly one error", () => {
    const data = { schema_version: "1.0.0", entries: "not-an-array" };
    const errs = validateIndexData(data, "test.json");
    assert.equal(errs.length, 1);
    assert.match(errs[0], /entries must be an array/);
  });

  test("a hand-edited entry pointing at a DIFFERENT plugin's artifact is caught (regression: bypassing publish.mjs doesn't bypass CI)", () => {
    const bad = entry({
      artifact: {
        mirror_url: `https://${GOOD_HOST}/plugins-fixtures/sinkra-os/0.0.0-fixture/${DIGEST}.tar.gz`,
        r2_key: `plugins-fixtures/sinkra-os/0.0.0-fixture/${DIGEST}.tar.gz`,
      },
    });
    const data = { schema_version: "1.0.0", entries: [bad] };
    const errs = validateIndexData(data, "test.json");
    assert.ok(errs.some((e) => e.includes("not namespaced under its own plugin_id")));
  });

  test("a hand-edited entry pointing at a FOREIGN host is caught (fix-cycle-2, CI side of F-BINDING-NO-HOST-ALLOWLIST)", () => {
    const bad = entry({
      artifact: {
        mirror_url: `https://evil.example.com/plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
        r2_key: `plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
      },
    });
    const data = { schema_version: "1.0.0", entries: [bad] };
    const errs = validateIndexData(data, "test.json");
    assert.ok(errs.some((e) => e.includes("not an AIOX-operated mirror")));
  });

  test("two entries with the same plugin_id+version but conflicting digests: D24 immutability violation", () => {
    const data = {
      schema_version: "1.0.0",
      entries: [entry(), entry({ digest: { algorithm: "sha256", value: "0".repeat(64) } })],
    };
    const errs = validateIndexData(data, "test.json");
    assert.ok(errs.some((e) => e.includes("D24 immutability violated")));
  });
});
