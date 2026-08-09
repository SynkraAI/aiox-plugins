// lib/ledger.mjs — the persistent, append-only registry of every plugin_id ever published (D24
// a/b, story 055.W3.3). Lives OUTSIDE any single index file (index/index.json, fixtures/index.json)
// specifically so retiring/removing an INDEX entry never erases the memory that a name existed
// (VC-1 — the trap this story exists to close: "if [the burned-name registry] lives inside the
// catalog entry itself, despublishing erases the memory and check (b) becomes decorative").
//
// Shape (ledger/plugin-ids.json):
// {
//   "schema_version": "1.0.0",
//   "plugins": {
//     "<plugin_id>": {
//       "status": "active" | "retired",
//       "first_published_at": "<ISO8601, set once, from the FIRST publish's own published_at>",
//       "retired_at": null | "<ISO8601>",
//       "retired_reason": null | "<string>",
//       "history": [ { "version": "...", "digest": "...", "published_at": "..." }, ... ]  // oldest first, append-only
//     }
//   }
// }
//
// Append-only is enforced two ways: (1) scripts/check-ledger-append-only.mjs walks this file's
// ENTIRE git history and proves no existing key/history-entry was ever removed or mutated between
// any two adjacent recorded versions; (2) this module's own write surface has no delete/mutate-in-
// place export at all — recordPublish only appends, retirePlugin only flips status forward once.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const EMPTY_LEDGER = Object.freeze({ schema_version: "1.0.0", plugins: {} });

export function loadLedger(path) {
  if (!existsSync(path)) return structuredClone(EMPTY_LEDGER);
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.plugins ??= {};
  return data;
}

export function saveLedger(path, ledger) {
  writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n");
}

// Record a publish (first-time, or a later version of an already-registered plugin_id). Never
// mutates an existing history entry — only appends a new one, or creates the record on first sight.
export function recordPublish(ledger, { plugin_id, version, digest, published_at }) {
  const rec = ledger.plugins[plugin_id];
  if (!rec) {
    ledger.plugins[plugin_id] = {
      status: "active",
      first_published_at: published_at,
      retired_at: null,
      retired_reason: null,
      history: [{ version, digest, published_at }],
    };
    return ledger;
  }
  rec.history.push({ version, digest, published_at });
  return ledger;
}

// One-way transition only. Throws (never silently no-ops) on: unknown plugin_id (nothing to
// retire — retiring requires a prior publish, since a name that was never used cannot be burned),
// or an already-retired plugin_id (retirement is not reversible and not re-appliable — D24(b)).
export function retirePlugin(ledger, { plugin_id, reason, retired_at }) {
  const rec = ledger.plugins[plugin_id];
  if (!rec) {
    throw new Error(`cannot retire "${plugin_id}": it has never been published (no ledger record) — nothing to burn`);
  }
  if (rec.status === "retired") {
    throw new Error(
      `"${plugin_id}" is already retired (at ${rec.retired_at}) — retirement is a one-way transition, it cannot be re-applied or reversed (D24(b))`,
    );
  }
  rec.status = "retired";
  rec.retired_at = retired_at;
  rec.retired_reason = reason;
  return ledger;
}

// Every digest ever recorded for plugin_ids OTHER than `excludePluginId`, mapped to the plugin_id
// that first published it. Used by checkIdImmutabilityAgainstLedger (lib/entry-schema.mjs) — see
// that function's header comment for the documented scope/limitation of what this catches.
export function digestsPublishedUnderOtherPluginIds(ledger, excludePluginId) {
  const map = new Map(); // digest -> plugin_id that owns it
  for (const [pid, rec] of Object.entries(ledger.plugins)) {
    if (pid === excludePluginId) continue;
    for (const h of rec.history ?? []) {
      if (!map.has(h.digest)) map.set(h.digest, pid);
    }
  }
  return map;
}
