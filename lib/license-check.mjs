// lib/license-check.mjs — check (c), D24(c), story 055.W3.3: a license file MUST exist at the
// PACKAGE ROOT of the artifact tarball, verified by actually opening the artifact's bytes — never
// by trusting a self-reported `license` field alone. A field is an ASSERTION ("license: MIT"); it
// proves nothing about what actually ships inside the tarball a client downloads and runs. The
// catalog signs the index that points at that artifact (D20(3)) — proveniência assinada sobre um
// artefato sem licença pareceria endosso sem ter contrato algum, which is exactly what AC3/D24(c)
// exists to prevent.
//
// Shells out to the system `tar` binary (present on GitHub Actions ubuntu-latest and on macOS/Linux
// dev machines) rather than adding an npm tar-reading dependency — consistent with this repo's
// zero-new-dependency posture (node:test, no JSON-Schema library, etc).

import { execFileSync } from "node:child_process";

const LICENSE_NAME_RE = /^LICEN[SC]E(\.[A-Za-z0-9]+)?$|^COPYING(\.[A-Za-z0-9]+)?$/i;

function listTarEntries(tarPath) {
  const out = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    // both BSD tar (macOS) and GNU tar (Linux/GH Actions) prefix every entry with "./" when the
    // tarball was built with `-C <dir> .` (the convention this repo's own tooling uses, see
    // test/helpers/tarball.mjs) — normalize it away so "./LICENSE" and "LICENSE" resolve to the
    // same depth. The bare "./" root-directory entry becomes "" after stripping and is dropped.
    .map((l) => (l.startsWith("./") ? l.slice(2) : l))
    .filter(Boolean);
}

// "Package root" resolves the same way a real installer would: either a true top-level file, OR —
// if (and only if) EVERY entry in the tarball shares exactly one common top-level directory (the
// `reponame-1.2.3/` wrapping convention produced by `npm pack` / `git archive` / most publish
// tooling) — a file one level inside that single wrapping directory. It never means "a license
// anywhere in the tree"; a LICENSE buried three directories deep does not satisfy this.
export function checkLicenseInPackageRoot(tarPath) {
  const errors = [];
  let entries;
  try {
    entries = listTarEntries(tarPath);
  } catch (e) {
    errors.push(`could not open "${tarPath}" as a tar/gzip artifact to verify its license: ${e.message}`);
    return errors;
  }
  if (entries.length === 0) {
    errors.push(`artifact "${tarPath}" is an empty tarball — cannot contain a license at any root`);
    return errors;
  }

  const topDirs = new Set(entries.filter((e) => e.includes("/")).map((e) => e.split("/")[0]));
  const soleTopDir = [...topDirs][0];
  const singleWrappingDir =
    topDirs.size === 1 && entries.every((e) => e === soleTopDir || e === `${soleTopDir}/` || e.startsWith(`${soleTopDir}/`))
      ? soleTopDir
      : null;

  const rootCandidates = entries.filter((e) => {
    if (e.endsWith("/")) return false; // directory entry, not a file
    const depth = e.split("/").length;
    if (depth === 1) return true; // true top-level file
    if (singleWrappingDir && depth === 2 && e.startsWith(`${singleWrappingDir}/`)) return true; // one level inside the single wrapping dir
    return false;
  });

  const found = rootCandidates.some((e) => LICENSE_NAME_RE.test(e.split("/").pop()));
  if (!found) {
    errors.push(
      `artifact "${tarPath}" has no LICENSE/LICENCE/COPYING file at its package root — refusing (D24(c)): the catalog signs the index that points at this artifact, so shipping it unlicensed would carry unearned apparent endorsement without a term of use. Root-level candidates seen: ${
        rootCandidates.length ? rootCandidates.join(", ") : "(none)"
      }`,
    );
  }
  return errors;
}
