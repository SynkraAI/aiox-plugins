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
  checkIdImmutabilityAgainstLedger,
  checkNameNotBurned,
  checkTierVocabulary,
} from "../lib/entry-schema.mjs";
import { EMPTY_LEDGER, recordPublish, retirePlugin, digestsPublishedUnderOtherPluginIds } from "../lib/ledger.mjs";

const DIGEST = "9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a";
const GOOD_HOST = "pub-42179e62dc3040138151ec33229dd073.r2.dev";

// fix-cycle-2 (F9) — lineage_id is the plugin's stable identity, one per plugin.
const LIN_ENTERPRISE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIN_SINKRA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function validEntry(overrides = {}) {
  return {
    schema_version: "2.0.0",
    plugin_id: "aiox-enterprise",
    lineage_id: LIN_ENTERPRISE,
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

  // fix-cycle-2 (F9): lineage_id is IDENTITY, so "absent" and "malformed" must both be refused —
  // an entry that passes shape validation without one is a plugin whose renames are undetectable.
  test("F9 — rejects a missing lineage_id, and the error says it is identity, not optional metadata", () => {
    const e = validEntry();
    delete e.lineage_id;
    const errs = validateEntryShape(e);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /lineage_id required/);
    assert.match(errs[0], /stable IDENTITY/);
  });

  test("F9 — rejects a lineage_id that is not a canonical lowercase UUID (a human-meaningful value invites renaming it)", () => {
    for (const bad of ["aiox-enterprise", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "not-a-uuid", "1234", ""]) {
      const errs = validateEntryShape(validEntry({ lineage_id: bad }));
      assert.ok(
        errs.some((x) => x.includes("lineage_id required")),
        `expected "${bad}" to be refused as a lineage_id`,
      );
    }
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

describe("checkIdImmutabilityAgainstLedger (check a, story 055.W3.3 + fix-cycle-2/F9 lineage)", () => {
  test("a genuinely unrelated plugin (own lineage, own digest): no errors", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "sinkra-os", lineage_id: LIN_SINKRA, version: "1.0.0", digest: "unrelated-digest", published_at: "t1" });
    assert.deepEqual(checkIdImmutabilityAgainstLedger(ledger, validEntry()), []);
  });

  // ── (a3) digest lineage — retained from the pre-F9 design as the byte-level net ───────────────
  test("(a3) the same digest already recorded under a DIFFERENT plugin_id is REFUSED, naming both ids", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "sinkra-os", lineage_id: LIN_SINKRA, version: "1.0.0", digest: DIGEST, published_at: "t1" });
    const errs = checkIdImmutabilityAgainstLedger(ledger, validEntry({ plugin_id: "aiox-enterprise" }));
    assert.equal(errs.length, 1);
    assert.match(errs[0], /these exact artifact bytes/);
    assert.match(errs[0], /"aiox-enterprise"/);
    assert.match(errs[0], /"sinkra-os"/);
  });

  test("the same digest recorded under the SAME plugin_id's own history is not a self-conflict", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", digest: DIGEST, published_at: "t1" });
    assert.deepEqual(checkIdImmutabilityAgainstLedger(ledger, validEntry({ plugin_id: "aiox-enterprise" })), []);
  });

  // ── (a1) lineage collision — THE F9 FIX: byte-independent rename detection ────────────────────
  test("(a1) F9 — a rename with DIFFERENT bytes (the realistic version-bump rename) is REFUSED on lineage alone", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", digest: DIGEST, published_at: "t1" });
    // renamed AND rebuilt: a brand-new digest, so nothing digest-based could connect the two
    const renamed = validEntry({
      plugin_id: "aiox-enterprise-renamed",
      lineage_id: LIN_ENTERPRISE,
      version: "1.1.0",
      digest: { algorithm: "sha256", value: "f".repeat(64) },
      artifact: {
        mirror_url: `https://${GOOD_HOST}/plugins/aiox-enterprise-renamed/1.1.0/x.tar.gz`,
        r2_key: `plugins/aiox-enterprise-renamed/1.1.0/x.tar.gz`,
      },
    });
    const errs = checkIdImmutabilityAgainstLedger(ledger, renamed);
    assert.equal(errs.length, 1, "exactly the lineage rule fires — the digest rule cannot see this at all");
    assert.match(errs[0], /lineage_id .* is already registered under a DIFFERENT plugin_id/);
    assert.match(errs[0], /"aiox-enterprise"/);
    assert.match(errs[0], /A version bump does NOT make this a different plugin/);

    // and the control: the digest rule alone genuinely cannot see it (this is why F9 existed)
    assert.deepEqual(
      digestsPublishedUnderOtherPluginIds(ledger, "aiox-enterprise-renamed").get("f".repeat(64)),
      undefined,
    );
  });

  test("(a1) F9 — a genuinely new plugin with its OWN lineage and own bytes is accepted (the check is not a blanket refusal)", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", digest: DIGEST, published_at: "t1" });
    const fresh = validEntry({
      plugin_id: "sinkra-os",
      lineage_id: LIN_SINKRA,
      digest: { algorithm: "sha256", value: "e".repeat(64) },
    });
    assert.deepEqual(checkIdImmutabilityAgainstLedger(ledger, fresh), []);
  });

  test("(a1) F9 — a legitimate version bump of the SAME plugin (same lineage, same id, new bytes) is accepted", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", digest: DIGEST, published_at: "t1" });
    const bumped = validEntry({ version: "1.1.0", digest: { algorithm: "sha256", value: "c".repeat(64) } });
    assert.deepEqual(checkIdImmutabilityAgainstLedger(ledger, bumped), []);
  });

  // ── (a2) lineage stability — closes the two-step evasion ──────────────────────────────────────
  test("(a2) F9 — an existing plugin_id declaring a DIFFERENT lineage_id is REFUSED (no relabelling one's own identity)", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", digest: DIGEST, published_at: "t1" });
    const relabelled = validEntry({
      lineage_id: LIN_SINKRA,
      version: "1.1.0",
      digest: { algorithm: "sha256", value: "d".repeat(64) },
    });
    const errs = checkIdImmutabilityAgainstLedger(ledger, relabelled);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /is on record with lineage_id/);
    assert.match(errs[0], /set once at its first publish and never changes/);
  });

  test("F9 — (a1) and (a3) are INDEPENDENT nets: forging a fresh lineage but shipping identical bytes is still caught", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", digest: DIGEST, published_at: "t1" });
    const forged = validEntry({
      plugin_id: "aiox-enterprise-renamed",
      lineage_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", // freshly minted to dodge (a1)
      artifact: {
        mirror_url: `https://${GOOD_HOST}/plugins/aiox-enterprise-renamed/1.0.0/x.tar.gz`,
        r2_key: `plugins/aiox-enterprise-renamed/1.0.0/x.tar.gz`,
      },
    }); // same DIGEST as the original
    const errs = checkIdImmutabilityAgainstLedger(ledger, forged);
    assert.equal(errs.length, 1, "(a1) is dodged but (a3) still fires — that is the point of keeping both");
    assert.match(errs[0], /these exact artifact bytes/);
  });
});

describe("checkNameNotBurned (check b, story 055.W3.3 — the registry survives entry removal, VC-1)", () => {
  test("an active (never retired) plugin_id: no errors", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", digest: DIGEST, published_at: "t1" });
    assert.deepEqual(checkNameNotBurned(ledger, validEntry()), []);
  });

  test("a retired plugin_id is REFUSED, naming when it was retired", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", digest: DIGEST, published_at: "t1" });
    retirePlugin(ledger, { plugin_id: "aiox-enterprise", reason: "spam", retired_at: "t9" });
    const errs = checkNameNotBurned(ledger, validEntry());
    assert.equal(errs.length, 1);
    assert.match(errs[0], /retired at t9/);
    assert.match(errs[0], /burned forever/);
  });

  test("a plugin_id the ledger has never heard of: no errors (not every publish is a retirement attempt)", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    assert.deepEqual(checkNameNotBurned(ledger, validEntry()), []);
  });
});

describe("checkTierVocabulary (check d / AC8, story 055.W3.3, publish-time half of D21, VC-5)", () => {
  test("emitting exactly the manifest's declared vocabulary: no errors", () => {
    assert.deepEqual(checkTierVocabulary(["mapear", "forjar"], ["mapear", "forjar"], "sinkra-os"), []);
  });

  test("emitting a strict subset of the manifest's vocabulary: no errors", () => {
    assert.deepEqual(checkTierVocabulary(["mapear"], ["mapear", "forjar"], "sinkra-os"), []);
  });

  test("emitting a tier NOT in the manifest's vocabulary is REFUSED, naming the invalid tier AND the valid ones", () => {
    const errs = checkTierVocabulary(["forjarr"], ["mapear", "forjar"], "sinkra-os");
    assert.equal(errs.length, 1);
    assert.match(errs[0], /"forjarr"/);
    assert.match(errs[0], /"mapear"/);
    assert.match(errs[0], /"forjar"/);
  });

  test("a manifest with an empty tier vocabulary refuses any emitted tier, and says so explicitly", () => {
    const errs = checkTierVocabulary(["base"], [], "x");
    assert.match(errs[0], /manifest declares no tiers/);
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
