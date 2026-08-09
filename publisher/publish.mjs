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
// assuming it away.
//
// SCOPE (base pipeline, this story): structural schema validation + a minimal D24 guard (license
// required, no silent duplicate id+version). The FULL invariant suite (id immutability across the
// entry's history, burned-name ledger, CI-enforced license check) is story 055.W3.3 — this script
// deliberately does not pretend to be that story.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

function usageAndExit(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node publisher/publish.mjs --manifest <path.json> --target <index.json> --subject <entitlement-subject> [--artifact <local-file> | --digest <sha256> --mirror-url <url>] [--no-push]",
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

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Structural validation mirroring schema/index-entry.schema.json — kept dependency-free (no ajv)
// on purpose for this base pipeline; a schema-library-backed validator is in scope for 055.W3.3
// alongside the rest of the CI invariant suite.
function validateEntry(entry) {
  const errs = [];
  if (entry.schema_version !== "1.0.0") errs.push("schema_version must be '1.0.0'");
  if (!KEBAB.test(entry.plugin_id ?? "")) errs.push("plugin_id must be kebab-case");
  if (!SEMVER.test(entry.version ?? "")) errs.push("version must be semver");
  if (!Array.isArray(entry.tiers) || entry.tiers.length === 0) errs.push("tiers must be a non-empty array");
  if (!entry.digest || entry.digest.algorithm !== "sha256" || !SHA256_HEX.test(entry.digest.value ?? ""))
    errs.push("digest.{algorithm:'sha256', value:<64 hex>} required");
  if (!entry.artifact?.mirror_url) errs.push("artifact.mirror_url required");
  if (!entry.publisher?.subject) errs.push("publisher.subject required (D22 — entitlement subject, never a GitHub handle)");
  if (!entry.published_at) errs.push("published_at required");
  // D24(c) — license mandatory at package root, checked here as "the manifest declares one";
  // this script does not itself open the artifact to confirm the file is present at its root —
  // that mechanical check is 055.W3.3's CI, named here rather than silently assumed.
  if (!entry.license?.spdx_or_path) errs.push("license.spdx_or_path required (D24(c))");
  if (entry.overlay) {
    if (typeof entry.overlay.shadows === "object" && entry.overlay.shadows !== null) {
      for (const [skill, reason] of Object.entries(entry.overlay.shadows)) {
        if (!reason || typeof reason !== "string" || reason.trim() === "") {
          errs.push(`overlay.shadows.${skill} must carry a non-empty reason (D23) — an undeclared/empty reason is exactly the silent-override anti-pattern D23 exists to close`);
        }
      }
    }
  }
  return errs;
}

// Base D24 guard: refuse a silent duplicate (same plugin_id+version already indexed with a
// DIFFERENT digest — the immutability D24(a)/(b) protect). The full burned-name ledger across
// retirement is 055.W3.3's job; this is the minimal guard this story's pipeline can honestly claim.
function checkAgainstExisting(index, entry) {
  const clash = index.entries.find(
    (e) => e.plugin_id === entry.plugin_id && e.version === entry.version,
  );
  if (clash && clash.digest.value !== entry.digest.value) {
    return [`plugin_id "${entry.plugin_id}" version "${entry.version}" is already indexed with a DIFFERENT digest — refusing to overwrite (D24 immutability)`];
  }
  if (clash) {
    return [`plugin_id "${entry.plugin_id}" version "${entry.version}" is already indexed (identical digest) — nothing to do`];
  }
  return [];
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) usageAndExit("--manifest is required");
  if (!args.target) usageAndExit("--target is required");
  if (!args.subject) usageAndExit("--subject is required (entitlement subject, D22)");

  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));

  let digestValue = args.digest;
  let mirrorUrl = args["mirror-url"];
  if (args.artifact) {
    digestValue = sha256File(args.artifact);
  }
  if (!digestValue || !mirrorUrl) {
    usageAndExit("either --artifact <local-file> (digest computed here) or both --digest and --mirror-url are required");
  }

  const entry = {
    schema_version: "1.0.0",
    plugin_id: manifest.plugin_id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    tiers: manifest.tiers,
    digest: { algorithm: "sha256", value: digestValue },
    artifact: { mirror_url: mirrorUrl, ...(args["r2-key"] ? { r2_key: args["r2-key"] } : {}) },
    publisher: { subject: args.subject },
    published_at: new Date().toISOString(),
    license: { spdx_or_path: manifest.license },
    ...(manifest.overlay ? { overlay: manifest.overlay } : {}),
  };

  const entryErrs = validateEntry(entry);
  if (entryErrs.length) {
    console.error("REFUSED — entry fails schema validation:");
    for (const e of entryErrs) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (!existsSync(args.target)) usageAndExit(`--target ${args.target} does not exist`);
  const index = JSON.parse(readFileSync(args.target, "utf8"));
  index.entries ??= [];

  const clashErrs = checkAgainstExisting(index, entry);
  if (clashErrs.length) {
    console.error("REFUSED:");
    for (const e of clashErrs) console.error(`  - ${e}`);
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
