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

import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node scripts/render-catalog.mjs <index.json> <out.md>");
  process.exit(1);
}

const index = JSON.parse(readFileSync(inPath, "utf8"));
const lines = [];
lines.push(`# Catalog — rendered from \`${inPath}\``);
lines.push("");
lines.push(`_${index.entries.length} entr${index.entries.length === 1 ? "y" : "ies"}, generated_at: ${index.generated_at ?? "n/a"}_`);
lines.push("");

if (index.entries.length === 0) {
  lines.push("_No entries yet._");
}

for (const e of index.entries) {
  lines.push(`## ${e.name ?? e.plugin_id} — \`${e.plugin_id}\`@${e.version}`);
  lines.push("");
  if (e.description) lines.push(`${e.description}`);
  lines.push("");
  lines.push(`- Tiers: ${e.tiers.join(", ")}`);
  lines.push(`- Digest: \`sha256:${e.digest.value}\``);
  lines.push(`- Artifact: ${e.artifact.mirror_url}`);
  lines.push(`- Published by: \`${e.publisher.subject}\` at ${e.published_at}`);
  lines.push(`- License: ${e.license.spdx_or_path}`);

  const shadows = e.overlay?.shadows;
  if (shadows && Object.keys(shadows).length > 0) {
    lines.push("");
    lines.push("> **⚠ DECLARED SHADOW** — this plugin replaces the following base skill(s). This is a");
    lines.push("> declared, visible choice (D23), never an accident:");
    lines.push(">");
    for (const [skill, reason] of Object.entries(shadows)) {
      lines.push(`> - \`${skill}\` — ${reason}`);
    }
  }
  lines.push("");
}

writeFileSync(outPath, lines.join("\n"));
console.log(`wrote ${outPath} (${index.entries.length} entries)`);
