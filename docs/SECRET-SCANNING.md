# Secret scanning — what it catches, and what it does not (story 055.W4.1, D20(1))

Decision record: `ADR-COCKPIT-ENTERPRISE-PREMIUM-PACK`, **D20(1)** — *"scanning de segredos bloqueante
no publish"*. D20 also records **why review is not the primary defence**: the 77 Evil Twin extensions
that shipped malware all passed human review. The control here is mechanical and blocking.

**The most important section of this document is the last one.** If you only read one part, read
"What this scanner does NOT see".

---

## 1. Where the gate is, and that it is unconditional

`publisher/publish.mjs` runs the scan **before any other analysis**, over two subjects:

| Subject | Why it is in scope |
|---|---|
| the **manifest** (`--manifest`, scanned as raw JSON text) | it becomes a **public catalog entry**; a credential pasted into a `description` is published verbatim |
| the **artifact** (`--artifact`, its real extracted bytes) | it is what a client downloads and runs |

A finding is a **refusal** — nonzero exit, index untouched, ledger untouched. There is no flag, no
environment variable and no fixture path that disables it. That matches the posture of D24's four
invariants (`docs/INVARIANTS.md`), and it is asserted by tests rather than promised in prose: every
covered class has a planted-credential fixture that is pushed through the real CLI as a subprocess
and must be REFUSED (`test/publish-cli.test.mjs`, describe `055.W4.1`).

The refusal also tells the publisher to **rotate** the credential. A secret that reached bytes
prepared for publication should be treated as exposed whether or not the publish went through.

Standalone CLI, same engine (imported, never reimplemented, so CI-time and publish-time cannot
drift):

```bash
node scripts/scan-secrets.mjs --artifact path/to/plugin.tar.gz
node scripts/scan-secrets.mjs --manifest path/to/manifest.json --json
```

## 2. Why the rules are vendored from gitleaks (VC-1 — REUSE before writing a scanner)

Writing a secret detector from scratch would be both disproportionate and worse than the state of the
art. The corpus in `lib/secret-rules.mjs` is a **verbatim subset of gitleaks'
`config/gitleaks.toml`** (`master`, 222 rules, upstream latest `v8.30.1` when vendored on
2026-08-09; MIT, © 2019 Zachary Rice). Rule ids, descriptions, entropy floors and keyword prefilters
are the upstream values, so any finding is greppable against gitleaks' own documentation.

The three options, and why this one:

| Option | Verdict |
|---|---|
| **npm dependency** (`secretlint` + a recommended ruleset) | **Rejected.** It would introduce the first `package.json`/`node_modules` into this repo — today everything is stdlib `node:` plus system binaries, so a bare checkout runs the tests and the publisher with no install step. Putting `npm install` on the **publish path** means the blocking gate can fail for reasons unrelated to the package being published (registry outage, lockfile drift, a transitive advisory). A gate whose likeliest failure is unrelated to its subject is a gate that gets disabled. |
| **pinned gitleaks binary / GitHub Action** | **Rejected as the primary mechanism.** It works in CI, but AC1 requires the gate to block *inside* `publisher/publish.mjs`, which runs wherever the AIOX publish service runs. Shelling out to a possibly-absent binary leaves only fail-open (a gate that silently stops gating) or fail-closed-on-missing-tool (a pipeline that breaks on a machine without gitleaks). |
| **vendor the ruleset, keep the engine local** | **Chosen.** Reuse of the *detection corpus* — the part that is genuinely hard and that a hand-rolled scanner would get worse — with zero runtime dependency. The engine (`lib/secret-scanner.mjs`) is regex iteration plus Shannon entropy: small, testable, and blocking exactly where AC1 requires. |

**The cost of this choice, named:** a vendored corpus does not update itself. `SECRET_RULES_PROVENANCE`
records the upstream ref, file, rule count and vendoring date so the staleness is *measurable*; it is
not automatic. Re-vendoring is mechanical: add the rule, add its fixture — the test suite fails if
you add one without the other.

### The RE2 → JavaScript port

gitleaks patterns are Go RE2. Exactly two constructs do not exist in JavaScript and were handled
explicitly, with no other character of any pattern modified:

- `(?i)` inline flag → carried as the regex's `i` flag (identical semantics; every affected rule has
  it as the leading token).
- `(?-i:…)` (a case-sensitive island inside a case-insensitive pattern) → **no JavaScript
  equivalent**. It appears only in `generic-api-key`'s allowlist, which is why that rule is not
  vendored (§4).

A test asserts every vendored pattern compiles and that no RE2-only construct survived — the port is
verified, not assumed.

## 3. Covered classes (14)

Each row has a planted-credential fixture that is REFUSED through the real CLI, and each fixture is
invalid in **exactly one way** (asserted mechanically — a fixture that tripped two rules would let
its test pass for the wrong reason).

| Class | Upstream rule id | Shape |
|---|---|---|
| `private-key` | `private-key` | PEM `BEGIN … PRIVATE KEY` block |
| `aws-access-key` | `aws-access-token` | `AKIA`/`ASIA`/`ABIA`/`ACCA`/`A3T…` access key id |
| `github-token` | `github-pat` | `ghp_` personal access token |
| `github-fine-grained-token` | `github-fine-grained-pat` | `github_pat_` fine-grained token |
| `cloudflare-api-token` | `cloudflare-api-key` | 40-char token in a `cloudflare…=` assignment |
| `cloudflare-global-api-key` | `cloudflare-global-api-key` | 37-hex global key in a `cloudflare…=` assignment |
| `slack-token` | `slack-bot-token` | `xoxb-` bot token |
| `slack-user-token` | `slack-user-token` | `xoxp-`/`xoxe-` user token |
| `stripe-key` | `stripe-access-token` | `sk_live_`/`rk_test_`/… |
| `openai-api-key` | `openai-api-key` | `sk-…T3BlbkFJ…` |
| `anthropic-api-key` | `anthropic-api-key` | `sk-ant-api03-…AA` |
| `gcp-api-key` | `gcp-api-key` | `AIza…` |
| `npm-token` | `npm-access-token` | `npm_` access token |
| `jwt` | `jwt` | `ey….ey….…` |

Two upstream behaviours are kept because they are what stop the corpus from crying wolf:

- **Entropy floors.** Shape alone over-fires: `ghp_` followed by 36 identical characters matches the
  pattern and is obviously not a token. A shape-valid, low-entropy value is not reported.
- **Allowlists.** AWS's own `…EXAMPLE` documentation key and gitleaks' list of 16 well-known fake
  Google keys are not findings — a package that quotes a vendor's sample in its README still
  publishes.

**Findings are redacted.** A finding carries the first 4 characters and the length, never the value.
A scanner that prints what it found turns every CI log into the leak it was preventing.

## 4. Deliberately NOT vendored

- **`generic-api-key`** — gitleaks' catch-all for unknown providers (any `key`/`token`/`secret`-ish
  assignment above entropy 3.5). Its usability depends entirely on a large allowlist built on RE2's
  `(?-i:…)`, which does not port. Running it *without* its allowlist inverts the cost of a mistake
  from "a secret slips through" to "a legitimate publish is refused because a skill wrote
  `api_version: 2026-08-09`" — and a blocking gate that cries wolf is a gate that gets bypassed.
  **Consequence, stated plainly: a credential from an unlisted provider, or one with no recognisable
  prefix, is NOT detected.**
- **The other ~208 upstream rules** — the vendored subset covers the providers this catalog is
  plausibly exposed to (cloud, git forge, package registry, payments, AI vendors, this org's own
  Cloudflare/R2 infra) plus the format-recognisable generics. Vendoring all 222 would multiply the
  per-class fixture obligation by ~16 without adding an exposure this catalog actually has, and an
  **unproven rule is exactly the "gate that passes verde using a tool blind to the defect"** failure
  this lineage already shipped once.

## 5. What this scanner does NOT see — READ THIS ONE

This is the section AC3 exists for, and it is the easiest one to treat as bureaucracy. The finding it
answers to (**advisory-council `C2`**) is that *communicating a control as stronger than it is makes
the user calibrate trust by the label*. So these limits are not an appendix: they are a field of every
report object (`limits`), printed by `renderScanReport` on **every run — including a clean one that
succeeds**, and asserted by tests. This mirrors the posture `capabilities.limits` already takes
(`docs/CAPABILITIES.md` §6): limits travel WITH the claim and are never displayed apart from it.

### (a) It inspects the published manifest and artifact — NOT the target of an MCP pointer

An MCP server in a plugin is a **runtime-resolved pointer**, not an inspectable artifact. The manifest
supplies `{command, args}` (product repo, `crates/aiox-cockpit/src/mcp.rs:68`), typically
`npx <package>`, resolved against a registry AIOX does not control.

This scan covers **the pointer**. It has never opened, downloaded or executed **the target**, and
what `npx` fetches tomorrow is not what was published today. **A clean scan says nothing whatsoever
about the code an MCP pointer will pull at runtime.**

### (b) An obfuscated or encoded secret escapes

Every rule is a regex over literal text. A credential that is base64'd, split across concatenated
strings, XOR'd, stored reversed, or assembled at runtime matches nothing and is not detected. This is
a **shape detector, not a semantic one**.

### The rest, measured while building it

- **Coverage is a fixed list of providers**, not "secrets" in general (§4).
- **The corpus does not update itself** — it is a dated snapshot of a named upstream ref.
- **Binary and oversized members are skipped.** Files with a NUL byte in their head, and files above
  the 5 MiB cap, are not scanned. They are **counted and listed in every report** (`skipped_binary`,
  `skipped_too_large`) rather than dropped silently — but *listed* is not *scanned*. A secret inside
  a nested archive, image metadata, or a compiled binary is not seen.
- **Symlinks are not followed** — a symlink's target is outside the artifact; scanning it would
  report on the publishing machine's filesystem, not on what ships.
- **A clean scan is not a security verdict.** It means "no known credential *shape* was found in
  these bytes". It is not a statement that the package is safe, that it does no harm, or that AIOX
  endorses it — the catalog signs the **index** to attest provenance, never the artifact to attest
  endorsement (D20(3)).

## 6. Relationship to the base grep in CI

`.github/workflows/ci.yml` has a small grep step ("No obvious secret shapes committed") that scans
**this repository's own committed files**. It is a different control with a different subject and was
labelled "NOT the D20(1) blocking scanner" when it landed. It stays exactly as it was; the blocking
scanner described here scans what gets **published**, which the base grep never looks at.

The workflow additionally runs the scanner end-to-end over **two** artifacts — one clean (must pass)
and one with a planted credential (must be refused). A step that only ever ran the clean case would
prove only that the binary starts.

## 7. AC7 — no credential in this pipeline

Every fixture value in `test/helpers/secret-fixtures.mjs` is **fabricated** and **assembled at
runtime from fragments**, so the repository never contains a well-formed credential shape
contiguously. That is deliberate on two counts: it honours AC7 directly, and it keeps this repo's own
committed-secret grep intact — the tempting alternative (excluding `test/` from that guard) would
punch a hole in a working control to accommodate a test.
