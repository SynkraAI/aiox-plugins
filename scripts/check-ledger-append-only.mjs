#!/usr/bin/env node
// scripts/check-ledger-append-only.mjs — story 055.W3.3, CI proof for VC-1. Walks the ENTIRE git
// history of ledger/plugin-ids.json (every commit that touched it, oldest first) and verifies each
// recorded version is a PURE ADDITION over the previous one:
//   - the file itself is never deleted/left unparseable once it has recorded at least one plugin_id
//     (fix-cycle-1, F1 — see below, this is the QG-round-1 blocking finding)
//   - no existing plugin_id key ever disappears
//   - no existing history[] entry for a plugin_id is ever removed or mutated (old history must
//     remain an exact, unmodified prefix of new history)
//   - first_published_at / retired_at / retired_reason, once set, never change
//   - status is always exactly "active" or "retired" (fix-cycle-1, F2) and only ever transitions
//     active -> retired, never retired -> active (a "reborn" burned name is exactly what
//     AC2/D24(b) forbids)
//
// This is the mechanism that makes VC-1 real rather than aspirational: "the registry survives
// removal of the index entry" is checked at the DATA level (checkNameNotBurned reads the ledger,
// which is a separate file from index/index.json); THIS script is what proves nobody can quietly
// edit the ledger itself to un-burn a name or delete a plugin_id's history. Requires the checkout
// to have full history (actions/checkout with fetch-depth: 0 — see .github/workflows/ci.yml); a
// shallow clone would silently see only 1 commit and report a false OK, which is exactly the "gate
// that passes verde without pegging what it should" trap this story exists to avoid — hence the
// explicit fetch-depth: 0 requirement is called out here, not left implicit.
//
// fix-cycle-1 (QG round 1, gate-055.W3.3-…-20260809T210752Z.yaml, F1, HIGH/blocking): a commit that
// `git rm`s ledger/plugin-ids.json ENTIRELY was silently invisible to this script — `contentAt`
// returns `null` for a commit where the file doesn't exist, and the old main loop did a bare
// `continue`, meaning the deletion commit was dropped from `versions` before
// `checkAppendOnlySequence` ever saw it, and the whole run reported `OK`. Reproduced independently
// by the QG (2-commit throwaway repo: add 1 active plugin_id, `git rm` the file) before being
// accepted — see the regression test in test/ledger.test.mjs mirroring it. Fix: a commit whose
// content is missing/unparseable is now passed into `checkAppendOnlySequence` as `{ label, data:
// null }` instead of being dropped, and the sequence-checker treats "file missing after previously
// recording N plugin_id(s)" as a violation naming every plugin_id that would be silently erased —
// and does NOT advance its own "last known good" pointer past the deletion, so a later commit that
// restores the file is still held to the pre-deletion state, not compared against nothing.

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
  // versions: array of { label, data } in chronological order. `data` is the parsed ledger JSON,
  // or `null` when the file was missing/unparseable at that commit (fix-cycle-1, F1 — a `git rm` of
  // the whole file produces a `null` entry here rather than being silently dropped before this
  // function ever sees it).
  const violations = [];
  let prev = null; // last known-good (non-null) version — deliberately NOT advanced past a `null`
  //                  entry, so a commit that later restores the file is still held to the
  //                  pre-deletion state, not compared against nothing.
  for (const { label, data } of versions) {
    if (data === null) {
      const lostIds = Object.keys(prev?.plugins ?? {});
      if (lostIds.length) {
        violations.push(
          `${label}: ledger/plugin-ids.json is missing or unparseable at this commit, but the previous version recorded ${lostIds.length} plugin_id(s) (${lostIds.map((p) => `"${p}"`).join(", ")}) — every burned-name/digest-lineage record would be silently erased if this were trusted (whole-file deletion, append-only violated)`,
        );
      }
      continue;
    }

    // fix-cycle-1, F2: the closed 2-value status enum is now validated on EVERY recorded version,
    // not just the retired -> non-retired transition below — a hand-edit that invents a status
    // string neither "active" nor "retired" (e.g. from "active" to "archived-by-hand-edit") must
    // not pass silently just because it never touched the literal string "retired".
    for (const [pid, rec] of Object.entries(data.plugins ?? {})) {
      if (rec.status !== "active" && rec.status !== "retired") {
        violations.push(`${label}: "${pid}".status is "${rec.status}" — must be exactly "active" or "retired" (closed enum)`);
      }
    }

    if (prev) {
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
    prev = data;
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
    if (raw === null) {
      // fix-cycle-1, F1: previously `continue`d here, silently dropping a whole-file-deletion
      // commit from `versions` before checkAppendOnlySequence ever saw it. Now recorded as an
      // explicit `null` entry so the sequence-checker can flag it.
      versions.push({ label: sha, data: null });
      continue;
    }
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
