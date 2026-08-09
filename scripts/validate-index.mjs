#!/usr/bin/env node
// scripts/validate-index.mjs — CI base check (structural, dependency-free).
//
// Imports the SAME validation publisher/publish.mjs applies at write time (lib/entry-schema.mjs),
// re-run over a whole index file so CI catches a hand-edit that bypassed the pipeline entirely, or
// drift between the schema doc and the data. The FULL D20/D24 invariant suite (secret scanning,
// capability analysis, id-immutability history, burned-name ledger, license-in-tarball check) is
// story 055.W3.3 / Wave 4 — this is deliberately just the base structural + identity-binding gate
// this story owns.
//
// fix-cycle-1 (055.W3.1 QG @architect, F-AC6-ARTIFACT-BINDING): now also runs checkArtifactBinding
// per entry (imported, not reimplemented) so a hand-edited index that skips publish.mjs can't slip
// an artifact pointing at a DIFFERENT plugin's path past CI either.

import { readFileSync } from "node:fs";
import { validateEntryShape, checkArtifactBinding } from "../lib/entry-schema.mjs";

function validateFile(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const errors = [];
  if (data.schema_version !== "1.0.0") errors.push(`${path}: top-level schema_version must be '1.0.0'`);
  if (!Array.isArray(data.entries)) {
    errors.push(`${path}: entries must be an array`);
    return errors;
  }

  for (const [i, e] of data.entries.entries()) {
    const tag = `${path} entries[${i}] (${e.plugin_id ?? "?"})`;
    for (const err of validateEntryShape(e)) errors.push(`${tag}: ${err}`);
    for (const err of checkArtifactBinding(e)) errors.push(`${tag}: ${err}`);
  }

  // D24(a)/(b) base guard, replicated here so a hand-edit can't bypass what publish.mjs enforces:
  // no two entries with the same plugin_id+version but different digests.
  const seen = new Map();
  for (const e of data.entries) {
    const key = `${e.plugin_id}@${e.version}`;
    if (seen.has(key) && seen.get(key) !== e.digest?.value) {
      errors.push(`${path}: duplicate ${key} with conflicting digest — D24 immutability violated`);
    }
    seen.set(key, e.digest?.value);
  }
  return errors;
}

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
