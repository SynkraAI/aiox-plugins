#!/usr/bin/env node
// publisher/retire.mjs — story 055.W3.3. The ONLY writer that removes an entry from an index file
// (index/index.json or fixtures/index.json), and the ONLY writer that transitions a ledger record
// to "retired" (D24(b)). Removing the index entry WITHOUT marking the ledger would make check (b)
// (checkNameNotBurned, lib/entry-schema.mjs) decorative the moment the entry disappears — VC-1's
// exact concern. This script always does both in ONE commit, so the two can never drift apart.
//
// Same identity boundary as publish.mjs (see its header comment): this script trusts the caller to
// have already verified the caller's entitlement/authority to retire this plugin_id; it does not
// perform that verification itself.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadLedger, saveLedger, retirePlugin } from "../lib/ledger.mjs";

function usageAndExit(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node publisher/retire.mjs --plugin-id <id> --target <index.json> --ledger <ledger.json> --reason <text> [--no-push]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = { push: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-push") { out.push = false; continue; }
    if (!a.startsWith("--")) continue;
    out[a.slice(2)] = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["plugin-id"]) usageAndExit("--plugin-id is required");
  if (!args.target) usageAndExit("--target is required");
  if (!args.ledger) usageAndExit("--ledger is required");
  if (!args.reason) {
    usageAndExit(
      "--reason is required (D24(b) — a retirement without a recorded reason is a gap for whoever reads the ledger later)",
    );
  }

  if (!existsSync(args.target)) usageAndExit(`--target ${args.target} does not exist`);
  const index = JSON.parse(readFileSync(args.target, "utf8"));
  index.entries ??= [];
  const before = index.entries.length;
  index.entries = index.entries.filter((e) => e.plugin_id !== args["plugin-id"]);
  if (index.entries.length === before) {
    usageAndExit(`plugin_id "${args["plugin-id"]}" has no entry in ${args.target} — nothing to retire there`);
  }

  const ledger = loadLedger(args.ledger);
  try {
    retirePlugin(ledger, {
      plugin_id: args["plugin-id"],
      reason: args.reason,
      retired_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`REFUSED: ${e.message}`);
    process.exit(1);
  }

  index.generated_at = new Date().toISOString();
  writeFileSync(args.target, JSON.stringify(index, null, 2) + "\n");
  saveLedger(args.ledger, ledger);

  console.log(
    `OK — "${args["plugin-id"]}" retired: entry removed from ${args.target}; ledger burned the name permanently (${args.ledger}).`,
  );

  if (args.push) {
    execFileSync("git", ["add", args.target, args.ledger], { stdio: "inherit" });
    execFileSync(
      "git",
      ["commit", "-m", `chore(catalog): retire ${args["plugin-id"]} — name burned permanently (D24(b))`],
      { stdio: "inherit" },
    );
    execFileSync("git", ["push"], { stdio: "inherit" });
  } else {
    console.log("(--no-push: files written, not committed)");
  }
}

main();
