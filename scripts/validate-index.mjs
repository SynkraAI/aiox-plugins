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
// scripts/check-ledger-consistency.mjs) and publisher/publish.mjs — not into this file. Secret
// scanning (D20(1)) and capability analysis (D20(4)) genuinely remain future work
// (055.W4.1/055.W4.2), unwired anywhere.
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
import { validateEntryShape, checkArtifactBinding, checkArtifactHost } from "../lib/entry-schema.mjs";

export function validateIndexData(data, label) {
  const errors = [];
  if (data.schema_version !== "1.0.0") errors.push(`${label}: top-level schema_version must be '1.0.0'`);
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
