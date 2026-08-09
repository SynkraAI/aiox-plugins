// lib/ledger.mjs — the persistent, append-only registry of every plugin_id ever published (D24
// a/b, story 055.W3.3). Lives OUTSIDE any single index file (index/index.json, fixtures/index.json)
// specifically so retiring/removing an INDEX entry never erases the memory that a name existed
// (VC-1 — the trap this story exists to close: "if [the burned-name registry] lives inside the
// catalog entry itself, despublishing erases the memory and check (b) becomes decorative").
//
// Shape (ledger/plugin-ids.json):
// {
//   "schema_version": "2.0.0",
//   "plugins": {
//     "<plugin_id>": {
//       "lineage_id": "<uuid — the plugin's stable identity, set once, NEVER changes (F9)>",
//       "status": "active" | "retired",
//       "first_published_at": "<ISO8601, set once, from the FIRST publish's own published_at>",
//       "retired_at": null | "<ISO8601>",
//       "retired_reason": null | "<string>",
//       "history": [ { "version": "...", "digest": "...", "published_at": "..." }, ... ]  // oldest first, append-only
//     }
//   }
// }
//
// fix-cycle-2 (QG rounds 1+2, F9 — founder decision 2026-08-09): `lineage_id` is new and is the
// reason this file's schema_version went 1.0.0 -> 2.0.0. It is the plugin's STABLE IDENTITY: the
// thing that stays the same across a version bump, a rebuild, a display-name change — so that a
// `plugin_id` rename is detectable INDEPENDENTLY of the artifact's bytes. Before it existed, check
// (a) could only compare digests, so the realistic rename (rename + version bump = different bytes)
// passed green; see docs/INVARIANTS.md "check (a)" for the full account. Zero migration cost: both
// this ledger and index/index.json were still empty when the field was added, which is the only
// moment it costs nothing — the same reasoning that made D24 worth ratifying before a catalog
// existed.
//
// Append-only is enforced two ways: (1) scripts/check-ledger-append-only.mjs walks this file's
// ENTIRE git history and proves no existing key/history-entry was ever removed or mutated between
// any two adjacent recorded versions, including a whole-file deletion (fix-cycle-1, F1) and an
// invented status value (fix-cycle-1, F2); (2) this module's own write surface has no delete/
// mutate-in-place export at all — recordPublish only appends and self-refuses against an already-
// retired record (fix-cycle-1, F3), retirePlugin only flips status forward once.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const EMPTY_LEDGER = Object.freeze({ schema_version: "2.0.0", plugins: {} });

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
//
// fix-cycle-1 (QG round 1, F3): this module's own header comment claims the write surface "only
// appends, or flips status forward once" — but until this fix, that guarantee depended entirely on
// the CALLER (publish.mjs, via checkNameNotBurned) having already refused before ever reaching
// here. Not reachable via any shipped call site today (publish.mjs is the only caller and always
// checks first; retire.mjs never calls recordPublish), but a defense-in-depth gap inconsistent with
// retirePlugin's own self-enforcement below. recordPublish now refuses for itself, the same way.
// fix-cycle-2 (F9): `lineage_id` is REQUIRED and is stamped onto the record at first publish, then
// re-asserted (never rewritten) on every later version. Refusing here rather than defaulting is
// deliberate — a ledger record without a lineage_id would be a plugin whose renames are permanently
// undetectable, and a silently-minted default would be worse still (the author who forgot to carry
// the value would get a fresh identity and the rename check would pass green forever after).
export function recordPublish(ledger, { plugin_id, version, digest, published_at, lineage_id }) {
  if (!lineage_id) {
    throw new Error(
      `cannot record a publish for "${plugin_id}" without a lineage_id — it is the plugin's stable identity (D24(a), F9), not optional metadata; callers must supply it`,
    );
  }
  const rec = ledger.plugins[plugin_id];
  if (!rec) {
    ledger.plugins[plugin_id] = {
      lineage_id,
      status: "active",
      first_published_at: published_at,
      retired_at: null,
      retired_reason: null,
      history: [{ version, digest, published_at }],
    };
    return ledger;
  }
  if (rec.status === "retired") {
    throw new Error(
      `cannot record a publish for "${plugin_id}": it was retired at ${rec.retired_at} — a burned name can never be reborn (D24(b)); this call should never be reached (callers must check checkNameNotBurned first), so reaching this is itself a defect upstream`,
    );
  }
  if (rec.lineage_id !== lineage_id) {
    throw new Error(
      `cannot record a publish for "${plugin_id}": its lineage_id is "${rec.lineage_id}" and this publish declares "${lineage_id}" — a plugin's lineage is set once and never changes (D24(a), F9); this call should never be reached (callers must check checkIdImmutabilityAgainstLedger first), so reaching this is itself a defect upstream`,
    );
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

// fix-cycle-2 (F9). Every lineage_id ever recorded under a plugin_id OTHER than `excludePluginId`,
// mapped to the plugin_id that owns it. This is the byte-INDEPENDENT half of check (a): unlike a
// digest, a lineage_id survives a version bump and a rebuild untouched, so it is what makes a
// rename detectable in the realistic case (the author bumps the version and renames in the same
// move, so no digest is ever shared between the two identities).
export function lineagesRegisteredUnderOtherPluginIds(ledger, excludePluginId) {
  const map = new Map(); // lineage_id -> plugin_id that owns it
  for (const [pid, rec] of Object.entries(ledger.plugins)) {
    if (pid === excludePluginId) continue;
    if (rec.lineage_id && !map.has(rec.lineage_id)) map.set(rec.lineage_id, pid);
  }
  return map;
}

// The lineage_id already on record for `pluginId`, or null if it has never been published. Used by
// check (a)'s stability half: a plugin_id that comes back with a DIFFERENT lineage_id is trying to
// relabel its own identity, which would free the old lineage up for reuse under a new name.
export function recordedLineageOf(ledger, pluginId) {
  return ledger.plugins?.[pluginId]?.lineage_id ?? null;
}
