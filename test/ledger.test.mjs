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
import { loadLedger, saveLedger, recordPublish, retirePlugin, digestsPublishedUnderOtherPluginIds, EMPTY_LEDGER } from "../lib/ledger.mjs";
import { checkAppendOnlySequence } from "../scripts/check-ledger-append-only.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appendOnlyScript = join(here, "..", "scripts", "check-ledger-append-only.mjs");

describe("lib/ledger.mjs — write helpers", () => {
  test("recordPublish creates a new record on first sight", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", version: "1.0.0", digest: "d1", published_at: "t1" });
    assert.equal(ledger.plugins.x.status, "active");
    assert.equal(ledger.plugins.x.first_published_at, "t1");
    assert.deepEqual(ledger.plugins.x.history, [{ version: "1.0.0", digest: "d1", published_at: "t1" }]);
  });

  test("recordPublish appends (never replaces) history for an existing plugin_id", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", version: "1.0.0", digest: "d1", published_at: "t1" });
    recordPublish(ledger, { plugin_id: "x", version: "1.1.0", digest: "d2", published_at: "t2" });
    assert.equal(ledger.plugins.x.history.length, 2);
    assert.equal(ledger.plugins.x.first_published_at, "t1", "first_published_at must not change on a later publish");
  });

  test("retirePlugin flips status and records reason/timestamp", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", version: "1.0.0", digest: "d1", published_at: "t1" });
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
    recordPublish(ledger, { plugin_id: "x", version: "1.0.0", digest: "d1", published_at: "t1" });
    retirePlugin(ledger, { plugin_id: "x", reason: "a", retired_at: "t9" });
    assert.throws(() => retirePlugin(ledger, { plugin_id: "x", reason: "b", retired_at: "t10" }), /already retired/);
  });

  test("recordPublish throws when the record is already retired (fix-cycle-1, F3 — self-defense, not caller-only discipline)", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", version: "1.0.0", digest: "d1", published_at: "t1" });
    retirePlugin(ledger, { plugin_id: "x", reason: "gone", retired_at: "t9" });
    assert.throws(
      () => recordPublish(ledger, { plugin_id: "x", version: "2.0.0", digest: "d2", published_at: "t10" }),
      /it was retired at t9/,
    );
    assert.equal(ledger.plugins.x.history.length, 1, "the refused call must not have appended anything");
  });

  test("digestsPublishedUnderOtherPluginIds excludes the given plugin_id and maps digest -> owner", () => {
    const ledger = structuredClone(EMPTY_LEDGER);
    recordPublish(ledger, { plugin_id: "x", version: "1.0.0", digest: "shared", published_at: "t1" });
    recordPublish(ledger, { plugin_id: "y", version: "1.0.0", digest: "other", published_at: "t2" });
    const map = digestsPublishedUnderOtherPluginIds(ledger, "y");
    assert.equal(map.get("shared"), "x");
    assert.equal(map.has("other"), false, "y's own digest must be excluded when checking against y");
  });

  test("loadLedger/saveLedger round-trip through a real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-ledger-test-"));
    try {
      const path = join(dir, "ledger.json");
      const ledger = structuredClone(EMPTY_LEDGER);
      recordPublish(ledger, { plugin_id: "x", version: "1.0.0", digest: "d1", published_at: "t1" });
      saveLedger(path, ledger);
      const reloaded = loadLedger(path);
      assert.deepEqual(reloaded.plugins.x.history, [{ version: "1.0.0", digest: "d1", published_at: "t1" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  const v1 = { plugins: { x: { status: "active", first_published_at: "t1", retired_at: null, retired_reason: null, history: [{ version: "1.0.0", digest: "d1", published_at: "t1" }] } } };

  test("a pure-growth sequence (new key added, history appended) is clean", () => {
    const v2 = { plugins: { ...v1.plugins, y: { status: "active", first_published_at: "t2", retired_at: null, retired_reason: null, history: [{ version: "1.0.0", digest: "d2", published_at: "t2" }] } } };
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
      writeFileSync(ledgerPath, JSON.stringify({ schema_version: "1.0.0", plugins: { x: { status: "active", first_published_at: "t1", retired_at: null, retired_reason: null, history: [{ version: "1.0.0", digest: "d1", published_at: "t1" }] } } }, null, 2));
      git(dir, ["add", "ledger.json"]);
      git(dir, ["commit", "-q", "-m", "c1: add x"]);

      // c2: regress by deleting plugin_id "x" entirely — exactly the mutation VC-1 exists to catch
      writeFileSync(ledgerPath, JSON.stringify({ schema_version: "1.0.0", plugins: {} }, null, 2));
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
        writeFileSync(p2, JSON.stringify({ schema_version: "1.0.0", plugins: {} }, null, 2));
        git(dirGood, ["add", "ledger.json"]);
        git(dirGood, ["commit", "-q", "-m", "c1: empty"]);
        writeFileSync(p2, JSON.stringify({ schema_version: "1.0.0", plugins: { x: { status: "active", first_published_at: "t1", retired_at: null, retired_reason: null, history: [{ version: "1.0.0", digest: "d1", published_at: "t1" }] } } }, null, 2));
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
        JSON.stringify({ schema_version: "1.0.0", plugins: { x: { status: "active", first_published_at: "t1", retired_at: null, retired_reason: null, history: [{ version: "1.0.0", digest: "d1", published_at: "t1" }] } } }, null, 2),
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
