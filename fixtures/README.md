# Fixtures — non-production

Everything in this directory (including `index.json`) is **test data**. No real client consumes
it. It exists to prove `publisher/publish.mjs` end-to-end (AC6 of story `055.W3.1`) without writing
a real entry into `index/index.json` — the boundary the story's dispatch explicitly drew (VC-5):
creating the repo and structuring the pipeline is authorized; a real published entry is not, until
`055.W3.3`'s CI invariants exist.

Both entries below are written by running `publisher/publish.mjs` against `--target
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

Both fixture entries point at the **same** mirrored fixture artifact in R2
(`plugins-fixtures/sinkra-os/0.0.0-fixture/…`) to avoid uploading a second throwaway object. That
is a fixture-only shortcut — documented here so it is never mistaken for the real convention (one
distinct object per plugin+version), which `docs/CATALOG-AND-MIRROR.md` describes.

Render this fixture index as a human-readable catalog page with:

```bash
node ../scripts/render-catalog.mjs fixtures/index.json fixtures/CATALOG.md
```
