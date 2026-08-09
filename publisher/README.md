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
  --mirror-url https://pub-42179e62dc3040138151ec33229dd073.r2.dev/plugins-fixtures/... \
  --r2-key plugins-fixtures/...
```

`--artifact` computes the digest locally from the given file. If the artifact was already uploaded
and you only have its digest, pass `--digest <sha256> --mirror-url <url>` instead.

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

- Structural schema validation (mirrors `schema/index-entry.schema.json` without a schema-library
  dependency).
- A minimal D24 guard: refuses to silently overwrite an existing `plugin_id`+`version` with a
  different digest.
- `overlay.shadows` reasons must be non-empty (D23) — an empty/missing reason is refused, not
  silently accepted.

## What it deliberately does NOT check yet

The three CI-enforced invariants of D24 (full immutable-`id` history, the burned-name ledger across
retirement, and a mechanical open-the-tarball license check) are story `055.W3.3`'s CI, layered on
top of this same repository. This script's guard is intentionally the minimum this story can
honestly claim — see its header comment.
