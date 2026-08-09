#!/usr/bin/env node
// scripts/check-ledger-append-only.mjs — story 055.W3.3, CI proof for VC-1. Walks the ENTIRE git
// history of ledger/plugin-ids.json (every commit that touched it, oldest first) and verifies each
// recorded version is a PURE ADDITION over the previous one:
//   - no existing plugin_id key ever disappears
//   - no existing history[] entry for a plugin_id is ever removed or mutated (old history must
//     remain an exact, unmodified prefix of new history)
//   - first_published_at / retired_at / retired_reason, once set, never change
//   - status only ever transitions active -> retired, never retired -> active (a "reborn" burned
//     name is exactly what AC2/D24(b) forbids)
//
// This is the mechanism that makes VC-1 real rather than aspirational: "the registry survives
// removal of the index entry" is checked at the DATA level (checkNameNotBurned reads the ledger,
// which is a separate file from index/index.json); THIS script is what proves nobody can quietly
// edit the ledger itself to un-burn a name or delete a plugin_id's history. Requires the checkout
// to have full history (actions/checkout with fetch-depth: 0 — see .github/workflows/ci.yml); a
// shallow clone would silently see only 1 commit and report a false OK, which is exactly the "gate
// that passes verde without pegging what it should" trap this story exists to avoid — hence the
// explicit fetch-depth: 0 requirement is called out here, not left implicit.

import { execFileSync } from "node:child_process";

const FILE = process.argv[2] || "ledger/plugin-ids.json";

function sh(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function commitsTouching(file) {
  const out = sh(["log", "--format=%H", "--reverse", "--", file]);
  return out ? out.split("\n") : [];
}

function contentAt(sha, file) {
  try {
    return sh(["show", `${sha}:${file}`]);
  } catch {
    return null;
  }
}

export function checkAppendOnlySequence(versions) {
  // versions: array of { label, data } in chronological order (data = parsed ledger JSON or null)
  const violations = [];
  let prev = null;
  for (const { label, data } of versions) {
    if (prev && data) {
      const prevPlugins = prev.plugins ?? {};
      const nextPlugins = data.plugins ?? {};
      for (const [pid, prevRec] of Object.entries(prevPlugins)) {
        const nextRec = nextPlugins[pid];
        if (!nextRec) {
          violations.push(`${label}: plugin_id "${pid}" was REMOVED from the ledger — append-only violated`);
          continue;
        }
        if (prevRec.first_published_at !== nextRec.first_published_at) {
          violations.push(
            `${label}: "${pid}".first_published_at changed (${prevRec.first_published_at} -> ${nextRec.first_published_at}) — immutable once set`,
          );
        }
        if (prevRec.status === "retired" && nextRec.status !== "retired") {
          violations.push(
            `${label}: "${pid}".status went from "retired" back to "${nextRec.status}" — a burned name can never be reborn (D24(b))`,
          );
        }
        if (prevRec.retired_at && prevRec.retired_at !== nextRec.retired_at) {
          violations.push(`${label}: "${pid}".retired_at changed once set (${prevRec.retired_at} -> ${nextRec.retired_at})`);
        }
        if (prevRec.retired_reason && prevRec.retired_reason !== nextRec.retired_reason) {
          violations.push(`${label}: "${pid}".retired_reason changed once set`);
        }
        const prevHist = prevRec.history ?? [];
        const nextHist = nextRec.history ?? [];
        if (nextHist.length < prevHist.length) {
          violations.push(`${label}: "${pid}".history shrank (${prevHist.length} -> ${nextHist.length} entries) — append-only violated`);
        } else {
          for (let i = 0; i < prevHist.length; i++) {
            if (JSON.stringify(prevHist[i]) !== JSON.stringify(nextHist[i])) {
              violations.push(`${label}: "${pid}".history[${i}] was mutated — old history must remain an exact, unmodified prefix`);
            }
          }
        }
      }
    }
    if (data) prev = data;
  }
  return violations;
}

const isMain = process.argv[1] && process.argv[1].endsWith("check-ledger-append-only.mjs");
if (isMain) {
  const shas = commitsTouching(FILE);
  if (shas.length === 0) {
    console.log(`OK — ${FILE} has no history yet in this checkout (not committed, or repo has no commits touching it)`);
    process.exit(0);
  }

  const versions = [];
  for (const sha of shas) {
    const raw = contentAt(sha, FILE);
    if (raw === null) continue;
    try {
      versions.push({ label: sha, data: JSON.parse(raw) });
    } catch (e) {
      console.error(`FAIL — ${sha}: ${FILE} is not valid JSON at this commit: ${e.message}`);
      process.exit(1);
    }
  }

  const violations = checkAppendOnlySequence(versions);
  if (violations.length) {
    console.error(`FAIL — ${violations.length} append-only violation(s) across ${shas.length} commit(s) touching ${FILE}:`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`OK — ${FILE} is append-only across all ${shas.length} commit(s) in its history`);
}
