#!/usr/bin/env node
// scripts/check-ledger-consistency.mjs — story 055.W3.3. CI structural re-check of checks (a)/(b)
// against the PRODUCTION index (index/index.json) ONLY.
//
// Deliberately scoped to production, not fixtures/index.json: fixtures/ is explicitly non-
// production test data (fixtures/README.md) whose 055.W3.1 entries predate this story's ledger
// entirely — they were published before checks (a)-(d) or the ledger itself existed, so they were
// never ledger-recorded and re-checking them here would fail for a reason that has nothing to do
// with a real invariant violation. index/index.json (what D24 actually protects — the file a real
// install pins) ships empty in this story too (the hard boundary: no real plugin publication is
// authorized here), so this check runs for real against real data and trivially passes today; it
// stops being trivial the moment the first real entry lands.
//
// What this re-proves, independent of publish.mjs having already checked it once at publish time: a
// hand-edit of index/index.json that bypasses publisher/publish.mjs entirely (adds/changes an entry
// without ever invoking publish.mjs) would skip checkIdImmutabilityAgainstLedger and
// checkNameNotBurned too. This script re-derives the same two checks purely from what's committed
// on disk (the index + the ledger), so CI catches that class of bypass on every push — though not
// exhaustively: VC-6 names the remaining platform-level gap (no distinct service push identity yet,
// so a human collaborator with write access could still hand-edit and push before CI runs).

import { readFileSync } from "node:fs";
import { loadLedger } from "../lib/ledger.mjs";
import { checkIdImmutabilityAgainstLedger, checkNameNotBurned } from "../lib/entry-schema.mjs";

export function checkIndexAgainstLedger(indexData, ledger) {
  const errors = [];
  for (const entry of indexData.entries ?? []) {
    for (const err of checkIdImmutabilityAgainstLedger(ledger, entry)) errors.push(err);
    for (const err of checkNameNotBurned(ledger, entry)) errors.push(err);
  }
  return errors;
}

const isMain = process.argv[1] && process.argv[1].endsWith("check-ledger-consistency.mjs");
if (isMain) {
  const indexPath = process.argv[2] || "index/index.json";
  const ledgerPath = process.argv[3] || "ledger/plugin-ids.json";
  const indexData = JSON.parse(readFileSync(indexPath, "utf8"));
  const ledger = loadLedger(ledgerPath);
  const errors = checkIndexAgainstLedger(indexData, ledger);
  if (errors.length) {
    console.error(`FAIL — ${errors.length} ledger-consistency violation(s) in ${indexPath}:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`OK — ${indexPath} is consistent with ${ledgerPath} (0 violations)`);
}
