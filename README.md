# AIOX Plugins — the public plugin catalog

This repository is the **public, versioned index** of plugins installable by the AIOX Cockpit
(`Ajuda ▾` → Plugins). It is deliberately **separate from the product repository** — the product
repo is never referenced here in a way that would grant read access to its private content — so
that publishing a plugin never exposes product source, and installing a plugin never depends on
the *product* repository continuing to exist.

Decision record: `ADR-COCKPIT-ENTERPRISE-PREMIUM-PACK`, decisions D15–D24 (catalog: D22; namespace
+ declared shadowing: D23; the three no-going-back invariants: D24). This repo implements the
catalog side of those decisions; the Cockpit-side consumer lives in the product repo.

## What lives here

| Path | What | Status |
|---|---|---|
| `schema/index-entry.schema.json` | The versioned schema every index entry MUST conform to (AC2) | Enforced by CI (structural check) |
| `index/index.json` | **The production index.** Ships **empty** — see "Why the production index is empty" below | No real entries yet |
| `fixtures/` | A **non-production** index + artifact used only to prove the publish pipeline works end-to-end | Test data, never consumed by a real client |
| `publisher/` | The publish pipeline itself — an AIOX-operated service, **not** a human PR workflow (AC5, D22) | Base pipeline (v1) |
| `docs/CATALOG-AND-MIRROR.md` | How the index, the R2 artifact mirror, and the publish pipeline fit together | — |
| `docs/SCHEMA.md` | Field-by-field explanation of the index entry schema | — |

## Why the production index is empty

Three invariants have to exist **before** the first real publication, because they are
irreversible after it (D24): the plugin `id` becomes immutable, an unpublished name gets burned
forever, and a license becomes mandatory at the package root. The CI that **verifies** those three
invariants mechanically lives in a follow-up story (`055.W3.3`) and has not landed yet in this
repo's history at the time this scaffolding was created. Publishing a real entry before that CI
exists would invert the order the design itself requires. This repo's `index/index.json` therefore
ships with zero entries; `fixtures/index.json` proves the pipeline against disposable data instead.

## Identity: who can publish

The right to publish is itself an entitlement (D16). The identity recorded on every entry is the
**entitlement subject** (`publisher.subject`) — never a GitHub handle — because it is the same
mechanism that already proves payment and provisioning, and the same mechanism that can later
revoke the right to publish. See `publisher/README.md` for how the pipeline is invoked and what it
assumes about that identity today.

## No PR flow, by design

Nothing in this repository is written by a human opening a pull request against it. The entry is
written by an AIOX-operated service (`publisher/publish.mjs`) that commits and pushes directly.
This is the other half of D22: the product repo's GitHub client (`aiox-gh`) is read-only by
construction, and a publish-by-PR flow would have collided with that. Writing the catalog from a
service, keyed by entitlement subject, dissolves the collision instead of reintroducing write
access into a crate that is deliberately read-only.

## Artifact mirror

Artifacts are mirrored in Cloudflare R2 infrastructure **already operated** by AIOX (no new
infrastructure stood up for this repo) so that installing a plugin never depends on the author's
own repository staying online. See `docs/CATALOG-AND-MIRROR.md` for the bucket, the path
convention, and how a client is expected to verify what it downloads.

## What this repo does NOT do (yet)

- It does not describe or perform pruning, removal, or revocation of a published entry. That
  capability (index freshness + monotonic version, D20(5)) is scoped to a later story
  (`055.W5.1`) and does not exist here. Nothing in this repo should be read as claiming otherwise.
- It does not sign the index. Signing (D20(3)) is a separate story (`055.W4.3`) with its own key
  material, deliberately kept in a vault separate from the entitlement signing key.
- It does not run the secret-scanning / capability-analysis / version-pin checks of D20(1)(2)(4).
  Those are `055.W4.1`/`055.W4.2`.
