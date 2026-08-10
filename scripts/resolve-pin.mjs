#!/usr/bin/env node
// scripts/resolve-pin.mjs — story 055.W4.1 (D20(2)). Resolves `<plugin_id>@<version>` against an
// index to the artifact's DIGEST, and optionally verifies local bytes against it.
//
//   --index <index.json>          the index to resolve against (required)
//   --pin <plugin_id@version>     the pin (required)
//   --verify <local-file.tar.gz>  recompute sha256 of these bytes and compare to the resolved digest
//   --json                        machine-readable output (carries `pin_cost` — see below)
//
// Exit 0 when the pin resolves (and, with --verify, when the bytes match); non-zero otherwise.
//
// EVERY output mode carries the pin's COST (AC6): pinning freezes an install, which also means an
// already-installed artifact CANNOT BE REPAIRED by a later corrected build — the capability that
// index freshness (story 055.W5.1, D20(5)) is what gives back. Printing the benefit without the cost
// is the exact miscommunication advisory-council finding C4 measured, so the CLI cannot do it.

import { readFileSync, existsSync } from "node:fs";
import { resolvePin, verifyBytesAgainstPin, renderResolution } from "../lib/pin.mjs";

function usageAndExit(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: node scripts/resolve-pin.mjs --index <index.json> --pin <plugin_id@version> [--verify <file.tar.gz>] [--json]");
  process.exit(2);
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--json") { args.json = true; continue; }
  if (!a.startsWith("--")) continue;
  args[a.slice(2)] = process.argv[++i];
}

if (!args.index) usageAndExit("--index is required");
if (!args.pin) usageAndExit("--pin is required");
if (!existsSync(args.index)) usageAndExit(`--index ${args.index} does not exist`);

let resolved;
try {
  resolved = resolvePin(JSON.parse(readFileSync(args.index, "utf8")), args.pin);
} catch (e) {
  console.error(`REFUSED — ${e.message}`);
  process.exit(1);
}

let verification = null;
if (args.verify) {
  if (!existsSync(args.verify)) usageAndExit(`--verify ${args.verify} does not exist`);
  verification = verifyBytesAgainstPin(resolved, args.verify);
}

if (args.json) {
  console.log(JSON.stringify({ resolved, verification }, null, 2));
} else {
  console.log(renderResolution(resolved));
  if (verification) {
    console.log("");
    console.log(`verify         ${verification.path}`);
    console.log(`  expected     ${verification.expected}`);
    console.log(`  actual       ${verification.actual}`);
    console.log(`  result       ${verification.ok ? "MATCH — same pin, same digest, same bytes" : "MISMATCH"}`);
  }
}

if (verification && !verification.ok) {
  console.error("REFUSED — the bytes do not match the digest this pin resolves to");
  process.exit(1);
}
