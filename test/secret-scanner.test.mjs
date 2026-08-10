// test/secret-scanner.test.mjs — story 055.W4.1 (D20(1)), function-level coverage of the scanner.
//
// The CLI-level obligation of AC2 ("a fixture with a planted secret of EACH class, REJECTED, through
// the real CLI as a subprocess") lives in test/publish-cli.test.mjs. This file covers the properties
// a subprocess test cannot show cleanly: that each fixture is invalid in exactly ONE way, that the
// entropy floor and the upstream allowlists actually do something, that a finding never carries the
// credential in clear, and that the limits are attached to every report.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanText,
  scanArtifact,
  scanManifestFile,
  shannonEntropy,
  redact,
  renderScanReport,
  SCANNER_LIMITS,
} from "../lib/secret-scanner.mjs";
import {
  SECRET_CLASSES,
  SECRET_RULES,
  DELIBERATELY_NOT_VENDORED,
  SECRET_RULES_PROVENANCE,
} from "../lib/secret-rules.mjs";
import { PLANTED_SECRETS, buildArtifactWithPlantedSecret, buildCleanArtifact } from "./helpers/secret-fixtures.mjs";
import { buildTarball, FIXTURE_SKILL } from "./helpers/tarball.mjs";

describe("the corpus is vendored, attributed, and paired with fixtures", () => {
  test("every covered CLASS has a planted fixture — adding a rule without a fixture fails HERE", () => {
    const covered = [...new Set(PLANTED_SECRETS.map((p) => p.class))].sort();
    assert.deepEqual(
      covered,
      [...SECRET_CLASSES],
      "AC2 is per-CLASS: a class in lib/secret-rules.mjs with no fixture is an unproven class",
    );
  });

  test("provenance is recorded (a vendored corpus that cannot be dated cannot be audited for staleness)", () => {
    assert.match(SECRET_RULES_PROVENANCE.source, /gitleaks/);
    assert.match(SECRET_RULES_PROVENANCE.license, /MIT/);
    assert.ok(
      SECRET_RULES_PROVENANCE.upstream_rule_count > SECRET_RULES.length,
      "the vendored set is a SUBSET — the count proves it",
    );
    assert.ok(DELIBERATELY_NOT_VENDORED.length >= 1, "what was left out is part of the deliverable, not an omission");
    assert.ok(DELIBERATELY_NOT_VENDORED.some((r) => r.id === "generic-api-key"));
  });

  test("every rule's pattern compiles as a JavaScript regex (the RE2 port is real, not assumed)", () => {
    for (const r of SECRET_RULES) {
      assert.doesNotThrow(() => new RegExp(r.pattern, `g${r.flags ?? ""}`), `rule ${r.id} does not compile`);
      assert.ok(!r.pattern.includes("(?i)"), `rule ${r.id} still carries an RE2 inline flag`);
      assert.ok(!r.pattern.includes("(?-i:"), `rule ${r.id} carries an RE2 construct with no JS equivalent`);
    }
  });
});

describe("per-class detection — each fixture is invalid in EXACTLY ONE way", () => {
  for (const planted of PLANTED_SECRETS) {
    test(`${planted.class} — detected, and nothing else is`, () => {
      const findings = scanText(planted.render(), planted.where);
      assert.ok(findings.length >= 1, `no finding for ${planted.class}`);
      const classes = [...new Set(findings.map((f) => f.class))];
      assert.deepEqual(
        classes,
        [planted.class],
        `fixture for ${planted.class} also trips ${classes.filter((c) => c !== planted.class).join(", ")} — a test that can pass for the wrong reason is not evidence`,
      );
    });
  }
});

describe("the entropy floor and the upstream allowlists actually do something", () => {
  test("a shape-valid AWS key with degenerate entropy is NOT reported (shape alone over-fires)", () => {
    const shapeOnly = `AWS_ACCESS_KEY_ID=${"AKIA"}${"AAAAAAAAAAAAAAAA"}\n`;
    assert.equal(scanText(shapeOnly, "config/x.env").length, 0);
    assert.ok(
      shannonEntropy(`${"AKIA"}${"AAAAAAAAAAAAAAAA"}`) < 3,
      "the fixture is only meaningful if it genuinely fails the floor",
    );
  });

  test("gitleaks' `.+EXAMPLE$` allowlist is honoured — AWS's own documentation sample is not a finding", () => {
    assert.equal(scanText(`AWS_ACCESS_KEY_ID=${"AKIA"}${"IOSFODNN7EXAMPLE"}\n`, "README.md").length, 0);
  });

  test("gitleaks' known-fake GCP keys are allowlisted", () => {
    assert.equal(scanText(`key = "${"AIza"}Syabcdefghijklmnopqrstuvwxyz1234567"\n`, "README.md").length, 0);
  });

  test("ordinary prose produces nothing (the keyword prefilter skips every rule)", () => {
    assert.equal(scanText("just some ordinary prose about plugins and catalogs.\n", "docs/x.md").length, 0);
  });
});

describe("a finding never leaks what it found", () => {
  test("the redaction keeps 4 characters and the length; the rendered report contains no raw secret", () => {
    const planted = PLANTED_SECRETS.find((p) => p.class === "github-token");
    const text = planted.render();
    const raw = text.match(/ghp_[0-9a-zA-Z]{36}/)[0];
    const findings = scanText(text, planted.where);
    assert.equal(findings.length, 1);
    assert.ok(!findings[0].redacted.includes(raw), "the finding must not carry the credential");
    assert.match(findings[0].redacted, /^ghp_\*+ \(len \d+\)$/);

    const full = renderScanReport({
      subject: "artifact",
      files_total: 1,
      files_scanned: 1,
      bytes_scanned: text.length,
      skipped_binary: [],
      skipped_too_large: [],
      findings,
      rules: SECRET_RULES.length,
      classes: [...SECRET_CLASSES],
      provenance: SECRET_RULES_PROVENANCE,
      limits: [...SCANNER_LIMITS],
    });
    assert.ok(!full.includes(raw), "the rendered report — which goes to CI logs — must not contain the credential");
  });
});

describe("what was NOT scanned is reported, never silently dropped", () => {
  test("a binary member is skipped AND listed; the report says so in words", () => {
    // A NUL byte in the head is the "not text" signal. The planted credential AFTER it is what makes
    // this test meaningful: the file genuinely contains a secret, and the report must say the file
    // was NOT LOOKED AT rather than quietly reporting zero findings for it.
    //
    // The NUL is produced with String.fromCharCode, never written as a literal byte in this source:
    // a source file containing a real NUL is classified as binary, and `grep -I` (which this repo's
    // own CI guards use) SKIPS binary files — the test file would silently fall out of the
    // secret-shape and portable-path sweeps it is supposed to be subject to.
    const NUL = String.fromCharCode(0, 1);
    const planted = PLANTED_SECRETS.find((p) => p.class === "github-token");
    const tar = buildTarball({
      LICENSE: "MIT\n",
      "SKILL.md": FIXTURE_SKILL,
      "assets/blob.bin": NUL + " binary payload\n" + planted.render(),
    });
    const report = scanArtifact(tar);
    assert.equal(report.findings.length, 0, "the binary member was not scanned — that is the point");
    assert.equal(report.skipped_binary.length, 1);
    assert.equal(report.skipped_binary[0].path, "assets/blob.bin");
    assert.match(renderScanReport(report), /a skipped file is an UNKNOWN, not a pass/);
    assert.match(renderScanReport(report), /\[binary\] {4}assets\/blob\.bin/);
  });

  test("the limits are attached to EVERY report and name the two the story requires", () => {
    const report = scanArtifact(buildCleanArtifact());
    assert.ok(report.limits.length >= 2);
    const joined = report.limits.join("\n");
    assert.match(joined, /POINTER, NOT THE TARGET/, "limit (a) — the MCP pointer is not the target");
    assert.match(joined, /mcp\.rs:68/, "limit (a) must cite the code, not gesture at it");
    assert.match(joined, /OBFUSCATED OR ENCODED SECRET ESCAPES/, "limit (b)");
    assert.match(renderScanReport(report), /WHAT THIS SCAN CANNOT SEE/);
  });
});

describe("artifact + manifest are both in scope", () => {
  test("a credential planted in the ARTIFACT is found", () => {
    const planted = PLANTED_SECRETS.find((p) => p.class === "stripe-key");
    const report = scanArtifact(buildArtifactWithPlantedSecret(planted));
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].class, "stripe-key");
  });

  test("a credential planted in the MANIFEST is found (the manifest becomes a PUBLIC index entry)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-manifestfix-"));
    try {
      const p = join(dir, "manifest.json");
      const planted = PLANTED_SECRETS.find((x) => x.class === "npm-token");
      writeFileSync(p, JSON.stringify({ plugin_id: "x", description: planted.render().trim() }, null, 2));
      const report = scanManifestFile(p);
      assert.equal(report.subject, "manifest");
      assert.equal(report.findings.length, 1);
      assert.equal(report.findings[0].class, "npm-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the POSITIVE CONTROL: a clean package produces zero findings and a non-zero scanned count", () => {
    const report = scanArtifact(buildCleanArtifact());
    assert.equal(report.findings.length, 0);
    assert.ok(report.files_scanned >= 4, "a scan of zero files would also report zero findings — that is the trap");
    assert.ok(report.bytes_scanned > 0);
  });
});
