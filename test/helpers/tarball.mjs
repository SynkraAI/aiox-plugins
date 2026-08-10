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
    // COPYFILE_DISABLE=1 (fix-cycle-4, F17) — without it, macOS `tar` writes an AppleDouble `._name`
    // companion member for every file, and `tar -tzf` does NOT list them. Those members' bytes ship
    // inside the artifact, so the scanner's header walk enumerates them and REFUSES them as
    // uncertifiable. That refusal is correct: this env var is what a well-formed macOS build uses,
    // and a fixture is supposed to be a well-formed package. The refusal itself is pinned by its own
    // negative test in test/publish-cli.test.mjs — this is not a fixture edited to dodge a gate.
    execFileSync("tar", ["-czf", outPath, "-C", workDir, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    return outPath;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// story 055.W4.2: `allowed-tools` became MANDATORY on every publishable skill (D17/AC1), so every
// fixture skill below now carries it. This is deliberately applied to the NEGATIVE fixtures too:
// a license-negative fixture that ALSO fails the allowed-tools gate would still make its test pass
// (the assertion greps for the license message), but for the wrong reason — and a test that can
// pass for the wrong reason stops being evidence the moment the right reason disappears. Each
// fixture is therefore invalid in EXACTLY ONE way.
export const FIXTURE_SKILL = `---
name: fixture-skill
description: A minimal valid fixture skill.
allowed-tools: Read
---

# fixture skill
`;

// A valid fixture skill carrying a distinguishing marker in its body. The D24(a)/F9 lineage tests
// depend on artifacts having DIFFERENT BYTES from one another (that is the property under test),
// so they cannot all share one constant — the marker is what keeps the digests distinct while the
// frontmatter keeps them publishable.
export function fixtureSkill(marker) {
  return `---\nname: fixture-skill\ndescription: A minimal valid fixture skill.\nallowed-tools: Read\n---\n\n# ${marker}\n`;
}

// A minimal, valid plugin artifact: LICENSE at the true top level.
export function buildValidArtifact() {
  return buildTarball({
    "LICENSE": "MIT License\n\nCopyright (c) AIOX\n",
    "SKILL.md": FIXTURE_SKILL,
  });
}

// A plugin artifact with NO license anywhere — the negative fixture for check (c).
export function buildArtifactWithoutLicense() {
  return buildTarball({
    "SKILL.md": FIXTURE_SKILL,
    "src/index.js": "// no license\n",
  });
}

// A plugin artifact whose LICENSE is buried inside a subdirectory, not at the root — also a
// negative fixture for check (c): proves "root" is enforced literally, not "anywhere in the tree".
export function buildArtifactWithBuriedLicense() {
  return buildTarball({
    "src/nested/deep/LICENSE": "MIT License (buried, not at package root)\n",
    "SKILL.md": FIXTURE_SKILL,
  });
}

// story 055.W4.2 — the AC1 negative fixture at CLI level: a licensed, otherwise-perfect artifact
// whose skill declares NO `allowed-tools`. Everything else about it is valid, so a publish that
// still succeeds proves the gate is decorative.
export function buildArtifactWithoutAllowedTools() {
  return buildTarball({
    "LICENSE": "MIT License\n\nCopyright (c) AIOX\n",
    "SKILL.md": "---\nname: fixture-skill\ndescription: declares no allowed-tools.\n---\n\n# fixture skill\n",
  });
}

// story 055.W4.2 — a skill that ships its own scripts/ AND instructs executing it. Used to prove
// the two derived signals reach the published entry and the rendered catalog.
export function buildArtifactWithExecutingSkill() {
  return buildTarball({
    "LICENSE": "MIT License\n\nCopyright (c) AIOX\n",
    "skills/runner/SKILL.md": `---
name: runner
description: Runs its own helper.
allowed-tools: Read, Bash
---

Run \`node <skill-dir>/scripts/helper.mjs --go\` before anything else.
`,
    "skills/runner/scripts/helper.mjs": "// helper\n",
  });
}
