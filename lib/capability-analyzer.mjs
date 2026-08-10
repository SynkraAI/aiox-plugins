// lib/capability-analyzer.mjs — story 055.W4.2, D17 + D20(4).
//
// WHAT THIS IS: a STATIC analyzer that DERIVES what a plugin's skills are capable of doing, by
// reading the skills' own bodies. It is the AIOX side of the wire, run by AIOX-operated tooling
// (publish-time + CI), never by the publisher.
//
// WHAT THIS IS NOT — and this framing is load-bearing, not a disclaimer: this delivers
// VISIBILITY, NOT CONTAINMENT. Nothing here sandboxes anything. Real containment needs an
// execution host, and the ADR rejects a third-party WASM host with evidence ("o Zed provou que
// mesmo com wasmtime completo a extensão não desenha UI"). Per D17, v1 WARNS AND DISPLAYS; the
// blocking path exists below (see `BLOCK_ON_CAPABILITY_FINDINGS`) but is OFF by configuration,
// with its documented trigger: "when opening to externals".
//
// WHY DERIVED AND NOT DECLARED (D17): a capability declared by an untrusted party is worth zero.
// In Zed it is imposed by the `wasmtime` host; over a stdio subprocess it is a label. So the
// publisher has NO manifest field in which to assert its own capabilities — see
// `checkNoSelfDeclaredCapabilities` below, which refuses the publish outright if one appears.
//
// THE THREAT MODEL IS NOT THE OBVIOUS ONE (finding C2, measured). In an app where an agent
// EXECUTES WHAT IT READS, declarative markdown is not the safe class — it is the class with the
// widest reach and the least visibility. The prohibition on third-party `scripts/` is verifiable
// over the FOLDER, not over the BEHAVIOUR, so this analyzer emits TWO INDEPENDENT SIGNALS per
// skill and never collapses them into one number:
//
//   OWNS_SCRIPTS        — the skill ships its own `scripts/` directory (it HOSTS code).
//   INSTRUCTS_EXECUTION — the skill's body tells the agent to EXECUTE a script: its own,
//                         ANOTHER skill's, or the repo's.
//
// They are orthogonal and both matter: who EXECUTES third-party script matters as much as who
// HOSTS one. A skill can host scripts it never runs, and can run scripts it does not host.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

// ── frontmatter ────────────────────────────────────────────────────────────────────────────────

// `allowed-tools` is kebab-case and accepts a space- or comma-separated string OR a YAML list.
// All three shapes are valid Claude Code skill frontmatter, so all three must parse here — a
// parser that only understood one shape would report "absent" for a perfectly valid declaration
// and turn AC1 into a false accusation.
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { present: false, fields: {}, body: text };

  const fields = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value = rawValue.trim();
    if (value === "" || value === "|" || value === ">") {
      // block scalar or YAML list — consume the indented continuation
      const items = [];
      let block = [];
      for (let j = i + 1; j < lines.length; j++) {
        const li = lines[j].match(/^\s*-\s+(.*)$/);
        if (li) { items.push(li[1].trim()); i = j; continue; }
        if (/^\s+\S/.test(lines[j])) { block.push(lines[j].trim()); i = j; continue; }
        break;
      }
      fields[key] = items.length ? items : block.join(" ");
      continue;
    }
    fields[key] = value.replace(/^["']|["']$/g, "");
  }
  return { present: true, fields, body: text.slice(m[0].length) };
}

export function parseAllowedTools(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const s = String(value).trim();
  if (!s) return [];
  return s.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
}

// ── AC1 — `allowed-tools` is MANDATORY on every publishable skill ──────────────────────────────

// A skill with no `allowed-tools` is a skill whose author never had to state, even once, what it
// reaches for. Refusing is cheap and the declaration is the only thing the analyzer can COMPARE
// its derived findings against (see `discrepancies` below) — without it there is no second
// opinion, only the analyzer's own.
export function checkAllowedToolsDeclared(skills) {
  const errors = [];
  for (const skill of skills) {
    const { present, fields } = parseFrontmatter(skill.content);
    if (!present) {
      errors.push(`skill "${skill.name}" (${skill.path}): no YAML frontmatter at all — refusing: \`allowed-tools\` is REQUIRED on every publishable skill (D17/AC1)`);
      continue;
    }
    const raw = fields["allowed-tools"] ?? fields["allowed_tools"] ?? fields["allowedTools"];
    if (raw === undefined) {
      errors.push(`skill "${skill.name}" (${skill.path}): frontmatter declares no \`allowed-tools\` — refusing (D17/AC1). Declare the tools this skill actually uses, e.g. \`allowed-tools: Read, Grep, Bash\`. The field is kebab-case and accepts a comma- or space-separated string, or a YAML list.`);
      continue;
    }
    if (fields["allowed_tools"] !== undefined || fields["allowedTools"] !== undefined) {
      errors.push(`skill "${skill.name}" (${skill.path}): the field is spelled \`allowed-tools\` (kebab-case). \`allowed_tools\`/\`allowedTools\` are silently ignored by the runtime, so accepting them here would let a skill ship with a declaration that never takes effect.`);
      continue;
    }
    const tools = parseAllowedTools(raw);
    if (!tools || tools.length === 0) {
      errors.push(`skill "${skill.name}" (${skill.path}): \`allowed-tools\` is present but empty — refusing: an empty declaration is indistinguishable from no declaration.`);
      continue;
    }
    if (tools.includes("*")) {
      errors.push(`skill "${skill.name}" (${skill.path}): \`allowed-tools: *\` is refused — a wildcard passes the presence check while declaring nothing. Enumerate the tools the skill actually uses.`);
    }
  }
  return errors;
}

// ── AC3 — the publisher has NO field in which to declare its own capabilities ──────────────────

// The literal proof AC3 asks for: not "we ignore the field", but "the field is refused". A
// manifest that tries to assert capabilities fails the publish, so no declared value can ever
// reach the user-facing display by any path.
const SELF_DECLARED_CAPABILITY_FIELDS = ["capabilities", "permissions", "grants", "sandbox", "trust_level"];

export function checkNoSelfDeclaredCapabilities(manifest) {
  const errors = [];
  for (const field of SELF_DECLARED_CAPABILITY_FIELDS) {
    if (manifest && Object.prototype.hasOwnProperty.call(manifest, field)) {
      errors.push(
        `manifest declares \`${field}\` — refusing (D17/AC3): capabilities are DERIVED by static analysis on the AIOX side, NEVER self-declared by the publisher. A capability asserted by the party being assessed is worth zero (in Zed it is imposed by the wasmtime host; over a stdio subprocess it is just a label), and displaying it would let an author choose the label the user calibrates trust against. Remove the field; the catalog computes and displays the derived analysis instead.`,
      );
    }
  }
  return errors;
}

// ── the two signals ────────────────────────────────────────────────────────────────────────────

// A script-file token. The basename must start LOWERCASE, which is what keeps framework names out
// of the corpus: "Node.js", "Next.js", "Vue.js" are capitalized and therefore never match, while
// "run-aiox.sh", "write-ack.mjs" and "registry-governance-check.js" do. Both path separators are
// accepted because the Windows branch of a real instruction uses backslashes
// (`-File scripts\run-aiox.ps1`).
// The leading lookbehind is what keeps FRAMEWORK NAMES out of the corpus. Without it, "Next.js"
// matches from its `e` ("ext.js") and "Node.js" from its `o`. Requiring a non-word character
// immediately before the match, plus a lowercase first character, rejects both while still
// accepting `run-aiox.sh`, `write-ack.mjs` and `registry-governance-check.js`.
const SCRIPT_TOKEN = /(?<![\w])(?:[\w.@-]+[/\\])*[a-z0-9][\w.-]*\.(?:mjs|cjs|js|sh|bash|zsh|ps1|py|rb|pl)\b/g;

// An interpreter in front of the token. It is NOT required to be immediately adjacent, because
// every real instruction in this corpus puts a path placeholder in between
// (`node <skill-dir>/scripts/write-ack.mjs`) and the placeholder's `<`/`>` cannot be part of the
// token. What the gap MAY contain is tightly constrained — flags and path-ish characters only,
// never an English word — so "the shell script `foo.sh`" still does not qualify.
const INTERPRETER = /\b(?:node|bash|sh|zsh|python3?|npx|deno|ruby|perl|pwsh|powershell)\b/gi;

// True when `before` ends in a genuine command line for one of the interpreters above.
//
// Written as code rather than one regex because the gap between the interpreter and the script is
// where the real cases live and they are not uniform: `node <skill-dir>/`, `bash `, and
// `powershell -NoProfile -ExecutionPolicy Bypass -File ` all occur verbatim in the corpus. The
// last of those is why a naive "flags only" pattern fails — `Bypass` is a bare word that is a
// FLAG'S VALUE, not prose.
//
// The rule that keeps prose out: every chunk between the interpreter and the script must be a
// flag, a path-ish token, or the value of a preceding flag. That admits `-ExecutionPolicy Bypass`
// while rejecting "each node in `graph.js`" — where the gap is the bare English word "in".
function hasInterpreterBefore(before) {
  INTERPRETER.lastIndex = 0;
  let end = -1;
  let m;
  while ((m = INTERPRETER.exec(before)) !== null) end = m.index + m[0].length;
  if (end < 0) return false;

  const gap = before.slice(end);
  if (gap.length > 120) return false;          // an interpreter mentioned far away is not this command
  if (gap.length > 0 && !/^\s/.test(gap)) return false; // must be whitespace-separated from its argv

  const chunks = gap.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (!/^[-\w:.$<>{}()\\/,=[\]"']+$/.test(c)) return false; // backticks, prose punctuation, etc.
    const isFlag = /^-/.test(c);
    const isPathish = /[/\\<>.$]/.test(c);
    const prevIsFlag = i > 0 && /^-/.test(chunks[i - 1]);
    if (!isFlag && !isPathish && !prevIsFlag) return false;   // a bare English word ends it
  }
  return true;
}

// An imperative run-verb close in front of the token. PT-BR is first-class here: this corpus is
// bilingual and `rode` is exactly as much an execution instruction as `run`. Backticks ARE allowed
// in the gap (a code span is the normal way to write a script name); sentence terminators are not.
const RUN_VERB_BEFORE = /\b(?:run|runs|rode|rodar|rodando|execute|executar|executes|exec|invoke|invokes|invoking|call|called|calling|calls)\b([^.!?]{0,40})$/i;

// ...unless it is negated. "never calls it at all" / "não roda" must not count as an instruction
// to execute. Only the span BETWEEN the verb and the token is examined.
const NEGATION_BETWEEN = /\b(?:never|not|no|n[aã]o|nunca|without|sem)\b/i;

function isExecutionContext(before) {
  if (hasInterpreterBefore(before)) return "interpreter";
  if (/\.[/\\]$/.test(before)) return "interpreter"; // ./script.sh
  const verb = before.match(RUN_VERB_BEFORE);
  if (verb && !NEGATION_BETWEEN.test(verb[1])) return "run-verb";
  return null;
}

// Classify WHO owns the script an instruction points at. All four forms are real and all of them
// matter to D17's threat model, which is exactly why the signal is not "owns a script":
//   own         — the skill's own scripts/ dir
//   other-skill — ANOTHER skill's script (a real, measured pattern: /validate runs full-cycle's guard)
//   repo        — the repository's top-level scripts/
//   ambient     — a BARE script name with no path, resolved from PATH/cwd at runtime. Which file
//                 actually runs is decided on the user's machine; see ANALYZER_LIMITS.
function classifyTarget(target, skillName, ownedScripts = []) {
  const norm = target.replace(/\\/g, "/");

  // An explicit `skills/<name>/` segment is the most specific evidence available — check it first,
  // before any placeholder heuristic, so `<repo-root>/.aiox-core/skills/full-cycle/scripts/x.mjs`
  // is correctly `other-skill` and never collapses to `repo`.
  const m = norm.match(/(?:^|\/)skills\/([^/]+)\//);
  if (m) return m[1] === skillName ? "own" : "other-skill";

  // A `<...>` placeholder that MENTIONS a skill (`<skill-dir>`, `<skill>`,
  // `<design-md-skill-root>`) denotes the skill's own directory. `<repo-root>` does not, and must
  // fall through — otherwise every placeholder path would be misread as self-owned.
  const ph = norm.match(/^<([^>]*)>\//);
  if (ph && /skill/i.test(ph[1])) return "own";

  const rest = norm.replace(/^<[^>]*>\//, "");

  // A bare relative `scripts/<file>` is genuinely ambiguous in prose — it can mean the repo's
  // top-level scripts/ or the skill's own, written skill-relative. Resolve it against the
  // package's REAL file listing rather than guessing: if this skill actually ships a script of
  // that name, the reference is to its own. Evidence beats convention.
  const basename = rest.split("/").pop();
  if (basename && ownedScripts.some((f) => f.replace(/\\/g, "/").endsWith(`/${basename}`))) return "own";

  if (rest.includes("/")) return "repo";
  return "ambient";
}

export function detectExecutionInstructions(body, skillName, ownedScripts = []) {
  const hits = [];
  const lines = body.split(/\r?\n/);
  lines.forEach((line, idx) => {
    SCRIPT_TOKEN.lastIndex = 0;
    let m;
    while ((m = SCRIPT_TOKEN.exec(line)) !== null) {
      const before = line.slice(0, m.index);
      const how = isExecutionContext(before);
      if (!how) continue;
      // Re-attach a `<...>/` placeholder the token regex could not absorb (`<` and `>` are not
      // path characters). Without this the owner of `node <skill-dir>/scripts/write-ack.mjs`
      // reads as the repo's top-level scripts/ instead of the skill's own — a wrong ANSWER from
      // a right DETECTION, which is the more dangerous of the two failures.
      const phMatch = before.match(/<[^>]*>\/$/);
      const target = (phMatch ? phMatch[0] : "") + m[0];
      hits.push({
        line: idx + 1,
        text: line.trim().slice(0, 220),
        target,
        owner: classifyTarget(target, skillName, ownedScripts),
        matched_by: how,
      });
    }
  });
  return hits;
}

// A skill OWNS a script when the file lives under that skill's own directory. Matched on the
// path segment `<skillName>/scripts/` so it works for every layout this repo actually sees:
// `skills/<name>/scripts/x` (SOT dir), `<wrapper>/skills/<name>/scripts/x` (npm-pack style
// tarball) and a bare `<name>/scripts/x`. The repo's OWN top-level `scripts/` is deliberately
// NOT owned by anybody — a skill that runs it is `repo`, which is a different signal.
export function detectOwnedScripts(files, skillName) {
  const needle = `/${skillName}/scripts/`;
  return files
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => `/${f}`.includes(needle))
    .sort();
}

// ── derived capabilities ───────────────────────────────────────────────────────────────────────

// Derived from the BODY, never from `allowed-tools`. The declaration is recorded separately and
// only ever used as a second opinion to diff against (see `discrepancies`).
const CAPABILITY_PROBES = [
  { id: "filesystem:read",  re: /\b(?:Read|Grep|Glob)\b|\bread the\b|\bleia\b/ },
  { id: "filesystem:write", re: /\b(?:Write|Edit|NotebookEdit)\b|\bwrite (?:the|a)\b|\bescrev[ae]\b/ },
  { id: "shell:execute",    re: /\bBash\b|```(?:bash|sh|shell|console)\b|\bgit \w+|\bcargo \w+|\bgh \w+/ },
  { id: "network:fetch",    re: /\b(?:WebFetch|WebSearch)\b|\bcurl\b|\bnpx\b|https?:\/\// },
  { id: "agent:spawn",      re: /\bAgent\(|\bsubagent_type\b|\bTeamCreate\b|\bAgent tool\b/ },
  { id: "user:prompt",      re: /\bAskUserQuestion\b/ },
  { id: "mcp:server",       re: /\bmcp(?:Servers)?\b|\bMCP\b/ },
];

export function deriveCapabilities(body, signals) {
  const caps = new Set();
  for (const probe of CAPABILITY_PROBES) if (probe.re.test(body)) caps.add(probe.id);
  if (signals.owns_scripts.value) caps.add("script:host");
  if (signals.instructs_execution.value) {
    caps.add("script:execute");
    caps.add("shell:execute"); // executing a script IS shell reach, whether or not "Bash" is written
  }
  return [...caps].sort();
}

// ── AC5 — what this analyzer CANNOT see ────────────────────────────────────────────────────────

// Without this, the capability display lies by omission — the C2 finding in its most expensive
// form. Every report carries these limits; they are not an appendix, they are part of the result.
export const ANALYZER_LIMITS = Object.freeze([
  "An MCP server is a RUNTIME-RESOLVED POINTER, not an inspectable artifact: the manifest supplies `{command, args}` (see the product repo's mcp.rs:68, typically `npx <package>`), resolved against a registry AIOX does not control. This analysis covers the POINTER; it has never opened the TARGET. The `npx` target is NEVER inspected, downloaded or executed here, so nothing below constrains what that package does once it runs.",
  "A signature over the index covers the pointer, not the pointed-at package. Provenance is not behaviour.",
  "This is STATIC analysis of skill prose. It cannot see what an agent will actually decide to do at runtime, and a skill body is natural language — an execution instruction phrased in a form these probes do not match will be missed. Absence of a signal is NOT proof of absence of the behaviour.",
  "An execution instruction classified `ambient` (a bare script name with no path) resolves from PATH/cwd at runtime. Which file actually runs is decided on the user's machine and is not knowable here.",
  "`allowed-tools` GRANTS pre-approval for a turn; it does NOT restrict. A tool absent from the declaration remains callable (it merely prompts), so the declaration is a floor on intent, never a ceiling on reach.",
  "Only skills are analyzed. Any other executable content in the package (binaries, hooks, postinstall) is outside this pass.",
]);

// Blocking is DELIBERATELY off (D17: v1 warns and displays). The path exists so that turning it
// on is a configuration change with a test behind it, not a re-design.
// TRIGGER TO ENABLE: when the catalog opens to EXTERNAL publishers. Until then every finding is
// surfaced to the user and to the operator, and none of them refuses a publish.
export const BLOCK_ON_CAPABILITY_FINDINGS = false;

export function capabilityFindingsAreBlocking(override = undefined) {
  return override === undefined ? BLOCK_ON_CAPABILITY_FINDINGS : Boolean(override);
}

// ── the analysis ───────────────────────────────────────────────────────────────────────────────

export function analyzeSkill(skill, allFiles) {
  const { fields, body } = parseFrontmatter(skill.content);
  const declared = parseAllowedTools(
    fields["allowed-tools"] ?? fields["allowed_tools"] ?? fields["allowedTools"],
  );

  const ownedScripts = detectOwnedScripts(allFiles, skill.name);
  const execHits = detectExecutionInstructions(body, skill.name, ownedScripts);

  const signals = {
    // Signal 1 — HOSTS code.
    owns_scripts: { value: ownedScripts.length > 0, evidence: ownedScripts },
    // Signal 2 — INSTRUCTS execution (own / other-skill / repo / ambient).
    instructs_execution: {
      value: execHits.length > 0,
      forms: [...new Set(execHits.map((h) => h.owner))].sort(),
      evidence: execHits,
    },
  };

  const derived = deriveCapabilities(body, signals);

  // The declaration's ONLY role: a second opinion to diff against. It never feeds the display.
  const discrepancies = [];
  if (declared) {
    if (signals.instructs_execution.value && !declared.includes("Bash")) {
      discrepancies.push(
        `instructs executing a script (${signals.instructs_execution.evidence[0].target}) but \`allowed-tools\` does not list Bash — the declaration under-states the skill's reach`,
      );
    }
    for (const [cap, tool] of [["filesystem:write", "Write"], ["network:fetch", "WebFetch"]]) {
      if (derived.includes(cap) && declared.length && !declared.some((t) => t.startsWith(tool))) {
        discrepancies.push(`derived \`${cap}\` is not reflected in the declared \`allowed-tools\``);
      }
    }
  }

  return {
    skill: skill.name,
    path: skill.path,
    declared_allowed_tools: declared,
    signals,
    derived_capabilities: derived,
    discrepancies,
  };
}

export function analyzeSkills(skills, allFiles) {
  const perSkill = skills.map((s) => analyzeSkill(s, allFiles)).sort((a, b) => a.skill.localeCompare(b.skill));
  return {
    analyzer_version: "1.0.0",
    derived_by: "aiox-plugins/lib/capability-analyzer.mjs (static analysis, AIOX-operated)",
    self_declared: false,
    skills: perSkill,
    totals: {
      skills: perSkill.length,
      owns_scripts: perSkill.filter((s) => s.signals.owns_scripts.value).length,
      instructs_execution: perSkill.filter((s) => s.signals.instructs_execution.value).length,
    },
    union_capabilities: [...new Set(perSkill.flatMap((s) => s.derived_capabilities))].sort(),
    limits: [...ANALYZER_LIMITS],
    enforcement: BLOCK_ON_CAPABILITY_FINDINGS ? "blocking" : "warn-and-display",
  };
}

// The compact projection stored on a catalog entry and rendered to the user (D20(4):
// "capabilities derivadas e VISÍVEIS"). `self_declared: false` is written as DATA, not prose, so
// a reader of the raw index can tell at a glance that this block was computed, not accepted.
// `limits` travels WITH the capabilities on purpose — a capability list that can be displayed
// without its blind spots is a capability list that will eventually be displayed without them.
export function toEntryCapabilities(report) {
  return {
    analyzer_version: report.analyzer_version,
    derived_by: report.derived_by,
    self_declared: false,
    enforcement: report.enforcement,
    union: report.union_capabilities,
    skills: report.skills.map((s) => ({
      skill: s.skill,
      capabilities: s.derived_capabilities,
      owns_scripts: s.signals.owns_scripts.value,
      instructs_execution: s.signals.instructs_execution.value
        ? s.signals.instructs_execution.forms
        : [],
    })),
    limits: report.limits,
  };
}

// ── collectors: a directory of skills, or an artifact tarball ──────────────────────────────────

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1).split(sep).join("/"));
  }
  return out;
}

// A directory laid out as <root>/<skill>/SKILL.md (a SOT skills dir), or <root>/skills/<skill>/SKILL.md.
export function collectSkillsFromDir(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  const base = existsSync(join(root, "skills")) ? join(root, "skills") : root;
  const files = walk(base).map((f) => `skills/${f}`);
  const skills = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(base, d.name, "SKILL.md")))
    .map((d) => ({
      name: d.name,
      path: `skills/${d.name}/SKILL.md`,
      content: readFileSync(join(base, d.name, "SKILL.md"), "utf8"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { skills, files };
}

// Extracts the artifact to a temp dir and reads the real bytes — same posture as
// lib/license-check.mjs (shell out to the system `tar`, no new npm dependency).
export function collectSkillsFromTarball(tarPath) {
  const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-capability-"));
  try {
    execFileSync("tar", ["-xzf", tarPath, "-C", dir]);
    const all = walk(dir);
    const skillMds = all.filter((f) => /(?:^|\/)SKILL\.md$/.test(f));
    const skills = skillMds.map((rel) => {
      const parts = rel.split("/");
      return {
        name: parts.length >= 2 ? parts[parts.length - 2] : "(root)",
        path: rel,
        content: readFileSync(join(dir, rel), "utf8"),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { skills, files: all };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── human-readable rendering (AC6 — the catalog entry must SHOW this) ──────────────────────────

export function renderCapabilityReport(report) {
  const out = [];
  out.push(`Derived capabilities — ${report.totals.skills} skill(s) analyzed`);
  out.push(`(DERIVED by static analysis on the AIOX side; never self-declared by the publisher — D17)`);
  out.push("");
  out.push(`Signals: OWNS_SCRIPTS ${report.totals.owns_scripts}/${report.totals.skills} · INSTRUCTS_EXECUTION ${report.totals.instructs_execution}/${report.totals.skills}`);
  out.push(`Union of capabilities: ${report.union_capabilities.join(", ") || "(none detected)"}`);
  out.push("");
  for (const s of report.skills) {
    const flags = [
      s.signals.owns_scripts.value ? "OWNS_SCRIPTS" : null,
      s.signals.instructs_execution.value ? `INSTRUCTS_EXECUTION(${s.signals.instructs_execution.forms.join("/")})` : null,
    ].filter(Boolean);
    out.push(`  ${s.skill}`);
    out.push(`    capabilities: ${s.derived_capabilities.join(", ") || "(none detected)"}`);
    out.push(`    signals:      ${flags.join(" · ") || "none"}`);
    out.push(`    declared:     ${s.declared_allowed_tools ? s.declared_allowed_tools.join(", ") : "(NONE — refused at publish, AC1)"}`);
    for (const h of s.signals.instructs_execution.evidence) {
      out.push(`      ↳ line ${h.line} [${h.owner}] ${h.target}`);
    }
    for (const d of s.discrepancies) out.push(`      ! ${d}`);
  }
  out.push("");
  out.push(`Enforcement: ${report.enforcement.toUpperCase()} (D17 — v1 warns and displays; blocking path exists, off by configuration, trigger: "when opening to externals")`);
  out.push("");
  out.push("WHAT THIS ANALYSIS CANNOT SEE:");
  for (const l of report.limits) out.push(`  - ${l}`);
  return out.join("\n");
}
