# Version pin + the plugin's own channel (story 055.W4.1, D20(2) / D19)

Decision records: `ADR-COCKPIT-ENTERPRISE-PREMIUM-PACK` **D20(2)** (*"pin de versão + canal
separado"*) and **D19** (a plugin's update cycle is **independent** of the binary's — marker by
version+tier+digest, separate from `.aiox-core-build`).

---

## 1. What a pin is

```
<plugin_id>@<version>          e.g.  sinkra-os@1.2.0
```

Resolving a pin against an index yields the artifact's **digest**, and the digest is what a client
fetches by. There is no mutable "latest" pointer anywhere in this path.

```bash
node scripts/resolve-pin.mjs --index index/index.json --pin sinkra-os@1.2.0
node scripts/resolve-pin.mjs --index index/index.json --pin sinkra-os@1.2.0 --verify ./downloaded.tar.gz
```

**Same pin ⇒ same digest ⇒ same bytes.** The mirror path is content-addressed
(`plugins/<plugin_id>/<version>/<sha256>.tar.gz` — see `docs/CATALOG-AND-MIRROR.md`), so the digest
*is* the filename: the same bytes can never be silently swapped under an existing pointer.

### Determinism is a property of the function, not a promise in a doc

`resolvePin` (`lib/pin.mjs`) is a **pure function of exactly two inputs**: the parsed index data and
the pin string. It reads no clock, no environment variable, no file, and no network. That is what
makes the guarantee testable rather than assertable — and it is also, in the same breath, the
mechanism behind §3: *a function that cannot observe the binary channel cannot be affected by it*.

**Ambiguity is a refusal, never a tie-break.** If an index somehow carried two entries for the same
`plugin_id@version` with different digests, any tie-break (first / last / highest) would make the
resolved BYTES depend on entry ORDER — i.e. on how the file was edited. That is precisely the silent
artifact substitution D24(b) exists to prevent, so `resolvePin` refuses and says so.

### Proof (AC4), executed against the live mirror

The artifact mirrored by story `055.W3.1` was downloaded from the real public R2 endpoint and its
bytes re-hashed against what the pin resolves to:

```
$ node scripts/resolve-pin.mjs --index fixtures/index.json --pin sinkra-os@0.0.0-fixture
pin            sinkra-os@0.0.0-fixture
digest         sha256:9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a

$ curl -sS -o w31.tar.gz -w "HTTP_STATUS=%{http_code} bytes=%{size_download}\n" \
    "https://pub-42179e62dc3040138151ec33229dd073.r2.dev/plugins-fixtures/sinkra-os/0.0.0-fixture/9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a.tar.gz"
HTTP_STATUS=200 bytes=1188

$ node scripts/resolve-pin.mjs --index fixtures/index.json --pin sinkra-os@0.0.0-fixture --verify w31.tar.gz
  expected     9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a
  actual       9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a
  result       MATCH — same pin, same digest, same bytes
```

`test/pin.test.mjs` keeps this honest **offline**: it asserts the resolver still maps that pin to
that exact digest and content-addressed URL, so a regression is caught on every push without a unit
suite depending on a bucket being reachable.

## 2. What pinning COSTS — this is not a footnote

Advisory-council finding **`C4`**, verified: *"of the four original controls, zero acted on an
already-installed artifact, and the pin even prevented it from being fixed."*

| | |
|---|---|
| **Benefit** | An install is reproducible. The same pin resolves to the same digest, which fetches the same bytes, forever. A client that never re-resolves can never be silently handed different content. |
| **COST** | **The same property prevents an already-installed artifact from being repaired.** A pinned client keeps resolving that version — *including after the publisher ships a corrected build*. Pinning freezes the good and the bad alike: it does not act on what is already on a user's disk, and it actively stands in the way of anything that would. |
| **What gives that capability back** | **Index freshness — story `055.W5.1` (D20(5))**: an `expires` field plus a monotonic index version, so a client can distinguish a stale index from a current one and knows when it must re-resolve. |

This is carried as **data on every resolution** (`pin_cost` on the result object) and printed by the
CLI in every output mode — the same posture `capabilities.limits` takes in `docs/CAPABILITIES.md`.
A benefit that can be displayed without its cost eventually *is* displayed without it, and then the
pin reads as pure gain, which is false.

> **`VC-3` — this is not a revocation claim.** Restoring the ability to **repair** is not the same as
> revocation, and nothing in this module implements, implies or depends on revocation. Revocation is
> governed by `O5` (story `055.W1.3`), which has **not** closed; epic 055 rule R2 forbids any story
> from asserting it exists. See `docs/CATALOG-AND-MIRROR.md` § "AC8 (`055.W3.1`)" — the same
> guardrail, in the same words, applies here.

## 3. The plugin channel is not the binary channel (AC5)

The cockpit **binary** already has an update channel, governed by `ADR-COCKPIT-UPDATE-CHANNELS`
(epic `017`, `Done`) — per-role channels, its own feed, its own installer. **That concept is REUSED,
not reimplemented.** Nothing in this repository is a second binary channel.

| | plugin channel (this repo) | binary channel (epic 017) |
|---|---|---|
| identified by | **version + tier + digest** — the product's plugin marker, `~/.aiox/sinkra-os-plugin.marker` (`crates/aiox-cockpit/src/plugin_channel.rs`) | `.aiox-core-build` / the binary's own update feed (`crates/aiox-cockpit/src/provision.rs`, `updater.rs`) |
| resolved from | the catalog index + the pin, and nothing else | the release feed for the user's role |
| governed by | D19 / D20(2), this repo | `ADR-COCKPIT-UPDATE-CHANNELS` |

### Independence, proved in BOTH directions

Both directions are the same fact stated twice — `resolvePin` is a pure function of (index, pin) —
but each is asserted separately, because "obvious from the design" is exactly the kind of claim that
stops being true after one edit.

1. **A plugin updates without the binary.** `test/pin.test.mjs` publishes `pinme@1.0.0` then
   `pinme@1.1.0` through the real CLI, resolves both pins (different digests), confirms the old pin
   still resolves to the old digest, and asserts the whole cycle created **no** binary-channel
   artifact (`.aiox-core-build`, `RELEASES`).
2. **The binary updates without the plugin.** The same test moves binary-channel state through three
   distinct configurations — marker absent, build A, build B — and mutates the environment
   (`AIOX_UPDATE_CHANNEL`, `AIOX_CORE_BUILD`), resolving the same pin at every step and asserting
   **byte-identical** resolutions. A resolver that read binary state would change its answer here.

### Enforced, not merely intended

`scripts/check-channel-separation.mjs` runs in CI and refuses any executable file in this repository
(`lib/`, `publisher/`, `scripts/`, `schema/`, `index/`, `ledger/`) that references a binary-channel
identifier, plus it refuses a `process.env` read in the resolver itself.

**Exactly what is exempt, stated precisely** (fix-cycle-1, F4 — the earlier wording here claimed more
than the code did):

1. **Comment content.** Comments are blanked (offsets preserved, so line numbers stay true) and the
   guard searches the code that remains. A doc-comment naming an identifier in order to *declare* the
   separation is legitimate and stays exempt. This replaced a line-prefix check that the QG defeated
   with one character — a real `readFileSync(".aiox-core-build")` written after a `/*` opener on the
   same line used to pass. Quote tracking is included so a `//` inside a `"https://…"` string is not
   mistaken for a comment opener, which would fail in the dangerous direction.
2. **The frozen `binary_channel_identifiers` list in `lib/pin.mjs`** — which *is* the declaration of
   what must not be read, and is the single source the guard itself reads. This exemption is a
   **text-range** check (from `binary_channel_identifiers` to the closing `]),`), not an AST one: an
   expression placed inside that range would be exempt too. Stated plainly rather than described as
   tighter than it is. An occurrence anywhere else in that file is refused like anywhere else.

Residual, named: regex literals are not tracked by the comment blanker, so a `/`-initiated regex
containing `//` could confuse it — in the direction of **over**-reporting (a spurious violation
someone must look at), never of missing a coupling.

**The guard has its own negative fixture.** `test/pin.test.mjs` plants a coupling in the scanned
surface, asserts the guard FAILS, removes it, and asserts it goes back to green — a guard only ever
observed passing is a guard nobody has seen catch anything.

### Product-side evidence (measured, both repos)

| Measurement | Result |
|---|---|
| binary-channel modules (`updater.rs`, `update_gate.rs`) referencing `plugin_channel` or the plugin marker | **0** |
| `plugin_channel.rs` referencing velopack / `RELEASES` / `update_gate` / `updater` | **0** |
| `.aiox-core-build` occurrences in `plugin_channel.rs` | **3** — two doc-comments stating the separation, one inside `mod tests` writing a fixture home; no runtime read |
| catalog repo executable files referencing any binary-channel identifier | **0** (21 files scanned by the CI guard) |
