# Derived capabilities + mandatory `allowed-tools`

Story `055.W4.2` · ADR-COCKPIT-ENTERPRISE-PREMIUM-PACK **D17** + **D20(4)**.

> **Read this first: this delivers VISIBILITY, not CONTAINMENT.**
> Nothing in this document sandboxes a plugin. Real containment needs an execution host, and the
> ADR rejects a third-party WASM host **with evidence** — *"o Zed provou que mesmo com wasmtime
> completo a extensão não desenha UI"*. What ships here lets a user **see** what a plugin is
> capable of before installing it. If you read any of the below as "the plugin is now contained",
> you have read it wrong.

---

## 1. The threat model is not the obvious one

The intuitive frontier — *declarative markdown is safe, scripts are dangerous* — does not match the
real risk. In an app where **an agent executes what it reads**, markdown is not the safe class: it
is the class with the **widest reach and the least visibility**.

Measured in the product repo's SOT (`.aiox-core/skills/`), 2026-08-10:

| Measurement | Result |
|---|---|
| Skills declaring `allowed-tools` before this story | **0 of 35** |
| Skills that ship their own `scripts/` (`OWNS_SCRIPTS`) | **6 of 35** |
| Skills whose body instructs executing a script (`INSTRUCTS_EXECUTION`) | **9 of 35** |
| Is an MCP server an inspectable artifact? | **No — a `{command, args}` pointer** (`crates/aiox-core/src/mcp.rs:68`) |

D17's prohibition on third-party `scripts/` remains valid, but it is verifiable **over the folder,
not over the behaviour**. That is why the analyzer emits two signals and never one number.

## 2. Two independent signals, never collapsed

```
OWNS_SCRIPTS        the skill ships its own scripts/ directory      → it HOSTS code
INSTRUCTS_EXECUTION the body tells the agent to EXECUTE a script    → it RUNS code
```

They are **orthogonal**, and both matter: *who executes third-party script matters as much as who
hosts one.* A skill can host scripts it never runs; a skill can run scripts it does not host.
`INSTRUCTS_EXECUTION` is further classified by **whose** script:

| Form | Meaning | Real example measured in the SOT |
|---|---|---|
| `own` | the skill's own `scripts/` | `close` → `node <skill-dir>/scripts/write-ack.mjs` |
| `other-skill` | **another skill's** script | `validate` → `full-cycle/scripts/full-cycle-guard.mjs` |
| `repo` | the repository's top-level `scripts/` | `update-cockpit` → `bash scripts/run-aiox.sh` |
| `ambient` | a **bare name**, resolved from PATH/cwd at runtime | `criar-sot` → ``rode `registry-governance-check.js` `` |

### Why the count is not an acceptance criterion

**A measured number rots.** Three different counts circulated for `INSTRUCTS_EXECUTION` while this
story was being written (7 → 8 → 9) and *each was correct for its moment*: `validate` gained a
script reference after the ADR was written.

Worse, the naive regex everyone was quoting —
`grep -rlE 'scripts/[a-z]|\.mjs|\.sh' .aiox-core/skills/*/SKILL.md` — returns **9**, and the
correct answer is **also 9**, but they are **different sets**:

- it **wrongly includes** `self-heal` (a false positive — see §3), and
- it **wrongly excludes** `criar-sot` (a false negative: `.js`, no `scripts/` prefix, so the
  pattern never sees it).

Two opposite errors that happened to cancel out in the total. **Had the acceptance criterion fixed
a number, a wrong set would have passed it.** So the criterion requires the two signals, the
negative fixture, and coverage of every execution form — never a count.

## 3. `self-heal` — the mandatory negative fixture

`self-heal` has **no `scripts/` directory at all**, and its single script-shaped match is prose
citing another tool **by analogy**:

> **Adapters mirror the `sync.mjs` ADAPTERS pattern** (add a CLI = add an adapter; the loop is
> untouched).

The discriminant is **execution instruction vs. mention by pattern analogy**. The analyzer requires
either an interpreter in front of the token (`node …`, `bash …`, `powershell -File …`, `./…`) or an
imperative run-verb close in front of it (`run`, and PT-BR `rode`/`execute` — this corpus is
bilingual), and it rejects negated forms (*"never calls `wave-launch.js`"*).

**If the analyzer marks `self-heal`, it has reproduced inside itself the exact calibration error
D17 exists to correct.** `test/capability-analyzer.test.mjs` asserts it is in **neither** signal.

## 4. `allowed-tools` is mandatory (AC1) — and it is *not* a sandbox

Every publishable skill MUST declare `allowed-tools` in its frontmatter. Publishing without it
**fails**, unconditionally — no flag, no env var, no branch disables it
(`lib/capability-analyzer.mjs::checkAllowedToolsDeclared`, wired into `publisher/publish.mjs`).

The canonical contract, verified against Claude Code's own documentation:

- Spelling is **kebab-case** `allowed-tools`. `allowed_tools`/`allowedTools` are silently ignored
  by the runtime, so this repo **refuses** them rather than accepting a declaration that would
  never take effect.
- The value may be a **comma-separated** string, a **space-separated** string, or a **YAML list**.
  All three parse here.
- `allowed-tools: *` is refused — a wildcard passes a presence check while declaring nothing.

> **It GRANTS, it does not RESTRICT.** `allowed-tools` pre-approves tools for the turn that invokes
> the skill; a tool *absent* from the list remains callable and merely prompts. So the declaration
> is a **floor on stated intent, never a ceiling on reach** — which is precisely why the displayed
> capabilities are derived from the body instead of read off this field.

## 5. Capabilities are DERIVED, never self-declared (AC3)

A capability declared by an untrusted party is worth zero. In Zed it is imposed by the `wasmtime`
host; over a stdio subprocess it is a label the author chose.

So **the publisher has no field in which to assert its own capabilities.** This is enforced as a
refusal, not as "we ignore that field" — a field that is ignored today gets read by accident
tomorrow. A manifest carrying any of `capabilities`, `permissions`, `grants`, `sandbox` or
`trust_level` **fails the publish** (`checkNoSelfDeclaredCapabilities`).

The derived block is written onto the entry by `publisher/publish.mjs`, computed from the
artifact's **actual bytes**, and carries `self_declared: false` as **data** — so a reader of the raw
index can tell at a glance that it was computed, not accepted. `lib/entry-schema.mjs` re-checks that
the flag is literally `false`.

The declaration from §4 has exactly one role: a **second opinion to diff against**. When a skill's
body plainly does more than it declares, that surfaces as a `discrepancy` — it never shrinks the
displayed capability set.

## 6. What this analysis CANNOT see (AC5)

These travel **with** the capabilities, always — onto the entry, and into the rendered catalog. The
coupling is deliberate: **a capability list displayed without its blind spots lies by omission.**

- **An MCP server is a runtime-resolved pointer, not an artifact.** The manifest supplies
  `{command, args}` (product repo `crates/aiox-core/src/mcp.rs:68`, typically `npx <package>`) against a registry AIOX
  does not control. This analysis covers the **pointer**; it has never opened the **target**. The
  `npx` target is never inspected, downloaded or executed.
- A signature over the index covers the pointer, not the pointed-at package. **Provenance is not
  behaviour.**
- This is **static analysis of natural-language prose**. An execution instruction phrased in a form
  the probes do not match will be missed. **Absence of a signal is not proof of absence of the
  behaviour.**
- An `ambient` instruction resolves from PATH/cwd **on the user's machine**; which file actually
  runs is not knowable here.
- `allowed-tools` grants rather than restricts (§4).
- **Only skills are analyzed.** Other executable content (binaries, hooks, postinstall) is outside
  this pass.

## 7. v1 warns and displays; the blocking path is off (AC6)

Per D17 this is an explicit decision, not laxity. The blocking path **exists in code** and is
exercised by tests — `BLOCK_ON_CAPABILITY_FINDINGS` / `capabilityFindingsAreBlocking(override)` and
the `--strict` flag on the CLI.

**Documented trigger to turn it on: when the catalog opens to EXTERNAL publishers.**

## 8. Running it

```bash
# over a plugin artifact (the publish-time / CI input)
node scripts/analyze-capabilities.mjs --artifact <plugin.tar.gz> [--json] [--require-allowed-tools]

# over a directory of skills (e.g. a SOT skills tree) — same analyzer, different input adapter,
# so the numbers a maintainer reproduces here are the numbers the publish path computes
node scripts/analyze-capabilities.mjs --dir <skills-dir> [--json]
```

At publish time all of this is automatic: AC1 blocks, AC3 blocks, the derived block is attached to
the entry, and the report is printed for the operator.

---

*Story 055.W4.2 — AIOX Cockpit plugin system. See `docs/INVARIANTS.md` for D24's no-going-back
invariants and `docs/SCHEMA.md` for the entry shape.*
