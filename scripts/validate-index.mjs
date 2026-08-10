#!/usr/bin/env node
// scripts/validate-index.mjs — CI base check (structural, dependency-free).
//
// Imports the SAME validation publisher/publish.mjs applies at write time (lib/entry-schema.mjs),
// re-run over a whole index file so CI catches a hand-edit that bypassed the pipeline entirely, or
// drift between the schema doc and the data. This file is deliberately just the base structural +
// identity-binding gate — it does NOT itself run id-immutability/burned-name/license checks.
//
// fix-cycle-1 (QG round 1, F7 — this comment was stale): the D24 invariant suite (id-immutability
// history, burned-name ledger, license-in-package-root) and D21's publish-time tier check landed in
// story 055.W3.3, but wired into SEPARATE scripts (scripts/check-ledger-append-only.mjs,
// scripts/check-ledger-consistency.mjs) and publisher/publish.mjs — not into this file. The same is
// now true of the two D20 controls that were future work when this comment was first written:
// capability analysis (D20(4), story 055.W4.2 — lib/capability-analyzer.mjs +
// scripts/analyze-capabilities.mjs) and BLOCKING secret scanning (D20(1), story 055.W4.1 —
// lib/secret-scanner.mjs + scripts/scan-secrets.mjs, gating inside publisher/publish.mjs). Both
// operate on an ARTIFACT's bytes, which this file never has: it validates an index FILE. Neither is
// wired here, and that is by construction, not omission.
//
// fix-cycle-1 (055.W3.1 QG @architect, F-AC6-ARTIFACT-BINDING): now also runs checkArtifactBinding
// per entry (imported, not reimplemented) so a hand-edited index that skips publish.mjs can't slip
// an artifact pointing at a DIFFERENT plugin's path past CI either.
//
// fix-cycle-2 (F-BINDING-NO-HOST-ALLOWLIST): also runs checkArtifactHost per entry.
//
// fix-cycle-2 (closing QG gate 4, zero-tests finding): `validateIndexData` is exported as a pure
// function (parsed object in, error strings out — no file I/O) precisely so test/validate-index.test.mjs
// can exercise it directly without touching disk. `validateFile` (below) is the thin CLI wrapper.

import { readFileSync } from "node:fs";
import { ENTRY_SCHEMA_VERSION, validateEntryShape, checkArtifactBinding, checkArtifactHost } from "../lib/entry-schema.mjs";

export function validateIndexData(data, label) {
  const errors = [];
  if (data.schema_version !== ENTRY_SCHEMA_VERSION)
    errors.push(`${label}: top-level schema_version must be '${ENTRY_SCHEMA_VERSION}'`);
  if (!Array.isArray(data.entries)) {
    errors.push(`${label}: entries must be an array`);
    return errors;
  }

  for (const [i, e] of data.entries.entries()) {
    const tag = `${label} entries[${i}] (${e.plugin_id ?? "?"})`;
    for (const err of validateEntryShape(e)) errors.push(`${tag}: ${err}`);
    for (const err of checkArtifactBinding(e)) errors.push(`${tag}: ${err}`);
    for (const err of checkArtifactHost(e)) errors.push(`${tag}: ${err}`);
  }

  // D24(a)/(b) base guard, replicated here so a hand-edit can't bypass what publish.mjs enforces:
  // no two entries with the same plugin_id+version but different digests.
  const seen = new Map();
  for (const e of data.entries) {
    const key = `${e.plugin_id}@${e.version}`;
    if (seen.has(key) && seen.get(key) !== e.digest?.value) {
      errors.push(`${label}: duplicate ${key} with conflicting digest — D24 immutability violated`);
    }
    seen.set(key, e.digest?.value);
  }

  // fix-cycle-2 (F9): the same guard for lineage, INSIDE a single index file. checkIdImmutability-
  // AgainstLedger catches a lineage collision against the LEDGER; this catches one that is visible
  // in the index alone — two entries sharing a lineage_id under different plugin_ids, i.e. a rename
  // sitting in plain sight. Both halves matter: a hand-edit could add both entries at once without
  // ever touching the ledger, and then the ledger-side check would have nothing to compare against.
  // Conversely, a lineage_id must stay pinned to ONE plugin_id, so the reverse mapping is checked
  // too rather than assumed.
  const lineageOwner = new Map();
  for (const e of data.entries) {
    if (!e.lineage_id) continue; // absence is already a shape error, reported above
    const owner = lineageOwner.get(e.lineage_id);
    if (owner && owner !== e.plugin_id) {
      errors.push(
        `${label}: lineage_id ${e.lineage_id} appears under two different plugin_ids ("${owner}" and "${e.plugin_id}") — the same plugin cannot change its immutable namespace root (D24(a), F9)`,
      );
    }
    lineageOwner.set(e.lineage_id, e.plugin_id);
  }

  const pluginLineage = new Map();
  for (const e of data.entries) {
    if (!e.lineage_id) continue;
    const known = pluginLineage.get(e.plugin_id);
    if (known && known !== e.lineage_id) {
      errors.push(
        `${label}: plugin_id "${e.plugin_id}" appears with two different lineage_ids (${known} and ${e.lineage_id}) — a plugin's lineage is set once and never rewritten (D24(a), F9)`,
      );
    }
    pluginLineage.set(e.plugin_id, e.lineage_id);
  }
  return errors;
}

function validateFile(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  return validateIndexData(data, path);
}

// Only run the CLI when this file is executed directly (`node scripts/validate-index.mjs ...`),
// not when test/validate-index.test.mjs imports validateIndexData/validateFile from it.
const isMain = process.argv[1] && process.argv[1].endsWith("validate-index.mjs");
if (isMain) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: node scripts/validate-index.mjs <index.json> [more.json ...]");
    process.exit(1);
  }

  let allErrors = [];
  for (const t of targets) {
    allErrors = allErrors.concat(validateFile(t));
  }

  if (allErrors.length) {
    console.error(`FAIL — ${allErrors.length} violation(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`OK — ${targets.length} file(s) validated, 0 violations`);
}

export { validateFile };
