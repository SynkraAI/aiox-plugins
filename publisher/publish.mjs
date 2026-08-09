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
// SCOPE (base pipeline, this story): structural schema validation + artifact-identity binding +
// artifact-host allowlist + a minimal D24 guard (license required, no silent duplicate id+version).
// The FULL invariant suite (id immutability across the entry's history, burned-name ledger,
// CI-enforced license check) is story 055.W3.3 — this script deliberately does not pretend to be
// that story.
//
// fix-cycle-1 (055.W3.1 QG @architect, F-AC6-ARTIFACT-BINDING): validation now lives in
// lib/entry-schema.mjs, shared with scripts/validate-index.mjs, so publish-time and CI-time checks
// can never drift apart. artifact.r2_key is now REQUIRED (was optional) — it's needed to verify
// identity-binding, and no real entry has ever shipped that would be broken by tightening this.
//
// fix-cycle-2 (F-BINDING-NO-HOST-ALLOWLIST): a correctly plugin_id-namespaced path on a
// COMPLETELY DIFFERENT HOST used to pass every check. checkArtifactHost (lib/entry-schema.mjs)
// now refuses any mirror_url whose host isn't in the single named ALLOWED_ARTIFACT_HOSTS list.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  validateEntryShape,
  checkArtifactBinding,
  checkArtifactHost,
  checkNoConflictingDuplicate,
} from "../lib/entry-schema.mjs";

function usageAndExit(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node publisher/publish.mjs --manifest <path.json> --target <index.json> --subject <entitlement-subject> --r2-key <bucket-key> (--artifact <local-file> | --digest <sha256>) --mirror-url <url> [--no-push]",
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
  if (!args.subject) usageAndExit("--subject is required (entitlement subject, D22)");
  if (!args["r2-key"]) usageAndExit("--r2-key is required (fix-cycle-1: needed for artifact-identity binding)");
  if (!args["mirror-url"]) usageAndExit("--mirror-url is required");

  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));

  let digestValue = args.digest;
  if (args.artifact) {
    digestValue = sha256File(args.artifact);
  }
  if (!digestValue) usageAndExit("either --artifact <local-file> (digest computed here) or --digest is required");

  const entry = {
    schema_version: "1.0.0",
    plugin_id: manifest.plugin_id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    tiers: manifest.tiers,
    digest: { algorithm: "sha256", value: digestValue },
    artifact: { mirror_url: args["mirror-url"], r2_key: args["r2-key"] },
    publisher: { subject: args.subject },
    published_at: new Date().toISOString(),
    license: { spdx_or_path: manifest.license },
    ...(manifest.overlay ? { overlay: manifest.overlay } : {}),
  };

  const shapeErrs = validateEntryShape(entry);
  const bindingErrs = checkArtifactBinding(entry);
  const hostErrs = checkArtifactHost(entry);
  if (shapeErrs.length || bindingErrs.length || hostErrs.length) {
    console.error("REFUSED — entry fails validation:");
    for (const e of [...shapeErrs, ...bindingErrs, ...hostErrs]) console.error(`  - ${e}`);
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

  console.log(`OK — ${entry.plugin_id}@${entry.version} appended to ${args.target}`);
  if (entry.overlay?.shadows) {
    console.log(`  declared shadow(s): ${Object.keys(entry.overlay.shadows).join(", ")}`);
  }

  if (args.push) {
    // Direct commit + push. No PR (AC5) — this is a service writing its own repository, not a
    // human proposing a change for review.
    execFileSync("git", ["add", args.target], { stdio: "inherit" });
    execFileSync(
      "git",
      ["commit", "-m", `feat(catalog): publish ${entry.plugin_id}@${entry.version} via pipeline`],
      { stdio: "inherit" },
    );
    execFileSync("git", ["push"], { stdio: "inherit" });
  } else {
    console.log("(--no-push: file written, not committed)");
  }
}

main();
