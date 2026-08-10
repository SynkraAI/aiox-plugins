#!/usr/bin/env node
// scripts/check-channel-separation.mjs — story 055.W4.1, AC5.
//
// D19 fixes that a plugin's update cycle is INDEPENDENT of the cockpit binary's: the plugin is
// identified by version+tier+digest in its own marker, separate from `.aiox-core-build`, and the
// per-role binary channel of `ADR-COCKPIT-UPDATE-CHANNELS` (epic 017, Done) is REUSED as a concept,
// never reimplemented here.
//
// "Independent" is easy to write in a doc and easy to lose in a later edit. This guard makes it
// mechanical: no executable file in this repository may reference any binary-channel identifier, so
// a future change that starts reading the binary's state fails CI instead of quietly coupling the
// two channels.
//
// THE ONE EXEMPTION, and why it is safe: `lib/pin.mjs` names the identifiers in a frozen
// `binary_channel_identifiers` list — that list IS the declaration of what must not be read, and the
// single source this guard itself reads. The exemption is not "that file is trusted": occurrences in
// it are checked to fall inside that array literal (or inside a comment), and an occurrence anywhere
// else in the file is refused exactly like anywhere else in the repo.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNEL } from "../lib/pin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// The EXECUTABLE surface — the code that actually runs at publish time and in CI. Documentation is
// deliberately out of scope: docs/PIN-AND-CHANNEL.md must be free to explain the separation, which
// requires naming both sides of it.
const SCAN_DIRS = ["lib", "publisher", "scripts", "schema", "index", "ledger"];
const DECLARATION_FILE = "lib/pin.mjs";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// The region of lib/pin.mjs where naming an identifier is the point.
function declarationRegion(text) {
  const start = text.indexOf("binary_channel_identifiers");
  if (start < 0) return null;
  const end = text.indexOf("]),", start);
  if (end < 0) return null;
  return [start, end + 3];
}

// fix-cycle-1 (F4). The previous exemption was LINE-PREFIX textual — "does this line start with
// `//`, `*` or `/*`?" — and the QG defeated it with one character: a real coupling written as
// `/* probe */ const s = readFileSync(".aiox-core-build", …)` passed the guard, while the identical
// read on an ordinary line was caught. A guard with a one-character bypass is precisely the
// anti-pattern this story spends its whole argument on.
//
// The exemption is now applied to COMMENT CONTENT rather than to whole lines: comments are blanked
// out (preserving offsets, so reported line numbers stay true) and the guard searches what is LEFT,
// which is code. A doc-comment that names an identifier in order to declare the separation is still
// exempt — that is legitimate and there are several — but code hiding behind a comment opener on the
// same line is not, because after blanking the comment the code is still there.
//
// Quote tracking is included because a naive stripper would treat the `//` in a `"https://…"` string
// literal as a comment opener and blank the REST OF THE LINE — which fails in the dangerous
// direction (a real coupling after a URL would vanish). Regex literals are NOT tracked; a `/` that
// begins a regex containing `//` could still confuse this. That residual is stated rather than
// hidden, and it fails toward over-reporting (a spurious violation someone must look at), never
// toward missing a coupling.
function blankComments(text) {
  const out = text.split("");
  let i = 0;
  let state = "code"; // code | line | block | single | double | template
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "template";
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; i++; continue; }
      out[i] = " ";
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
      if (c !== "\n") out[i] = " ";
      i++;
      continue;
    }
    // inside a string/template: only the matching terminator (unescaped) ends it
    if (c === "\\") { i += 2; continue; }
    if ((state === "single" && c === "'") || (state === "double" && c === '"') || (state === "template" && c === "`")) {
      state = "code";
    }
    i++;
  }
  return out.join("");
}

const files = SCAN_DIRS.flatMap((d) => {
  try { return walk(join(root, d)); } catch { return []; }
});

const violations = [];
let occurrencesInDeclaration = 0;

for (const file of files) {
  const rel = relative(root, file).split("\\").join("/");
  const raw = readFileSync(file, "utf8");
  // Comments blanked, offsets preserved — so `code` and `raw` agree on every index and line number.
  const code = rel.endsWith(".json") ? raw : blankComments(raw);
  const region = rel === DECLARATION_FILE ? declarationRegion(raw) : null;
  const lines = raw.split(/\r?\n/);

  for (const id of CHANNEL.binary_channel_identifiers) {
    let idx = code.indexOf(id);
    while (idx !== -1) {
      const line = raw.slice(0, idx).split(/\r?\n/).length;
      const inRegion = region && idx >= region[0] && idx < region[1];
      if (inRegion) occurrencesInDeclaration++;
      else violations.push({ rel, line, id, text: (lines[line - 1] ?? "").trim().slice(0, 160) });
      idx = code.indexOf(id, idx + id.length);
    }
  }
}

// A second, independent property: the pin resolver must not be able to observe process state at all.
// `resolvePin` being a pure function of (index, pin) is what makes AC4's determinism and AC5's
// independence the SAME fact — so the absence of `process.env` in that module is worth asserting
// mechanically rather than trusting a reviewer to notice its reintroduction.
const pinSource = readFileSync(join(root, DECLARATION_FILE), "utf8");
if (/process\s*\.\s*env/.test(pinSource)) {
  violations.push({ rel: DECLARATION_FILE, line: 0, id: "process.env", text: "the pin resolver must not read the environment — determinism (AC4) and channel independence (AC5) both depend on it being a pure function of (index, pin)" });
}

console.log(`channel separation — scanned ${files.length} file(s) across ${SCAN_DIRS.join(", ")}`);
console.log(`binary-channel identifiers checked: ${CHANNEL.binary_channel_identifiers.join(", ")}`);
console.log(`declaration-site occurrences (lib/pin.mjs frozen list): ${occurrencesInDeclaration}`);

if (violations.length) {
  console.error(`REFUSED — the plugin channel must not reference the binary channel (${violations.length} occurrence(s)):`);
  for (const v of violations) console.error(`  - ${v.rel}:${v.line} [${v.id}] ${v.text}`);
  console.error("The plugin's cycle is independent of the binary's (D19): version+tier+digest in the plugin's own marker, resolved from the catalog index + the pin, and nothing else.");
  process.exit(1);
}

console.log("OK — no executable file in this repository reads binary-channel state");
