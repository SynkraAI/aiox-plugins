// test/entry-schema.test.mjs — fix-cycle-2 (closes QG gate 4: zero automated tests).
//
// Node's built-in test runner (`node:test`) — zero dependency, matches this repo's "scaffolding,
// not a heavyweight framework" posture. Run: `node --test test/` (wired into .github/workflows/ci.yml).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateEntryShape,
  checkArtifactBinding,
  checkArtifactHost,
  checkNoConflictingDuplicate,
  validateEntryFull,
  ALLOWED_ARTIFACT_HOSTS,
} from "../lib/entry-schema.mjs";

const DIGEST = "9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a";
const GOOD_HOST = "pub-42179e62dc3040138151ec33229dd073.r2.dev";

function validEntry(overrides = {}) {
  return {
    schema_version: "1.0.0",
    plugin_id: "aiox-enterprise",
    name: "AIOX Enterprise",
    description: "test",
    version: "0.0.0-fixture",
    tiers: ["enterprise"],
    digest: { algorithm: "sha256", value: DIGEST },
    artifact: {
      mirror_url: `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
      r2_key: `plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
    },
    publisher: { subject: "acct_test" },
    published_at: new Date().toISOString(),
    license: { spdx_or_path: "MIT" },
    ...overrides,
  };
}

describe("validateEntryShape", () => {
  test("a fully-formed entry has zero shape errors", () => {
    assert.deepEqual(validateEntryShape(validEntry()), []);
  });

  test("rejects a non-kebab plugin_id", () => {
    const errs = validateEntryShape(validEntry({ plugin_id: "Not_Kebab!" }));
    assert.ok(errs.some((e) => e.includes("plugin_id must be kebab-case")));
  });

  test("rejects a missing r2_key (required since fix-cycle-1)", () => {
    const e = validEntry();
    delete e.artifact.r2_key;
    const errs = validateEntryShape(e);
    assert.ok(errs.some((e) => e.includes("artifact.r2_key required")));
  });

  test("rejects an overlay.shadows entry with an empty reason (D23)", () => {
    const e = validEntry({ overlay: { shadows: { review: "   " } } });
    const errs = validateEntryShape(e);
    assert.ok(errs.some((e) => e.includes("must carry a non-empty reason")));
  });

  test("accepts overlay.shadows with a real reason", () => {
    const e = validEntry({ overlay: { shadows: { review: "the Enterprise pack's own /review" } } });
    assert.deepEqual(validateEntryShape(e), []);
  });
});

describe("checkArtifactBinding (F-AC6-ARTIFACT-BINDING, fix-cycle-1)", () => {
  test("correctly-namespaced entry: no errors", () => {
    assert.deepEqual(checkArtifactBinding(validEntry()), []);
  });

  test("scenario C — the ORIGINAL demonstrated defect: entry points at a DIFFERENT plugin's key — REFUSED", () => {
    const e = validEntry({
      plugin_id: "aiox-enterprise",
      artifact: {
        mirror_url: `https://${GOOD_HOST}/plugins-fixtures/sinkra-os/0.0.0-fixture/${DIGEST}.tar.gz`,
        r2_key: `plugins-fixtures/sinkra-os/0.0.0-fixture/${DIGEST}.tar.gz`,
      },
    });
    const errs = checkArtifactBinding(e);
    assert.equal(errs.length, 2, "both mirror_url and r2_key should be flagged");
    assert.ok(errs.every((e) => e.includes("not namespaced under its own plugin_id")));
  });

  test("scenario D — substring-only gaming (\"aiox-enterprise-2\" contains \"aiox-enterprise\" but is not an exact segment) — REFUSED", () => {
    const e = validEntry({
      plugin_id: "aiox-enterprise",
      artifact: {
        mirror_url: `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise-2/0.0.0-fixture/${DIGEST}.tar.gz`,
        r2_key: `plugins-fixtures/aiox-enterprise-2/0.0.0-fixture/${DIGEST}.tar.gz`,
      },
    });
    const errs = checkArtifactBinding(e);
    assert.equal(errs.length, 2, "exact-segment matching must not be fooled by a substring");
  });

  test("scenario A (known LOW residual, F-BINDING-POSITION-AGNOSTIC, WON'T_FIX this cycle) — plugin_id present but NOT at the canonical position still PASSES today; pinned here so this is a deliberate choice, not silent drift", () => {
    const e = validEntry({
      plugin_id: "aiox-enterprise",
      artifact: {
        mirror_url: `https://${GOOD_HOST}/plugins-fixtures/OTHER-SEGMENT/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
        r2_key: `plugins-fixtures/OTHER-SEGMENT/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
      },
    });
    assert.deepEqual(checkArtifactBinding(e), [], "position-agnostic is a KNOWN, accepted residual — see docs/backlog and the QG re-review");
  });
});

describe("checkArtifactHost (F-BINDING-NO-HOST-ALLOWLIST, fix-cycle-2)", () => {
  test("the real AIOX-operated host passes", () => {
    assert.deepEqual(checkArtifactHost(validEntry()), []);
  });

  test("every host in ALLOWED_ARTIFACT_HOSTS is non-empty and lower-case (sanity on the constant itself)", () => {
    assert.ok(ALLOWED_ARTIFACT_HOSTS.length >= 1);
    for (const h of ALLOWED_ARTIFACT_HOSTS) assert.equal(h, h.toLowerCase());
  });

  test("the QG's residual, now closed: a correctly-namespaced path on a FOREIGN host is REFUSED", () => {
    const e = validEntry({
      artifact: {
        mirror_url: `https://evil.example.com/plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
        r2_key: `plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
      },
    });
    const errs = checkArtifactHost(e);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /not an AIOX-operated mirror/);
    assert.match(errs[0], /evil\.example\.com/);
  });

  test("host matching is case-insensitive (a host is not a secret to be typo-guessed around)", () => {
    const e = validEntry({
      artifact: {
        ...validEntry().artifact,
        mirror_url: `https://${GOOD_HOST.toUpperCase()}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
      },
    });
    assert.deepEqual(checkArtifactHost(e), []);
  });

  test("an unparseable mirror_url is refused, not silently ignored", () => {
    const e = validEntry({ artifact: { ...validEntry().artifact, mirror_url: "not a url at all" } });
    const errs = checkArtifactHost(e);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /not a valid absolute URL/);
  });

  test("a subdomain of the allowed host does NOT pass (exact hostname match, not a suffix match)", () => {
    const e = validEntry({
      artifact: {
        ...validEntry().artifact,
        mirror_url: `https://evil.${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
      },
    });
    const errs = checkArtifactHost(e);
    assert.equal(errs.length, 1, "a suffix/subdomain match would be a real bypass — must stay exact");
  });
});

describe("checkNoConflictingDuplicate (D24(a)/(b) minimal guard)", () => {
  test("a genuinely new plugin_id+version: no errors", () => {
    assert.deepEqual(checkNoConflictingDuplicate([], validEntry()), []);
  });

  test("same plugin_id+version, DIFFERENT digest: refused, names D24 immutability", () => {
    const existing = [validEntry({ digest: { algorithm: "sha256", value: "0".repeat(64) } })];
    const errs = checkNoConflictingDuplicate(existing, validEntry());
    assert.equal(errs.length, 1);
    assert.match(errs[0], /D24 immutability/);
  });

  test("same plugin_id+version, IDENTICAL digest: refused as a no-op, distinct message", () => {
    const existing = [validEntry()];
    const errs = checkNoConflictingDuplicate(existing, validEntry());
    assert.equal(errs.length, 1);
    assert.match(errs[0], /nothing to do/);
  });

  test("same plugin_id, different version: no conflict", () => {
    const existing = [validEntry({ version: "0.0.1-fixture" })];
    assert.deepEqual(checkNoConflictingDuplicate(existing, validEntry({ version: "0.0.2-fixture" })), []);
  });
});

describe("validateEntryFull (composition)", () => {
  test("a fully valid, correctly-bound, correctly-hosted, non-conflicting entry: zero errors end to end", () => {
    assert.deepEqual(validateEntryFull(validEntry(), []), []);
  });

  test("a bad entry accumulates errors from every layer (shape + binding + host + duplicate)", () => {
    const bad = {
      plugin_id: "aiox-enterprise",
      version: "0.0.0-fixture",
      digest: { algorithm: "sha256", value: DIGEST },
      artifact: {
        mirror_url: `https://evil.example.com/plugins-fixtures/sinkra-os/0.0.0-fixture/${DIGEST}.tar.gz`,
        r2_key: `plugins-fixtures/sinkra-os/0.0.0-fixture/${DIGEST}.tar.gz`,
      },
      // missing: schema_version, tiers, publisher, published_at, license
    };
    const existing = [validEntry({ plugin_id: "aiox-enterprise", digest: { algorithm: "sha256", value: "0".repeat(64) } })];
    const errs = validateEntryFull(bad, existing);
    assert.ok(errs.length >= 5, `expected many accumulated errors, got ${errs.length}: ${errs.join("; ")}`);
  });
});
