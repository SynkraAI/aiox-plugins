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
import { gunzipSync } from "node:zlib";
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
// ── fix-cycle-4 (F17): classify from the ARCHIVE'S BYTES, not from `tar`'s rendered listing ───────
//
// WHAT THE QG EXECUTED. The cycle-3 archive with ONE extra header field: a crafted `uname` of
// `0 Aug 1`. uname is a 32-byte FREE-TEXT slot the archive's author fills in, and `tar -tvzf` prints
// it as a column between the link count and the size:
//
//   drw-r--r--  0 0 Aug 1 g          39 Jul 27  2021 ./config/payload/
//                 ^^^^^^^ "digits followed by a date" — the exact shape the size regex anchored on,
//                         appearing BEFORE the real size of 39
//
// `parseMemberSize` returned 0, `isRealDirectory` became true, the member was exempted from
// classification, and the scan reported "2/2 file(s) scanned", "Findings: none", exit 0 — while
// `tar -xOzf artifact.tar.gz ./config/payload/` printed the AWS key. Reproduced here before writing
// this, on this machine, with the same tar.
//
// WHY THIS IS A DIFFERENT KIND OF FIX FROM THE PREVIOUS THREE. Cycles 1-3 each closed the shape that
// had been demonstrated. Cycle 3 in particular was right in FORM — it inverted the classifier so that
// exemption requires positive evidence — but it left the EVIDENCE itself attacker-shapeable, because
// both the type and the size were read from `tar -tvzf`: a HUMAN-READABLE RENDERING whose column
// layout is a function of attacker-supplied header fields. An allowlist whose evidence is forgeable
// is an allowlist in shape and a denylist in effect. The previous cycle's own comment names half of
// this ("Rendered is load-bearing") and then uses a second value from the same rendering as the
// cross-check.
//
// THE FIX IS TERMINAL FOR THE CLASS, not another enumeration step: read the two facts from the ustar
// header's FIXED BINARY OFFSETS — typeflag at 156, size as octal at 124. No header field an attacker
// can write moves another field's offset, so there is no "one more forged column" variant of this.
// It stops asking what a member LOOKS LIKE and reads what the archive actually SAYS.
//
// WHAT IT COSTS, stated because "it's free" would be false: this is a minimal tar reader — the thing
// parsing the CLI was chosen to avoid. It must handle the extensions a real archive uses (ustar
// `prefix`, PAX `x`/`g` records, GNU `L`/`K` long names) or it would REFUSE legitimate packages whose
// paths exceed 100 bytes. Those are handled below. Anything it cannot walk cleanly refuses the whole
// artifact rather than guessing — the same fail-closed doctrine as every cycle before it.
//
// `tar` IS STILL CONSULTED, but demoted from source of truth to SECOND OPINION: its member count is
// compared against the header walk's, and a disagreement refuses the artifact. That is a real gain
// over cycle 3 — declared residual (i) said "nothing here detects a parser differential", and a
// count differential between two independent parses of the same bytes now does.
const TAR_LIST_MAX_BUFFER = 64 * 1024 * 1024;
const TAR_BLOCK = 512;

// ustar header field offsets (POSIX 1003.1-1988). These are the whole point of this cycle: a field
// at a fixed offset cannot be displaced by the content of any other field.
const OFF = Object.freeze({
  name: 0, size: 124, chksum: 148, typeflag: 156, magic: 257, prefix: 345,
});

// An octal numeric field: ASCII digits terminated by NUL and/or spaces. Returns null when the field
// cannot be read as a number — the caller must fail closed, never assume 0.
function parseOctalField(buf, off, len) {
  let s = buf.toString("ascii", off, off + len).replace(/\0/g, "").trim();
  if (s.length === 0) return null;
  if (!/^[0-7]+$/.test(s)) return null;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : null;
}

// GNU base-256 encoding for values that do not fit the octal field (large files). Signalled by the
// high bit of the first byte. Handled because refusing a >8 GiB member for the wrong reason would be
// a false refusal, not a security property.
function parseSizeField(buf) {
  const first = buf[OFF.size];
  if ((first & 0x80) === 0) return parseOctalField(buf, OFF.size, 12);
  let n = 0;
  for (let i = OFF.size + 1; i < OFF.size + 12; i++) n = n * 256 + buf[i];
  return Number.isSafeInteger(n) ? n : null;
}

// The header checksum, verified as both the unsigned and the signed sum (old tars differ on whether
// the bytes are signed). This is NOT an anti-forgery control — an attacker computes it as easily as
// tar does. It is a DESYNC detector: if the walk ever mistakes a data block for a header, the sum
// will not match and the whole artifact is refused instead of yielding invented members.
function headerChecksumOk(buf) {
  const stored = parseOctalField(buf, OFF.chksum, 8);
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < TAR_BLOCK; i++) {
    const b = i >= OFF.chksum && i < OFF.chksum + 8 ? 0x20 : buf[i]; // the field counts as spaces
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

function cstr(buf, off, len) {
  const end = buf.indexOf(0, off);
  const stop = end === -1 || end > off + len ? off + len : end;
  return buf.toString("utf8", off, stop);
}

// A PAX extended header's payload: repeated `<len> <key>=<value>\n` records. Only `path` and `size`
// are consumed — they are the two facts this classifier depends on, and ignoring an override that
// `tar` honours would reintroduce exactly the divergence this cycle exists to remove.
function parsePaxRecords(payload) {
  const out = {};
  let i = 0;
  const text = payload.toString("utf8");
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp === -1) break;
    const len = Number(text.slice(i, sp));
    if (!Number.isFinite(len) || len <= 0 || i + len > text.length) break;
    const record = text.slice(sp + 1, i + len).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

// The raw ustar typeflag, mapped onto the single-letter vocabulary `classifyMembers` already speaks.
// The mapping is total: an unrecognised flag keeps its own character, so the refusal message names
// the actual byte found in the archive rather than a guess about it.
function typeFromFlag(flag) {
  switch (flag) {
    case "0": case "\0": case "7": return "-"; // regular (and GNU contiguous, read as regular)
    case "5": return "d";
    case "1": return "h";
    case "2": return "l";
    case "3": return "c";
    case "4": return "b";
    case "6": return "p";
    default: return flag;
  }
}

function normalizeMemberPath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

// An entry whose path escapes the package root cannot be mapped to a file inside the extracted tree,
// so its bytes are not something this scan can honestly claim to have read.
function isUnsafeMemberPath(p) {
  return p.startsWith("/") || p === ".." || p.startsWith("../") || p.includes("/../");
}

// Walks the inflated tar stream block by block and returns one entry per real member, with the type
// and the size read from the header's own bytes. `aligned: false` means the stream could not be
// walked cleanly (or `tar` disagrees about how many members it holds) and the artifact is refused
// whole — the `reason` travels with it so the operator is told which of the two happened.
export function tarMemberTable(tarPath) {
  const raw = readFileSync(tarPath);
  let buf;
  try {
    // gzip magic. A plugin artifact is always a .tar.gz, but accepting a plain tar costs one branch
    // and avoids refusing a valid archive for a reason that has nothing to do with its contents.
    buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  } catch (e) {
    return { aligned: false, members: [], reason: `the archive could not be decompressed (${e.code ?? e.message}) — nothing about its contents can be certified` };
  }

  const members = [];
  let next = {}; // PAX / GNU long-name overrides awaiting the member they describe
  let off = 0;

  while (off + TAR_BLOCK <= buf.length) {
    const head = buf.subarray(off, off + TAR_BLOCK);
    if (head.every((b) => b === 0)) {
      // End-of-archive. Everything after it MUST be padding: a non-zero byte here is a member some
      // reader might pick up and this one would not, which is the differential this cycle refuses.
      const tail = buf.subarray(off);
      if (!tail.every((b) => b === 0)) {
        return { aligned: false, members: [], reason: "non-zero bytes follow the end-of-archive marker — the stream carries data outside the member table, which different tar implementations treat differently" };
      }
      break;
    }
    if (!headerChecksumOk(head)) {
      return { aligned: false, members: [], reason: `a 512-byte header at offset ${off} fails its own checksum — the member table cannot be walked, so nothing about the archive can be certified` };
    }

    const size = parseSizeField(head);
    if (size === null || size < 0) {
      return { aligned: false, members: [], reason: `the size field of the header at offset ${off} is not a readable number — the walk cannot advance without guessing where the next member begins` };
    }
    const flag = String.fromCharCode(head[OFF.typeflag]);
    const dataStart = off + TAR_BLOCK;
    const dataEnd = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (dataEnd > buf.length) {
      return { aligned: false, members: [], reason: `the header at offset ${off} declares ${size} byte(s) of data that run past the end of the stream — the archive is truncated or its headers are inconsistent` };
    }
    const payload = buf.subarray(dataStart, dataStart + size);

    // Metadata blocks: they describe the NEXT member and are not members themselves.
    if (flag === "x" || flag === "g") {
      const rec = parsePaxRecords(payload);
      if (flag === "x") {
        if (rec.path !== undefined) next.path = rec.path;
        if (rec.size !== undefined) next.size = Number(rec.size);
      }
      off = dataEnd;
      continue;
    }
    if (flag === "L") { next.path = payload.toString("utf8").replace(/\0+$/, ""); off = dataEnd; continue; }
    if (flag === "K") { off = dataEnd; continue; } // long LINK name — describes the target, not the member

    const prefix = head.toString("ascii", OFF.magic, OFF.magic + 5) === "ustar" ? cstr(head, OFF.prefix, 155) : "";
    const base = cstr(head, OFF.name, 100);
    const rawPath = next.path ?? (prefix ? `${prefix}/${base}` : base);
    members.push({
      raw_path: rawPath,
      path: normalizeMemberPath(rawPath),
      // From the header's typeflag byte at offset 156 — the archive's own statement about what this
      // member IS, not `tar`'s rendering of it. This is the whole of fix-cycle-4.
      type: typeFromFlag(flag),
      // From the octal size field at offset 124. A real directory carries 0; the F14/F17 member
      // carries 39, and no forged uname/gname/mode can change a byte at a fixed offset.
      size: next.size ?? size,
    });
    next = {};
    off = dataEnd;
  }

  // ── `tar` as a SECOND OPINION, not as the source of truth ───────────────────────────────────────
  //
  // The header walk is now authoritative, so `tar`'s enumeration becomes a DIFFERENTIAL: any member
  // one parse sees and the other does not is named individually. Declared residual (i) said "nothing
  // here detects a parser differential"; this does, at member granularity rather than as a count.
  //
  // It immediately found one, and it is not hypothetical. `tar -czf` on macOS writes an AppleDouble
  // `._name` companion member for every file carrying extended attributes — and `tar -tzf` DOES NOT
  // LIST IT, because the extracting tar consumes it as metadata. MEASURED here: an xattr set with
  // `xattr -w` on a LICENSE file produces a 163-byte `./._LICENSE` member absent from every listing
  // this scanner has ever read, whose bytes carry the xattr's value verbatim and are recoverable from
  // the published archive. Every cycle before this one enumerated from `tar`'s listing, so all four
  // of them reported complete coverage of archives containing members they had never seen. That is
  // the same undisclosed-blindness class as F10/F11/F14/F17, and the header walk is what makes it
  // visible. Dropping such a member because tar hides it would be the disqualifying failure by name,
  // so it is enumerated and refused like any other member the scan cannot certify.
  const tarNames = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8", maxBuffer: TAR_LIST_MAX_BUFFER })
    .split("\n").filter((l) => l.length > 0).map(normalizeMemberPath);

  // Multiset comparison — a duplicated path is listed twice by tar and appears twice in the headers,
  // and collapsing either side to a set would hide exactly the F10 construction.
  const remaining = new Map();
  for (const n of tarNames) remaining.set(n, (remaining.get(n) ?? 0) + 1);
  for (const m of members) {
    const left = remaining.get(m.path) ?? 0;
    m.listed_by_tar = left > 0;
    if (left > 0) remaining.set(m.path, left - 1);
  }
  const tar_only = [];
  for (const [name, count] of remaining) for (let i = 0; i < count; i++) tar_only.push(name);

  return { aligned: true, members, tar_only, counts: { names: tarNames.length, headers: members.length } };
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
        why: table.reason ?? "the archive's contents cannot be enumerated reliably, so nothing about it can be certified",
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

  // fix-cycle-4 (F17, differential half): a name `tar` enumerates that the header walk never
  // produced. The two parses disagree about what is in the archive, so neither can be trusted for it.
  for (const name of table.tar_only ?? []) {
    structural.push({ path: name, kind: "phantom-member", why: "`tar` lists this member but no ustar header in the stream produces it — two independent parses of the same bytes disagree about what the archive contains, so nothing about this member can be certified" });
  }

  for (const m of content) {
    // fix-cycle-4 (F17, differential half): a member whose header IS in the stream but which `tar`
    // does not list. The macOS AppleDouble case is the one that exists in practice, so it is named:
    // it ships real bytes (an xattr's value, recoverable from the archive) that no previous cycle
    // ever enumerated. Reported before every other check because the operator's fix is different
    // from every other refusal here — it is a rebuild, not an edit.
    if (m.listed_by_tar === false) {
      const appleDouble = /(^|\/)\._/.test(m.raw_path);
      structural.push({
        path: m.path,
        kind: "hidden-member",
        why: appleDouble
          ? "an AppleDouble metadata member that `tar -tzf` does not list — macOS `tar` writes one per file carrying extended attributes, and its bytes (the xattr values) ship inside the artifact while being invisible to the archive's own listing. Rebuild the package with `COPYFILE_DISABLE=1 tar -czf …` so the artifact contains only the files it declares."
          : "present as a ustar header in the stream but absent from `tar`'s own enumeration — its bytes ship inside the artifact while some extractors will never materialise it, so it cannot be certified",
      });
      continue;
    }
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
    // fix-cycle-3 (F14) / fix-cycle-4 (F17) — a member that PRESENTS as a directory without being
    // one, reached from either side: the header's typeflag says directory, or the name ends in `/`.
    // Reported before the generic non-regular case because the operator needs the specific anomaly
    // named: "it says directory but carries data" is a different problem from "it is a symlink".
    if (m.type === "d" || m.raw_path.endsWith("/")) {
      if (m.size === null) {
        structural.push({ path: m.path, kind: "directory-with-data", why: "presents as a directory but its size could not be read from the ustar header — a claim to be a directory that cannot be verified is not a pass (F14/F17)" });
      } else if (m.size > 0) {
        structural.push({
          path: m.path,
          kind: "directory-with-data",
          why: `presents as a directory but carries ${m.size} bytes of data — a real directory carries none, so this is a regular-file member wearing a directory's name (F14: the bytes ship and are recoverable with \`tar -xOzf\`, while nothing on disk holds them). The size is read from the ustar header at offset 124, not from tar's rendered listing (F17).`,
        });
      } else {
        structural.push({ path: m.path, kind: "directory-shaped-name", why: "member name ends in '/' but the ustar header's typeflag does not say directory — it cannot be mapped to exactly one extracted regular file (F14)" });
      }
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
    // fix-cycle-4: an archive `tar` cannot extract used to THROW out of here — an uncaught exception
    // with a stack trace instead of a report. It failed closed by accident (a crashed process exits
    // non-zero) rather than by design, and the operator was told nothing actionable. Found by the
    // broken-header fixture below, which is the first artifact this suite ever built that tar
    // refuses to unpack. It is now the same named, fail-closed refusal as every other unreadable
    // member: the archive is enumerated, nothing is certified, and the reason is printed.
    try {
      execFileSync("tar", ["-xzf", tarPath, "-C", dir], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      const detail = String(e.stderr ?? e.message ?? "").trim().split("\n")[0];
      return {
        subject: "artifact",
        files_total: 1,
        files_scanned: 0,
        bytes_scanned: 0,
        skipped_binary: [],
        skipped_too_large: [],
        skipped_structural: [{
          path: "(whole archive)",
          kind: "unextractable-archive",
          why: `\`tar\` could not unpack this archive (${detail || "no detail reported"}) — no member's bytes could be read, so nothing about it can be certified`,
        }],
        findings: [],
        rules: SECRET_RULES.length,
        classes: [...SECRET_CLASSES],
        provenance: SECRET_RULES_PROVENANCE,
        limits: [...SCANNER_LIMITS],
      };
    }
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
  "WHAT THE MEMBER TABLE ITSELF CANNOT SEE (the residual after fix-cycle-4, stated because an undeclared blind spot is the disqualifying kind). Since fix-cycle-4 the inventory is a direct walk of the archive's own 512-byte ustar headers — the typeflag at offset 156 and the size at offset 124 — so classification no longer depends on `tar`'s rendered listing, which is a human-readable projection whose columns an attacker can shape (F17: one forged `uname` re-exempted a credential-carrying member). What remains: (i) a member only ONE of the two parses can see is now DETECTED and refused by name in both directions (`hidden-member` / `phantom-member`) — that is how macOS AppleDouble members, whose bytes carry extended-attribute values and which `tar -tzf` does not list at all, are caught — but detection is a differential between exactly TWO parsers, this walk and the local `tar`; a third implementation that disagrees with BOTH is still not covered. (ii) The table describes STRUCTURE, not content: it cannot tell that an ordinary-looking member is itself a nested archive whose contents are never opened. (iii) Anything the walk cannot resolve cleanly — a header failing its own checksum, an unreadable size field, data past the end-of-archive marker, or an archive `tar` cannot unpack — refuses the ENTIRE artifact rather than guessing. Fail-closed, but it means such an archive cannot be published at all.",
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
