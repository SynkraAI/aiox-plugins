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
| `publisher/` | The publish pipeline (`publish.mjs`) and the despublish pipeline (`retire.mjs`) — both AIOX-operated services, **not** a human PR workflow (AC5, D22) | Full D24 invariant suite wired in (`055.W3.3`) |
| `lib/entry-schema.mjs` | Shared validation (shape, artifact-identity binding, artifact-host allowlist, id-immutability, burned-name, tier-vocabulary) — imported by BOTH `publisher/publish.mjs` and `scripts/validate-index.mjs`/`scripts/check-ledger-consistency.mjs` | Enforced publish-time AND in CI |
| `lib/license-check.mjs` | Opens the artifact tarball and verifies a license file at the package root (D24(c)) | Enforced publish-time |
| `lib/ledger.mjs` | The persistent, append-only registry of every `plugin_id` ever published (`ledger/plugin-ids.json`) — survives an index entry's removal (VC-1) | — |
| `ledger/plugin-ids.json` | The ledger itself. Ships with zero real plugins, matching the production index | Append-only, proved across its entire git history |
| `scripts/check-ledger-append-only.mjs` | CI proof that the ledger's git history never removed/mutated an existing record | Run on every push |
| `scripts/check-ledger-consistency.mjs` | CI structural re-check of id-immutability/burned-name against `index/index.json`, independent of publish-time | Run on every push |
| `test/` | Automated unit tests (`node:test`, zero dependency) for `lib/`, the `publish.mjs`/`retire.mjs` CLIs, `render-catalog.mjs`, and the ledger checks | Run on every push (`ci.yml`) |
| `docs/CATALOG-AND-MIRROR.md` | How the index, the R2 artifact mirror, and the publish pipeline fit together | — |
| `docs/SCHEMA.md` | Field-by-field explanation of the index entry schema | — |
| `docs/INVARIANTS.md` | The four no-going-back invariants (D24 a/b/c + D21's `AC8`), how each is verified, and the explicitly-named design boundaries | — |

## Capability analysis + mandatory `allowed-tools` (`055.W4.2`)

Every publishable skill MUST declare `allowed-tools` (kebab-case; comma/space string or YAML list).
Publishing without it fails, unconditionally. Capabilities shown to the user are **DERIVED** by
AIOX-side static analysis from the artifact's bytes — the publisher has no field in which to
declare them, and a manifest that tries is refused.

This delivers **visibility, not containment**: nothing here sandboxes a plugin. v1 **warns and
displays**; the blocking path exists in code, off by configuration, with the documented trigger
"when opening to externals".

```bash
node scripts/analyze-capabilities.mjs --artifact <plugin.tar.gz> --require-allowed-tools
node scripts/analyze-capabilities.mjs --dir <skills-dir> --json
```

Full design reasoning, the two signals, and what the analysis **cannot** see: `docs/CAPABILITIES.md`.

## Testing

```bash
node --test test/*.test.mjs
```

Node's built-in test runner — zero dependency added to a scaffolding repo. Covers: every refusal
path in `lib/entry-schema.mjs` (artifact-identity binding, artifact-host allowlist, the D24
duplicate/immutability guard, shape validation), `escapeMd`'s HTML/Markdown/injection neutralization
plus AC9 legibility for benign input, `renderCatalog`'s positive/negative shadow-warning cases, the
`publish.mjs` CLI end to end (always with `--no-push` — no test ever runs `git commit`/`git push`),
`validate-index.mjs`'s CI-side gate, and a regression pin that `index/index.json` (production) stays
empty (VC-5). Wired into `.github/workflows/ci.yml`, runs on every push and PR.

## Why the production index is empty

Three invariants have to exist **before** the first real publication, because they are
irreversible after it (D24): the plugin `id` becomes immutable (enforced against each entry's
`lineage_id`, its stable identity across version bumps — see `docs/INVARIANTS.md` "Check (a)"), a
**retired** `plugin_id` is **burned forever** (never reused by any publisher, enforced by the
persistent ledger — see `docs/INVARIANTS.md` "Check (b)"), and a license becomes mandatory at the
package root. The same "before it exists, it costs nothing" logic is why the entry schema went
`1.0.0` -> `2.0.0` inside this story: adding the required `lineage_id` was free while this index was
still empty, and would have been a migration of an artifact every offline client pins by digest one
publication later. A fourth, the publish-time half of
D21 (`AC8`), was moved into the same story so a typo'd tier fails at publish, not on a paying
client's machine. The CI that **verifies** all four now exists (`055.W3.3` — see
`docs/INVARIANTS.md`), but the first real publication is still a deliberate, separate authorization
this story's own dispatch did not grant: `index/index.json` therefore continues to ship with zero
entries; `fixtures/index.json` proves the pipeline against disposable data instead.

## Identity: who can publish

The right to publish is itself an entitlement (D16). The identity recorded on every entry is the
**entitlement subject** (`publisher.subject`) — never a GitHub handle — because it is the same
mechanism that already proves payment and provisioning. See `publisher/README.md` for how the
pipeline is invoked and what it assumes about that identity today. (`publisher/retire.mjs`,
`055.W3.3`, is the one deliberate exception to "nothing removes an entry" — see "Despublishing" below
and `docs/INVARIANTS.md`; it does not act on identity, and it is distinct from the automatic index-
freshness/expiry mechanism of D20(5), which still does not exist — see "What this repo does NOT do
(yet)".)

## Despublishing (`publisher/retire.mjs`, `055.W3.3`)

`retire.mjs` removes a `plugin_id`'s entry from a target index file AND, in the same operation,
flips that `plugin_id`'s record in `ledger/plugin-ids.json` to `status: "retired"` — see
`docs/INVARIANTS.md` "Check (b)" for why both writes always happen together. This is a **manual,
explicit** operation with a mandatory `--reason`; it is not the automatic index-freshness/expiry
mechanism of D20(5) (still `055.W5.1`, still does not exist) — retiring a plugin here is a deliberate
act by whoever operates the pipeline, not something the system does on its own on a schedule or a
version pin.

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

## Repository hygiene — branch protection on `main` (fix-cycle-1)

`main` has branch protection (verify: `gh api repos/SynkraAI/aiox-plugins/branches/main/protection`).
What is on, what is deliberately off, and why:

| Setting | Value | Why |
|---|---|---|
| `allow_force_pushes` | **off** | The commit history (every real publish) can't be rewritten. |
| `allow_deletions` | **off** | `main` can't be deleted out from under installed clients. |
| `required_linear_history` | **on** | No merge commits muddying the index's history. |
| `required_status_checks` | **on**, `contexts: ["validate"]`, strict | If a PR is ever opened against this repo (e.g. by a human collaborator, since the publisher never opens one), CI must pass before it can merge. |
| `required_pull_request_reviews` | **off, deliberately** | Turning this on would require EVERY change — including `publisher/publish.mjs`'s own direct commits — to go through a PR, which contradicts D22 (the publisher does not open a PR). This is the one setting NOT applied, and it's the reason the two facts ("branch is protected" and "the publisher pushes straight to main") are not in tension. |
| `enforce_admins` | **off** | Consistent with the row above — nothing here should silently start blocking the publisher. |
| `restrictions` (who may push) | **not set** (any collaborator with write access) | There is currently no distinct machine identity to name here — see the backlog card below. |

**What this protects against, concretely:** nobody (accidentally or otherwise) rewrites or deletes
the published history. **What it does NOT protect against yet:** a human collaborator with write
access hand-editing `index/index.json` directly, bypassing `publisher/publish.mjs`'s validation
(schema, artifact-identity binding, D24 duplicate guard) entirely — CI would catch it, but only
*after* the push lands, not as a merge gate, because there is no PR step to gate. Closing that gap needs a distinct service credential that `restrictions` can name instead of "anyone
with write" — tracked, not fixed here, as a backlog card in the product repo (a founder-level
infra/cost decision, not a catalog-repo code change; not linked from here, consistent with this
repo never referencing the product repo, AC1).

## What this repo does NOT do (yet)

- It does not perform *automatic* pruning, removal, or revocation of a published entry based on
  freshness/staleness. That capability (index freshness + monotonic version, D20(5)) is scoped to a
  later story (`055.W5.1`) and does not exist here. What this repo DOES have, as of `055.W3.3`, is
  `publisher/retire.mjs` — a manual, explicit despublish operation with a mandatory reason, needed to
  make check (b)'s "burned name" invariant provable at all (see "Despublishing" above and
  `docs/INVARIANTS.md`). Neither retirement nor anything else here acts based on entitlement/identity
  — see the "Identity" section above.
- It does not sign the index. Signing (D20(3)) is a separate story (`055.W4.3`) with its own key
  material, deliberately kept in a vault separate from the entitlement signing key.
- It does not run the secret-scanning / capability-analysis / version-pin checks of D20(1)(2)(4).
  Those are `055.W4.1`/`055.W4.2`.
