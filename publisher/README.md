# The publish pipeline

`publish.mjs` is the **only** writer of `index/index.json` and `fixtures/index.json`. It is meant
to be invoked by an AIOX-operated service after that service has independently verified the
caller's entitlement — this script trusts the `--subject` it is given and does not itself perform
that verification (see the header comment in `publish.mjs` for the explicit boundary).

## Why there is no PR flow here (AC5, D22)

The product repo's GitHub client (`aiox-gh`) is **read-only by construction**
(`crates/aiox-gh/src/client.rs:8-9`, AC 8 of that crate — "no mutation exists in this crate"). A
design where the publisher opens a PR against this catalog repo would need write access somewhere,
and the natural place for that write logic to leak into would have been `aiox-gh`. D22 resolves the
conflict from the other side instead: **the publisher does not open a PR at all.** It is a service
with its own git identity that commits and pushes directly to this repository — a fully separate
codebase from the product, with its own credentials, never touching `aiox-gh`.

## Usage

```bash
node publisher/publish.mjs \
  --manifest path/to/plugin-manifest.json \
  --target fixtures/index.json \
  --subject acct_example \
  --artifact path/to/plugin-artifact.tar.gz \
  --mirror-url https://pub-42179e62dc3040138151ec33229dd073.r2.dev/plugins/<plugin_id>/<version>/<sha256>.tar.gz \
  --r2-key plugins/<plugin_id>/<version>/<sha256>.tar.gz
```

`--artifact` computes the digest locally from the given file. If the artifact was already uploaded
and you only have its digest, pass `--digest <sha256>` instead of `--artifact`. `--mirror-url` and
`--r2-key` are **both required** (fix-cycle-1) — `<plugin_id>` in the two paths above MUST be an
exact match of the `plugin_id` inside `--manifest`, or the publish is refused (see "What this script
checks" below).

`plugin-manifest.json` shape (the input this script expects, distinct from the OUTPUT index entry
shape in `schema/index-entry.schema.json`):

```jsonc
{
  "plugin_id": "sinkra-os",
  "name": "SINKRA OS",
  "description": "...",
  "version": "1.2.3",
  "tiers": ["mapear", "forjar"],
  "license": "MIT",                 // or an in-package path
  "overlay": {                      // optional — omit entirely for no declared shadow
    "shadows": { "review": "the mandatory reason" }
  }
}
```

## What this script checks (base pipeline — see the header comment for the full boundary)

All checks live in `../lib/entry-schema.mjs`, shared with `scripts/validate-index.mjs` (the CI
gate) so publish-time and CI-time checks can never drift apart:

- Structural schema validation (mirrors `schema/index-entry.schema.json` without a schema-library
  dependency).
- **Artifact-identity binding (fix-cycle-1, `F-AC6-ARTIFACT-BINDING`):** `artifact.mirror_url` and
  `artifact.r2_key` must each contain the entry's own `plugin_id` as an exact path segment. AC4's
  digest check protects byte-integrity; this protects a different property — that the pointer
  actually points at THIS plugin's artifact, not some other plugin's. Demonstrated concretely: this
  check is what catches the exact mistake this repo's own fixture set originally shipped
  (`aiox-enterprise`'s entry pointing at a `sinkra-os/…` key).
- **Artifact-host allowlist (fix-cycle-2, `F-BINDING-NO-HOST-ALLOWLIST`):** `artifact.mirror_url`'s
  host must be one of `ALLOWED_ARTIFACT_HOSTS` (`../lib/entry-schema.mjs`, one named constant, edit
  it to add a mirror — never scatter a host string anywhere else). Binding alone proves the PATH is
  right; this proves the artifact is actually served from infrastructure AIOX operates. A
  correctly-namespaced path on `evil.example.com` used to pass every check before this fix.
- A minimal D24 guard: refuses to silently overwrite an existing `plugin_id`+`version` with a
  different digest.
- `overlay.shadows` reasons must be non-empty (D23) — an empty/missing reason is refused, not
  silently accepted.

All of the above are covered by automated tests (`../test/`, `node --test test/*.test.mjs`,
Node's built-in `node:test` — zero new dependency), wired into `.github/workflows/ci.yml` so they
run on every push (fix-cycle-2, closing the QG's "zero automated tests" finding).

## What it deliberately does NOT check yet

The three CI-enforced invariants of D24 (full immutable-`id` history, the burned-name ledger across
retirement, and a mechanical open-the-tarball license check) are story `055.W3.3`'s CI, layered on
top of this same repository. This script's guard is intentionally the minimum this story can
honestly claim — see its header comment. Two named, accepted residuals of the artifact-binding
check itself (LOW severity, `055.W3.3`-adjacent, deliberately not fixed this cycle):
`plugin_id` need only appear *somewhere* in the path, not at the canonical position
(`F-BINDING-POSITION-AGNOSTIC`); and the freely-typed `name` field can carry Unicode look-alike
characters (`F-HOMOGLYPH-NAME`, belongs to `055.W3.3`'s already-open `O4`). Both are pinned as
explicit regression tests in `../test/entry-schema.test.mjs` so the current, accepted behavior is a
deliberate choice, not silent drift.
