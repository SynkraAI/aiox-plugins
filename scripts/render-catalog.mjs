#!/usr/bin/env node
// scripts/render-catalog.mjs — the CATALOG SURFACE (AC9 of story 055.W3.1).
//
// Renders an index.json into a human-readable page. The one thing this script exists to prove:
// a plugin that declares `overlay.shadows` shows that fact — and its mandatory reason — VISIBLY
// on its own catalog entry (D23's literal words, "aviso visível na entrada do catálogo"), never
// buried in a boot log the way the pre-D23 sync.mjs collision counter was. A plugin with no
// declared shadow renders with no such warning at all (the negative case).
//
// This is a RENDERER, not a new data source: the `overlay.shadows` block it reads is the exact
// same contract already defined and enforced in the product repo's
// .aiox-core/sync/OVERLAY-MANIFEST.md (story 055.W2.2) — this script only displays it.
//
// fix-cycle-1 (055.W3.1 QG @architect, F-CR-PLUGINS-5): every manifest-controlled field is now
// passed through escapeMd() before interpolation. Zero blast radius existed when this was flagged
// (only 2 self-authored fixtures), but the moment a real third-party manifest reaches this exact
// script it becomes real — HTML/script injection and Markdown-structure-breaking (fake headings,
// broken tables/blockquotes via embedded newlines or unescaped `|`/backticks) are both closed.
// Proven with an adversarial fixture — see fixtures/README.md "Adversarial fixture" section.
//
// fix-cycle-2 (closing QG gate 4, zero-tests finding): `escapeMd` and `renderCatalog` are now
// exported as pure functions (no file I/O) precisely so test/render-catalog.test.mjs can exercise
// them directly. The CLI block at the bottom is the only part that touches disk.

import { readFileSync, writeFileSync } from "node:fs";

// Escapes a single untrusted field for safe interpolation into generated Markdown:
//  - HTML-escapes &, <, > so raw HTML (e.g. <script>, <img onerror=...>) never parses as HTML if
//    this Markdown is later rendered to HTML by anything downstream.
//  - Backslash-escapes Markdown control characters (`, *, _, [, ], |) so a hostile string can't
//    reopen/replace an emphasis run, a link, or break a table cell.
//  - Collapses embedded newlines to a visible placeholder so a hostile field can't inject a fake
//    heading (`# ...`), a fake blockquote line, or otherwise escape the single line it was meant
//    to occupy.
export function escapeMd(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, " ⏎ ");
}

// Pure: index.json's parsed contents in, the full rendered Markdown page out. `label` is only
// used in the page's own title line (e.g. the source path), never read from disk here.
export function renderCatalog(index, label) {
  const lines = [];
  lines.push(`# Catalog — rendered from \`${label}\``);
  lines.push("");
  lines.push(
    `_${index.entries.length} entr${index.entries.length === 1 ? "y" : "ies"}, generated_at: ${index.generated_at ?? "n/a"}_`,
  );
  lines.push("");

  if (index.entries.length === 0) {
    lines.push("_No entries yet._");
  }

  for (const e of index.entries) {
    // plugin_id/version are already KEBAB/SEMVER-constrained by lib/entry-schema.mjs before an
    // entry can ever be written — escaped here too, defensively, in case this renderer is ever
    // pointed at a hand-edited file that skipped that gate.
    lines.push(`## ${escapeMd(e.name ?? e.plugin_id)} — \`${escapeMd(e.plugin_id)}\`@${escapeMd(e.version)}`);
    lines.push("");
    if (e.description) lines.push(escapeMd(e.description));
    lines.push("");
    lines.push(`- Tiers: ${(e.tiers ?? []).map(escapeMd).join(", ")}`);
    lines.push(`- Digest: \`sha256:${escapeMd(e.digest?.value)}\``);
    lines.push(`- Artifact: ${escapeMd(e.artifact?.mirror_url)}`);
    lines.push(`- Published by: \`${escapeMd(e.publisher?.subject)}\` at ${escapeMd(e.published_at)}`);
    lines.push(`- License: ${escapeMd(e.license?.spdx_or_path)}`);

    const shadows = e.overlay?.shadows;
    if (shadows && Object.keys(shadows).length > 0) {
      lines.push("");
      lines.push("> **⚠ DECLARED SHADOW** — this plugin replaces the following base skill(s). This is a");
      lines.push("> declared, visible choice (D23), never an accident:");
      lines.push(">");
      for (const [skill, reason] of Object.entries(shadows)) {
        lines.push(`> - \`${escapeMd(skill)}\` — ${escapeMd(reason)}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Only run the CLI when this file is executed directly, not when a test imports escapeMd/renderCatalog.
const isMain = process.argv[1] && process.argv[1].endsWith("render-catalog.mjs");
if (isMain) {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("usage: node scripts/render-catalog.mjs <index.json> <out.md>");
    process.exit(1);
  }

  const index = JSON.parse(readFileSync(inPath, "utf8"));
  const rendered = renderCatalog(index, inPath);
  writeFileSync(outPath, rendered);
  console.log(`wrote ${outPath} (${index.entries.length} entries)`);
}
