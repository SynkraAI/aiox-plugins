// lib/secret-scanner.mjs — story 055.W4.1, D20(1): the BLOCKING secret scan.
//
// WHAT THIS IS: the engine that runs the vendored gitleaks corpus (lib/secret-rules.mjs) over the
// two things a publish actually makes public — the ARTIFACT'S REAL BYTES and the MANIFEST that
// becomes the catalog entry. It is wired into publisher/publish.mjs as an unconditional refusal
// (AC1): a finding is a failure, never a warning. There is no flag, environment variable or fixture
// path that turns it off — the same posture as D24's four invariants.
//
// WHY THE ARTIFACT AND NOT "THE REPO": the base grep in .github/workflows/ci.yml scans this
// repository's own committed files. That is a different control with a different subject, and it was
// explicitly labelled "NOT the D20(1) blocking scanner" when it landed. The thing a user downloads
// and runs is the tarball in R2; the thing that ends up in the public index is the manifest. Those
// are what this scans.
//
// ── WHAT IT CANNOT SEE (AC3 — read `SCANNER_LIMITS` below, it is part of the result) ─────────────
//
// The limits travel WITH every report, exactly like `capabilities.limits` does in
// lib/capability-analyzer.mjs, and for the same measured reason (advisory-council finding C2): a
// control communicated as stronger than it is makes the user calibrate trust by the label. A scan
// result that can be displayed without its blind spots WILL eventually be displayed without them,
// so the blind spots are a field of the result object, not a paragraph in a document somewhere.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { SECRET_RULES, SECRET_RULES_PROVENANCE, SECRET_CLASSES } from "./secret-rules.mjs";

// A file larger than this is not READ. Chosen so a normal skill package (markdown + small scripts)
// is always fully covered while a vendored blob cannot make the publish pipeline hang.
export const MAX_SCANNED_FILE_BYTES = 5 * 1024 * 1024;

// ── THE DECISION SITE: an UNSCANNABLE member is a REFUSAL, not a pass (fix-cycle-1, F2) ───────────
//
// WHAT THE QG EXECUTED. Two one-line evasions each let an artifact carrying a live-shaped AWS key
// exit 0 and publish: (A) one leading NUL byte, so the member is classified `[binary]` and skipped;
// (B) the same credential followed by >5 MiB of padding, so it is classified `[too large]` and
// skipped. Both produced "Findings: none".
//
// WHY THAT WAS NOT ALREADY OBVIOUSLY WRONG — and the QG is right about this: the blindness was
// DISCLOSED. Every run printed which members were skipped and said "a skipped file is an UNKNOWN,
// not a pass". So this was never the failure this lineage is haunted by (a gate passing verde using
// a tool blind to the defect it was meant to catch — that failure is about UNDISCLOSED blindness).
// What was actually missing was smaller and more damning: every other trade-off in this deliverable
// is written down at its decision site, and THIS one was not. It was presented as an unavoidable
// property of scanning rather than as an alternative that had been weighed.
//
// THE CHOICE, MADE AND RECORDED: **fail-closed**. `publisher/publish.mjs` and
// `scripts/scan-secrets.mjs` REFUSE when any member could not be scanned. AC1's text is "um pacote
// contendo credencial reconhecível não publica — falha, não aviso"; a member nobody could read is a
// member nobody can say that about, and "unscannable therefore not publishable" is the only reading
// under which the sentence stays true. Disclosure is not enforcement.
//
// WHAT FAIL-CLOSED COSTS — named concretely, because "it's free" would be false:
//   1. A legitimate binary asset in a package (an icon, a font, a .wasm) is REFUSED. A plugin is
//      skills + scripts + a licence today, so this is not a case that exists yet — but it is the
//      case most likely to appear first.
//   2. macOS packaging junk is REFUSED, and this is the likeliest real false refusal: `.DS_Store`
//      and AppleDouble `._*` files are binary and `tar` on macOS sweeps them in by accident. The
//      refusal is arguably CORRECT here (that junk has no business in a published artifact) but it
//      will surprise a macOS publisher, so the message names the file and says what to do.
//   3. A genuinely large TEXT member (>5 MiB) is REFUSED rather than silently unexamined.
//
// WHY THE COST IS WORTH PAYING NOW: the catalog has ZERO real entries and is closed to external
// publishers, so today the false-refusal cost is literally zero — and that makes this the only
// moment when tightening the rule is free. It is the same reasoning that made D24 worth ratifying
// before a catalog existed: these things only cost nothing before they exist. Waiting until a real
// publisher is broken by the change is strictly worse than paying for it while nobody is watching.
//
// WHY THERE IS NO `--allow-unscannable` OVERRIDE, though the obvious design has one: an override is
// precisely the disable path AC1 forbids and the bypass sweep hunts for. A flag that lets a publish
// through with unread bytes is a flag that will be passed by default in somebody's CI within a
// quarter. When a legitimate binary-asset case actually appears, the answer is a DESIGNED rule
// (e.g. an explicit, digest-pinned asset allowlist that says which member is exempt and why),
// decided with a real case in hand — not a bypass built speculatively for a case that does not yet
// exist.
//
// Skipped members are still counted and listed in every report, exactly as before. What changed is
// that the listing is now a REFUSAL rather than a note the operator was free to ignore.
export const UNSCANNABLE_IS_BLOCKING = true;

// Every member the scan could not read, as one list — the thing the caller refuses on.
export function unscannableMembers(report) {
  if (!report) return [];
  return [
    ...report.skipped_binary.map((s) => ({ ...s, why: "binary (NUL byte in the first 8000 bytes — not readable as text)" })),
    ...report.skipped_too_large.map((s) => ({ ...s, why: `larger than the ${MAX_SCANNED_FILE_BYTES}-byte scan cap` })),
  ];
}

// ── entropy ──────────────────────────────────────────────────────────────────────────────────────

// Shannon entropy in bits/character — the same measure gitleaks applies to a rule's captured secret.
// Rules carry an entropy floor precisely because shape alone over-fires: `ghp_` followed by 36
// repetitions of one character matches the pattern and is obviously not a token.
export function shannonEntropy(str) {
  if (!str) return 0;
  const counts = new Map();
  for (const ch of str) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// ── redaction ────────────────────────────────────────────────────────────────────────────────────

// A scanner that prints what it found turns every CI log into the leak it was preventing. Findings
// carry a fingerprint, never the value: the first 4 characters (enough to recognise the provider
// prefix a human already knows) plus the length, plus a short digest-free hash-like tail marker.
export function redact(secret) {
  const s = String(secret ?? "");
  if (s.length <= 4) return `${"*".repeat(s.length)} (len ${s.length})`;
  return `${s.slice(0, 4)}${"*".repeat(Math.min(12, s.length - 4))} (len ${s.length})`;
}

// ── the scan ─────────────────────────────────────────────────────────────────────────────────────

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function compiled(rule) {
  // `g` is required (we iterate all matches); the rule's own flags carry the lifted `(?i)`.
  return new RegExp(rule.pattern, `g${rule.flags ?? ""}`);
}

function pathAllowed(rule, path) {
  if (!rule.allowPaths || !path) return false;
  return rule.allowPaths.some((p) => new RegExp(p).test(path));
}

function matchAllowed(rule, matched) {
  if (!rule.allowMatch) return false;
  return rule.allowMatch.some((p) => new RegExp(p).test(matched));
}

// Scans one text blob. `path` is only used for reporting + upstream path allowlists.
export function scanText(text, path = "(inline)") {
  const findings = [];
  const haystack = text.toLowerCase();

  for (const rule of SECRET_RULES) {
    // gitleaks' own keyword prefilter, kept for fidelity (and speed): a rule whose keyword does not
    // appear anywhere in the text cannot match, so it is skipped without running the regex.
    if (rule.keywords?.length && !rule.keywords.some((k) => haystack.includes(k))) continue;
    if (pathAllowed(rule, path)) continue;

    const re = compiled(rule);
    let m;
    while ((m = re.exec(text)) !== null) {
      // The "secret" is capture group 1 when the rule has one, else the whole match — the same
      // choice gitleaks makes, and it matters: the entropy floor is meant to apply to the credential,
      // not to the surrounding `cloudflare_token = ` boilerplate.
      const secret = m[1] ?? m[0];
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (matchAllowed(rule, secret)) continue;
      const entropy = shannonEntropy(secret);
      if (rule.entropy !== undefined && entropy < rule.entropy) continue;
      findings.push({
        rule_id: rule.id,
        class: rule.class,
        description: rule.description,
        path,
        line: lineOf(text, m.index),
        redacted: redact(secret),
        entropy: Number(entropy.toFixed(2)),
      });
    }
  }
  return findings;
}

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue; // a symlink's target is outside the artifact; see SCANNER_LIMITS
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(full.slice(base.length + 1).split(sep).join("/"));
  }
  return out;
}

// A NUL byte in the head of a file is the standard, cheap "this is not text" signal (`git` uses the
// same heuristic). Binary members are skipped and counted — see SCANNER_LIMITS.
function looksBinary(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 8000));
  return head.includes(0);
}

export function scanArtifact(tarPath) {
  const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-secretscan-"));
  try {
    execFileSync("tar", ["-xzf", tarPath, "-C", dir]);
    const rels = walk(dir);
    const findings = [];
    let scanned = 0;
    let bytes = 0;
    const skipped_binary = [];
    const skipped_too_large = [];

    for (const rel of rels) {
      const full = join(dir, rel);
      const size = statSync(full).size;
      if (size > MAX_SCANNED_FILE_BYTES) { skipped_too_large.push({ path: rel, bytes: size }); continue; }
      const buf = readFileSync(full);
      if (looksBinary(buf)) { skipped_binary.push({ path: rel, bytes: size }); continue; }
      scanned++;
      bytes += size;
      findings.push(...scanText(buf.toString("utf8"), rel));
    }

    return {
      subject: "artifact",
      files_total: rels.length,
      files_scanned: scanned,
      bytes_scanned: bytes,
      skipped_binary,
      skipped_too_large,
      findings,
      rules: SECRET_RULES.length,
      classes: [...SECRET_CLASSES],
      provenance: SECRET_RULES_PROVENANCE,
      limits: [...SCANNER_LIMITS],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The manifest is scanned as the raw JSON TEXT it is on disk, not as a parsed object: a secret can
// hide in a field this repo does not know about, and re-serialising would drop exactly those.
export function scanManifestFile(manifestPath) {
  const text = readFileSync(manifestPath, "utf8");
  return {
    subject: "manifest",
    files_total: 1,
    files_scanned: 1,
    bytes_scanned: Buffer.byteLength(text),
    skipped_binary: [],
    skipped_too_large: [],
    findings: scanText(text, manifestPath.split(/[\\/]/).pop()),
    rules: SECRET_RULES.length,
    classes: [...SECRET_CLASSES],
    provenance: SECRET_RULES_PROVENANCE,
    limits: [...SCANNER_LIMITS],
  };
}

// ── AC3 — what this scanner CANNOT see ───────────────────────────────────────────────────────────
//
// (a) and (b) are the two the story names explicitly; the rest are the ones measured while building
// it. They are frozen data, attached to every report, and rendered by `renderScanReport` under a
// heading that cannot be mistaken for an endorsement.
export const SCANNER_LIMITS = Object.freeze([
  "THE POINTER, NOT THE TARGET (limit (a), the big one). An MCP server in a plugin is a RUNTIME-RESOLVED POINTER — the manifest supplies `{command, args}` (product repo, crates/aiox-core/src/mcp.rs:68), typically `npx <package>`. This scan reads the PUBLISHED MANIFEST and the PUBLISHED ARTIFACT. It has never opened, downloaded or executed what that pointer resolves to, and what `npx` fetches tomorrow is not what was published today. A clean scan says nothing whatsoever about the code an MCP pointer will pull at runtime.",
  "AN OBFUSCATED OR ENCODED SECRET ESCAPES (limit (b)). Every rule here is a regex over literal text. A credential that is base64'd, split across concatenated strings, XOR'd, stored reversed, or assembled at runtime does not match any pattern and is not detected. This is a shape detector, not a semantic one.",
  "COVERAGE IS A FIXED LIST OF PROVIDERS, NOT 'SECRETS' IN GENERAL. The vendored corpus is a curated SUBSET of gitleaks' 222 rules (see lib/secret-rules.mjs `DELIBERATELY_NOT_VENDORED`). gitleaks' catch-all `generic-api-key` rule is deliberately NOT vendored, so a credential from an unlisted provider, or one with no recognisable prefix, is NOT detected.",
  "THE CORPUS DOES NOT UPDATE ITSELF. It is a snapshot (see `provenance`), vendored on a date, from a named upstream ref. New provider formats added upstream do not reach this scanner until someone re-vendors them. The snapshot is recorded so the staleness is measurable; it is not automatic.",
  "BINARY AND OVERSIZED MEMBERS CANNOT BE SCANNED — AND THEREFORE BLOCK THE PUBLISH (fail-closed, fix-cycle-1/F2). Files containing a NUL byte in their head, and files above the size cap, are not readable by this scanner. They are counted, listed, and REFUSED: a member nobody could read is a member nobody can certify, so 'unscannable' is treated as 'not publishable' rather than as a pass. The residual limit is therefore not a publishing hole but a USABILITY one, and it is real: a package with a legitimate binary asset (an icon, a font, a .wasm) or with macOS packaging junk (`.DS_Store`, AppleDouble `._*`) is refused until that member is removed or shipped in a scannable form. There is deliberately no override flag — see the decision site in lib/secret-scanner.mjs.",
  "SYMLINKS ARE NOT FOLLOWED. A symlink inside the artifact points outside the artifact; scanning its target would report on the publishing machine's filesystem, not on what ships.",
  "A CLEAN SCAN IS NOT A SECURITY VERDICT. It means 'no known credential SHAPE was found in these bytes'. It is not a statement that the package is safe, that it does no harm, or that AIOX endorses it — the catalog signs the INDEX to attest provenance, never the artifact to attest endorsement (D20(3)).",
]);

// ── rendering ────────────────────────────────────────────────────────────────────────────────────

export function renderScanReport(report) {
  const out = [];
  out.push(
    `Secret scan (${report.subject}) — ${report.files_scanned}/${report.files_total} file(s) scanned, ${report.bytes_scanned} byte(s), ${report.rules} rule(s) across ${report.classes.length} class(es)`,
  );
  out.push(
    `Corpus: ${report.provenance.source} @ ${report.provenance.ref} (${report.provenance.file}), vendored ${report.provenance.vendored_at}, upstream latest ${report.provenance.upstream_latest_release_when_vendored}`,
  );
  if (report.skipped_binary.length || report.skipped_too_large.length) {
    out.push(
      `NOT scanned: ${report.skipped_binary.length} binary, ${report.skipped_too_large.length} oversized — a skipped file is an UNKNOWN, not a pass, and an UNKNOWN is BLOCKING (fix-cycle-1, F2):`,
    );
    for (const s of report.skipped_binary) out.push(`  - [binary]    ${s.path} (${s.bytes} bytes)`);
    for (const s of report.skipped_too_large) out.push(`  - [too large] ${s.path} (${s.bytes} bytes)`);
  }
  if (report.findings.length === 0) {
    out.push("Findings: none");
  } else {
    out.push(`Findings: ${report.findings.length} — BLOCKING (D20(1)/AC1: this is a failure, not a warning)`);
    for (const f of report.findings) {
      out.push(`  ! [${f.class}] ${f.path}:${f.line} — rule ${f.rule_id}, entropy ${f.entropy}, value ${f.redacted}`);
      out.push(`      ${f.description}`);
    }
  }
  out.push("");
  out.push("WHAT THIS SCAN CANNOT SEE:");
  for (const l of report.limits) out.push(`  - ${l}`);
  return out.join("\n");
}

// The single call publisher/publish.mjs makes. Returns the two reports plus the merged finding list;
// the CALLER refuses on a non-empty list. Deliberately NOT `process.exit`-ing from in here — a
// library that kills the process cannot be tested, and an untestable gate is an unproven one.
export function scanPublishInputs({ manifestPath, artifactPath }) {
  const manifest = scanManifestFile(manifestPath);
  const artifact = existsSync(artifactPath) ? scanArtifact(artifactPath) : null;
  const findings = [...manifest.findings, ...(artifact?.findings ?? [])];
  // fix-cycle-1 (F2): the caller refuses on EITHER list. A finding means "we found a credential";
  // an unscannable member means "we could not look" — and under fail-closed both stop the publish.
  const unscannable = [...unscannableMembers(manifest), ...unscannableMembers(artifact)];
  return { manifest, artifact, findings, unscannable };
}
