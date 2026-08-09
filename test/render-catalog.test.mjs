// test/render-catalog.test.mjs — fix-cycle-2 (closes QG gate 4). Covers escapeMd() (F-CR-PLUGINS-5,
// fix-cycle-1) neutralizing HTML/Markdown/fake-heading/table-pipe injection, and that the AC9 shadow
// warning stays legible for benign input (the exact thing @architect's fix-cycle-1 re-review checked
// by hand, now pinned as a regression test).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { escapeMd, renderCatalog } from "../scripts/render-catalog.mjs";

describe("escapeMd", () => {
  test("null/undefined become empty string, not the literal word 'null'/'undefined'", () => {
    assert.equal(escapeMd(null), "");
    assert.equal(escapeMd(undefined), "");
  });

  test("HTML special characters are entity-escaped, ampersand first (no double-escaping)", () => {
    assert.equal(escapeMd("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
    assert.equal(escapeMd("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  });

  test("Markdown control characters are backslash-escaped", () => {
    assert.equal(escapeMd("`code`"), "\\`code\\`");
    assert.equal(escapeMd("*bold*"), "\\*bold\\*");
    assert.equal(escapeMd("_em_"), "\\_em\\_");
    assert.equal(escapeMd("[link](url)"), "\\[link\\](url)");
    assert.equal(escapeMd("| a | b |"), "\\| a \\| b \\|");
  });

  test("embedded newlines collapse to a visible inline placeholder — never a literal line break", () => {
    const out = escapeMd("line one\n# FAKE HEADING\nline three");
    assert.ok(!out.includes("\n"), "no raw newline must survive");
    assert.ok(out.includes(" ⏎ "));
  });

  test("plain benign text passes through with NO visible escape artifacts (AC9 legibility)", () => {
    assert.equal(escapeMd("the Enterprise pack's own /review — declared, not accidental"),
      "the Enterprise pack's own /review — declared, not accidental");
  });
});

const DIGEST = "9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a";
const MIRROR = `https://pub-42179e62dc3040138151ec33229dd073.r2.dev/plugins-fixtures/sinkra-os/0.0.0-fixture/${DIGEST}.tar.gz`;

function entry(overrides = {}) {
  return {
    schema_version: "1.0.0",
    plugin_id: "sinkra-os",
    name: "SINKRA OS (fixture)",
    description: "fixture entry",
    version: "0.0.0-fixture",
    tiers: ["mapear", "forjar"],
    digest: { algorithm: "sha256", value: DIGEST },
    artifact: { mirror_url: MIRROR, r2_key: "plugins-fixtures/sinkra-os/0.0.0-fixture/x.tar.gz" },
    publisher: { subject: "acct_test" },
    published_at: "2026-08-09T00:00:00.000Z",
    license: { spdx_or_path: "MIT" },
    ...overrides,
  };
}

describe("renderCatalog", () => {
  test("an empty index renders the explicit 'no entries yet' line (AC9 negative surface)", () => {
    const out = renderCatalog({ entries: [], generated_at: null }, "index.json");
    assert.match(out, /No entries yet\./);
  });

  test("AC9 positive case: a declared shadow renders a VISIBLE warning with the mandatory reason", () => {
    const idx = { entries: [entry({ overlay: { shadows: { review: "the Enterprise pack's own /review" } } })], generated_at: "x" };
    const out = renderCatalog(idx, "fixtures/index.json");
    assert.match(out, /⚠ DECLARED SHADOW/);
    assert.match(out, /the Enterprise pack's own \/review/);
  });

  test("AC9 negative case: an entry with NO overlay.shadows renders with zero shadow warning", () => {
    const idx = { entries: [entry()], generated_at: "x" };
    const out = renderCatalog(idx, "fixtures/index.json");
    assert.doesNotMatch(out, /DECLARED SHADOW/);
  });

  test("hostile manifest fields render as INERT literal text — no raw HTML tag survives", () => {
    const idx = {
      entries: [
        entry({
          name: "Acme *Hostile* <b>Fixture</b>\n# FAKE HEADING",
          description: "…<script>alert(1)</script>… | x | y |",
          license: { spdx_or_path: "MIT` `injected <img src=x onerror=alert(1)>" },
          overlay: { shadows: { review: "`code`, <img src=x onerror=alert(1)>, a ] ( break ) attempt\nand a newline" } },
        }),
      ],
      generated_at: "x",
    };
    const out = renderCatalog(idx, "fixtures/index.json");

    assert.doesNotMatch(out, /<script/i, "no raw <script> tag must survive");
    assert.doesNotMatch(out, /<img/i, "no raw <img> tag must survive");
    assert.doesNotMatch(out, /^# FAKE HEADING$/m, "no fake top-level heading LINE must survive (inline collapse is fine)");
    assert.doesNotMatch(out, /^\|.*\|$/m, "no injected table row must survive as its own line");
    // the payload is still PRESENT, just neutralized — this proves escaping, not silent deletion
    assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});
