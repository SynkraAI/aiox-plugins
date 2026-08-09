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
