// lib/pin.mjs — story 055.W4.1, D20(2): version PIN + the plugin's own CHANNEL.
//
// A "pin" is `<plugin_id>@<version>`. Resolving it against an index yields the artifact's DIGEST,
// and the digest is what a client fetches by — never a mutable "latest" pointer. That is the whole
// mechanism: same pin ⇒ same digest ⇒ same bytes (AC4).
//
// ── DETERMINISM IS A PROPERTY OF THE FUNCTION, NOT A PROMISE IN A DOC ────────────────────────────
//
// `resolvePin` is a PURE function of exactly two inputs: the parsed index data and the pin string.
// It reads no clock, no environment variable, no file, no network, and no channel state of any kind.
// That is what makes AC4 provable rather than assertable, and it is also the mechanical half of AC5:
// a function that cannot observe the binary channel cannot be affected by it. `test/pin.test.mjs`
// proves both directions by resolving the same pin with binary-channel state present and absent, and
// with the environment mutated, asserting byte-identical results.
//
// ── WHY AMBIGUITY IS A REFUSAL, NOT A "PICK THE FIRST ONE" ───────────────────────────────────────
//
// If one index somehow carried two entries for the same `plugin_id@version`, any tie-break rule
// (first, last, highest) would make the RESOLUTION depend on entry ORDER — i.e. on how the file was
// edited — which is exactly the silent substitution D24(b) exists to prevent. Refusing is the only
// answer that keeps the pin meaningful.
//
// fix-cycle-1 (F5): this paragraph used to say that and the code only half-did it — duplicates with
// DIFFERENT digests were refused, duplicates with the SAME digest were tie-broken with `exact[0]`,
// so `tiers` and `mirror_url` were order-dependent. `tiers` is the entitlement axis, so that is not
// cosmetic. Any duplicate is now a refusal; the reasoning and the implementation say the same thing.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PIN_SYNTAX = "<plugin_id>@<version>";

// Mirrors lib/entry-schema.mjs's shapes. Imported values are not reused here on purpose: this module
// must stay resolvable against ANY index that declares itself valid, including a future schema
// version, so it validates the two fields it actually consumes rather than the whole entry.
const PIN_RE = /^([a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function parsePin(pin) {
  const m = PIN_RE.exec(String(pin ?? "").trim());
  if (!m) {
    throw new Error(
      `invalid pin "${pin}" — expected ${PIN_SYNTAX} (kebab-case plugin_id, semver version), e.g. "sinkra-os@1.2.0"`,
    );
  }
  return { plugin_id: m[1], version: m[2] };
}

// ── AC6 — the pin's COST, carried WITH every resolution ──────────────────────────────────────────
//
// Advisory-council finding C4, verified: "of the 4 original controls, zero acted on an
// already-installed artifact, and the pin even prevented it from being fixed."
//
// This is DATA on the result object, not prose in a document, for the same reason
// `capabilities.limits` is data in lib/capability-analyzer.mjs: a benefit that can be displayed
// without its cost WILL eventually be displayed without it, and then the pin reads as pure gain —
// which is false.
export const PIN_COST = Object.freeze({
  benefit:
    "A pin makes an install reproducible: the same pin resolves to the same digest, which fetches the same bytes, forever. A client that never re-resolves can never be silently handed different content.",
  cost:
    "THE SAME PROPERTY PREVENTS AN ALREADY-INSTALLED ARTIFACT FROM BEING REPAIRED. A client pinned to a version keeps resolving that version — including after the publisher ships a corrected build. Pinning freezes the good and the bad alike: it is not a control that acts on what is already on a user's disk, and it actively stands in the way of one.",
  what_gives_the_capability_back:
    "Index freshness — story 055.W5.1 (D20(5)): an `expires` field plus a monotonic index version, so a client can tell a stale index from a current one and knows when it must re-resolve. That is the mechanism that restores the ability to REPAIR an installed artifact.",
  not_a_revocation_claim:
    "Restoring the ability to repair is NOT the same as revocation, and nothing in this module implements, implies or depends on revocation. Revocation is governed by O5 (story 055.W1.3), which has NOT closed — epic 055 rule R2 forbids any story from asserting it exists. See docs/CATALOG-AND-MIRROR.md, section 'AC8 (055.W3.1)'.",
});

// ── AC5 — the plugin channel is not the binary channel ───────────────────────────────────────────
//
// REUSE, not reimplementation: the binary's update channel already exists and is governed by
// `ADR-COCKPIT-UPDATE-CHANNELS` (epic 017, Done) — per-role channels for the cockpit BINARY. This
// module does not implement a second one and must never read the first. D19 fixes that the plugin's
// cycle is independent of the binary's (marker by version+tier+digest, separate from
// `.aiox-core-build`).
export const CHANNEL = Object.freeze({
  name: "plugin",
  what_identifies_an_install:
    "version + tier + digest (the product's plugin marker, ~/.aiox/sinkra-os-plugin.marker — crates/aiox-cockpit/src/plugin_channel.rs)",
  resolved_from: "the catalog index + the pin, and nothing else",
  // The binary channel's identifiers. This module never reads any of them;
  // scripts/check-channel-separation.mjs mechanically proves that for the whole repository, so the
  // separation is enforced rather than merely intended.
  binary_channel_identifiers: Object.freeze([
    ".aiox-core-build", // the framework/binary provisioning marker (crates/aiox-cockpit/src/provision.rs)
    "ADR-COCKPIT-UPDATE-CHANNELS", // the per-role binary channel decision (epic 017)
    "velopack", // the installer/updater the binary ships through
    "RELEASES", // the binary update feed's manifest file
  ]),
  independence:
    "A plugin can be re-pinned and updated with the binary untouched, and the binary can update with every plugin pin unchanged: the two are resolved from different inputs, recorded in different markers, and neither reads the other's state.",
});

// Resolve a pin against parsed index data. PURE — index data + pin string in, resolution out.
export function resolvePin(indexData, pin) {
  const { plugin_id, version } = parsePin(pin);
  const entries = Array.isArray(indexData?.entries) ? indexData.entries : null;
  if (!entries) throw new Error("index has no `entries` array — cannot resolve a pin against it");

  const forPlugin = entries.filter((e) => e.plugin_id === plugin_id);
  if (forPlugin.length === 0) {
    const known = [...new Set(entries.map((e) => e.plugin_id))].sort();
    throw new Error(
      `pin "${pin}" — no plugin "${plugin_id}" in this index. Known plugin_ids: ${known.length ? known.join(", ") : "(index is empty)"}`,
    );
  }

  const exact = forPlugin.filter((e) => e.version === version);
  if (exact.length === 0) {
    const versions = [...new Set(forPlugin.map((e) => e.version))].sort();
    throw new Error(
      `pin "${pin}" — plugin "${plugin_id}" exists but not at version "${version}". Published versions: ${versions.join(", ")}`,
    );
  }

  // fix-cycle-1 (F5). This used to refuse only when the duplicates carried DIFFERENT digests, and
  // silently took `exact[0]` otherwise — which the QG executed: two same-digest entries for one pin,
  // in two index orderings, resolved to different `artifact.mirror_url` and different `tiers`.
  //
  // Two reasons that was the wrong shape, and the second is the one that matters:
  //  1. The comment at the top of this module argues that ANY tie-break "would make the resolved
  //     BYTES depend on entry ORDER" — stated absolutely while the code tie-broke in one case. The
  //     reasoning has to be as strict as the implementation or one of them is a lie.
  //  2. `tiers` is the ENTITLEMENT axis (`gate_plugin(plugin, tier)`), so an order-dependent `tiers`
  //     is not cosmetic drift — it is which customers the resolution says may install this.
  //
  // So: ANY duplicate `plugin_id@version` is a refusal, whatever the digests say. The publish path
  // already refuses to create one (lib/entry-schema.mjs::checkNoConflictingDuplicate), so reaching
  // this requires a hand-edited index — which is exactly the case a resolver should not paper over.
  if (exact.length > 1) {
    const digests = [...new Set(exact.map((e) => e.digest?.value))];
    const detail = digests.length > 1
      ? `with ${digests.length} DIFFERENT digests (${digests.join(", ")})`
      : `with the same digest but potentially differing metadata (tiers/mirror_url) — order would decide which one you get, and \`tiers\` is the entitlement axis`;
    throw new Error(
      `pin "${pin}" — REFUSED: ${exact.length} entries share this plugin_id@version ${detail}. A pin whose resolution depends on entry order is not a pin; the index is corrupt and must be fixed, not tie-broken.`,
    );
  }

  const e = exact[0];
  if (!e.digest?.value || !e.artifact?.mirror_url) {
    throw new Error(`pin "${pin}" — entry is missing digest.value or artifact.mirror_url; cannot resolve to bytes`);
  }
  // fix-cycle-1 (F6). This used to default a missing `digest.algorithm` to "sha256". Defaulting is
  // the wrong posture for the field that decides how bytes are verified: the schema REQUIRES it
  // (schema/index-entry.schema.json), so an entry without it is malformed, and silently assuming the
  // algorithm means a future entry using a different one would be verified with the wrong function
  // while reporting success. Refuse instead — fail-closed is the shape of an invariant.
  if (!e.digest.algorithm) {
    throw new Error(
      `pin "${pin}" — REFUSED: the entry has no digest.algorithm. The field is REQUIRED by the entry schema; this resolver will not assume one, because assuming the algorithm that verifies bytes is how a mismatch becomes a silent pass.`,
    );
  }

  return {
    pin: `${plugin_id}@${version}`,
    plugin_id,
    version,
    lineage_id: e.lineage_id ?? null,
    tiers: e.tiers ?? [],
    digest: { algorithm: e.digest.algorithm, value: e.digest.value },
    artifact: { mirror_url: e.artifact.mirror_url, r2_key: e.artifact.r2_key ?? null },
    channel: CHANNEL,
    // The cost travels with the claim — see PIN_COST's comment.
    pin_cost: PIN_COST,
  };
}

export function resolvePinFromFile(indexPath, pin) {
  return resolvePin(JSON.parse(readFileSync(indexPath, "utf8")), pin);
}

// Verify downloaded/local bytes against a resolution. This is the "same digest ⇒ same bytes" half of
// AC4 — a pin that resolves to a digest nobody ever checks is a string, not a guarantee.
export function verifyBytesAgainstPin(resolved, filePath) {
  if (resolved.digest.algorithm !== "sha256") {
    throw new Error(`unsupported digest algorithm "${resolved.digest.algorithm}" — only sha256 is implemented`);
  }
  const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return { ok: actual === resolved.digest.value, expected: resolved.digest.value, actual, path: filePath };
}

export function renderResolution(resolved) {
  const out = [];
  out.push(`pin            ${resolved.pin}`);
  out.push(`digest         ${resolved.digest.algorithm}:${resolved.digest.value}`);
  out.push(`artifact       ${resolved.artifact.mirror_url}`);
  out.push(`tiers          ${resolved.tiers.join(", ") || "(none)"}`);
  out.push(`channel        ${resolved.channel.name} — ${resolved.channel.resolved_from}`);
  out.push(`               identified by: ${resolved.channel.what_identifies_an_install}`);
  out.push(`               independent of the binary channel (${resolved.channel.binary_channel_identifiers.join(", ")})`);
  out.push("");
  out.push("WHAT PINNING COSTS (this is not a footnote):");
  out.push(`  benefit: ${resolved.pin_cost.benefit}`);
  out.push(`  COST:    ${resolved.pin_cost.cost}`);
  out.push(`  fix:     ${resolved.pin_cost.what_gives_the_capability_back}`);
  out.push(`  note:    ${resolved.pin_cost.not_a_revocation_claim}`);
  return out.join("\n");
}
