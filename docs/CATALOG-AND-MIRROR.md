# How the index, the mirror, and the pipeline fit together

## The index

`index/index.json` is the **production** index — the file a real Cockpit install would eventually
pin and consume. It ships in this story with **zero entries** (see the README section "Why the
production index is empty"): the three irreversible invariants of D24 (immutable `plugin_id`,
burned unpublished names, mandatory license) are verified by CI that a follow-up story
(`055.W3.3`) adds to this repo, and writing a real entry before that CI exists would let an
unverified entry through the exact gate that story is meant to be the gate for.

`fixtures/index.json` is **not** consumed by any real client. It exists only so the publish
pipeline (`publisher/publish.mjs`) can be proven end-to-end (AC6) without writing to the index a
client actually pins.

## The artifact mirror

Artifacts are mirrored in **Cloudflare R2 infrastructure AIOX already operates** — no new bucket
was stood up for this story, per explicit founder direction (REUSE, not new infra).

| | |
|---|---|
| Bucket | `aiox-education` (Cloudflare R2, same account as the rest of AIOX's distribution infra) |
| Public base URL | `https://pub-42179e62dc3040138151ec33229dd073.r2.dev` |
| Why this bucket and not `aiox-cockpit-beta` | The catalog mirror must be reachable **without authentication** by any installing client. `aiox-cockpit-beta` is gated behind Cloudflare Access (OTP) for beta distribution; `aiox-education` already has public R2.dev access enabled and is the operated bucket that fits an unauthenticated-read requirement. This is a reuse-of-what-fits decision, not a new provisioning choice — a dedicated bucket may be worth a name of its own once the catalog is a real production surface; that is a follow-up, not a blocker for this story. |
| Path convention (production) | `plugins/<plugin_id>/<version>/<sha256>.tar.gz` — content-addressed by digest, so the same bytes are never silently swapped under an existing pointer. **Enforced in code as of fix-cycle-1**, not just prose: `lib/entry-schema.mjs::checkArtifactBinding` refuses (at publish time AND in CI) any entry whose `artifact.mirror_url`/`artifact.r2_key` don't contain the entry's own `plugin_id` as an exact path segment. **As of fix-cycle-2**, the HOST itself is also enforced: `lib/entry-schema.mjs::checkArtifactHost` refuses any `mirror_url` whose host isn't in the single named `ALLOWED_ARTIFACT_HOSTS` constant — a correctly-namespaced path pointing at a non-AIOX server used to pass every earlier check. |
| Path convention (this story's fixture data) | `plugins-fixtures/<plugin_id>/<version>/<sha256>.tar.gz` — the `plugins-fixtures/` prefix is deliberate and unambiguous: it can never collide with a real `plugins/` path, and it marks every object under it as test data for the publish pipeline, never a real install target. |

### How AC3/AC4 were verified — the literal commands, against the LIVE endpoint

`wrangler` v4 defaults every `put`/`get`/`list` to **local** simulated storage — a known trap in
this org's infra (see the memory note `wrangler-v4-kv-local-default-trap`). Every command below
that touches R2 passes `--remote` explicitly, and the read-back that proves AC3/AC4 is an HTTP
`curl` against the public endpoint — never a `wrangler` read-back, which would only prove the
local simulator worked.

```bash
export CLOUDFLARE_ACCOUNT_ID=f21aa6cc2bef91742b6ce6631bc0afe3

# 1. upload (REMOTE — hits the real bucket, not .wrangler/state)
npx wrangler r2 object put \
  "aiox-education/plugins-fixtures/sinkra-os/0.0.0-fixture/<sha256>.tar.gz" \
  --file=sinkra-os-0.0.0-fixture.tar.gz --content-type=application/gzip --remote

# 2. verify against the LIVE public endpoint, not local wrangler state
curl -sS -o downloaded.tar.gz -w "HTTP_STATUS=%{http_code}\n" \
  "https://pub-42179e62dc3040138151ec33229dd073.r2.dev/plugins-fixtures/sinkra-os/0.0.0-fixture/<sha256>.tar.gz"

# 3. recompute the digest of the DOWNLOADED bytes and compare to what the index says
shasum -a 256 downloaded.tar.gz
```

Real result recorded in the story's Dev Agent Record / handoff to `@devops`'s report: HTTP `200`,
recomputed digest **exactly equal** to the uploaded digest
(`9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a`).

## AC8 (`055.W3.1`) — automatic revocation still does not exist; manual despublish does (`055.W3.3`)

This document, this repository's README, and every generated catalog page describe installation and
publication, plus — as of `055.W3.3` — one narrow, explicit, manual capability:
`publisher/retire.mjs` removes an index entry and burns its `plugin_id` in `ledger/plugin-ids.json`
forever (D24(b)), triggered only by an operator running the script with a mandatory `--reason`. None
of this repo describes *automatic* pruning, removal, or revocation based on freshness, staleness, or
entitlement — that capability is still `055.W5.1` (D20(5), index freshness + monotonic version) and
is not built here. If you are editing this repo and about to write the word "revoke"/"prune"/
"remove" as something the system does **on its own** (not as an explicit, manual, reasoned
operator action), stop — check whether `055.W1.3`'s `O5` reconciliation and `055.W5.1` have actually
landed first.
