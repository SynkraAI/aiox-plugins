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
import { digestsPublishedUnderOtherPluginIds } from "./ledger.mjs";

export const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
export const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

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
  if (entry.schema_version !== "1.0.0") errors.push(`${tag}: schema_version must be '1.0.0'`);
  if (!KEBAB.test(entry.plugin_id ?? "")) errors.push(`${tag}: plugin_id must be kebab-case`);
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

// check (a) — id immutability, enforced via DIGEST LINEAGE, NOT a fabricated "origin/lineage" field.
// See docs/INVARIANTS.md "check (a): why digest lineage, not a new field" for the full reasoning —
// summarized here: nothing in the manifest/schema today carries an identity that survives a
// plugin_id change (no origin_id/UUID exists, and inventing one now — before it has ever been
// needed by a real caller — would be exactly the kind of speculative field the No-Invention
// principle exists to block). The one non-fabricated signal that DOES survive is the artifact's own
// digest: if the EXACT SAME bytes were already published under a DIFFERENT plugin_id, that is
// direct, mechanical evidence that "this is the same package trying to change its immutable
// namespace root" (D24(a); D23 made plugin_id the root of the <plugin_id>/<skill> namespace already
// projected onto every installed client's disk — changing it invalidates every path already
// installed).
//
// NAMED, DOCUMENTED SCOPE (not hidden): this does NOT catch a rename where the author ALSO changes
// the artifact's bytes (a version bump, a rebuild) — that is indistinguishable from a brand-new
// plugin at the data level without a lineage field that does not exist. Closing that wider gap is
// future work if it's ever needed; this is the honest, provable slice available today.
export function checkIdImmutabilityAgainstLedger(ledger, entry) {
  const errors = [];
  if (!entry.plugin_id || !entry.digest?.value) return errors;
  const owners = digestsPublishedUnderOtherPluginIds(ledger, entry.plugin_id);
  const priorOwner = owners.get(entry.digest.value);
  if (priorOwner) {
    errors.push(
      `"${entry.plugin_id}": these exact artifact bytes (digest ${entry.digest.value}) were already published under a DIFFERENT plugin_id ("${priorOwner}") — refusing: this is exactly the id-change D24(a) forbids (plugin_id is the immutable root of the <plugin_id>/<skill> namespace already projected onto every installed client's disk; changing it invalidates every path already installed). If this is genuinely a distinct package, its artifact must have distinct bytes.`,
    );
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
