// lib/entry-schema.mjs — shared validation, imported by BOTH publisher/publish.mjs (publish-time
// gate) and scripts/validate-index.mjs (CI gate), so the two can never drift apart.
//
// fix-cycle-1 (055.W3.1 QG @architect, F-AC6-ARTIFACT-BINDING): before this change, nothing checked
// that artifact.r2_key/mirror_url was actually namespaced under the entry's OWN plugin_id — the
// convention (plugins/<plugin_id>/<version>/<sha256>.tar.gz) existed only as prose. Demonstrated
// concretely: the original fixtures/index.json had `aiox-enterprise`'s entry legitimately pointing
// at a `sinkra-os/...` R2 key, which this check now refuses. AC4's digest check protects
// byte-integrity; this checks IDENTITY-binding, a different property.
//
// fix-cycle-2 (F-BINDING-NO-HOST-ALLOWLIST, MEDIUM, named by @architect's fix-cycle-1 re-review):
// checkArtifactBinding above binds the artifact to the right plugin_id, but a plugin_id-correct
// path on a COMPLETELY DIFFERENT SERVER still passed every check — nothing verified mirror_url's
// HOST was actually AIOX-operated R2. That directly undercuts AC3's promise (install must not
// depend on infra AIOX doesn't operate). checkArtifactHost (below) closes it.
//
// story 055.W3.3 (D24's three no-going-back invariants, on the CI side): adds
// checkIdImmutabilityAgainstLedger (check a), checkNameNotBurned (check b), and checkTierVocabulary
// (check d / AC8, the publish-time half of D21). Both (a) and (b) read a persistent ledger
// (lib/ledger.mjs, ledger/plugin-ids.json) that survives an index entry's removal — see that
// module's header for why it has to live outside index/index.json. Check (c), license-in-package-
// root, lives in lib/license-check.mjs (needs to open the artifact's actual bytes, a different kind
// of input than the other three).
// fix-cycle-2 (QG rounds 1+2, F9 — founder decision 2026-08-09): check (a) gains a real lineage
// field (`lineage_id`), because digest lineage alone only caught a same-bytes republish and let the
// REALISTIC rename (rename + version bump) through. See docs/INVARIANTS.md "check (a)" and
// checkIdImmutabilityAgainstLedger below. The entry schema_version goes 1.0.0 -> 2.0.0 with it.
import {
  digestsPublishedUnderOtherPluginIds,
  lineagesRegisteredUnderOtherPluginIds,
  recordedLineageOf,
} from "./ledger.mjs";

export const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
export const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

// The entry shape this repo currently emits and validates. Bumped from 1.0.0 by fix-cycle-2 (F9):
// `lineage_id` is a REQUIRED new field, which is a breaking change to the entry shape.
export const ENTRY_SCHEMA_VERSION = "2.0.0";

// lineage_id must be a canonical lowercase UUID — deliberately OPAQUE, and that opacity is the
// whole point (see checkIdImmutabilityAgainstLedger). Any format that looks human-meaningful (a
// slug, a name, the old plugin_id) invites an author to "rename" the lineage in the very same edit
// that renames the plugin, silently reopening the hole this field exists to close. A UUID gives
// them no reason to touch it.
export const LINEAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Single source of truth for which hosts are AIOX-operated artifact mirrors (D22). Adding a new
// bucket/host means editing EXACTLY this list — never scatter a host string anywhere else in this
// repo. Each entry is documented: what it is, and where it's operated (see
// docs/CATALOG-AND-MIRROR.md for the full operational writeup).
export const ALLOWED_ARTIFACT_HOSTS = Object.freeze([
  // aiox-education — Cloudflare R2 bucket, AIOX-operated, public read (no auth). The catalog's
  // artifact mirror for this story (055.W3.1) reuses this already-operated bucket; see
  // docs/CATALOG-AND-MIRROR.md "Why this bucket and not aiox-cockpit-beta".
  "pub-42179e62dc3040138151ec33229dd073.r2.dev",
]);

export function validateEntryShape(entry) {
  const errors = [];
  const tag = entry.plugin_id ? `"${entry.plugin_id}"` : "(no plugin_id)";
  if (entry.schema_version !== ENTRY_SCHEMA_VERSION)
    errors.push(`${tag}: schema_version must be '${ENTRY_SCHEMA_VERSION}'`);
  if (!KEBAB.test(entry.plugin_id ?? "")) errors.push(`${tag}: plugin_id must be kebab-case`);
  // fix-cycle-2 (F9): REQUIRED, and refused rather than defaulted. An entry with no lineage_id is a
  // plugin whose renames are permanently undetectable — the exact defect this field closes — so
  // "absent" can never be a passing state.
  if (!LINEAGE_ID.test(entry.lineage_id ?? ""))
    errors.push(
      `${tag}: lineage_id required and must be a canonical lowercase UUID (D24(a), F9) — this is the plugin's stable IDENTITY across version bumps and renames, not optional metadata; mint one ONCE for a genuinely new plugin (\`uuidgen | tr 'A-Z' 'a-z'\`) and never change it again`,
    );
  if (!SEMVER.test(entry.version ?? "")) errors.push(`${tag}: version must be semver`);
  if (!Array.isArray(entry.tiers) || entry.tiers.length === 0)
    errors.push(`${tag}: tiers must be a non-empty array`);
  if (!entry.digest || entry.digest.algorithm !== "sha256" || !SHA256_HEX.test(entry.digest.value ?? ""))
    errors.push(`${tag}: digest.{algorithm:'sha256', value:<64 hex>} required`);
  if (!entry.artifact?.mirror_url) errors.push(`${tag}: artifact.mirror_url required`);
  if (!entry.artifact?.r2_key)
    errors.push(`${tag}: artifact.r2_key required (fix-cycle-1 — needed to verify identity-binding, see checkArtifactBinding)`);
  if (!entry.publisher?.subject)
    errors.push(`${tag}: publisher.subject required (D22 — entitlement subject, never a GitHub handle)`);
  if (!entry.published_at) errors.push(`${tag}: published_at required`);
  if (!entry.license?.spdx_or_path) errors.push(`${tag}: license.spdx_or_path required (D24(c))`);
  if (entry.overlay?.shadows && typeof entry.overlay.shadows === "object") {
    for (const [skill, reason] of Object.entries(entry.overlay.shadows)) {
      if (!reason || typeof reason !== "string" || !reason.trim()) {
        errors.push(
          `${tag}: overlay.shadows.${skill} must carry a non-empty reason (D23) — an undeclared/empty reason is exactly the silent-override anti-pattern D23 exists to close`,
        );
      }
    }
  }
  return errors;
}

// fix-cycle-1 (F-AC6-ARTIFACT-BINDING): the entry's OWN plugin_id must appear as an exact path
// SEGMENT (not a substring match — "sinkra-os" must not satisfy "sinkra-os-extra") of both
// artifact.mirror_url's path and artifact.r2_key. This is a cross-field check the JSON Schema
// (draft-07, no $data extension used here) cannot express — it lives in code on both sides
// (publish-time refusal + CI re-check), per the shared-module import.
export function checkArtifactBinding(entry) {
  const errors = [];
  const pid = entry.plugin_id;
  if (!pid || !entry.artifact) return errors; // shape errors already reported by validateEntryShape

  const segmentsOf = (value) => {
    try {
      // works for absolute URLs (mirror_url) and for bare keys (r2_key) alike
      const asUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? new URL(value) : null;
      const path = asUrl ? asUrl.pathname : value;
      return path.split("/").filter(Boolean);
    } catch {
      return value.split("/").filter(Boolean);
    }
  };

  if (entry.artifact.mirror_url) {
    const segs = segmentsOf(entry.artifact.mirror_url);
    if (!segs.includes(pid)) {
      errors.push(
        `"${pid}": artifact.mirror_url is not namespaced under its own plugin_id — expected a path segment exactly equal to "${pid}" (convention: plugins/<plugin_id>/<version>/<sha256>.tar.gz). Got: ${entry.artifact.mirror_url}`,
      );
    }
  }
  if (entry.artifact.r2_key) {
    const segs = segmentsOf(entry.artifact.r2_key);
    if (!segs.includes(pid)) {
      errors.push(
        `"${pid}": artifact.r2_key is not namespaced under its own plugin_id — expected a path segment exactly equal to "${pid}". Got: ${entry.artifact.r2_key}`,
      );
    }
  }
  return errors;
}

// fix-cycle-2 (F-BINDING-NO-HOST-ALLOWLIST): artifact.mirror_url's HOST must be one of
// ALLOWED_ARTIFACT_HOSTS. checkArtifactBinding (above) proves the PATH is namespaced correctly;
// this proves the artifact is actually served from infrastructure AIOX operates — a
// correctly-namespaced path on an attacker-controlled host would pass checkArtifactBinding alone,
// which is exactly the gap this closes. mirror_url that doesn't even parse as an absolute URL is
// refused outright (the schema already requires format:"uri", so an unparseable value is itself a
// defect this check also catches).
export function checkArtifactHost(entry) {
  const errors = [];
  const pid = entry.plugin_id ?? "?";
  const url = entry.artifact?.mirror_url;
  if (!url) return errors; // shape errors already reported by validateEntryShape

  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    errors.push(`"${pid}": artifact.mirror_url is not a valid absolute URL — cannot verify its host is AIOX-operated. Got: ${url}`);
    return errors;
  }

  if (!ALLOWED_ARTIFACT_HOSTS.includes(host)) {
    errors.push(
      `"${pid}": artifact.mirror_url's host "${host}" is not an AIOX-operated mirror (allowed: ${ALLOWED_ARTIFACT_HOSTS.join(", ")}) — refusing: install must never depend on infrastructure AIOX does not operate (AC3, D22)`,
    );
  }
  return errors;
}

// D24(a)/(b) minimal guard — refuse a silent duplicate (same plugin_id+version already indexed
// with a DIFFERENT digest). The full burned-name ledger across retirement is 055.W3.3's job.
export function checkNoConflictingDuplicate(existingEntries, entry) {
  const clash = existingEntries.find(
    (e) => e.plugin_id === entry.plugin_id && e.version === entry.version,
  );
  if (clash && clash.digest?.value !== entry.digest?.value) {
    return [
      `plugin_id "${entry.plugin_id}" version "${entry.version}" is already indexed with a DIFFERENT digest — refusing to overwrite (D24 immutability)`,
    ];
  }
  if (clash) {
    return [
      `plugin_id "${entry.plugin_id}" version "${entry.version}" is already indexed (identical digest) — nothing to do`,
    ];
  }
  return [];
}

export function validateEntryFull(entry, existingEntries = []) {
  return [
    ...validateEntryShape(entry),
    ...checkArtifactBinding(entry),
    ...checkArtifactHost(entry),
    ...checkNoConflictingDuplicate(existingEntries, entry),
  ];
}

// ── story 055.W3.3 — D24's three no-going-back invariants, verified in CI ──────────────────────

// check (a) — id immutability (D24(a)), enforced against the persistent ledger on THREE independent
// rules. See docs/INVARIANTS.md "check (a)" for the full account; the short version:
//
// `plugin_id` is the immutable root of the <plugin_id>/<skill> namespace (D23) already projected
// onto every installed client's disk — changing it invalidates every path already installed. But
// "already registered for that plugin" presupposes an identity for "that plugin" that SURVIVES a
// plugin_id change. That identity is `lineage_id` (fix-cycle-2, F9): an opaque UUID, minted once for
// a genuinely new plugin, carried unchanged through every version bump, rebuild and display-name
// change for the rest of that plugin's life.
//
// (a1) LINEAGE COLLISION — this lineage_id is already registered under a DIFFERENT plugin_id.
//      Byte-independent, and therefore the rule that actually closes the realistic rename: an author
//      renaming a plugin normally bumps the version too, so the two identities share no bytes at all
//      and nothing digest-based can connect them.
// (a2) LINEAGE INSTABILITY — this plugin_id is already on record under a DIFFERENT lineage_id. A
//      lineage is set once and never rewritten; without this rule, an author could relabel an
//      existing plugin's lineage first and then rename under the freed-up identity.
// (a3) DIGEST LINEAGE — these exact bytes are already recorded under a different plugin_id. Kept
//      from the pre-F9 design as a second, byte-level net: it still fires when (a1) is evaded by
//      forging a fresh lineage_id but shipping the identical artifact.
//
// THE RESIDUAL, NAMED NOT HIDDEN: an author who changes BOTH the artifact's bytes AND forges a new
// lineage_id is, at the data level, declaring a brand-new plugin, and no mechanism on this side of
// the wire can distinguish that from an actually-new plugin. What changed with F9 is which case is
// the DEFAULT: before, the honest, ordinary rename (bump the version, rename the id) passed green
// and the invariant only caught the lazy same-bytes republish; now evading it requires deliberately
// forging an identity token. That is the difference between an invariant and a warning — the ask of
// this story's own AC4.
export function checkIdImmutabilityAgainstLedger(ledger, entry) {
  const errors = [];
  if (!entry.plugin_id) return errors;

  // (a1) — the lineage is already someone else's namespace root.
  if (entry.lineage_id) {
    const lineageOwner = lineagesRegisteredUnderOtherPluginIds(ledger, entry.plugin_id).get(entry.lineage_id);
    if (lineageOwner) {
      errors.push(
        `"${entry.plugin_id}": lineage_id ${entry.lineage_id} is already registered under a DIFFERENT plugin_id ("${lineageOwner}") — refusing: this is the same plugin trying to change its immutable namespace root, which is exactly what D24(a) forbids (plugin_id is the root of the <plugin_id>/<skill> namespace already projected onto every installed client's disk; changing it invalidates every path already installed). A version bump does NOT make this a different plugin. If it genuinely IS a different plugin, it needs its own lineage_id — and then it is a new plugin, not a rename of "${lineageOwner}".`,
      );
    }

    // (a2) — the plugin is trying to relabel its own identity.
    const onRecord = recordedLineageOf(ledger, entry.plugin_id);
    if (onRecord && onRecord !== entry.lineage_id) {
      errors.push(
        `"${entry.plugin_id}": this plugin_id is on record with lineage_id ${onRecord}, but this publish declares ${entry.lineage_id} — refusing: a plugin's lineage is set once at its first publish and never changes (D24(a)). Rewriting it would let the old lineage be reused under a new name, which is the rename this invariant exists to prevent, taken one step at a time.`,
      );
    }
  }

  // (a3) — byte-level net, retained from the pre-F9 design.
  if (entry.digest?.value) {
    const priorOwner = digestsPublishedUnderOtherPluginIds(ledger, entry.plugin_id).get(entry.digest.value);
    if (priorOwner) {
      errors.push(
        `"${entry.plugin_id}": these exact artifact bytes (digest ${entry.digest.value}) were already published under a DIFFERENT plugin_id ("${priorOwner}") — refusing: this is exactly the id-change D24(a) forbids. If this is genuinely a distinct package, its artifact must have distinct bytes.`,
      );
    }
  }

  return errors;
}

// check (b) — burned name (D24(b)). The ledger record for plugin_id persists (VC-1) even after
// every index entry for it has been removed by publisher/retire.mjs, so this check keeps refusing
// AFTER despublish — the literal proof AC2 asks for ("if the registry disappears with the entry,
// the check is decorative").
export function checkNameNotBurned(ledger, entry) {
  const errors = [];
  const rec = ledger.plugins?.[entry.plugin_id];
  if (rec?.status === "retired") {
    errors.push(
      `"${entry.plugin_id}": this plugin_id was retired at ${rec.retired_at}${
        rec.retired_reason ? ` (reason: ${rec.retired_reason})` : ""
      } — refusing to publish: a retired name is burned forever (D24(b)); reusing it would let an offline client's pinned name silently resolve to a different artifact (silent substitution).`,
    );
  }
  return errors;
}

// check (d) / AC8 — the publish-time half of D21. The tier vocabulary comes from the plugin's OWN
// manifest (VC-5), never a hardcoded CI list — the same trap VC-1 names in different clothes: a
// vocabulary that doesn't track the real data goes decorative the first time a plugin's vocabulary
// diverges from whatever example inspired the hardcode. `manifestTiers` is the FULL vocabulary the
// manifest declares; `emitTiers` is what THIS entry actually publishes (may be the full vocabulary,
// or any subset — a plugin can choose to enable only some of its declared tiers for a given
// version). Every item of `emitTiers` must be present in `manifestTiers`; the error message names
// BOTH the invalid tier(s) AND the valid vocabulary, per AC8's explicit requirement.
export function checkTierVocabulary(emitTiers, manifestTiers, pluginId = "?") {
  const errors = [];
  const vocab = Array.isArray(manifestTiers) ? manifestTiers : [];
  const emitted = Array.isArray(emitTiers) ? emitTiers : [];
  const invalid = emitted.filter((t) => !vocab.includes(t));
  if (invalid.length) {
    errors.push(
      `"${pluginId}": tier(s) ${invalid.map((t) => `"${t}"`).join(", ")} not declared in the plugin's own manifest vocabulary (valid: ${
        vocab.length ? vocab.map((t) => `"${t}"`).join(", ") : "(manifest declares no tiers)"
      }) — refusing (D21 publish-time half): a typo'd/undeclared tier must fail here, not surface on a paying client's machine at runtime.`,
    );
  }
  return errors;
}
