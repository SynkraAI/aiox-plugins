#!/usr/bin/env node
// publisher/publish.mjs — the AIOX-operated publish pipeline (D22).
//
// WHAT THIS IS NOT: a human PR workflow. This script writes the target index file directly and
// commits + pushes with plain git — no GitHub API write call anywhere in this file, and nothing in
// this repository imports the product repo's `aiox-gh` crate (which is read-only by construction,
// AC 8 of that crate — see crates/aiox-gh/src/client.rs:8-9 in the product repo). AC5 of story
// 055.W3.1 is exactly this: the publisher never opens a PR.
//
// IDENTITY: `--subject` is meant to be the entitlement subject (D22) — the same identity that
// proves payment/provisioning; the right to publish is itself an entitlement (D16). This script
// does NOT verify that the caller genuinely holds that subject's entitlement; that
// verification is the CALLER's job (the AIOX service that invokes this script after checking a
// signed token) and is explicitly out of scope here — recording that boundary rather than quietly
// assuming it away. (fix-cycle-1, F-CR-PLUGINS-7: today the actual git push authentication is
// whatever identity is configured on the machine running this script — there is no distinct service
// credential yet. Named, carded, not fixed here — see
// docs/backlog/aiox-plugins-sem-credencial-de-servico-e-branch-protection-parcial.md in the product
// repo.)
//
// SCOPE: structural schema validation + artifact-identity binding + artifact-host allowlist + the
// FULL D24 invariant suite (story 055.W3.3): id-immutability (digest lineage against the
// persistent ledger), burned-name rejection, license-in-package-root, and the publish-time half of
// D21 (tier vocabulary from the plugin's own manifest). All FOUR are BLOCKING — no flag/env var
// disables any of them (AC4/AC6, VC-2/VC-3).
//
// fix-cycle-1 (055.W3.1 QG @architect, F-AC6-ARTIFACT-BINDING): validation now lives in
// lib/entry-schema.mjs, shared with scripts/validate-index.mjs, so publish-time and CI-time checks
// can never drift apart. artifact.r2_key is now REQUIRED (was optional) — it's needed to verify
// identity-binding, and no real entry has ever shipped that would be broken by tightening this.
//
// fix-cycle-2 (F-BINDING-NO-HOST-ALLOWLIST): a correctly plugin_id-namespaced path on a
// COMPLETELY DIFFERENT HOST used to pass every check. checkArtifactHost (lib/entry-schema.mjs)
// now refuses any mirror_url whose host isn't in the single named ALLOWED_ARTIFACT_HOSTS list.
//
// story 055.W3.3 — BREAKING CHANGE from 055.W3.1's shape: `--artifact <local-tarball>` is now
// REQUIRED (was one of two alternatives with `--digest`). Verifying a license is physically inside
// the package root (check c, D24(c)) needs the actual bytes — a digest alone cannot prove what a
// tarball contains. `--digest`, if also passed, is now a CROSS-CHECK against the digest computed
// from `--artifact` (must match, or the publish is refused) rather than an alternative input mode.
// `--emit-tiers <comma,separated,list>` is new and optional (defaults to the manifest's own
// `tiers`, so every pre-055.W3.3 invocation shape keeps working unchanged) — see check (d) below.
// `--ledger <path>` is new and REQUIRED: the persistent, append-only registry (lib/ledger.mjs) that
// checks (a) and (b) read and write.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  validateEntryShape,
  checkArtifactBinding,
  checkArtifactHost,
  checkNoConflictingDuplicate,
  checkIdImmutabilityAgainstLedger,
  checkNameNotBurned,
  checkTierVocabulary,
} from "../lib/entry-schema.mjs";
import { checkLicenseInPackageRoot } from "../lib/license-check.mjs";
import { loadLedger, saveLedger, recordPublish } from "../lib/ledger.mjs";

function usageAndExit(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node publisher/publish.mjs --manifest <path.json> --target <index.json> --ledger <ledger.json> --subject <entitlement-subject> --r2-key <bucket-key> --artifact <local-file.tar.gz> --mirror-url <url> [--digest <sha256-crosscheck>] [--emit-tiers <csv>] [--no-push]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = { push: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-push") { out.push = false; continue; }
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    out[key] = argv[++i];
  }
  return out;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) usageAndExit("--manifest is required");
  if (!args.target) usageAndExit("--target is required");
  if (!args.ledger) usageAndExit("--ledger is required (story 055.W3.3 — checks a/b read+write it)");
  if (!args.subject) usageAndExit("--subject is required (entitlement subject, D22)");
  if (!args["r2-key"]) usageAndExit("--r2-key is required (fix-cycle-1: needed for artifact-identity binding)");
  if (!args.artifact) usageAndExit("--artifact <local-file> is required (story 055.W3.3 — check (c), license-in-package-root, needs the actual bytes; --digest alone can no longer stand in for it)");
  if (!args["mirror-url"]) usageAndExit("--mirror-url is required");

  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));

  const digestFromArtifact = sha256File(args.artifact);
  if (args.digest && args.digest !== digestFromArtifact) {
    console.error(`REFUSED — --digest ${args.digest} does not match the digest computed from --artifact (${digestFromArtifact})`);
    process.exit(1);
  }
  const digestValue = digestFromArtifact;

  const emitTiers = args["emit-tiers"]
    ? args["emit-tiers"].split(",").map((t) => t.trim()).filter(Boolean)
    : manifest.tiers;

  const entry = {
    schema_version: "1.0.0",
    plugin_id: manifest.plugin_id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    tiers: emitTiers,
    digest: { algorithm: "sha256", value: digestValue },
    artifact: { mirror_url: args["mirror-url"], r2_key: args["r2-key"] },
    publisher: { subject: args.subject },
    published_at: new Date().toISOString(),
    license: { spdx_or_path: manifest.license },
    ...(manifest.overlay ? { overlay: manifest.overlay } : {}),
  };

  const ledger = loadLedger(args.ledger);

  const shapeErrs = validateEntryShape(entry);
  const bindingErrs = checkArtifactBinding(entry);
  const hostErrs = checkArtifactHost(entry);
  const tierErrs = checkTierVocabulary(emitTiers, manifest.tiers, manifest.plugin_id);
  const licenseErrs = checkLicenseInPackageRoot(args.artifact);
  const idImmutabilityErrs = checkIdImmutabilityAgainstLedger(ledger, entry);
  const burnedErrs = checkNameNotBurned(ledger, entry);

  const allErrs = [...shapeErrs, ...bindingErrs, ...hostErrs, ...tierErrs, ...licenseErrs, ...idImmutabilityErrs, ...burnedErrs];
  if (allErrs.length) {
    console.error("REFUSED — entry fails validation:");
    for (const e of allErrs) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (!existsSync(args.target)) usageAndExit(`--target ${args.target} does not exist`);
  const index = JSON.parse(readFileSync(args.target, "utf8"));
  index.entries ??= [];

  const dupErrs = checkNoConflictingDuplicate(index.entries, entry);
  if (dupErrs.length) {
    console.error("REFUSED:");
    for (const e of dupErrs) console.error(`  - ${e}`);
    process.exit(1);
  }

  index.entries.push(entry);
  index.generated_at = new Date().toISOString();
  writeFileSync(args.target, JSON.stringify(index, null, 2) + "\n");

  recordPublish(ledger, { plugin_id: entry.plugin_id, version: entry.version, digest: entry.digest.value, published_at: entry.published_at });
  saveLedger(args.ledger, ledger);

  console.log(`OK — ${entry.plugin_id}@${entry.version} appended to ${args.target}; ledger updated (${args.ledger})`);
  if (entry.overlay?.shadows) {
    console.log(`  declared shadow(s): ${Object.keys(entry.overlay.shadows).join(", ")}`);
  }

  if (args.push) {
    // Direct commit + push. No PR (AC5) — this is a service writing its own repository, not a
    // human proposing a change for review.
    //
    // fix-cycle-1 (QG round 1, F4): `--only` + a `--` pathspec scopes the commit to EXACTLY
    // args.target/args.ledger, disregarding anything else that might already be staged in the
    // working directory at commit time — harmless in a clean checkout (the normal case), but this
    // pipeline pushes straight to `main` with no PR review as its only safety net (D22), so the
    // commit's own scope is the only remaining guard against sweeping in stray staged content.
    execFileSync("git", ["add", args.target, args.ledger], { stdio: "inherit" });
    execFileSync(
      "git",
      ["commit", "--only", "-m", `feat(catalog): publish ${entry.plugin_id}@${entry.version} via pipeline`, "--", args.target, args.ledger],
      { stdio: "inherit" },
    );
    execFileSync("git", ["push"], { stdio: "inherit" });
  } else {
    console.log("(--no-push: files written, not committed)");
  }
}

main();
