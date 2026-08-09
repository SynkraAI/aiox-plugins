// test/helpers/tarball.mjs — shared test helper, story 055.W3.3. Builds throwaway .tar.gz fixtures
// via the system `tar` binary (same tool lib/license-check.mjs shells out to) so tests exercise the
// REAL code path, not a mocked one.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// files: { "relative/path": "content" }. Pass a path with no "/" for a true top-level file.
export function buildTarball(files) {
  const workDir = mkdtempSync(join(tmpdir(), "aiox-plugins-tarball-src-"));
  const outDir = mkdtempSync(join(tmpdir(), "aiox-plugins-tarball-out-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(workDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    const outPath = join(outDir, "artifact.tar.gz");
    execFileSync("tar", ["-czf", outPath, "-C", workDir, "."]);
    return outPath;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// A minimal, valid plugin artifact: LICENSE at the true top level.
export function buildValidArtifact() {
  return buildTarball({
    "LICENSE": "MIT License\n\nCopyright (c) AIOX\n",
    "SKILL.md": "# fixture skill\n",
  });
}

// A plugin artifact with NO license anywhere — the negative fixture for check (c).
export function buildArtifactWithoutLicense() {
  return buildTarball({
    "SKILL.md": "# fixture skill, no license anywhere in the package\n",
    "src/index.js": "// no license\n",
  });
}

// A plugin artifact whose LICENSE is buried inside a subdirectory, not at the root — also a
// negative fixture for check (c): proves "root" is enforced literally, not "anywhere in the tree".
export function buildArtifactWithBuriedLicense() {
  return buildTarball({
    "src/nested/deep/LICENSE": "MIT License (buried, not at package root)\n",
    "SKILL.md": "# fixture skill\n",
  });
}
