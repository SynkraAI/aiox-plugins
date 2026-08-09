#!/usr/bin/env node
// scripts/validate-index.mjs — CI base check (structural, dependency-free).
//
// This is the SAME validation publisher/publish.mjs applies per-entry at write time, re-run over
// a whole index file so CI catches a hand-edit that bypassed the pipeline, or drift between the
// schema doc and the data. The FULL D20/D24 invariant suite (secret scanning, capability
// analysis, id-immutability history, burned-name ledger, license-in-tarball check) is story
// 055.W3.3 / Wave 4 — this is deliberately just the base structural gate this story owns.

import { readFileSync } from "node:fs";

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function validateEntry(entry, i, errors) {
  const tag = `entries[${i}] (${entry.plugin_id ?? "?"})`;
  if (entry.schema_version !== "1.0.0") errors.push(`${tag}: schema_version must be '1.0.0'`);
  if (!KEBAB.test(entry.plugin_id ?? "")) errors.push(`${tag}: plugin_id must be kebab-case`);
  if (!SEMVER.test(entry.version ?? "")) errors.push(`${tag}: version must be semver`);
  if (!Array.isArray(entry.tiers) || entry.tiers.length === 0) errors.push(`${tag}: tiers must be non-empty array`);
  if (!entry.digest || entry.digest.algorithm !== "sha256" || !SHA256_HEX.test(entry.digest.value ?? ""))
    errors.push(`${tag}: digest.{algorithm:'sha256', value:<64 hex>} required`);
  if (!entry.artifact?.mirror_url) errors.push(`${tag}: artifact.mirror_url required`);
  if (!entry.publisher?.subject) errors.push(`${tag}: publisher.subject required`);
  if (!entry.published_at) errors.push(`${tag}: published_at required`);
  if (!entry.license?.spdx_or_path) errors.push(`${tag}: license.spdx_or_path required (D24(c))`);
  if (entry.overlay?.shadows) {
    for (const [skill, reason] of Object.entries(entry.overlay.shadows)) {
      if (!reason || typeof reason !== "string" || !reason.trim()) {
        errors.push(`${tag}: overlay.shadows.${skill} must carry a non-empty reason`);
      }
    }
  }
}

function validateFile(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const errors = [];
  if (data.schema_version !== "1.0.0") errors.push(`${path}: top-level schema_version must be '1.0.0'`);
  if (!Array.isArray(data.entries)) errors.push(`${path}: entries must be an array`);
  else data.entries.forEach((e, i) => validateEntry(e, i, errors));

  // D24(a)/(b) base guard, replicated here so a hand-edit can't bypass what publish.mjs enforces:
  // no two entries with the same plugin_id+version but different digests.
  const seen = new Map();
  for (const e of data.entries ?? []) {
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
