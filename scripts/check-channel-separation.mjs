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
// direction (a real coupling after a URL would vanish).
//
// fix-cycle-2 (F12) — A REGRESSION THIS FUNCTION ITSELF INTRODUCED, and the honest framing matters:
// the round-1 version of this comment claimed regex confusion "fails toward over-reporting … never
// toward missing a coupling". **That claim was false**, and the QG executed the counterexample:
// `const re = /[/*]/;` followed on the next line by a real `readFileSync(".aiox-core-build")` passed
// the guard with exit 0. The `/*` inside the character class opened block-comment state and erased
// the coupling. Under the OLD line-prefix logic that same construction WAS caught. On a story whose
// subject is inaccurate claims about a control's strength, an inaccurate claim about this control's
// strength is the specific error under review — so it is FIXED here, and what remains is described
// as it actually behaves rather than as I would like it to behave.
//
// TWO INDEPENDENT MEASURES, because one heuristic guarding a guard is not enough:
//
//   1. REGEX LITERALS ARE RECOGNISED. A `/` in regex-start position (the previous meaningful
//      character is an operator, opener, or a keyword like `return` — never an identifier, `)` or
//      `]`, which mean division) consumes to its unescaped closing `/`, honouring `[...]` classes.
//      The `//` and `/*` checks run FIRST, so an ordinary comment after `;` is still a comment and
//      not mistaken for a regex.
//   2. AN UNTERMINATED BLOCK COMMENT IS TREATED AS A PARSE FAILURE. If block state is entered and
//      never closed before EOF, this function returns the RAW text, so the guard searches everything
//      including comments. That over-reports (a doc-comment mention becomes a violation someone must
//      look at) — which is the safe direction — and it is precisely what would have caught F12 even
//      if measure 1 had missed, since `/[/*]/` opens a block that is never closed.
//
// THE RESIDUAL, stated accurately this time: a regex literal that measure 1 misclassifies as
// division AND that contains a BALANCED `/* … */` could still blank real code. That is narrower than
// the hole F12 exercised, but it is not "impossible", and this comment no longer says it is.
function blankComments(text) {
  const out = text.split("");
  let i = 0;
  let state = "code"; // code | line | block | single | double | template
  let lastMeaningful = "";

  // A `/` starts a regex literal when what precedes it cannot END an expression. Identifiers,
  // numbers, `)` and `]` can, so a `/` after those is division.
  const REGEX_START_AFTER = new Set(["", "=", "(", ",", "[", "{", ";", ":", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", ">", "\n"]);
  const KEYWORD_BEFORE_REGEX = /\b(?:return|typeof|instanceof|in|of|case|do|else|void|delete|yield|await)$/;

  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "code") {
      // Comment openers are checked BEFORE the regex heuristic: `x;` followed by `// note` must stay
      // a comment. This ordering is also why measure 1 is safe — at the first `/` of `/[/*]/` the
      // next character is `[`, so neither comment branch fires and the regex branch gets its turn.
      if (c === "/" && n === "/") { state = "line"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
      if (c === "/") {
        const before = text.slice(0, i);
        const canBeRegex = REGEX_START_AFTER.has(lastMeaningful) || KEYWORD_BEFORE_REGEX.test(before.trimEnd());
        if (canBeRegex) {
          // Consume the literal verbatim — it is code, it stays.
          let j = i + 1;
          let inClass = false;
          while (j < text.length) {
            const rc = text[j];
            if (rc === "\\") { j += 2; continue; }
            if (rc === "\n") break;              // an unterminated literal is not a regex; bail out
            if (rc === "[") inClass = true;
            else if (rc === "]") inClass = false;
            else if (rc === "/" && !inClass) { j++; break; }
            j++;
          }
          lastMeaningful = "/";
          i = j;
          continue;
        }
      }
      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "template";
      if (!/\s/.test(c)) lastMeaningful = c;
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
      lastMeaningful = c;
    }
    i++;
  }

  // Measure 2 — a block comment that never closes means this function's model of the file is wrong.
  // Return the RAW text so the guard searches everything: over-reporting is recoverable (a human
  // looks at a flagged doc-comment), under-reporting is the failure F12 was.
  if (state === "block") return text;
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
