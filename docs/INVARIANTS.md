# The four no-going-back invariants, verified in CI (story 055.W3.3)

Decision record: `ADR-COCKPIT-ENTERPRISE-PREMIUM-PACK`, D24 (checks a/b/c) and D21 (check d, `AC8`,
moved here from `055.W2.1`). This document is the human explanation of *how* — and, for check (a)
specifically, an explicit account of a design boundary named rather than hidden.

All four checks are **BLOCKING, always** (AC4/VC-2). There is no flag, environment variable, or
branch that disables any of them — verified by an active grep sweep of `publisher/`, `scripts/`, and
`.github/workflows/ci.yml` on every close of this story (see the story's handoff for the literal
command + output).

## Check (a) — `id` immutability, via `lineage_id`

**The trap this story names explicitly:** a check that only compares an entry's `plugin_id` to
itself passes verde always and proves nothing. "Already registered for that plugin" presupposes an
identity for "that plugin" that survives a `plugin_id` change.

### The first attempt, and why it was not enough (F9)

The original design of this check used the one signal already present in the data: the artifact's
**digest**. Refuse a publish when the exact same bytes were already recorded under a different
`plugin_id`. The reasoning was No-Invention — nothing in the manifest carried a lineage, so rather
than fabricate a field, use a byte-for-byte fact the ledger already had.

The QG (rounds 1 and 2, finding **F9**) named the hole, and the founder ruled on it on 2026-08-09:
**digest lineage only catches the lazy case.** An author who renames a plugin, in practice, also
bumps its version — so the two identities share no bytes at all, and nothing digest-based can
connect them. The check passed verde on the case it exists to prevent, and fired only on an
exact-byte republish nobody realistically performs. Reproduced literally before the fix: two
publishes, `aiox-enterprise@1.0.0` then `aiox-enterprise-renamed@1.1.0` with rebuilt bytes, both
accepted, exit `0`, two entries in the index.

That failed this story's own bar twice over: `AC4` ("an invariant that only warns is not an
invariant") and `AC5` ("a check that passes verde against a valid input proves nothing").

### What the check is now

`lineage_id` — an opaque, canonical lowercase UUID, declared in the plugin's manifest, **minted once
for a genuinely new plugin and never changed again**: not on a version bump, not on a rebuild, not
on a display-name change, and above all not on a rename. It is IDENTITY, not metadata. It is
`REQUIRED` on every entry (`schema/index-entry.schema.json`, `lib/entry-schema.mjs::validateEntry-
Shape`) and stamped into the ledger record at first publish (`lib/ledger.mjs::recordPublish`).

`checkIdImmutabilityAgainstLedger` (`lib/entry-schema.mjs`) now enforces three independent rules:

| Rule | What it refuses | What it catches that the others don't |
|---|---|---|
| **(a1) lineage collision** | This `lineage_id` is already registered under a **different** `plugin_id` | The realistic rename: rename + version bump, **byte-independent** — this is the F9 fix |
| **(a2) lineage instability** | This `plugin_id` is on record with a **different** `lineage_id` | The two-step evasion: relabel your own identity first, then rename under the freed-up lineage |
| **(a3) digest lineage** | These exact bytes are already recorded under a different `plugin_id` | A forged fresh `lineage_id` shipped with the **identical** artifact — the pre-F9 rule, kept as a second net |

**Two design choices that are load-bearing, not cosmetic:**

1. **The UUID format.** A human-meaningful lineage value (a slug, a name, the old `plugin_id`) would
   invite an author to "update" it in the very same edit that renames the plugin — silently
   reopening the hole. An opaque UUID gives them no reason to touch it.
2. **No auto-mint fallback.** `publish.mjs` refuses a manifest with no `lineage_id` instead of
   generating one. If it minted a value whenever one was absent, an author who simply forgot to
   carry theirs forward would receive a fresh identity and every later rename would pass verde —
   the exact defect the field exists to close, reintroduced as a convenience. Fail-closed is the
   only shape of this that is an invariant rather than a warning.

**The residual, named not hidden:** an author who changes **both** the artifact's bytes **and**
forges a new `lineage_id` is, at the data level, declaring a brand-new plugin, and nothing on this
side of the wire can distinguish that from an actually-new plugin. What F9 changed is which case is
the *default*: before, the honest, ordinary rename passed verde; now evading the invariant requires
deliberately forging an identity token, which is an act, not an oversight.

**Why the field could be added at all:** the production `index/index.json` was still `{"entries":
[]}` and the ledger still `{"plugins": {}}` when this landed. A required new field costs **zero**
now and becomes a migration of an artifact every client pins by digest the moment the first real
entry ships. That is the same reasoning that made D24 worth ratifying before a catalog existed:
these things only cost nothing before they exist.

**Negative fixtures (`AC5`), all through the real CLI as a subprocess:**
`test/publish-cli.test.mjs`, describe "check (a)" — the rename-with-version-bump refusal (the F9
fixture), the relabelling refusal, the missing-`lineage_id` refusal, the same-bytes-forged-lineage
refusal, plus three positive controls (a genuinely new plugin, a legitimate version bump, and a
distinct plugin with its own lineage) so the check is provably not a blanket refusal.
`test/entry-schema.test.mjs` covers the same rules at the function level.

**CI-side re-proof, independent of publish-time:** `scripts/check-ledger-consistency.mjs` re-derives
all three rules purely from the committed index + ledger, so a hand-edited `index/index.json` that
skipped `publisher/publish.mjs` entirely is still caught (see "Why `fixtures/index.json` is out of
this check's scope" below for exactly what it does and does not cover). `scripts/validate-index.mjs`
additionally checks lineage consistency **within a single index file** — one `lineage_id` under two
`plugin_id`s, or one `plugin_id` under two `lineage_id`s — which catches a rename added as both
entries in one hand-edit that never touched the ledger at all. And
`scripts/check-ledger-append-only.mjs` proves no `lineage_id` was ever rewritten or dropped across
the ledger's entire git history, since a rewritable identity would be trivially defeatable one
commit at a time.

## Check (b) — burned name survives despublish

**The trap this story names explicitly (VC-1):** if the burned-name registry lived *inside* the
catalog entry itself, despublishing would erase the memory that the name ever existed, and the check
becomes decorative — it would pass verde against a republish of a retired name, because there'd be
nothing left recording that it was ever retired.

**What actually happens:** `ledger/plugin-ids.json` (`lib/ledger.mjs`) is a **separate file** from
`index/index.json`/`fixtures/index.json`. `publisher/retire.mjs` is the *only* script that removes an
entry from an index file, and it *always*, in the same operation, flips that `plugin_id`'s ledger
record to `status: "retired"` — the two can never drift apart because one script does both writes.
`checkNameNotBurned` (`lib/entry-schema.mjs`) reads the ledger, not the index, so it keeps refusing
long after the index entry is gone.

**Proved by a real round-trip**, not by inspection: `test/publish-cli.test.mjs` publishes a plugin,
retires it (confirming the index entry is actually gone), then attempts to republish under the same
`plugin_id` and asserts the refusal names "retired" and "burned forever". This is the literal ask of
AC2: "if the registry disappears with the entry, the check is decorative" — the test proves it does
not disappear.

## Check (c) — license at the package root, verified by opening the artifact

**Why a `license` field alone doesn't satisfy AC3:** a field (`license: "MIT"`) is an *assertion*
about what the tarball contains. It proves nothing about what's actually inside the bytes a client
downloads and runs. `lib/license-check.mjs::checkLicenseInPackageRoot` shells out to the system `tar`
binary and lists the artifact's real contents, requiring a `LICENSE`/`LICENCE`/`COPYING` file at the
true package root — either a genuine top-level file, or one level inside a single common wrapping
directory (the `reponame-1.2.3/` convention `npm pack`/`git archive` produce). "Root" is enforced
literally: a license three directories deep does not satisfy this (negative fixture in
`test/publish-cli.test.mjs`: `buildArtifactWithBuriedLicense`).

**Deliberate tightening of the CLI (breaking change from `055.W3.1`'s shape):** `--artifact
<local-tarball>` is now **required** on every `publish.mjs` invocation — it was previously one of
two alternatives with `--digest`. Verifying a license needs the real bytes; a digest alone cannot
prove what a tarball contains. `--digest`, if also passed, is now a cross-check against the digest
computed from `--artifact` (must match, or the publish is refused) rather than an alternative input
mode.

**This check only runs at publish time** (it needs local file bytes that aren't retained anywhere
after upload) — CI re-proves it is wired correctly via the automated test suite
(`node --test test/*.test.mjs`, which every push runs), not via a separate structural re-scan of
already-published entries (there's nothing left to re-scan; the artifact bytes live in R2, not in
this repo).

## Check (d) / `AC8` — tier vocabulary from the plugin's own manifest (D21 publish-time half)

**VC-5's trap in different clothing:** a vocabulary that doesn't track the real data goes decorative
the moment a real plugin's vocabulary diverges from whatever example inspired a hardcoded CI list.
`checkTierVocabulary` (`lib/entry-schema.mjs`) never hardcodes a tier name anywhere — it compares
the entry's *emitted* tiers against the vocabulary declared in that specific publish's own
`--manifest` file (`manifest.tiers`), nothing else.

**Why `--emit-tiers` exists:** before this story, `manifest.tiers` was copied verbatim into the
entry — there was no way for "emitted" and "declared vocabulary" to ever diverge, which would have
made this check tautological (always passes, because it's comparing an array to itself). The new,
optional `--emit-tiers <csv>` flag lets a single publish enable a **subset** of the manifest's full
vocabulary (e.g. a version that only ships to `base` even though the plugin's manifest ultimately
declares `base,pro`); when omitted, it defaults to `manifest.tiers` unchanged, so every pre-`055.W3.3`
invocation shape still works. The error message names **both** the invalid tier(s) and the valid
vocabulary — the literal requirement of `AC8`.

## The ledger's own integrity: append-only, proved across its entire git history (VC-1)

`scripts/check-ledger-append-only.mjs` walks **every commit** that ever touched
`ledger/plugin-ids.json` (oldest to newest) and proves each version is a pure addition over the
previous one: no existing `plugin_id` key disappears, no existing `history[]` entry is removed or
edited (old history must remain an exact, unmodified prefix), every record carries a `lineage_id`
and never has it rewritten (F9 — see check (a)), `first_published_at`/`retired_at`/`retired_reason`
never change once set, and `status` only ever transitions `active -> retired`, never back. This requires the CI checkout to fetch full history (`actions/checkout@v4` with
`fetch-depth: 0`, wired in `.github/workflows/ci.yml`) — a shallow clone would silently see one
commit and report a false `OK`, which is exactly the "gate that passes verde without pegging what it
should" trap this story exists to avoid, so the requirement is called out explicitly rather than left
implicit.

Proved by a **real git-history mutation**, not just a pure-function unit test:
`test/ledger.test.mjs` builds a throwaway git repo, commits a ledger, commits a regression that
deletes an existing `plugin_id` key, and runs `node scripts/check-ledger-append-only.mjs` as an
actual subprocess against that repo — asserting it exits non-zero. A second temp repo, growth-only,
proves the same subprocess reports `OK` for the legitimate case.

## Why `fixtures/index.json` is out of `check-ledger-consistency.mjs`'s scope

`scripts/check-ledger-consistency.mjs` — the CI-side, publish-independent re-check of (a)/(b) —
runs against `index/index.json` only, not `fixtures/index.json`. Two reasons, both load-bearing:

1. `fixtures/index.json` is explicitly non-production test data (`fixtures/README.md`) — its four
   `055.W3.1` entries were published **before** this story's ledger existed, so they were never
   ledger-recorded. Re-checking them against a ledger they predate would fail for a reason that has
   nothing to do with a real invariant violation.
2. `index/index.json` — the file D24 actually protects, the one a real install pins — ships empty in
   this story too (the hard boundary: no real plugin publication is authorized here). The check runs
   for real, against real (if currently trivial) data, and stops being trivial the moment the first
   real entry lands.

Any **new** fixture publish going forward (post-`055.W3.3`) DOES write through the same
`publisher/publish.mjs`/ledger path as a production publish — the ledger doesn't distinguish target
files, only identity. What's scoped out here is *re-checking the pre-ledger historical fixtures*,
not the mechanism itself.

## `VC-6` — this closes the CI/logic layer; the platform layer is a named, open GAP

All four checks above are mechanical and unconditional in the CI/logic sense: nothing in
`publisher/`, `scripts/`, or `.github/workflows/ci.yml` can disable them, and `AC6`'s active bypass
grep (documented in the story's handoff) found zero escape hatches. What this story does **not**
close: `SynkraAI/aiox-plugins` has no distinct service push identity yet — the real `git push`
authentication is whatever collaborator account is configured locally, not something branch
protection's `restrictions` setting can name. A collaborator with write access could still hand-edit
`index/index.json` directly and push, bypassing `publisher/publish.mjs`'s checks entirely — CI
(`check-ledger-consistency.mjs`, `validate-index.mjs`) would catch it, but only *after* the push
lands, since there's no PR gate in this design (D22 — the publisher never opens one). Tracked in the
product repo: `docs/backlog/aiox-plugins-sem-credencial-de-servico-e-branch-protection-parcial.md`
(founder-level infra/cost decision, not a catalog-repo code change).

## `VC-7` — the `055.W3.1` fixture names do not burn against this ledger

`test/publish-cli.test.mjs`'s pre-existing fixtures (`aiox-enterprise`, `sinkra-os`, and the ones
added in this story's own tests) are all exercised with `--no-push` against throwaway temp
directories, each with its **own** fresh, empty `ledger.json` — never the real
`ledger/plugin-ids.json` at the repo root. Running the test suite therefore never records, retires,
or burns a real `plugin_id` against the persistent ledger. This was true by construction even before
this story (the `055.W3.1` tests never touched a ledger, because none existed) and remains true now
that a ledger exists — it is stated here explicitly because the `055.W3.1` handoff routed this exact
doc pass to this story rather than leaving it undocumented.
