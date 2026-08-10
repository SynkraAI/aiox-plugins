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
  --ledger ledger/plugin-ids.json \
  --subject acct_example \
  --artifact path/to/plugin-artifact.tar.gz \
  --mirror-url https://pub-42179e62dc3040138151ec33229dd073.r2.dev/plugins/<plugin_id>/<version>/<sha256>.tar.gz \
  --r2-key plugins/<plugin_id>/<version>/<sha256>.tar.gz \
  [--emit-tiers base,pro]
```

**`--artifact` is REQUIRED as of story `055.W3.3`** (was one of two alternatives with `--digest`,
`055.W3.1`) — it computes the digest locally from the given file, and the file itself is opened to
verify a license exists at its package root (check c, D24(c); a digest alone cannot prove what a
tarball contains). If `--digest` is also passed, it is now a cross-check against the digest computed
from `--artifact` (must match, or the publish is refused), not an alternative input mode.
`--mirror-url` and `--r2-key` are **both required** (fix-cycle-1) — `<plugin_id>` in the two paths
above MUST be an exact match of the `plugin_id` inside `--manifest`, or the publish is refused (see
"What this script checks" below). **`--ledger` is REQUIRED as of `055.W3.3`** — the persistent,
append-only registry (`../lib/ledger.mjs`) that checks (a)/(b) read and write; `--target` and
`--ledger` are always committed+pushed together in the same commit when `--no-push` is absent.
**`manifest.lineage_id` is REQUIRED as of `055.W3.3` fix-cycle-2 (F9)** — it is a manifest field,
not a CLI flag, precisely because it belongs to the plugin permanently rather than to one
invocation. A manifest without it is refused at the usage level, with an error that says how to
mint one for a new plugin and where to find the existing one for a known plugin.
**`--emit-tiers <csv>`, new and optional (`055.W3.3`, `AC8`):** the tiers this specific publish
actually enables — defaults to the manifest's own `tiers` (full vocabulary) when omitted, so every
pre-`055.W3.3` invocation shape still works unchanged. See `../docs/INVARIANTS.md` for why this flag
exists (it's what makes check (d) non-tautological).

`plugin-manifest.json` shape (the input this script expects, distinct from the OUTPUT index entry
shape in `schema/index-entry.schema.json`):

```jsonc
{
  "plugin_id": "sinkra-os",
  // REQUIRED as of 055.W3.3 fix-cycle-2 (F9). The plugin's stable IDENTITY, not metadata: mint it
  // ONCE for a genuinely new plugin (`uuidgen | tr 'A-Z' 'a-z'`) and never change it again — not on
  // a version bump, not on a rebuild, not on a rename. It is what lets the catalog detect a
  // plugin_id rename independently of the artifact's bytes (D24(a)). For an EXISTING plugin, copy
  // the value already recorded in ledger/plugin-ids.json; do NOT mint a new one. publish.mjs
  // refuses a manifest without it rather than generating one — see ../docs/INVARIANTS.md "check (a)".
  "lineage_id": "3f2a91c4-0b7e-4d18-9a6f-2c5b8e1d7a40",
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
- **Id immutability via `lineage_id` (`055.W3.3`, check a, D24(a); reinforced in fix-cycle-2 by the
  QG's finding F9):** three independent rules — refuses a publish whose `lineage_id` is already
  registered under a DIFFERENT `plugin_id` (the realistic rename: rename **+ version bump**, caught
  independently of the bytes), one that declares a DIFFERENT `lineage_id` for a `plugin_id` already
  on record (no relabelling your own identity), and one whose artifact bytes were already recorded
  under a different `plugin_id` (the byte-level net kept from the original design). The first rule
  is the one that made this check an invariant rather than a warning — before it, an author who
  renamed and bumped the version passed verde. See `../docs/INVARIANTS.md` "check (a)" for the full
  account, including the residual named rather than hidden.
- **Burned-name rejection (`055.W3.3`, check b, D24(b)):** refuses a publish under a `plugin_id`
  the ledger has marked `retired` — see `../publisher/retire.mjs` and `../docs/INVARIANTS.md`.
- **License-in-package-root (`055.W3.3`, check c, D24(c)):** opens the artifact tarball
  (`../lib/license-check.mjs`) and requires a LICENSE/LICENCE/COPYING file at the true package root.
- **Tier vocabulary from the manifest (`055.W3.3`, check d, `AC8`, D21 publish-time half):** refuses
  a publish whose `--emit-tiers` includes a tier the manifest itself doesn't declare, naming both the
  invalid tier and the valid vocabulary.
- **Mandatory `allowed-tools` (`055.W4.2`, D17/AC1):** every publishable skill must declare
  `allowed-tools`; a skill with none — or with an empty value, a wildcard, or the silently-ignored
  `allowed_tools`/`allowedTools` spelling — is refused. A manifest that tries to **self-declare**
  `capabilities`/`permissions`/`grants`/`sandbox`/`trust_level` is likewise refused rather than
  ignored (capabilities are DERIVED on the AIOX side — `../lib/capability-analyzer.mjs`,
  `../docs/CAPABILITIES.md`).
- **Secret scanning (`055.W4.1`, D20(1)):** refuses a publish when a recognisable credential is found
  in the **manifest** (which becomes a public catalog entry) or in the **artifact's real bytes**,
  using a vendored subset of gitleaks' rule corpus (`../lib/secret-rules.mjs` — 14 rules / 14 classes,
  each with a negative fixture through this very CLI). **Also refuses when a member could not be
  scanned at all** — binary, over the size cap, a **duplicate/shadowed member path**, a non-regular
  member (symlink/hardlink/FIFO/socket/device), or a path escaping the package root — because
  unscannable is treated as not publishable (fail-closed; see `../docs/SECRET-SCANNING.md` §5.1 for
  the decision, its named cost, and why there is deliberately no override flag, and §5.2 for why the
  inventory comes from the archive's **member table** rather than from the extracted tree). What the
  scan can and cannot see is printed on **every** run, including a successful one.

All of the above are BLOCKING, unconditionally — no flag/env var/branch disables any of them
(AC4/AC6; see the story's handoff for the literal bypass-grep command + output).

> **Keeping this list true is part of the job.** This enumeration reads as complete, so a gate that
> ships without a line here is a gate readers will not know exists — the `055.W4.1` QG caught exactly
> that (finding `F3`: two shipped blocking gates missing from this list, while the paragraph below
> still announced one of them as unbuilt). If you add a blocking check to `publish.mjs`, add it here
> in the same commit.

All checks are covered by automated tests (`../test/`, `node --test test/*.test.mjs`, Node's
built-in `node:test` — zero new dependency), wired into `.github/workflows/ci.yml` so they run on
every push.

## What it deliberately does NOT check yet

Two named, accepted residuals of the artifact-binding check itself (LOW severity, deliberately not
fixed): `plugin_id` need only appear *somewhere* in the path, not at the canonical position
(`F-BINDING-POSITION-AGNOSTIC`); and the freely-typed `name` field can carry Unicode look-alike
characters (`F-HOMOGLYPH-NAME`, belongs to the still-open `O4` curation question). Both are pinned as
explicit regression tests in `../test/entry-schema.test.mjs` so the current, accepted behavior is a
deliberate choice, not silent drift.

D20(1) (blocking secret scanning) and D20(4) (capability analysis) **are now built** and gate this
very script — see the two entries added to the blocking list above (`055.W4.1` and `055.W4.2`
respectively). D20(2) (version pin + separate plugin channel) also landed in `055.W4.1`, but
deliberately **not** inside this script: a pin is resolved by a *consumer* against an index
(`../lib/pin.mjs`, `../scripts/resolve-pin.mjs`), not asserted by the publisher, so there is nothing
for `publish.mjs` to check. What remains genuinely unbuilt here is **D20(3)** — AIOX signing the
index — which is `055.W4.3`, and **D20(5)** — index freshness (`expires` + a monotonic version),
which is `055.W5.1` and is also what would give back the ability to repair an already-installed
artifact.
