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

A finding is a **refusal** — nonzero exit, index untouched, ledger untouched. **So is a member the
scan could not read** (see §5.1: unscannable ⇒ not publishable, fail-closed). There is no flag, no
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
supplies `{command, args}` (product repo, `crates/aiox-core/src/mcp.rs:68`), typically
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
- **Binary and oversized members cannot be scanned — and therefore BLOCK the publish** (§5.1).
- **Symlinks are not followed** — a symlink's target is outside the artifact; scanning it would
  report on the publishing machine's filesystem, not on what ships. Since fix-cycle-2 they are also
  not *dropped*: they are enumerated from the member table and refused (§5.2).
- **The member table has its own blind spots** — a tar parser differential, and nested archives
  (§5.2).
- **A clean scan is not a security verdict.** It means "no known credential *shape* was found in
  these bytes". It is not a statement that the package is safe, that it does no harm, or that AIOX
  endorses it — the catalog signs the **index** to attest provenance, never the artifact to attest
  endorsement (D20(3)).

### 5.1 Unscannable ⇒ not publishable (fail-closed) — the decision, and what it costs

**The defect this closes, which was executed rather than theorised.** The QG built two artifacts, each
carrying a real shape-valid AWS key, identical except for a one-line evasion: **(A)** one leading NUL
byte, so the member reads as binary; **(B)** the same credential followed by >5 MiB of padding, so the
member exceeds the scan cap. Both were skipped, both reported "Findings: none", both exited **0**.
AC1 says a package containing a recognisable credential does not publish; these did.

**What was — and was not — wrong about that.** The blindness was *disclosed*: every run printed which
members were skipped and said "a skipped file is an UNKNOWN, not a pass". So this was never the
failure this lineage is haunted by (a gate passing green using a tool blind to the defect it was
meant to catch — that failure is about **undisclosed** blindness). The real gap was smaller and more
damning: every other trade-off in this deliverable is written down at its decision site, and this one
was not. It was presented as an unavoidable property of scanning rather than as an alternative that
had been weighed. **Disclosure is not enforcement.**

**The decision: fail-closed.** `publisher/publish.mjs` and `scripts/scan-secrets.mjs` refuse when any
member could not be read. A member nobody could read is a member nobody can certify.

**What it costs — named, because "it's free" would be false:**

| Cost | Assessment |
|---|---|
| A legitimate binary asset (icon, font, `.wasm`) is refused | Does not exist today — a plugin is skills + scripts + a licence — but it is the case most likely to appear first. |
| macOS packaging junk (`.DS_Store`, AppleDouble `._*`) is refused | **The likeliest real false refusal**: those files are binary and `tar` on macOS sweeps them in by accident. Arguably the *correct* outcome (that junk has no business in a published artifact), but it will surprise a macOS publisher — so the refusal names the file and says exactly that. |
| A genuinely large **text** member (>5 MiB) is refused | Refused rather than silently unexamined. |

**Why pay that now:** the catalog has **zero** real entries and is closed to external publishers, so
today the false-refusal cost is literally zero — which makes this the only moment when tightening the
rule is free. Same reasoning that made D24 worth ratifying before a catalog existed: these things
only cost nothing before they exist.

**Why there is no `--allow-unscannable` override**, though the obvious design has one: an override is
precisely the disable path AC1 forbids and the bypass sweep hunts for, and a flag that lets unread
bytes through is a flag that will be passed by default in somebody's CI within a quarter. When a
legitimate binary-asset case actually appears, the answer is a **designed rule** (e.g. an explicit,
digest-pinned asset allowlist that records which member is exempt and why), decided with a real case
in hand — not a bypass built speculatively. Tracked in the product repo:
`docs/backlog/aiox-plugins-scanner-fail-closed-sem-rota-para-asset-binario-legitimo.md`.

**Proven by execution, not by this paragraph.** Both evasions are permanent fixtures
(`buildArtifactWithNulPrefixedSecret`, `buildArtifactWithOversizedSecret`) pushed through the real CLI
in `test/publish-cli.test.mjs`, plus a control proving the refusal is about *not being able to look*
rather than about finding something (a clean binary member with no credential in it also blocks), plus
the positive control that a clean package still publishes.

### 5.2 The inventory is the ARCHIVE, not the extraction (fix-cycle-2, F10/F11)

Fail-closed only means something if the list of members it runs over is complete. It was not.

**Executed by the QG, and reproduced here before the fix.** A single tar stream carrying the **same
path twice** — first member holding a shape-valid AWS key, second member clean — extracts to one
clean file. The scanner inventoried the *extracted filesystem*, saw one file, found nothing, exited
**0**. The credential shipped and stayed fully recoverable from the published bytes:

```
$ tar -tzf shadow.tar.gz | sort | uniq -d
./config/app.env                      ← the same member, twice
$ tar -xOzf shadow.tar.gz ./config/app.env
AWS_ACCESS_KEY_ID=AKIA…               ← still there, in the bytes a client downloads
```

**Why this outranked the gap it replaced**, even at the same severity: §5.1 was survivable because
the scanner *said out loud* what it had not read. A shadowed member appeared in **nothing** — not
`files_total`, not `skipped_binary`, not `skipped_too_large`, not `unscannable`. Undisclosed
blindness is the disqualifying kind. The same root cause had a quieter symptom too (**F11**):
symlinks and other non-regular members were dropped *before* enumeration, so a 3-member archive
reported `2/2 file(s) scanned` — which reads as complete coverage of an archive that was not fully
seen, in the very report §5 makes load-bearing.

**The fix, once, for both.** The **member table** (`tar -tzf` for names, `tar -tvzf` for types) is
the source of truth for what the archive contains; the extracted tree only supplies *bytes* for
members the table says are ordinary files. Anything the table lists that cannot be mapped to exactly
one readable regular file is **unscannable**, and therefore refused by the path §5.1 already built:

| Member kind | Treatment |
|---|---|
| regular file, unique path | scanned |
| **directory** — *positively identified*: rendered type `d` **and** size exactly 0 | structural — carries no bytes, present in every normal artifact, **not** refused (a fix that refused these would refuse everything) |
| **directory-shaped but carrying data** (or whose size cannot be determined) | refused — §5.3 |
| **duplicate path** | refused — extraction keeps only the last, so an earlier member's bytes ship without ever existing on disk to be read |
| **non-regular** (symlink, hardlink, FIFO, socket, device) | refused — enumerated rather than dropped before counting |
| **absolute or `..`-escaping path** | refused — cannot be mapped to a file inside the package root |
| listed as a regular file but **absent after extraction** | refused — a member that was never read is not a pass |

`files_total` now counts the archive's content members, so `N/M file(s) scanned` means what a reader
assumes it means.

**What the member table still cannot see** — declared here and in the limits printed on every run,
because the lesson of §5.1 is that an undeclared blind spot is the disqualifying kind:

1. **Parser differential.** The inventory is *this* `tar`'s parse. A crafted archive that another tar
   implementation reads differently — extra, ignored or ambiguous headers, PAX vs ustar
   disagreements — could present a consumer with members this scan never saw. Nothing here detects
   that. It is an adversarial construction, and it matters most at the same moment §5.1's residual
   does: when the catalog opens to external publishers. **Scope, stated precisely because it was
   misread once:** this covers *disagreement between parses*. It does **not** cover a member this
   parse itself misclassifies — that is a defect, not a residual, and one such defect (F14) was found
   and fixed in §5.3. The remedy for both, if this area is ever worked again, is a real tar reader
   instead of parsing CLI output.
2. **Structure, not content.** The table cannot tell that an ordinary-looking member is itself a
   nested archive whose contents are never opened.
3. **Unenumerable archives are refused outright.** If the two listings disagree on member count (a
   member name containing a newline is the realistic cause), the whole artifact is refused rather
   than guessed at — fail-closed, but it means such an archive cannot be published at all.

**Fixtures** (`test/publish-cli.test.mjs`, through the real CLI): the shadowed-duplicate artifact —
which first asserts the credential really *is* recoverable from the archive, so a later refusal
cannot pass for the wrong reason — the symlink artifact, a `files_total` honesty check (3 reported as
3), the positive control that a clean package still publishes, and a control that directories are not
refused.

### 5.3 The classifier is an ALLOWLIST — exemption requires positive evidence (fix-cycle-3, F14)

**Executed by the QG, and reproduced here before the fix.** A hand-forged ustar member with typeflag
`0` (**regular file**) whose **name ends in `/`**, carrying 39 bytes with a shape-valid AWS key:

```
$ tar -tvzf forged.tar.gz
-rw-r--r--  0 0 0    4 Aug 10 01:48 ./LICENSE
-rw-r--r--  0 0 0   51 Aug 10 01:48 ./SKILL.md
drw-r--r--  0 0 0   39 Aug 10 01:48 ./config/payload/     ← rendered `d`, but 39 bytes of DATA
$ tar -xOzf forged.tar.gz ./config/payload/
AWS_ACCESS_KEY_ID=AKIA…                                    ← same tar, same machine
```

Before the fix: `2/2 file(s) scanned`, `Findings: none`, **exit 0**. The member was excluded from
classification *before* any refusal logic could run.

**This is not the declared parser-differential residual.** That residual is about *different* tar
implementations disagreeing. Here one implementation is enough to recover the credential, so it was a
classification bug in this parse — a genuine finding, not a disclosed limit.

**The root cause was the shape of the rule, not the missing case.** The old pre-filter asked what a
member *looks like* and exempted on resemblance: `type !== "d" && !name.endsWith("/")`. Anything
resembling a directory inherited the directory exemption **regardless of what it carried**. Over a
format as old and permissive as tar, a denylist keeps producing findings — three cycles running, each
closed the demonstrated instance and left an undemonstrated one.

So the question is inverted:

| | |
|---|---|
| **Old (denylist)** | "is this member excluded from classification?" → exempt on **resemblance** |
| **New (allowlist)** | "can this member be **positively identified** as one of two known-safe things?" → everything else, **including anything unrecognised**, is unscannable and refuses |

The two positively-identified categories, and nothing else:

- **Directory** — rendered type `d` **and** a size that is **known and exactly 0**. A real directory
  carries no data. A member rendered as a directory with non-zero size is anomalous by construction.
  If the size cannot be parsed at all, that is **not** a pass either: an unverifiable claim to be a
  directory is unscannable, because the whole point of the inversion is that **exemption requires
  positive evidence**.
- **Ordinary file** — rendered type `-`/`0`, name not ending in `/`, safe path, unique among content
  members, mappable to exactly one extracted regular file.

**Directories must stay exempt**, and that is the one thing this inversion cannot tighten: refusing
them would refuse *every* package built the normal way (`tar -czf x.tgz -C dir .`). That carve-out is
pinned by its own control test, alongside a test of the allowlist property itself (a directory whose
size is unknown refuses; a directory carrying data refuses; an ordinary file still reads).

**Fixtures:** the forged archive is a permanent fixture that first asserts the archive is **valid**
and the credential **really is recoverable** from it — the second engine's own attempt at this probe
produced a *damaged* archive that yielded only NUL bytes, i.e. an unproven assertion dressed as a
finding, which is worth remembering before trusting a probe nobody ran.

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
