#!/usr/bin/env node
// scripts/analyze-capabilities.mjs — story 055.W4.2, D17 + D20(4).
//
// Runs the static capability analyzer (lib/capability-analyzer.mjs) over either a plugin ARTIFACT
// (.tar.gz — the publish-time / CI input) or a DIRECTORY of skills (the shape a SOT skills tree
// has). Same analyzer either way: the input adapter differs, the derivation does not, so the
// numbers a maintainer reproduces over a directory are the numbers the publish path computes over
// a tarball.
//
// v1 is WARN-AND-DISPLAY (D17): this exits 0 even when it finds capabilities. `--strict` opts into
// the blocking path that exists for "when opening to externals". AC1 (`allowed-tools` mandatory)
// is a SEPARATE, always-blocking check at publish time — see publisher/publish.mjs.
//
// usage:
//   node scripts/analyze-capabilities.mjs --artifact <plugin.tar.gz> [--json] [--strict]
//   node scripts/analyze-capabilities.mjs --dir <skills-dir>        [--json] [--strict]

import {
  analyzeSkills,
  collectSkillsFromDir,
  collectSkillsFromTarball,
  renderCapabilityReport,
  checkAllowedToolsDeclared,
  capabilityFindingsAreBlocking,
} from "../lib/capability-analyzer.mjs";

function usageAndExit(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: node scripts/analyze-capabilities.mjs (--artifact <file.tar.gz> | --dir <skills-dir>) [--json] [--strict] [--require-allowed-tools]");
  process.exit(1);
}

const argv = process.argv.slice(2);
const args = { json: argv.includes("--json"), strict: argv.includes("--strict"), requireAllowedTools: argv.includes("--require-allowed-tools") };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--artifact") args.artifact = argv[++i];
  if (argv[i] === "--dir") args.dir = argv[++i];
}
if (!args.artifact && !args.dir) usageAndExit("one of --artifact / --dir is required");
if (args.artifact && args.dir) usageAndExit("--artifact and --dir are mutually exclusive");

let collected;
try {
  collected = args.artifact ? collectSkillsFromTarball(args.artifact) : collectSkillsFromDir(args.dir);
} catch (e) {
  console.error(`error: could not read the input: ${e.message}`);
  process.exit(2);
}

if (collected.skills.length === 0) {
  console.error("error: no SKILL.md found in the input — nothing to analyze (this is a defect in the input, not a clean result)");
  process.exit(2);
}

const report = analyzeSkills(collected.skills, collected.files);

console.log(args.json ? JSON.stringify(report, null, 2) : renderCapabilityReport(report));

// AC1 as an explicit, opt-in gate for the directory/CI path (at publish time it is unconditional).
if (args.requireAllowedTools) {
  const errors = checkAllowedToolsDeclared(collected.skills);
  if (errors.length) {
    console.error("\nREFUSED — `allowed-tools` is mandatory (D17/AC1):");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.error(`\nOK — all ${collected.skills.length} skill(s) declare \`allowed-tools\``);
}

if (capabilityFindingsAreBlocking(args.strict || undefined) && report.union_capabilities.length) {
  console.error("\nREFUSED — capability findings are blocking under --strict (the D17 path reserved for opening to externals)");
  process.exit(1);
}
