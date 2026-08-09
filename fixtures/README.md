# Fixtures — non-production

Everything in this directory (including `index.json`) is **test data**. No real client consumes
it. It exists to prove `publisher/publish.mjs` end-to-end (AC6 of story `055.W3.1`) without writing
a real entry into `index/index.json` — the boundary the story's dispatch explicitly drew (VC-5):
creating the repo and structuring the pipeline is authorized; a real published entry is not, until
`055.W3.3`'s CI invariants exist.

All entries below are written by running `publisher/publish.mjs` against `--target
fixtures/index.json` — never by hand — which is the literal thing AC6 requires ("produced by the
pipeline, not by hand").

## What's in here

- **`aiox-enterprise`** (plugin #0) — no declared shadow. Proves the AC9 **negative** case: an
  entry without `overlay.shadows` renders with no shadow warning.
- **`sinkra-os`** (plugin #1) — declares a shadow of the base `review` skill, with a mandatory
  reason ("the Enterprise pack's own `/review`"). Proves the AC9 **positive** case, and is D15's
  literal requirement that "the first part [plugin #0] publishes through the same pipeline as the
  third [a real third-party plugin]" — here demonstrated with #0 and #1, the two parts available
  at this stage of the épico.
- **`acme-hostile-fixture`** (adversarial, added fix-cycle-1) — an intentionally hostile manifest:
  its `name`/`description`/`tiers`/`license`/`overlay.shadows` reason and the `--subject` it was
  published with all carry raw HTML (`<script>`, `<img onerror=...>`), unescaped Markdown control
  characters (`` ` ``, `*`, `|`, `]`/`(`), and an embedded newline that attempts to open a fake
  top-level heading and a fake blockquote line. Proves `scripts/render-catalog.mjs`'s sanitization
  (`F-CR-PLUGINS-5`, QG `@architect` 2026-08-09): `fixtures/CATALOG.md` renders every one of those
  payloads as **inert literal text** — no raw `<script>`/`<img>` tag survives, no fake heading line,
  no broken table row. Verified mechanically, not just visually — see the handoff for the exact
  `grep` commands.
- **`fixcycle1-smoke`** — a trivial 4th entry, published by `publisher/publish.mjs` (with its own
  `git commit`+`git push`, not a manual git command) immediately AFTER branch protection was applied
  to `main` (`F-CR-PLUGINS-7` partial fix). Its only purpose is proof: the pipeline's own automated
  push still succeeds under the new protection — `required_pull_request_reviews` was deliberately
  left off precisely so this would keep working. See `README.md`'s "Repository hygiene" section for
  the exact protection settings.

Each entry now points at its **own**, distinctly-namespaced fixture artifact in R2
(`plugins-fixtures/<plugin_id>/0.0.0-fixture/<sha256>.tar.gz` — same underlying bytes reused across
all three objects to avoid uploading throwaway content three times over, but three DISTINCT R2 keys,
one per `plugin_id`). This is fix-cycle-1's correction of `F-AC6-ARTIFACT-BINDING`: the ORIGINAL
version of this fixture set had `aiox-enterprise`'s entry pointing at a `sinkra-os/…` key — legal
under the old code, and exactly the bug `lib/entry-schema.mjs::checkArtifactBinding` now refuses at
publish time. Byte-content reuse across distinct, correctly-namespaced keys remains a fixture-only
shortcut, documented so it is never mistaken for the real convention (one distinct **object** per
plugin+version), which `docs/CATALOG-AND-MIRROR.md` describes.

Render this fixture index as a human-readable catalog page with:

```bash
node ../scripts/render-catalog.mjs fixtures/index.json fixtures/CATALOG.md
```
