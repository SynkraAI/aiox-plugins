# Index entry schema (v1.0.0)

Canonical, machine-checked definition: `schema/index-entry.schema.json`. This file is the human
explanation; the JSON Schema is the source of truth.

## Field-by-field

| Field | Required | Notes |
|---|---|---|
| `schema_version` | yes | Version of the entry SHAPE, not of the plugin. `"1.0.0"` today. |
| `plugin_id` | yes | Kebab-case. Root of the `<plugin-id>/<skill>` namespace (D23). **Immutable after first publication** (D24(a)) and, once retired, the name is **never reused** (D24(b)) — these are the two irreversible choices this schema exists to protect. |
| `name` | no | Display name. Free to change across versions. |
| `description` | no | Free text. |
| `version` | yes | Semver of the plugin package (not of the schema). |
| `tiers` | yes | The tier vocabulary this plugin accepts. **Source of truth is the plugin's own manifest** (D21) — an entry whose `tiers` don't match what the manifest declares is a publish-time failure, not a schema violation this file alone can catch. |
| `digest` | yes | `{ algorithm: "sha256", value: <64 hex chars> }` of the exact bytes mirrored in R2. A client MUST recompute this after download and refuse to install on mismatch (AC4). |
| `artifact.mirror_url` | yes | Public URL in AIOX-operated R2 — see `CATALOG-AND-MIRROR.md`. Never a pointer back into the author's own repository (that dependency is exactly what D22 removes). **MUST contain the entry's own `plugin_id` as an exact path segment** — enforced in code (`lib/entry-schema.mjs::checkArtifactBinding`, fix-cycle-1), because AC4's digest check protects byte-integrity but not *identity*-binding: nothing else stops an entry from pointing at a different plugin's artifact. **MUST also resolve to a host in `ALLOWED_ARTIFACT_HOSTS`** (`lib/entry-schema.mjs::checkArtifactHost`, fix-cycle-2) — a correctly plugin_id-namespaced path on a foreign/attacker-controlled server used to pass every other check; this closes that gap, protecting AC3's actual promise (install never depends on infra AIOX doesn't operate). |
| `artifact.r2_key` | **yes** (was optional; tightened fix-cycle-1) | The object key inside the bucket. Required because the identity-binding check above needs it — convention: `plugins/<plugin_id>/<version>/<sha256>.tar.gz`. |
| `publisher.subject` | yes | The entitlement subject that published this entry (D22). Never a GitHub handle — publishing is itself an entitlement (D16). |
| `published_at` | yes | ISO-8601 timestamp. |
| `license.spdx_or_path` | yes | SPDX id or in-package path to the license found at the package root, checked at publish (D24(c)). |
| `overlay.shadows` | no | Present only when the plugin declares shadowing one or more base skills (D23). `{ "<base-skill>": "<mandatory reason>" }`. This is **REUSE**, not a new mechanism — it mirrors the identical `overlay.shadows` block already defined and enforced in the product repo's `.aiox-core/sync/OVERLAY-MANIFEST.md` (story `055.W2.2`). The catalog only *renders* it (AC9). |

## What is deliberately absent from this version of the schema

- Anything describing expiry, freshness, or revocation. That capability (D20(5), monotonic index
  version + `expires`) is scoped to story `055.W5.1` and does not exist yet — adding a field for it
  now, before the mechanism exists, would make the schema imply behavior the repo doesn't have.
- A signature field over the entry or the index. Signing the index (D20(3)) is story `055.W4.3`,
  with its own key material in a vault kept separate from the entitlement signing key.

## Versioning this schema

`schema_version` is a closed value per release of the schema (currently only `"1.0.0"` validates).
A breaking change to the entry shape bumps this constant and is expected to ship alongside a CI
check that can read both the old and the new shape during the transition — not designed here, since
no second version exists yet.
