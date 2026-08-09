// test/ledger.test.mjs — story 055.W3.3. Unit coverage for lib/ledger.mjs's pure write helpers,
// plus the pure sequence-checker exported by scripts/check-ledger-append-only.mjs, plus a REAL
// integration proof (temp git repo, actual commits, actual CLI subprocess) that the append-only
// checker script rejects a genuine history regression — the strongest form of AC5 evidence for this
// specific mechanism, since checkAppendOnlySequence alone only proves the pure function is correct,
// not that the CLI wiring (git log/show parsing) actually catches a real mutated commit.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadLedger,
  saveLedger,
  recordPublish,
  retirePlugin,
  digestsPublishedUnderOtherPluginIds,
  lineagesRegisteredUnderOtherPluginIds,
  recordedLineageOf,
  EMPTY_LEDGER,
} from "../lib/ledger.mjs";
import { checkAppendOnlySequence } from "../scripts/check-ledger-append-only.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appendOnlyScript = join(here, "..", "scripts", "check-ledger-append-only.mjs");

// fix-cycle-2 (F9): every ledger record now carries a lineage_id — the plugin's stable identity.
const LIN_X = "11111111-1111-4111-8111-111111111111";
const LIN_Y = "22222222-2222-4222-8222-222222222222";

describe("lib/ledger.mjs — write helpers", () => {
  test("recordPublish creates a new record on first sight", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
    assert.equal(ledger.plugins.x.status, "active");
    assert.equal(ledger.plugins.x.first_published_at, "t1");
    assert.deepEqual(ledger.plugins.x.history, [{ version: "1.0.0", digest: "d1", published_at: "t1" }]);
  });

  test("recordPublish appends (never replaces) history for an existing plugin_id", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.1.0", digest: "d2", published_at: "t2" });
    assert.equal(ledger.plugins.x.history.length, 2);
    assert.equal(ledger.plugins.x.first_published_at, "t1", "first_published_at must not change on a later publish");
  });

  test("retirePlugin flips status and records reason/timestamp", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
    retirePlugin(ledger, { plugin_id: "x", reason: "abandoned", retired_at: "t9" });
    assert.equal(ledger.plugins.x.status, "retired");
    assert.equal(ledger.plugins.x.retired_reason, "abandoned");
  });

  test("retirePlugin throws for a plugin_id that was never published", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    assert.throws(() => retirePlugin(ledger, { plugin_id: "never", reason: "x", retired_at: "t" }), /never been published/);
  });

  test("retirePlugin throws on double-retirement (one-way transition)", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
    retirePlugin(ledger, { plugin_id: "x", reason: "a", retired_at: "t9" });
    assert.throws(() => retirePlugin(ledger, { plugin_id: "x", reason: "b", retired_at: "t10" }), /already retired/);
  });

  test("recordPublish throws when the record is already retired (fix-cycle-1, F3 — self-defense, not caller-only discipline)", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
    retirePlugin(ledger, { plugin_id: "x", reason: "gone", retired_at: "t9" });
    assert.throws(
      () => recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "2.0.0", digest: "d2", published_at: "t10" }),
      /it was retired at t9/,
    );
    assert.equal(ledger.plugins.x.history.length, 1, "the refused call must not have appended anything");
  });

  test("digestsPublishedUnderOtherPluginIds excludes the given plugin_id and maps digest -> owner", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "shared", published_at: "t1" });
    recordPublish(ledger, { plugin_id: "y", lineage_id: LIN_Y, version: "1.0.0", digest: "other", published_at: "t2" });
    const map = digestsPublishedUnderOtherPluginIds(ledger, "y");
    assert.equal(map.get("shared"), "x");
    assert.equal(map.has("other"), false, "y's own digest must be excluded when checking against y");
  });

  test("loadLedger/saveLedger round-trip through a real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-ledger-test-"));
    try {
      const path = join(dir, "ledger.json");
      const ledger = structuredClone(EMPTY_LEDGER);
      recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
      saveLedger(path, ledger);
      const reloaded = loadLedger(path);
      assert.deepEqual(reloaded.plugins.x.history, [{ version: "1.0.0", digest: "d1", published_at: "t1" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── fix-cycle-2 (F9) — lineage_id is the plugin's stable identity ────────────────────────────
  test("F9 — recordPublish stamps lineage_id onto the record at first publish", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
    assert.equal(ledger.plugins.x.lineage_id, LIN_X);
  });

  test("F9 — recordPublish REFUSES a publish with no lineage_id (never defaults/mints one)", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    assert.throws(
      () => recordPublish(ledger, { plugin_id: "x", version: "1.0.0", digest: "d1", published_at: "t1" }),
      /without a lineage_id/,
    );
    assert.deepEqual(ledger.plugins, {}, "the refused call must not have created a record");
  });

  test("F9 — recordPublish REFUSES a later version that declares a DIFFERENT lineage_id (self-defense, mirroring F3)", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
    assert.throws(
      () => recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_Y, version: "1.1.0", digest: "d2", published_at: "t2" }),
      /lineage is set once and never changes/,
    );
    assert.equal(ledger.plugins.x.history.length, 1, "the refused call must not have appended anything");
    assert.equal(ledger.plugins.x.lineage_id, LIN_X, "and must not have rewritten the identity");
  });

  test("F9 — lineagesRegisteredUnderOtherPluginIds excludes the given plugin_id and maps lineage -> owner", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
    recordPublish(ledger, { plugin_id: "y", lineage_id: LIN_Y, version: "1.0.0", digest: "d2", published_at: "t2" });
    const map = lineagesRegisteredUnderOtherPluginIds(ledger, "y");
    assert.equal(map.get(LIN_X), "x");
    assert.equal(map.has(LIN_Y), false, "y's own lineage must be excluded when checking against y");
  });

  test("F9 — recordedLineageOf returns the stored identity, and null for an unknown plugin_id", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
    assert.equal(recordedLineageOf(ledger, "x"), LIN_X);
    assert.equal(recordedLineageOf(ledger, "never-seen"), null);
  });

  test("F9 — a lineage_id survives a version bump untouched (the property digest lineage could not provide)", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.0.0", digest: "d1", published_at: "t1" });
    recordPublish(ledger, { plugin_id: "x", lineage_id: LIN_X, version: "1.1.0", digest: "TOTALLY-DIFFERENT", published_at: "t2" });
    assert.equal(ledger.plugins.x.lineage_id, LIN_X);
    assert.equal(ledger.plugins.x.history.length, 2);
    // the two versions share NO digest — which is exactly why the pre-F9 digest-only check could
    // not connect them, and why a rename at this point used to pass green
    assert.notEqual(ledger.plugins.x.history[0].digest, ledger.plugins.x.history[1].digest);
  });

  test("loadLedger on a nonexistent path returns an empty ledger, not a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-ledger-test-"));
    try {
      const reloaded = loadLedger(join(dir, "does-not-exist.json"));
      assert.deepEqual(reloaded.plugins, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkAppendOnlySequence (pure function, scripts/check-ledger-append-only.mjs)", () => {
  const v1 = { plugins: { x: { lineage_id: LIN_X, status: "active", first_published_at: "t1", retired_at: null, retired_reason: null, history: [{ version: "1.0.0", digest: "d1", published_at: "t1" }] } } };

  test("a pure-growth sequence (new key added, history appended) is clean", () => {
    const v2 = { plugins: { ...v1.plugins, y: { lineage_id: LIN_Y, status: "active", first_published_at: "t2", retired_at: null, retired_reason: null, history: [{ version: "1.0.0", digest: "d2", published_at: "t2" }] } } };
    const v3 = { plugins: { ...v2.plugins, x: { ...v1.plugins.x, history: [...v1.plugins.x.history, { version: "1.1.0", digest: "d1b", published_at: "t3" }] } } };
    const violations = checkAppendOnlySequence([{ label: "c1", data: v1 }, { label: "c2", data: v2 }, { label: "c3", data: v3 }]);
    assert.deepEqual(violations, []);
  });

  test("removing an existing plugin_id key is a violation", () => {
    const v2 = { plugins: {} };
    const violations = checkAppendOnlySequence([{ label: "c1", data: v1 }, { label: "c2", data: v2 }]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /"x" was REMOVED/);
  });

  test("truncating history is a violation", () => {
    const v2 = { plugins: { x: { ...v1.plugins.x, history: [] } } };
    const violations = checkAppendOnlySequence([{ label: "c1", data: v1 }, { label: "c2", data: v2 }]);
    assert.match(violations[0], /history shrank/);
  });

  test("mutating an existing history entry (not truncating, editing) is a violation", () => {
    const v2 = { plugins: { x: { ...v1.plugins.x, history: [{ version: "1.0.0", digest: "TAMPERED", published_at: "t1" }] } } };
    const violations = checkAppendOnlySequence([{ label: "c1", data: v1 }, { label: "c2", data: v2 }]);
    assert.match(violations[0], /history\[0\] was mutated/);
  });

  test("un-retiring a plugin (status retired -> active) is a violation — a burned name can never be reborn", () => {
    const retired = { plugins: { x: { ...v1.plugins.x, status: "retired", retired_at: "t5", retired_reason: "gone" } } };
    const reborn = { plugins: { x: { ...retired.plugins.x, status: "active" } } };
    const violations = checkAppendOnlySequence([{ label: "c1", data: retired }, { label: "c2", data: reborn }]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /can never be reborn/);
  });

  test("changing first_published_at once set is a violation", () => {
    const v2 = { plugins: { x: { ...v1.plugins.x, first_published_at: "TAMPERED" } } };
    const violations = checkAppendOnlySequence([{ label: "c1", data: v1 }, { label: "c2", data: v2 }]);
    assert.match(violations[0], /first_published_at changed/);
  });

  test("fix-cycle-1, F1 — a `null` version (file missing/unparseable) AFTER a version that recorded plugin_id(s) is a violation naming every plugin_id that would be lost", () => {
    const violations = checkAppendOnlySequence([{ label: "c1", data: v1 }, { label: "c2", data: null }]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /missing or unparseable/);
    assert.match(violations[0], /"x"/);
  });

  test("fix-cycle-1, F1 — a `null` version is clean when NOTHING had been recorded yet (nothing to lose)", () => {
    const violations = checkAppendOnlySequence([{ label: "c1", data: null }]);
    assert.deepEqual(violations, []);
  });

  test("fix-cycle-1, F1 — a version restored AFTER a `null` (deletion) is still held to the pre-deletion state, not compared against nothing", () => {
    const restoredButMissingX = { plugins: {} }; // "restores" the file but omits the plugin the deletion erased
    const violations = checkAppendOnlySequence([
      { label: "c1", data: v1 },
      { label: "c2", data: null },
      { label: "c3", data: restoredButMissingX },
    ]);
    // c2 flags the deletion itself; c3 is compared against `prev` (still v1, NOT advanced past the
    // null) and flags "x" missing again — two independent violations, not one swallowed by the other.
    assert.equal(violations.length, 2);
    assert.match(violations[0], /missing or unparseable/);
    assert.match(violations[1], /"x" was REMOVED/);
  });

  test("fix-cycle-2, F9 — rewriting a lineage_id between two commits is a violation naming both values", () => {
    const relabelled = { plugins: { x: { ...v1.plugins.x, lineage_id: LIN_Y } } };
    const violations = checkAppendOnlySequence([{ label: "c1", data: v1 }, { label: "c2", data: relabelled }]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /lineage_id changed/);
    assert.match(violations[0], new RegExp(LIN_X));
    assert.match(violations[0], new RegExp(LIN_Y));
  });

  test("fix-cycle-2, F9 — a record with NO lineage_id at all is a violation (the field cannot be dropped by hand-edit)", () => {
    const stripped = { plugins: { x: { ...v1.plugins.x } } };
    delete stripped.plugins.x.lineage_id;
    const violations = checkAppendOnlySequence([{ label: "c1", data: stripped }]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /has no lineage_id/);
  });

  test("fix-cycle-2, F9 — carrying the SAME lineage_id forward while appending history is clean (the legitimate case)", () => {
    const grown = { plugins: { x: { ...v1.plugins.x, history: [...v1.plugins.x.history, { version: "1.1.0", digest: "d1b", published_at: "t3" }] } } };
    assert.deepEqual(checkAppendOnlySequence([{ label: "c1", data: v1 }, { label: "c2", data: grown }]), []);
  });

  test("fix-cycle-1, F2 — an invented status string (neither active nor retired) is a violation, even without a retired->non-retired transition", () => {
    const invented = { plugins: { x: { ...v1.plugins.x, status: "archived-by-hand-edit" } } };
    // single version, no prior — the per-version enum check must catch this on its own, not only
    // as a pairwise transition (an "active" plugin_id was never involved in any retired->X move).
    const violations = checkAppendOnlySequence([{ label: "c1", data: invented }]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /"x"\.status is "archived-by-hand-edit"/);
    assert.match(violations[0], /must be exactly "active" or "retired"/);
  });
});

describe("scripts/check-ledger-append-only.mjs — REAL git-history integration proof", () => {
  function git(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  test("a genuine 2-commit history where commit 2 deletes an existing plugin_id key is caught by the actual CLI subprocess", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-ledger-git-test-"));
    try {
      git(dir, ["init", "-q", "-b", "main"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "test"]);

      const ledgerPath = join(dir, "ledger.json");
      writeFileSync(ledgerPath, JSON.stringify({ schema_version: "2.0.0", plugins: { x: { lineage_id: LIN_X, status: "active", first_published_at: "t1", retired_at: null, retired_reason: null, history: [{ version: "1.0.0", digest: "d1", published_at: "t1" }] } } }, null, 2));
      git(dir, ["add", "ledger.json"]);
      git(dir, ["commit", "-q", "-m", "c1: add x"]);

      // c2: regress by deleting plugin_id "x" entirely — exactly the mutation VC-1 exists to catch
      writeFileSync(ledgerPath, JSON.stringify({ schema_version: "2.0.0", plugins: {} }, null, 2));
      git(dir, ["add", "ledger.json"]);
      git(dir, ["commit", "-q", "-m", "c2: regress — delete x"]);

      assert.throws(() => {
        execFileSync("node", [appendOnlyScript, "ledger.json"], { cwd: dir, stdio: "pipe" });
      }, /Command failed/);

      // and the GOOD case: a repo that only ever grows must pass, run against the real subprocess too
      const dirGood = mkdtempSync(join(tmpdir(), "aiox-plugins-ledger-git-good-"));
      try {
        git(dirGood, ["init", "-q", "-b", "main"]);
        git(dirGood, ["config", "user.email", "test@example.com"]);
        git(dirGood, ["config", "user.name", "test"]);
        const p2 = join(dirGood, "ledger.json");
        writeFileSync(p2, JSON.stringify({ schema_version: "2.0.0", plugins: {} }, null, 2));
        git(dirGood, ["add", "ledger.json"]);
        git(dirGood, ["commit", "-q", "-m", "c1: empty"]);
        writeFileSync(p2, JSON.stringify({ schema_version: "2.0.0", plugins: { x: { lineage_id: LIN_X, status: "active", first_published_at: "t1", retired_at: null, retired_reason: null, history: [{ version: "1.0.0", digest: "d1", published_at: "t1" }] } } }, null, 2));
        git(dirGood, ["add", "ledger.json"]);
        git(dirGood, ["commit", "-q", "-m", "c2: add x"]);
        const out = execFileSync("node", [appendOnlyScript, "ledger.json"], { cwd: dirGood, encoding: "utf8" });
        assert.match(out, /^OK —/m);
      } finally {
        rmSync(dirGood, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fix-cycle-1, F1 regression — a genuine 2-commit history where commit 2 `git rm`s the ENTIRE ledger file is caught by the actual CLI subprocess (was: silent `OK`, QG round 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-ledger-git-wholefile-"));
    try {
      git(dir, ["init", "-q", "-b", "main"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "test"]);

      const ledgerPath = join(dir, "ledger.json");
      writeFileSync(
        ledgerPath,
        JSON.stringify({ schema_version: "2.0.0", plugins: { x: { lineage_id: LIN_X, status: "active", first_published_at: "t1", retired_at: null, retired_reason: null, history: [{ version: "1.0.0", digest: "d1", published_at: "t1" }] } } }, null, 2),
      );
      git(dir, ["add", "ledger.json"]);
      git(dir, ["commit", "-q", "-m", "c1: add x"]);

      // c2: the QG's exact reproduction — `git rm` the WHOLE file, not just a key inside it
      git(dir, ["rm", "-q", "ledger.json"]);
      git(dir, ["commit", "-q", "-m", "c2: git rm the entire ledger file"]);

      let stdout = "";
      let threw = false;
      try {
        stdout = execFileSync("node", [appendOnlyScript, "ledger.json"], { cwd: dir, encoding: "utf8" });
      } catch (e) {
        threw = true;
        stdout = (e.stdout ?? "").toString();
        assert.match(e.stderr.toString(), /missing or unparseable/);
        assert.match(e.stderr.toString(), /"x"/);
      }
      assert.equal(threw, true, "the subprocess must exit non-zero — before fix-cycle-1 this printed 'OK', exit 0");
      assert.doesNotMatch(stdout, /^OK —/m, "must never print OK when the whole file was deleted after recording a plugin_id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
