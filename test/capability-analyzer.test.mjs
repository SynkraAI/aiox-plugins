// test/capability-analyzer.test.mjs — story 055.W4.2 (D17 + D20(4)).
//
// The fixtures below are not invented: each is the REAL shape measured in the product repo's SOT
// (`.aiox-core/skills/`) on 2026-08-10, reduced to the line that carries the signal. That matters
// because the analyzer's whole reason to exist is calibration — a fixture set built from
// imagination would calibrate it against imagination.
//
// The negative fixture (`self-heal`) is MANDATORY and is the most important test in this file.
// A naive regex (`scripts/[a-z]|\.mjs|\.sh`) marks it, and it is a FALSE POSITIVE: the skill has
// no scripts/ dir at all and its only match is prose citing sync.mjs BY ANALOGY. If the analyzer
// marks it, the analyzer has reproduced inside itself the exact calibration error D17 exists to
// correct.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeSkills,
  analyzeSkill,
  detectExecutionInstructions,
  detectOwnedScripts,
  parseFrontmatter,
  parseAllowedTools,
  checkAllowedToolsDeclared,
  checkNoSelfDeclaredCapabilities,
  toEntryCapabilities,
  ANALYZER_LIMITS,
  BLOCK_ON_CAPABILITY_FINDINGS,
  capabilityFindingsAreBlocking,
} from "../lib/capability-analyzer.mjs";

const fm = (tools) => `---\nname: x\ndescription: y\nallowed-tools: ${tools}\n---\n`;
const skill = (name, body, tools = "Read, Bash") => ({
  name,
  path: `skills/${name}/SKILL.md`,
  content: fm(tools) + body,
});

// ── frontmatter / allowed-tools parsing ────────────────────────────────────────────────────────

test("parseAllowedTools accepts all three canonical shapes", () => {
  assert.deepEqual(parseAllowedTools("Read, Grep, Bash"), ["Read", "Grep", "Bash"]);
  assert.deepEqual(parseAllowedTools("Read Grep Bash"), ["Read", "Grep", "Bash"]);
  assert.deepEqual(parseAllowedTools(["Read", "Grep"]), ["Read", "Grep"]);
  assert.equal(parseAllowedTools(undefined), null);
});

test("parseFrontmatter reads a YAML-list allowed-tools", () => {
  const { fields } = parseFrontmatter("---\nname: x\nallowed-tools:\n  - Read\n  - Bash\n---\nbody\n");
  assert.deepEqual(fields["allowed-tools"], ["Read", "Bash"]);
});

// ── AC1 — allowed-tools mandatory ──────────────────────────────────────────────────────────────

test("AC1: a skill WITHOUT allowed-tools is refused", () => {
  const s = { name: "no-decl", path: "skills/no-decl/SKILL.md", content: "---\nname: no-decl\ndescription: d\n---\nbody" };
  const errs = checkAllowedToolsDeclared([s]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /declares no `allowed-tools`/);
});

test("AC1: a skill WITH allowed-tools passes", () => {
  assert.deepEqual(checkAllowedToolsDeclared([skill("ok", "body")]), []);
});

test("AC1: `allowed-tools: *` is refused — a wildcard passes presence while declaring nothing", () => {
  const errs = checkAllowedToolsDeclared([skill("wild", "body", "*")]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /wildcard/);
});

test("AC1: an EMPTY allowed-tools is refused", () => {
  const s = { name: "empty", path: "p", content: "---\nname: empty\nallowed-tools:\n---\nbody" };
  assert.match(checkAllowedToolsDeclared([s])[0], /empty/);
});

test("AC1: snake_case/camelCase spellings are refused, not silently accepted", () => {
  const s = { name: "snake", path: "p", content: "---\nname: snake\nallowed_tools: Read\n---\nbody" };
  const errs = checkAllowedToolsDeclared([s]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /kebab-case/);
});

test("AC1: no frontmatter at all is refused", () => {
  const errs = checkAllowedToolsDeclared([{ name: "raw", path: "p", content: "# just a heading\n" }]);
  assert.match(errs[0], /no YAML frontmatter/);
});

// ── AC3 — no self-declared capabilities ────────────────────────────────────────────────────────

test("AC3: a manifest declaring `capabilities` is REFUSED (not ignored)", () => {
  const errs = checkNoSelfDeclaredCapabilities({ plugin_id: "p", capabilities: ["filesystem:write"] });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /DERIVED by static analysis/);
});

test("AC3: every self-assertion field is refused, not just `capabilities`", () => {
  for (const field of ["permissions", "grants", "sandbox", "trust_level"]) {
    const errs = checkNoSelfDeclaredCapabilities({ plugin_id: "p", [field]: "anything" });
    assert.equal(errs.length, 1, `${field} must be refused`);
  }
});

test("AC3: a clean manifest passes", () => {
  assert.deepEqual(checkNoSelfDeclaredCapabilities({ plugin_id: "p", tiers: ["base"] }), []);
});

test("AC3: the derived entry block marks itself self_declared:false", () => {
  const report = analyzeSkills([skill("a", "Read the file.")], ["skills/a/SKILL.md"]);
  assert.equal(toEntryCapabilities(report).self_declared, false);
});

// ── AC4 — the two independent signals ──────────────────────────────────────────────────────────

test("AC4 signals are INDEPENDENT: a skill can own scripts without instructing execution", () => {
  const s = skill("hoarder", "This skill ships helpers but the body never runs them.");
  const r = analyzeSkill(s, ["skills/hoarder/SKILL.md", "skills/hoarder/scripts/unused.mjs"]);
  assert.equal(r.signals.owns_scripts.value, true);
  assert.equal(r.signals.instructs_execution.value, false);
});

test("AC4 signals are INDEPENDENT: a skill can instruct execution without owning scripts", () => {
  const s = skill("borrower", "Run `bash scripts/run-aiox.sh` from the repo root.");
  const r = analyzeSkill(s, ["skills/borrower/SKILL.md"]);
  assert.equal(r.signals.owns_scripts.value, false);
  assert.equal(r.signals.instructs_execution.value, true);
});

// --- positive fixture: OWN script (real shape — `close`) ---
test("AC4 positive/own: `node <skill-dir>/scripts/write-ack.mjs` is detected and owned by the skill", () => {
  const s = skill("close", "node <skill-dir>/scripts/write-ack.mjs --story-id <story-id> --ack close");
  const r = analyzeSkill(s, ["skills/close/SKILL.md", "skills/close/scripts/write-ack.mjs"]);
  assert.equal(r.signals.instructs_execution.value, true);
  assert.deepEqual(r.signals.instructs_execution.forms, ["own"]);
});

// --- positive fixture: ANOTHER skill's script (real shape — `validate` runs full-cycle's guard) ---
test("AC4 positive/other-skill: a script under skills/<other>/scripts is classified other-skill", () => {
  const s = skill("validate", "node <repo-root>/.aiox-core/skills/full-cycle/scripts/full-cycle-guard.mjs inspect <story-path>");
  const r = analyzeSkill(s, ["skills/validate/SKILL.md"]);
  assert.deepEqual(r.signals.instructs_execution.forms, ["other-skill"]);
});

// --- positive fixture: REPO script (real shape — `update-cockpit`) ---
test("AC4 positive/repo: `bash scripts/run-aiox.sh` is classified repo", () => {
  const s = skill("update-cockpit", "   - macOS/Linux: `bash scripts/run-aiox.sh`");
  const r = analyzeSkill(s, ["skills/update-cockpit/SKILL.md"]);
  assert.deepEqual(r.signals.instructs_execution.forms, ["repo"]);
});

// --- positive fixture: AMBIENT (real shape — `criar-sot`, PT-BR, missed by the naive grep) ---
test("AC4 positive/ambient: a bare script name behind a PT-BR run verb is detected", () => {
  const s = skill("criar-sot", "- Em repos com governança de registry, rode `registry-governance-check.js --mode advisory` se aplicável.");
  const r = analyzeSkill(s, ["skills/criar-sot/SKILL.md"]);
  assert.equal(r.signals.instructs_execution.value, true);
  assert.deepEqual(r.signals.instructs_execution.forms, ["ambient"]);
});

test("AC4: the Windows branch of a real instruction (backslashes, -File) is detected", () => {
  const s = skill("update-cockpit", "   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\run-aiox.ps1`");
  const r = analyzeSkill(s, ["skills/update-cockpit/SKILL.md"]);
  assert.equal(r.signals.instructs_execution.value, true);
});

// --- THE MANDATORY NEGATIVE FIXTURE ---
test("AC4 NEGATIVE (mandatory): `self-heal` is in NEITHER signal — prose analogy is not execution", () => {
  // Verbatim from .aiox-core/skills/self-heal/SKILL.md:31 — its ONLY script-shaped match, and the
  // reason the naive regex returns 9 instead of the correct set.
  const s = skill(
    "self-heal",
    "**Adapters mirror the `sync.mjs` ADAPTERS pattern** (add a CLI = add an adapter; the loop is untouched).",
  );
  const r = analyzeSkill(s, ["skills/self-heal/SKILL.md"]); // no scripts/ dir — matches disk
  assert.equal(r.signals.owns_scripts.value, false, "self-heal has no scripts/ dir on disk");
  assert.equal(
    r.signals.instructs_execution.value,
    false,
    "marking self-heal reproduces inside the analyzer the calibration error D17 exists to correct",
  );
});

test("AC4-bis NEGATIVE (generic): a skill that mentions no script at all is in neither signal", () => {
  const r = analyzeSkill(skill("pure", "Read the story and report a verdict. No commands."), ["skills/pure/SKILL.md"]);
  assert.equal(r.signals.owns_scripts.value, false);
  assert.equal(r.signals.instructs_execution.value, false);
});

test("AC4 NEGATIVE: a NEGATED reference ('never calls wave-launch.js') is not an instruction", () => {
  const s = skill("wave-execute", "the legacy `wave-launch.js` env-contract mirrored below never calls it at all");
  assert.equal(analyzeSkill(s, ["skills/wave-execute/SKILL.md"]).signals.instructs_execution.value, false);
});

test("AC4 NEGATIVE: framework names (Node.js / Next.js) are never mistaken for scripts", () => {
  const s = skill("tech", "Run the build. Frameworks: React, Next.js, Vue. Serviço Node.js documentado.");
  const hits = detectExecutionInstructions(s.content, "tech");
  assert.deepEqual(hits, [], `expected no hits, got ${JSON.stringify(hits)}`);
});

test("AC4 NEGATIVE: a test file cited as evidence is not an execution instruction", () => {
  const s = skill("close", "Evidence: `scripts/write-ack.test.mjs` (4 cases — canonical path, field override).");
  assert.equal(analyzeSkill(s, ["skills/close/SKILL.md"]).signals.instructs_execution.value, false);
});

test("detectOwnedScripts matches a wrapped tarball layout, not only a bare SOT dir", () => {
  const files = ["pkg-1.0.0/skills/close/SKILL.md", "pkg-1.0.0/skills/close/scripts/write-ack.mjs"];
  assert.deepEqual(detectOwnedScripts(files, "close"), ["pkg-1.0.0/skills/close/scripts/write-ack.mjs"]);
  assert.deepEqual(detectOwnedScripts(files, "other"), []);
});

test("the repo's own top-level scripts/ is owned by NOBODY", () => {
  assert.deepEqual(detectOwnedScripts(["scripts/run-aiox.sh", "skills/x/SKILL.md"], "x"), []);
});

// ── AC5 — the analyzer states what it cannot see ───────────────────────────────────────────────

test("AC5: every report carries the limits, and the MCP pointer limitation is among them", () => {
  const report = analyzeSkills([skill("a", "body")], ["skills/a/SKILL.md"]);
  assert.ok(report.limits.length >= 1);
  const joined = report.limits.join("\n");
  assert.match(joined, /MCP/);
  assert.match(joined, /\{command, args\}/);
  assert.match(joined, /npx/i, "the npx target must be named as not inspected");
  assert.match(joined, /never inspected/i);
});

test("AC5: the limits survive into the entry block that reaches the catalog", () => {
  const report = analyzeSkills([skill("a", "body")], ["skills/a/SKILL.md"]);
  const entryCaps = toEntryCapabilities(report);
  assert.ok(entryCaps.limits.length >= 1);
  assert.match(entryCaps.limits.join("\n"), /MCP/);
});

test("AC5: ANALYZER_LIMITS records that allowed-tools GRANTS rather than RESTRICTS", () => {
  assert.match(ANALYZER_LIMITS.join("\n"), /does NOT restrict/);
});

// ── AC6 — warn and display, blocking path present but off ──────────────────────────────────────

test("AC6: v1 is warn-and-display — the blocking flag is off by configuration", () => {
  assert.equal(BLOCK_ON_CAPABILITY_FINDINGS, false);
  assert.equal(capabilityFindingsAreBlocking(), false);
});

test("AC6: the blocking path EXISTS and can be turned on (it is code, not a promise)", () => {
  assert.equal(capabilityFindingsAreBlocking(true), true);
});

test("AC6: the report announces its own enforcement mode", () => {
  const report = analyzeSkills([skill("a", "body")], ["skills/a/SKILL.md"]);
  assert.equal(report.enforcement, "warn-and-display");
});

// ── derived, not declared ──────────────────────────────────────────────────────────────────────

test("capabilities are derived from the BODY, not from allowed-tools", () => {
  // Declares only Read, but the body plainly instructs writing and shelling out. The derivation
  // must follow the body — otherwise a publisher could shrink its displayed reach by under-declaring.
  const s = skill("liar", "Write the report to disk, then run `bash scripts/deploy.sh`.", "Read");
  const r = analyzeSkill(s, ["skills/liar/SKILL.md"]);
  assert.ok(r.derived_capabilities.includes("filesystem:write"));
  assert.ok(r.derived_capabilities.includes("shell:execute"));
  assert.ok(r.derived_capabilities.includes("script:execute"));
});

test("an under-declared allowed-tools surfaces as a discrepancy, not a silent pass", () => {
  const s = skill("under", "Run `bash scripts/deploy.sh` now.", "Read");
  const r = analyzeSkill(s, ["skills/under/SKILL.md"]);
  assert.ok(r.discrepancies.some((d) => /does not list Bash/.test(d)));
});

test("totals never collapse the two signals into one number", () => {
  const report = analyzeSkills(
    [
      skill("owns-only", "ships helpers, runs nothing"),
      skill("exec-only", "Run `bash scripts/x.sh`"),
    ],
    ["skills/owns-only/SKILL.md", "skills/owns-only/scripts/h.mjs", "skills/exec-only/SKILL.md"],
  );
  assert.equal(report.totals.owns_scripts, 1);
  assert.equal(report.totals.instructs_execution, 1);
  assert.equal(report.totals.skills, 2);
});
