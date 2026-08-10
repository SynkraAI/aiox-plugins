# Index entry schema (v2.0.0)

Canonical, machine-checked definition: `schema/index-entry.schema.json`. This file is the human
explanation; the JSON Schema is the source of truth.

Story `055.W3.3` first landed with the entry SHAPE unchanged — only what gets VERIFIED changed: see
`INVARIANTS.md` for the four no-going-back invariants (D24 a/b/c + D21's publish-time tier check)
now enforced in CI. Its fix-cycle-2 then added **exactly one** new field, `lineage_id`, because the
QG's finding **F9** proved check (a) could not enforce D24(a) without one: comparing digests only
catches a same-bytes republish, never the realistic rename (rename + version bump). That is a
breaking change to the entry shape, hence `schema_version` `1.0.0` -> `2.0.0`. It was made while
the production index was still empty, which is the only moment it costs nothing —
`INVARIANTS.md` "check (a)" carries the full reasoning.

## Field-by-field

| Field | Required | Notes |
|---|---|---|
| `schema_version` | yes | Version of the entry SHAPE, not of the plugin. `"2.0.0"` today (`1.0.0` predates `lineage_id`). |
| `plugin_id` | yes | Kebab-case. Root of the `<plugin-id>/<skill>` namespace (D23). **Immutable after first publication** (D24(a)) and, once retired, the name is **never reused** (D24(b)) — these are the two irreversible choices this schema exists to protect. Immutability is enforced against `lineage_id`, never against this field alone: comparing a `plugin_id` to itself proves nothing. |
| `lineage_id` | **yes** (new in v2.0.0) | **IDENTITY, not metadata.** An opaque canonical lowercase UUID, minted **once** for a genuinely new plugin (`uuidgen \| tr 'A-Z' 'a-z'`) and never changed again — not on a version bump, not on a rebuild, not on a rename. It is what makes a `plugin_id` rename detectable *independently of the artifact's bytes*, which is the property D24(a) needs and digest lineage could not provide (finding **F9**). The opaque format is load-bearing: a human-meaningful value would invite an author to "update" it while renaming, reopening the hole. There is deliberately no auto-mint fallback — `publish.mjs` refuses a manifest without one rather than inventing a fresh identity that would silently disable the rename check forever after. Enforced at publish time, in CI against the ledger, across the ledger's whole git history, and within a single index file. |
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
| `capabilities` | no | **DERIVED** capability analysis (D17 + D20(4), story `055.W4.2`). Written EXCLUSIVELY by `publisher/publish.mjs` from `lib/capability-analyzer.mjs`, computed from the artifact's own bytes. Carries `self_declared: false` as data, the per-skill **two signals** (`owns_scripts` / `instructs_execution`), the derived `union`, and a **non-empty `limits`** array. The publisher has **no manifest field** that feeds this — a manifest carrying `capabilities`/`permissions`/`grants`/`sandbox`/`trust_level` is refused outright. See `docs/CAPABILITIES.md`. |
| `overlay.shadows` | no | Present only when the plugin declares shadowing one or more base skills (D23). `{ "<base-skill>": "<mandatory reason>" }`. This is **REUSE**, not a new mechanism — it mirrors the identical `overlay.shadows` block already defined and enforced in the product repo's `.aiox-core/sync/OVERLAY-MANIFEST.md` (story `055.W2.2`). The catalog only *renders* it (AC9). |

## What is deliberately absent from this version of the schema

- Anything describing expiry, freshness, or revocation. That capability (D20(5), monotonic index
  version + `expires`) is scoped to story `055.W5.1` and does not exist yet — adding a field for it
  now, before the mechanism exists, would make the schema imply behavior the repo doesn't have.
- A signature field over the entry or the index. Signing the index (D20(3)) is story `055.W4.3`,
  with its own key material in a vault kept separate from the entitlement signing key.
- Any field in which a PUBLISHER could state its own capabilities. Its absence is the point, not an
  omission (D17/AC3, story `055.W4.2`): a capability asserted by the party being assessed is worth
  zero, so the only capability data in an entry is the DERIVED `capabilities` block above. This is
  enforced as a refusal at publish time, never as a silently-ignored field.

## Versioning this schema

`schema_version` is a closed value per release of the schema (currently only `"2.0.0"` validates —
`lib/entry-schema.mjs::ENTRY_SCHEMA_VERSION` is the single constant every check reads, so the
publisher and CI can never disagree about which version is current).

The `1.0.0` -> `2.0.0` bump (fix-cycle-2, F9) shipped **without** a dual-shape transition period,
and that was a deliberate, one-time affordance rather than a precedent: both `index/index.json` and
`ledger/plugin-ids.json` were still empty, so there was no old-shape data anywhere to read. A future
breaking change will not have that luxury — once real entries exist, each is pinned by digest by
offline clients, and the bump will have to ship alongside a CI check that can read both shapes
during the transition.
