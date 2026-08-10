#!/usr/bin/env node
// scripts/scan-secrets.mjs — story 055.W4.1 (D20(1)). The standalone CLI for the same scanner
// publisher/publish.mjs runs as a blocking gate (lib/secret-scanner.mjs — imported, never
// reimplemented, so the CI-time and publish-time behaviours cannot drift apart).
//
// Two inputs, either or both:
//   --artifact <file.tar.gz>   scan a plugin artifact's real bytes
//   --manifest <file.json>     scan a publish manifest as raw text
//
// Exit 1 on any finding, 0 otherwise. `--json` emits the machine-readable report (which carries the
// `limits` array — the blind spots travel with the result by construction, in every output mode).

import { existsSync } from "node:fs";
import { scanArtifact, scanManifestFile, renderScanReport } from "../lib/secret-scanner.mjs";

function usageAndExit(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: node scripts/scan-secrets.mjs [--artifact <file.tar.gz>] [--manifest <file.json>] [--json]");
  process.exit(2);
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--json") { args.json = true; continue; }
  if (!a.startsWith("--")) continue;
  args[a.slice(2)] = process.argv[++i];
}

if (!args.artifact && !args.manifest) usageAndExit("at least one of --artifact / --manifest is required");
for (const k of ["artifact", "manifest"]) {
  if (args[k] && !existsSync(args[k])) usageAndExit(`--${k} ${args[k]} does not exist`);
}

const reports = [];
if (args.manifest) reports.push(scanManifestFile(args.manifest));
if (args.artifact) reports.push(scanArtifact(args.artifact));

const findings = reports.flatMap((r) => r.findings);

if (args.json) {
  console.log(JSON.stringify({ reports, findings_total: findings.length }, null, 2));
} else {
  for (const r of reports) console.log(renderScanReport(r));
}

if (findings.length) {
  console.error(`\nREFUSED — ${findings.length} credential(s) found (BLOCKING, D20(1)/AC1)`);
  process.exit(1);
}
console.error("\nOK — no credential of any covered class found (read the limits above before reading this as a safety verdict)");
