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
    // fix-cycle-2 (F10/F11): members the archive's STRUCTURE puts out of reach. Same doctrine,
    // applied one step earlier — at enumeration rather than at read.
    ...(report.skipped_structural ?? []),
  ];
}

// ── fix-cycle-2 (F10/F11): enumerate the ARCHIVE, not the extracted filesystem ────────────────────
//
// WHAT THE QG EXECUTED. A single tar stream carrying the SAME path twice — first member holding a
// shape-valid AWS key, second member clean — extracts to one clean file on disk. The old inventory
// walked that extracted tree, saw one file, found nothing, and exited 0. The credential shipped and
// was fully recoverable from the published bytes (`tar -xOzf artifact.tar.gz ./config/app.env`).
// Reproduced here before writing the fix, on this machine, with the same result.
//
// WHY THIS ONE OUTRANKED THE GAP IT REPLACED, and the reason is not severity: the fail-closed
// doctrine from fix-cycle-1 was survivable precisely because the scanner SAID OUT LOUD what it had
// not read. A shadowed member appeared in nothing — not `files_total`, not `skipped_*`, not
// `unscannable`. Undisclosed blindness is the disqualifying kind, and this story's whole thesis is
// that a control communicated as stronger than it is is worse than a weaker control described
// honestly.
//
// THE ROOT CAUSE was one architectural line, not a mistake in the previous cycle: the inventory came
// from the EXTRACTED FILESYSTEM, so anything that does not survive extraction as a distinct regular
// file was invisible BY CONSTRUCTION. Duplicates collapse. Symlinks and other non-regular members are
// dropped before they can be counted (F11 — the same cause wearing a different symptom, which is why
// one change closes both).
//
// THE FIX: the member table is the source of truth for WHAT IS IN the archive; the extracted tree is
// used only to read the BYTES of members the table says are ordinary files. Anything the table lists
// that cannot be mapped to exactly one readable regular file is UNSCANNABLE — which routes it into
// the fail-closed path built and tested in cycle 1 rather than inventing a second mechanism.
//
// Two listings are used because they answer different questions and `tar` will not answer both at
// once: `-tzf` gives one raw name per line (unambiguous, and it repeats a duplicated path), `-tvzf`
// gives the type in column 1. They enumerate in the same order, so they align by index — and when
// they DON'T align (a member name containing a newline is the realistic cause) the whole artifact is
// refused rather than guessed at.
const TAR_LIST_MAX_BUFFER = 64 * 1024 * 1024;

function normalizeMemberPath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

// An entry whose path escapes the package root cannot be mapped to a file inside the extracted tree,
// so its bytes are not something this scan can honestly claim to have read.
function isUnsafeMemberPath(p) {
  return p.startsWith("/") || p === ".." || p.startsWith("../") || p.includes("/../");
}

// The SIZE column of a long listing, anchored on the date that follows it so it cannot be confused
// with the link count or the uid/gid that precede it. Both layouts this repo can meet are covered:
//   BSD/libarchive:  drwxr-xr-x  0 user wheel    39 Aug 10 01:48 ./config/payload/
//   GNU tar:         drwxr-xr-x user/group       39 2026-08-10 01:48 ./config/payload/
// fix-cycle-3 (F14): the size is what distinguishes a REAL directory (always 0 bytes) from a member
// merely RENDERED as one. Without it, the classifier can only ask what a member looks like.
const TAR_SIZE_BEFORE_DATE = /\s(\d+)\s+(?:[A-Z][a-z]{2}\s+\d{1,2}|\d{4}-\d{2}-\d{2})\s/;

function parseMemberSize(verboseLine) {
  const m = TAR_SIZE_BEFORE_DATE.exec(verboseLine);
  return m ? Number(m[1]) : null; // null = could not be determined; the caller must fail closed
}

export function tarMemberTable(tarPath) {
  const opts = { encoding: "utf8", maxBuffer: TAR_LIST_MAX_BUFFER };
  const names = execFileSync("tar", ["-tzf", tarPath], opts).split("\n").filter((l) => l.length > 0);
  const verbose = execFileSync("tar", ["-tvzf", tarPath], opts).split("\n").filter((l) => l.length > 0);
  if (names.length !== verbose.length) {
    return { aligned: false, members: [], counts: { names: names.length, verbose: verbose.length } };
  }
  const members = names.map((raw, i) => ({
    raw_path: raw,
    path: normalizeMemberPath(raw),
    // Column 1 of a tar long listing is the RENDERED type: `-`/`0` regular, `d` directory,
    // `l` symlink, `h` hardlink, `p` FIFO, `s` socket, `c`/`b` device. "Rendered" is load-bearing:
    // bsdtar prints `d` for any trailing-slash name regardless of the header's real typeflag, which
    // is exactly how F14 slipped through. The type alone is a claim; the size is the cross-check.
    type: verbose[i][0],
    size: parseMemberSize(verbose[i]),
  }));
  return { aligned: true, members, counts: { names: names.length, verbose: verbose.length } };
}

// ── fix-cycle-3 (F14): the classifier is an ALLOWLIST, not a denylist with a pre-filter ──────────
//
// WHAT THE QG EXECUTED. A hand-forged ustar member with typeflag '0' (REGULAR FILE) whose NAME ends
// in '/', carrying 39 bytes containing a shape-valid AWS key. `tar -tzf` lists it; `tar -tvzf`
// renders it as type `d`, because bsdtar prints a trailing-slash name as a directory regardless of
// the header's real typeflag. The previous pre-filter excluded members that were `type === "d"` OR
// whose name ended in `/` — so BOTH halves excluded it, before any refusal logic could run. Result:
// "2/2 file(s) scanned" on a 3-member archive, "Findings: none", exit 0 — while
// `tar -xOzf artifact.tar.gz ./config/payload/` printed the credential. Reproduced here before the
// fix, on this machine, with the same tar. That last detail matters: this is NOT covered by the
// declared parser-differential residual, which is about DIFFERENT tar implementations disagreeing.
// One implementation was enough.
//
// WHY THE SHAPE OF THE BUG MATTERS MORE THAN THE INSTANCE. The old rule asked what a member LOOKS
// LIKE and exempted on appearance. Anything that merely resembles a directory inherited the
// directory exemption regardless of what it actually carried — and tar is an old, permissive format
// with more shapes than any denylist will hold. Three cycles running, a denylist closed the
// demonstrated instance and left an undemonstrated one. So the question is inverted:
//
//   OLD (denylist):  "is this member excluded from classification?"  -> exempt on resemblance
//   NEW (allowlist): "can this member be POSITIVELY identified as one of two known-safe things?"
//                    -> everything else, INCLUDING anything unrecognised, is unscannable and refuses
//
// The two positively-identified categories, and nothing else:
//
//   DIRECTORY — rendered type `d` AND a size that is KNOWN and EXACTLY 0. A real directory carries
//     no data. A member rendered as a directory with non-zero size is anomalous by construction and
//     refuses. If the size cannot be parsed at all, that is not a pass either: an unverifiable claim
//     to be a directory is treated as unscannable, because the entire point of this inversion is
//     that exemption requires positive evidence.
//   ORDINARY FILE — rendered type `-`/`0`, name NOT ending in `/`, safe path, unique among content
//     members, and mappable to exactly one extracted regular file (checked in scanArtifact).
//
// Directories must stay exempt: refusing them would refuse EVERY package, which would "close" the
// finding and break the product. That carve-out is the one thing this inversion cannot tighten, so
// it is pinned by its own control test.
export function classifyMembers(table) {
  if (!table.aligned) {
    return {
      readable: [],
      structural: [{
        path: "(whole archive)",
        kind: "unparseable-member-table",
        why: `tar's two listings disagree on member count (${table.counts.names} vs ${table.counts.verbose}) — most likely a member name containing a newline. The archive's contents cannot be enumerated reliably, so nothing about it can be certified.`,
      }],
    };
  }

  // POSITIVE identification of a real directory — the ONLY exemption from classification.
  const isRealDirectory = (m) => m.type === "d" && m.size === 0;

  const content = table.members.filter((m) => !isRealDirectory(m));
  const seen = new Map();
  for (const m of content) seen.set(m.path, (seen.get(m.path) ?? 0) + 1);

  const readable = [];
  const structural = [];
  const reportedDuplicates = new Set();

  for (const m of content) {
    if (seen.get(m.path) > 1) {
      // Report a shadowed path ONCE, with its multiplicity — the point is the path is ambiguous,
      // and printing it N times would bury that under repetition.
      if (!reportedDuplicates.has(m.path)) {
        reportedDuplicates.add(m.path);
        structural.push({
          path: m.path,
          kind: "duplicate",
          why: `appears ${seen.get(m.path)} times in the archive — extraction keeps only the last, so an earlier member's bytes ship inside the artifact while never existing on disk to be read (this is the F10 construction: a shadowed credential)`,
        });
      }
      continue;
    }
    if (isUnsafeMemberPath(m.path)) {
      structural.push({ path: m.path, kind: "unsafe-path", why: "absolute or parent-escaping member path — it cannot be mapped to a file inside the package root, so its bytes cannot be read here" });
      continue;
    }
    // fix-cycle-3 (F14) — a member RENDERED as a directory that is not one. Reported before the
    // generic non-regular case because the operator needs the specific anomaly named: the size is
    // the evidence, and "it says directory but carries data" is a different problem from "it is a
    // symlink".
    if (m.type === "d") {
      structural.push({
        path: m.path,
        kind: "directory-with-data",
        why: m.size === null
          ? "renders as a directory but its size could not be determined from the archive listing — a claim to be a directory that cannot be verified is not a pass (F14)"
          : `renders as a directory but carries ${m.size} bytes of data — a real directory carries none, so this is a regular-file member wearing a directory's name (F14: the bytes ship and are recoverable with \`tar -xOzf\`, while nothing on disk holds them)`,
      });
      continue;
    }
    // fix-cycle-3 (F14) — the same anomaly reached from the other side: a name ending in `/` that
    // some other tar renders as an ordinary file rather than as a directory. It cannot map to one
    // extracted regular file either way.
    if (m.raw_path.endsWith("/")) {
      structural.push({ path: m.path, kind: "directory-shaped-name", why: "member name ends in '/' but the member is not a verified directory — it cannot be mapped to exactly one extracted regular file (F14)" });
      continue;
    }
    if (m.type !== "-" && m.type !== "0") {
      structural.push({ path: m.path, kind: "non-regular", why: `member type '${m.type}' is not a regular file (symlink/hardlink/FIFO/socket/device) — it carries no readable bytes of its own, so it is enumerated and refused rather than dropped before counting (F11)` });
      continue;
    }
    readable.push(m);
  }

  return { readable, structural };
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
  // fix-cycle-2 (F10/F11): the ARCHIVE decides what exists; the extracted tree only supplies bytes.
  const table = tarMemberTable(tarPath);
  const { readable, structural } = classifyMembers(table);

  const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-secretscan-"));
  try {
    execFileSync("tar", ["-xzf", tarPath, "-C", dir]);
    const onDisk = new Set(walk(dir));
    const findings = [];
    let scanned = 0;
    let bytes = 0;
    const skipped_binary = [];
    const skipped_too_large = [];
    const skipped_structural = [...structural];

    for (const m of readable) {
      const full = join(dir, m.path);
      // A member the table lists as an ordinary file that is nevertheless absent from the extracted
      // tree is not a pass — it is a member we never read, and the whole point of this cycle is that
      // those are enumerated instead of vanishing.
      if (!onDisk.has(m.path)) {
        skipped_structural.push({ path: m.path, kind: "missing-after-extraction", why: "listed in the archive's member table as a regular file but absent from the extracted tree — its bytes were never read" });
        continue;
      }
      const size = statSync(full).size;
      if (size > MAX_SCANNED_FILE_BYTES) { skipped_too_large.push({ path: m.path, bytes: size }); continue; }
      const buf = readFileSync(full);
      if (looksBinary(buf)) { skipped_binary.push({ path: m.path, bytes: size }); continue; }
      scanned++;
      bytes += size;
      findings.push(...scanText(buf.toString("utf8"), m.path));
    }

    return {
      subject: "artifact",
      // Counts the archive's CONTENT MEMBERS (directories excluded — they carry no bytes), so
      // "N/M file(s) scanned" now means what a reader assumes it means. Before this cycle it counted
      // what survived extraction, which silently understated a 3-member archive as 2 (F11).
      files_total: readable.length + structural.length,
      files_scanned: scanned,
      bytes_scanned: bytes,
      skipped_binary,
      skipped_too_large,
      skipped_structural,
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
    skipped_structural: [],
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
  "SYMLINKS ARE NOT FOLLOWED — AND SINCE fix-cycle-2 THEY ARE NOT SILENTLY DROPPED EITHER. A symlink points outside the artifact, so scanning its target would report on the publishing machine's filesystem rather than on what ships. It is now enumerated from the archive's member table and REFUSED as unscannable, together with every other non-regular member (hardlink, FIFO, socket, device) and every DUPLICATE member path. Before fix-cycle-2 a symlink was dropped before it could be counted, so a 3-member archive reported '2/2 file(s) scanned'.",
  "WHAT THE MEMBER TABLE ITSELF CANNOT SEE (the residual after fix-cycle-2, stated because an undeclared blind spot is the disqualifying kind). The inventory is THIS `tar`'s parse of the archive. (i) A crafted archive that another tar implementation parses differently — extra, ignored or ambiguous headers, PAX vs ustar disagreements — could present the consumer with members this scan never saw; nothing here detects a parser differential. (ii) The table describes STRUCTURE, not content: it cannot tell that an ordinary-looking member is itself a nested archive whose contents are never opened. (iii) If the two listings disagree on member count (a member name containing a newline is the realistic cause) the entire artifact is refused rather than guessed at — fail-closed, but it means such an archive cannot be published at all.",
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
  const structural = report.skipped_structural ?? [];
  if (report.skipped_binary.length || report.skipped_too_large.length || structural.length) {
    out.push(
      `NOT scanned: ${report.skipped_binary.length} binary, ${report.skipped_too_large.length} oversized, ${structural.length} structural — a skipped file is an UNKNOWN, not a pass, and an UNKNOWN is BLOCKING (fix-cycle-1, F2; fix-cycle-2, F10/F11):`,
    );
    for (const s of report.skipped_binary) out.push(`  - [binary]    ${s.path} (${s.bytes} bytes)`);
    for (const s of report.skipped_too_large) out.push(`  - [too large] ${s.path} (${s.bytes} bytes)`);
    for (const s of structural) out.push(`  - [${s.kind}] ${s.path} — ${s.why}`);
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
