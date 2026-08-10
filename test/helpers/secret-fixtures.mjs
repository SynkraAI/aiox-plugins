// test/helpers/secret-fixtures.mjs — story 055.W4.1, AC2. One planted credential PER COVERED CLASS.
//
// ── WHY EVERY VALUE IS ASSEMBLED AT RUNTIME FROM FRAGMENTS ───────────────────────────────────────
//
// Not stylistic. Two hard reasons:
//
//   1. AC7 — "no secret in the pipeline itself". A test fixture that is a literal, well-formed
//      credential shape sitting in a committed file is exactly the thing this story exists to keep
//      out of published bytes. Concatenating fragments means the repository never contains the shape
//      contiguously, while the value the scanner sees at runtime is byte-for-byte a real one.
//   2. This repository's own CI already greps every committed file for `AKIA[0-9A-Z]{16}`, a PEM
//      `BEGIN ... PRIVATE KEY` header, and a `CLOUDFLARE_API_TOKEN=` assignment (.github/workflows/
//      ci.yml, "No obvious secret shapes committed"). Committing literal fixtures would make this
//      story's own tests fail that guard — and the tempting fix (adding an exclusion for the test
//      directory) would punch a hole in a working control to accommodate a test. Assembling at
//      runtime keeps BOTH controls intact, with neither weakened.
//
// Every value below is FABRICATED — invented character sequences that match a provider's published
// FORMAT. None of them is, or was ever, a live credential for anything.
//
// ── "INVALID IN EXACTLY ONE WAY" ─────────────────────────────────────────────────────────────────
//
// Same discipline as test/helpers/tarball.mjs's license fixtures: each artifact below is a fully
// VALID publishable package (LICENSE at root, a skill with `allowed-tools`) that carries exactly one
// planted credential, of exactly one class. `test/secret-scanner.test.mjs` asserts that mechanically
// — a fixture that trips two rules would let its test pass for the wrong reason.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTarball, FIXTURE_SKILL } from "./tarball.mjs";
import { MAX_SCANNED_FILE_BYTES } from "../../lib/secret-scanner.mjs";

// fix-cycle-4 (F17). macOS `tar` writes an AppleDouble `._name` companion member for every file that
// carries extended attributes, and `tar -tzf` does NOT list them — so their bytes ship inside the
// artifact while being invisible to the archive's own listing. A fixture is meant to be a WELL-FORMED
// package, and the scanner now (correctly) refuses one that carries members it does not declare.
// This env var is the standard macOS fix and a no-op on Linux, where GNU tar never writes them.
const NO_APPLEDOUBLE = { ...process.env, COPYFILE_DISABLE: "1" };

const B = "-----BEGIN ";
const E = "-----END ";
const PK = "RSA PRIVATE KEY-----";

// Fabricated PEM body — long enough to clear the rule's `{64,}` minimum between the two markers.
const PEM_BODY = [
  "MIIEpAIBAAKCAQEA3vQ2mKcLdYw7RsTbNzXfQjHgVpKmEuLoAiCwZxNdRfTgYhUj",
  "kLmPqRsTuVwXyZ0123456789abcdefGHIJKLMNOPqrstuvwxYZabcdEFGHijklmn",
  "opQRSTuvwxYZ0123456789ABCDEFghijKLMNopqrstUVWXyz0123456789abcdef",
].join("\n");

// Each entry: the CLASS (matching lib/secret-rules.mjs `SECRET_CLASSES`), the file the credential is
// planted in, and a `render()` that assembles it. `where` is realistic on purpose — a credential
// leaks in a config file, a deploy script or a README, not in a file named `secret.txt`.
export const PLANTED_SECRETS = Object.freeze([
  {
    class: "private-key",
    where: "config/deploy-key.pem",
    render: () => `${B}${PK}\n${PEM_BODY}\n${E}${PK}\n`,
  },
  {
    class: "aws-access-key",
    where: "config/settings.env",
    render: () => `AWS_ACCESS_KEY_ID=${"AKIA"}${"QRS7TUVWX234YZ56"}\n`,
  },
  {
    class: "github-token",
    where: "scripts/release.sh",
    render: () => `#!/bin/sh\nexport GH_TOKEN=${"ghp_"}${"aB3dEf7hIjKlM9oPqRsTuVwXyZ0123456789"}\n`,
  },
  {
    class: "github-fine-grained-token",
    where: "config/ci.env",
    render: () =>
      `FORGE_TOKEN=${"github_pat_"}${"11ABCDEFG0aB3dEf7hIjKlM9oPqRsTuVwXyZ0123456789bCdEfGhIjKlMnOpQrStUvWxYz01234567_x9"}\n`,
  },
  {
    class: "cloudflare-api-token",
    where: "config/edge.toml",
    render: () => `${"cloudflare"}_api_token = "${"vQ7hZ2mKcLdYw9RsTbNzXfQjHgVpKmEuLoAiCwZx"}"\n`,
  },
  {
    class: "cloudflare-global-api-key",
    where: "config/edge-global.toml",
    render: () => `${"cloudflare"}_global_key = "${"a1b2c3d4e5f60718293a4b5c6d7e8f90abcde"}"\n`,
  },
  {
    class: "slack-token",
    where: "scripts/notify.sh",
    render: () => `SLACK=${"xoxb-"}${"2938471029384"}-${"1029384756102"}-${"aB3dEf7hIjKlMnOpQrStUvWx"}\n`,
  },
  {
    class: "slack-user-token",
    where: "config/slack.env",
    render: () =>
      `SLACK_USER=${"xoxp-"}${"2938471029384"}-${"1029384756102"}-${"5647382910473"}-${"aB3dEf7hIjKlMnOpQrStUvWxYz012345"}\n`,
  },
  {
    class: "stripe-key",
    where: "config/billing.env",
    render: () => `STRIPE_SECRET="${"sk_live_"}${"4eC39HqLyjWDarjtT1zdp7dc"}"\n`,
  },
  {
    class: "openai-api-key",
    where: "config/models.env",
    render: () => `OPENAI="${"sk-"}${"aB3dEf7hIjKlM9oPqRsT"}${"T3BlbkFJ"}${"uVwXyZ0123456789abcd"}"\n`,
  },
  {
    class: "anthropic-api-key",
    where: "config/anthropic.env",
    render: () =>
      `ANTHROPIC="${"sk-ant-api03-"}${"aB3dEf7hIjKlM9oPqRsTuVwXyZ0123456789-_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012"}${"AA"}"\n`,
  },
  {
    class: "gcp-api-key",
    where: "config/maps.env",
    render: () => `GOOGLE_MAPS="${"AIza"}${"Sy7dQmKcLdYw9RsTbNzXfQjHgVpUeoAi2x4"}"\n`,
  },
  {
    class: "npm-token",
    where: ".npmrc",
    render: () => `//registry.npmjs.org/:_authToken=${"npm_"}${"aB3dEf7hIjKlM9oPqRsTuVwXyZ0123456789"}\n`,
  },
  {
    class: "jwt",
    where: "config/session.json",
    render: () =>
      `{ "token": "${"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}.${"eyJzdWIiOiJhY2N0X2ZpeHR1cmUiLCJpYXQiOjE1MTYyMzkwMjJ9"}.${"dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"}" }\n`,
  },
]);

// A fully valid publishable artifact + exactly one planted credential.
export function buildArtifactWithPlantedSecret(planted) {
  return buildTarball({
    LICENSE: "MIT License\n\nCopyright (c) AIOX\n",
    "SKILL.md": FIXTURE_SKILL,
    [planted.where]: planted.render(),
  });
}

// ── fix-cycle-1 (F2) — the EVASION fixtures ──────────────────────────────────────────────────────
//
// These are the two artifacts the QG built by hand to defeat the gate. They are reproduced here as
// permanent fixtures so the fail-closed decision is proven BY EXECUTION rather than by the paragraph
// that argues for it: the argument can be edited, the fixtures cannot be satisfied by prose.
//
// Both carry a REAL, shape-valid credential — the same `aws-access-key` fixture used above — so a
// scanner that could read the member would certainly find it. The only thing standing between the
// credential and publication is whether "I could not read this" is treated as a pass.

// Evasion A — one leading NUL byte makes the member read as binary.
// The NUL is produced with String.fromCharCode, never written as a literal byte in this source: a
// source file containing a real NUL is classified binary, and `grep -I` (which this repo's own CI
// guards use) SKIPS binary files, which would silently drop this file out of the sweeps it must be
// subject to.
export function buildArtifactWithNulPrefixedSecret() {
  const planted = PLANTED_SECRETS.find((p) => p.class === "aws-access-key");
  return buildTarball({
    LICENSE: "MIT License\n\nCopyright (c) AIOX\n",
    "SKILL.md": FIXTURE_SKILL,
    "config/creds.env": String.fromCharCode(0) + planted.render(),
  });
}

// Evasion B — the same credential, followed by padding that pushes the member past the scan cap.
export function buildArtifactWithOversizedSecret() {
  const planted = PLANTED_SECRETS.find((p) => p.class === "aws-access-key");
  const padding = "#".repeat(MAX_SCANNED_FILE_BYTES + 1);
  return buildTarball({
    LICENSE: "MIT License\n\nCopyright (c) AIOX\n",
    "SKILL.md": FIXTURE_SKILL,
    "config/creds.env": planted.render() + padding,
  });
}

// ── fix-cycle-2 (F10/F11) — the STRUCTURAL evasions ──────────────────────────────────────────────
//
// These two cannot be built with `buildTarball`, which writes a directory and archives it: one needs
// the same path to appear TWICE in a single tar stream (the filesystem cannot hold that), and the
// other needs a member that is not a regular file. They are built by driving `tar` directly, the
// same posture as the rest of this helper — exercise the real tool, never a mock.
//
// gzip is done with node:zlib rather than by shelling out, so the fixture does not depend on a
// `gzip` binary being on PATH in CI.

// F10 — the shadowed duplicate. Member 1 at `config/app.env` carries a shape-valid AWS key; member 2
// at the SAME path is clean. Extraction keeps only the clean one, so a filesystem-based inventory
// sees nothing wrong — while `tar -xOzf artifact.tar.gz ./config/app.env` still prints the
// credential from the published bytes. This is the QG's construction, reproduced verbatim.
export function buildArtifactWithShadowedDuplicate() {
  const planted = PLANTED_SECRETS.find((p) => p.class === "aws-access-key");
  const first = mkdtempSync(join(tmpdir(), "aiox-plugins-shadow-a-"));
  const second = mkdtempSync(join(tmpdir(), "aiox-plugins-shadow-b-"));
  const outDir = mkdtempSync(join(tmpdir(), "aiox-plugins-shadow-out-"));
  try {
    mkdirSync(join(first, "config"), { recursive: true });
    writeFileSync(join(first, "LICENSE"), "MIT License\n\nCopyright (c) AIOX\n");
    writeFileSync(join(first, "SKILL.md"), FIXTURE_SKILL);
    writeFileSync(join(first, "config", "app.env"), planted.render()); // the credential

    mkdirSync(join(second, "config"), { recursive: true });
    writeFileSync(join(second, "config", "app.env"), "APP_ENV=production\n"); // the innocent shadow

    const tarPath = join(outDir, "artifact.tar");
    // COPYFILE_DISABLE=1 — see test/helpers/tarball.mjs. The isolated defect here is the DUPLICATE
    // path; a fixture that also carried AppleDouble members would be refused for two reasons at once
    // and its test would pass for the wrong one.
    execFileSync("tar", ["-cf", tarPath, "."], { cwd: first, env: NO_APPLEDOUBLE });
    execFileSync("tar", ["-rf", tarPath, "./config/app.env"], { cwd: second, env: NO_APPLEDOUBLE });

    const gz = join(outDir, "artifact.tar.gz");
    writeFileSync(gz, gzipSync(readFileSync(tarPath)));
    return gz;
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
}

// F11 — a non-regular member. The symlink carries no bytes of its own, so this is an honesty defect
// rather than a leak path: before fix-cycle-2 it was dropped BEFORE enumeration, so a 3-member
// archive reported "2/2 file(s) scanned" — complete coverage of an archive it had not fully seen.
export function buildArtifactWithSymlinkMember() {
  const src = mkdtempSync(join(tmpdir(), "aiox-plugins-symlink-src-"));
  const outDir = mkdtempSync(join(tmpdir(), "aiox-plugins-symlink-out-"));
  try {
    mkdirSync(join(src, "config"), { recursive: true });
    writeFileSync(join(src, "LICENSE"), "MIT License\n\nCopyright (c) AIOX\n");
    writeFileSync(join(src, "SKILL.md"), FIXTURE_SKILL);
    symlinkSync("/etc/passwd", join(src, "config", "outside.env"));
    const gz = join(outDir, "artifact.tar.gz");
    execFileSync("tar", ["-czf", gz, "."], { cwd: src, env: NO_APPLEDOUBLE });
    return gz;
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}

// ── fix-cycle-3 (F14) — a member that PRESENTS as a directory while carrying file data ───────────
//
// This one cannot be produced by any standard tar tool, which is precisely why it needs a forged
// header: `tar` will not create a regular-file member whose name ends in `/`. The archive below is a
// valid ustar stream (correct header checksum — the second engine's own attempt produced a DAMAGED
// archive and therefore proved nothing, which is worth remembering before trusting a probe that was
// not run).
//
// The member is typeflag '0' (REGULAR FILE) named `./config/payload/` carrying a shape-valid AWS
// key. `tar -tvzf` renders it as type `d` because bsdtar prints any trailing-slash name as a
// directory — so a classifier that exempts on APPEARANCE lets it through, while
// `tar -xOzf artifact.tar.gz ./config/payload/` prints the credential from the published bytes with
// the same tar on the same machine.

function ustarHeader(name, size, typeflag, { uname = "", gname = "" } = {}) {
  const b = Buffer.alloc(512, 0);
  const put = (s, off, len) => b.write(String(s).slice(0, len), off, len, "ascii");
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  b.write("        ", 148, 8, "ascii"); // checksum field counts as spaces while summing
  put(typeflag, 156, 1);
  b.write("ustar\0", 257, 6, "ascii");
  b.write("00", 263, 2, "ascii");
  // uname/gname are 32-byte FREE-TEXT slots the archive's author fills in — see the F17 fixture below
  // for why that matters to anything that reads `tar`'s rendered listing.
  if (uname) put(uname, 265, 32);
  if (gname) put(gname, 297, 32);
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return b;
}

function ustarMember(name, data, typeflag, opts) {
  const buf = Buffer.from(data);
  const pad = Buffer.alloc((512 - (buf.length % 512)) % 512, 0);
  return Buffer.concat([ustarHeader(name, buf.length, typeflag, opts), buf, pad]);
}

// ── Leitura HERMÉTICA do artefato, espelho do `ustarHeader` acima ────────────────────────────────
//
// Adicionado pelo coordenador da wave (2026-08-10) porque os fixtures do F14/F17 VERIFICAVAM o
// artefato com `execFileSync("tar", …)` — extraindo POR NOME um membro cujo nome termina em `/`.
// Isso passa com bsdtar/libarchive (macOS) e REPROVA com GNU tar (o runner Linux da CI): extrair um
// arquivo REGULAR cujo nome tem forma de diretório é justamente o caso ambíguo que estes fixtures
// constroem de propósito, e cada implementação resolve à sua maneira. Resultado: 241/241 local,
// 238/241 na CI, e os 3 vermelhos eram exatamente as provas do F14 e do F17.
//
// É a mesma lição do F17 aplicada à PROVA em vez da implementação: não delegues a classificação a
// uma ferramenta cujo comportamento varia — lê os bytes. Este leitor usa os mesmos offsets que o
// escritor logo acima (name@0, size@124 octal, typeflag@156), então fixture e verificação
// permanecem um par coerente, e a suíte roda idêntica em qualquer sistema, com ou sem `tar`.
export function readArtifactMembers(artifactPath) {
  const buf = gunzipSync(readFileSync(artifactPath));
  const members = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((byte) => byte === 0)) break; // dois blocos nulos terminam o arquivo
    const str = (start, len) => {
      const raw = h.subarray(start, start + len);
      const nul = raw.indexOf(0);
      return raw.subarray(0, nul === -1 ? raw.length : nul).toString("ascii").trim();
    };
    const name = str(0, 100);
    const octal = str(124, 12);
    const size = octal ? parseInt(octal, 8) : 0;
    const typeflag = String.fromCharCode(h[156] || 0x30);
    const data = buf.subarray(off + 512, off + 512 + size);
    members.push({ name, typeflag, size, data });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return members;
}

// Os dois atalhos que os testes usavam via `tar -tzf` e `tar -xOzf`.
export function artifactMemberNames(artifactPath) {
  return readArtifactMembers(artifactPath).map((m) => m.name);
}
export function artifactMemberText(artifactPath, memberName) {
  // TODAS as ocorrências, concatenadas — não a primeira. Um tarball pode carregar o MESMO nome mais
  // de uma vez (é exatamente o fixture do F10: um membro sombreando o outro), e `tar -xOzf` despeja
  // as duas cópias em sequência. Devolver só a primeira faria o teste do F10 procurar a credencial
  // na cópia inocente e não encontrá-la — falso negativo introduzido pela própria verificação.
  return readArtifactMembers(artifactPath)
    .filter((x) => x.name === memberName)
    .map((x) => x.data.toString("utf8"))
    .join("");
}

export function buildArtifactWithDirectoryShapedFileMember() {
  const planted = PLANTED_SECRETS.find((p) => p.class === "aws-access-key");
  const outDir = mkdtempSync(join(tmpdir(), "aiox-plugins-forged-"));
  const tar = Buffer.concat([
    ustarMember("./LICENSE", "MIT License\n\nCopyright (c) AIOX\n", "0"),
    ustarMember("./SKILL.md", FIXTURE_SKILL, "0"),
    ustarMember("./config/payload/", planted.render(), "0"), // typeflag '0' + trailing-slash name
    Buffer.alloc(1024, 0), // two zero blocks terminate the archive
  ]);
  const gz = join(outDir, "artifact.tar.gz");
  writeFileSync(gz, gzipSync(tar));
  return gz;
}

// ── fix-cycle-4 (F17) — the SAME member, plus ONE forged header field ────────────────────────────
//
// This is the F14 archive with a single addition: a crafted `uname` of `0 Aug 1` written into the
// ustar header's 32-byte uname slot. Nothing about the member itself changes — same typeflag '0',
// same trailing-slash name, same 39 bytes of credential. What changes is how `tar -tvzf` RENDERS the
// line, because uname is a free-text column printed between the link count and the size:
//
//   drw-r--r--  0 0 Aug 1 g          39 Jul 27  2021 ./config/payload/
//                 ^^^^^^^ injected — a "digits followed by a date", i.e. the exact shape the
//                         size-column regex anchors on, appearing BEFORE the real size of 39
//
// The cycle-3 allowlist read the size from that rendering, so `parseMemberSize` returned 0, the
// member was positively identified as a real directory, and the credential published at exit 0.
//
// That is the whole point of the fixture: cycle 3 inverted the classifier (correct in SHAPE —
// exemption now requires positive evidence) but left the EVIDENCE itself attacker-shapeable. This
// member is the proof that a forgeable allowlist is an allowlist in shape and a denylist in effect,
// and it is the permanent regression test for the class.
export function buildArtifactWithForgedUnameDirectoryMember() {
  const planted = PLANTED_SECRETS.find((p) => p.class === "aws-access-key");
  const outDir = mkdtempSync(join(tmpdir(), "aiox-plugins-forged-uname-"));
  const tar = Buffer.concat([
    ustarMember("./LICENSE", "MIT License\n\nCopyright (c) AIOX\n", "0"),
    ustarMember("./SKILL.md", FIXTURE_SKILL, "0"),
    ustarMember("./config/payload/", planted.render(), "0", { uname: "0 Aug 1", gname: "g" }),
    Buffer.alloc(1024, 0),
  ]);
  const gz = join(outDir, "artifact.tar.gz");
  writeFileSync(gz, gzipSync(tar));
  return gz;
}

// ── fix-cycle-4 (F17) — a member the archive's own listing does not admit exists ─────────────────
//
// MEASURED, not theorised. Running `xattr -w com.example.cfg "AWS_ACCESS_KEY_ID=AKIA…" LICENSE` and
// then `tar -czf` on macOS produces an archive whose `tar -tzf` prints exactly `./` and `./LICENSE`
// — while the credential is recoverable verbatim from the published bytes, carried by a 163-byte
// `./._LICENSE` AppleDouble member that the listing never mentions. Every cycle before this one
// enumerated from that listing, so all four reported complete coverage of an archive containing a
// member they had never seen. Same undisclosed-blindness class as F10/F11/F14/F17.
//
// THE FIXTURE USES THE REAL TRIGGER, and that is a deliberate trade-off with a cost worth naming.
// A hand-forged AppleDouble member was tried first and REJECTED by measurement: macOS `tar` hides it
// from `-tzf` exactly as the real one is hidden, but then FAILS to extract the archive ("Failed to
// restore metadata"), because the forged blob is not a valid AppleDouble structure. A fixture that
// cannot be unpacked is not a package, and a test built on it would be asserting against a shape no
// publisher can produce. Writing a real AppleDouble encoder to fix that is a bigger detour than the
// property is worth.
//
// So the trigger is genuine — `xattr -w` then `tar -czf` — and therefore macOS-only. The function
// returns null where the platform cannot produce the condition (CI runs on ubuntu, where GNU tar has
// no AppleDouble concept at all, so there is nothing to reproduce rather than something skipped).
// CI's coverage of the REFUSAL itself does not depend on this: `classifyMembers` is pinned for both
// directions of the differential by a portable unit test that runs everywhere.
export function buildArtifactWithHiddenAppleDoubleMember() {
  if (process.platform !== "darwin") return null;
  const planted = PLANTED_SECRETS.find((p) => p.class === "aws-access-key");
  const src = mkdtempSync(join(tmpdir(), "aiox-plugins-appledouble-src-"));
  const outDir = mkdtempSync(join(tmpdir(), "aiox-plugins-appledouble-out-"));
  try {
    writeFileSync(join(src, "LICENSE"), "MIT License\n\nCopyright (c) AIOX\n");
    writeFileSync(join(src, "SKILL.md"), FIXTURE_SKILL);
    execFileSync("xattr", ["-w", "com.example.deploy", planted.render(), join(src, "LICENSE")]);
    const gz = join(outDir, "artifact.tar.gz");
    // NO COPYFILE_DISABLE here — the whole point is what macOS `tar` does by DEFAULT.
    execFileSync("tar", ["-czf", gz, "."], { cwd: src });
    return gz;
  } catch {
    return null; // xattr unavailable or refused — the condition cannot be produced here
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}

// The positive control (AC2's second half): the SAME package shape with no credential in it. If this
// one is also refused, the gate is a blanket refusal and every negative result above proves nothing.
export function buildCleanArtifact() {
  return buildTarball({
    LICENSE: "MIT License\n\nCopyright (c) AIOX\n",
    "SKILL.md": FIXTURE_SKILL,
    "config/settings.env": "AWS_REGION=us-east-1\nLOG_LEVEL=debug\nAPI_BASE=https://example.invalid/v1\n",
    "scripts/release.sh": "#!/bin/sh\nset -e\necho 'no credentials here'\n",
  });
}
