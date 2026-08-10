// test/publish-cli.test.mjs — fix-cycle-2 (closes QG gate 4). Exercises the ACTUAL CLI entrypoint
// (publisher/publish.mjs) as a subprocess against a throwaway temp directory, always with
// `--no-push` — this suite never runs `git commit`/`git push` and never touches the real repo. The
// git-push mechanism itself was already proven live, repeatedly, by the real fixture publications
// in fixtures/index.json (see the handoff) — that is deliberately NOT re-proven here.
//
// story 055.W3.3: `--artifact` is now REQUIRED (was one of two alternatives with `--digest`), and
// `--ledger` is new and REQUIRED. All 4 existing tests below are updated to the new required-flag
// shape (using a real tarball built by test/helpers/tarball.mjs, exercising the real
// checkLicenseInPackageRoot code path along the way). New describe blocks below prove each of
// D24's checks (a/b/c/d) is BLOCKING and has a fixture that deserves to fail and does (AC5).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTarball, buildValidArtifact, buildArtifactWithoutLicense, buildArtifactWithBuriedLicense, buildArtifactWithoutAllowedTools, buildArtifactWithExecutingSkill, fixtureSkill } from "./helpers/tarball.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publishScript = join(here, "..", "publisher", "publish.mjs");
const retireScript = join(here, "..", "publisher", "retire.mjs");

const GOOD_HOST = "pub-42179e62dc3040138151ec33229dd073.r2.dev";

// fix-cycle-2 (F9): manifest.lineage_id is REQUIRED — the plugin's stable identity.
const LIN_ENTERPRISE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-publish-cli-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeEmptyIndex(dir) {
  const target = join(dir, "index.json");
  writeFileSync(target, JSON.stringify({ schema_version: "2.0.0", generated_at: null, entries: [] }, null, 2));
  return target;
}

function writeEmptyLedger(dir) {
  const ledger = join(dir, "ledger.json");
  writeFileSync(ledger, JSON.stringify({ schema_version: "2.0.0", plugins: {} }, null, 2));
  return ledger;
}

function writeManifest(dir, overrides = {}, filename = "manifest.json") {
  const manifest = join(dir, filename);
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        plugin_id: "aiox-enterprise",
        lineage_id: LIN_ENTERPRISE,
        name: "test",
        description: "test",
        version: "0.0.0-fixture",
        tiers: ["enterprise"],
        license: "MIT",
        ...overrides,
      },
      null,
      2,
    ),
  );
  return manifest;
}

function publish(argsObj) {
  const args = [];
  for (const [k, v] of Object.entries(argsObj)) {
    if (v === true) { args.push(`--${k}`); continue; }
    args.push(`--${k}`, String(v));
  }
  return execFileSync("node", [publishScript, ...args], { stdio: "pipe" }).toString();
}

describe("publish.mjs CLI (--no-push only — never touches git)", () => {
  test("a correctly-formed, correctly-hosted, licensed publish succeeds and appends exactly one entry", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir);
      const artifact = buildValidArtifact();
      const out = publish({
        manifest, target, ledger,
        subject: "acct_test",
        artifact,
        "mirror-url": `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/placeholder.tar.gz`,
        "r2-key": `plugins-fixtures/aiox-enterprise/0.0.0-fixture/placeholder.tar.gz`,
        "no-push": true,
      });
      assert.match(out, /^OK —/m);
      const written = JSON.parse(readFileSync(target, "utf8"));
      assert.equal(written.entries.length, 1);
      assert.equal(written.entries[0].plugin_id, "aiox-enterprise");
      const ledgerWritten = JSON.parse(readFileSync(ledger, "utf8"));
      assert.ok(ledgerWritten.plugins["aiox-enterprise"], "publish must record the plugin_id in the ledger");
      assert.equal(ledgerWritten.plugins["aiox-enterprise"].status, "active");
    });
  });

  test("a foreign-host mirror_url is REFUSED — nonzero exit, target file unchanged (fix-cycle-2, F-BINDING-NO-HOST-ALLOWLIST)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const before = readFileSync(target, "utf8");
      const manifest = writeManifest(dir);
      const artifact = buildValidArtifact();
      assert.throws(() => {
        publish({
          manifest, target, ledger,
          subject: "acct_test",
          artifact,
          "mirror-url": `https://evil.example.com/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "r2-key": `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "no-push": true,
        });
      }, /Command failed/);
      assert.equal(readFileSync(target, "utf8"), before, "REFUSED publish must not mutate the target file");
    });
  });

  test("an entry pointing at a DIFFERENT plugin's key is REFUSED — nonzero exit, target file unchanged (fix-cycle-1, F-AC6-ARTIFACT-BINDING)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const before = readFileSync(target, "utf8");
      const manifest = writeManifest(dir); // plugin_id: aiox-enterprise
      const artifact = buildValidArtifact();
      assert.throws(() => {
        publish({
          manifest, target, ledger,
          subject: "acct_test",
          artifact,
          "mirror-url": `https://${GOOD_HOST}/plugins-fixtures/sinkra-os/0.0.0-fixture/x.tar.gz`,
          "r2-key": `plugins-fixtures/sinkra-os/0.0.0-fixture/x.tar.gz`,
          "no-push": true,
        });
      }, /Command failed/);
      assert.equal(readFileSync(target, "utf8"), before);
    });
  });

  test("missing --r2-key is refused at the CLI usage level (required since fix-cycle-1)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir);
      const artifact = buildValidArtifact();
      assert.throws(() => {
        publish({
          manifest, target, ledger,
          subject: "acct_test",
          artifact,
          "mirror-url": `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "no-push": true,
        });
      }, /Command failed/);
    });
  });

  test("missing --artifact is refused at the CLI usage level (required as of story 055.W3.3 — check (c) needs the real bytes)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir);
      assert.throws(() => {
        execFileSync("node", [
          publishScript,
          "--manifest", manifest, "--target", target, "--ledger", ledger,
          "--subject", "acct_test",
          "--digest", "0".repeat(64),
          "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "--no-push",
        ], { stdio: "pipe" });
      }, /Command failed/);
    });
  });
});

describe("check (c) — license-in-package-root is BLOCKING at publish (D24(c), AC3, AC4, AC5 negative fixtures)", () => {
  test("an artifact with NO license anywhere is REFUSED, naming the missing-license reason", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir);
      const artifact = buildArtifactWithoutLicense();
      let stderr = "";
      try {
        execFileSync("node", [
          publishScript,
          "--manifest", manifest, "--target", target, "--ledger", ledger,
          "--subject", "acct_test", "--artifact", artifact,
          "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "--no-push",
        ], { stdio: "pipe" });
        assert.fail("expected publish to be REFUSED");
      } catch (e) {
        stderr = e.stderr.toString();
      }
      assert.match(stderr, /no LICENSE\/LICENCE\/COPYING file at its package root/);
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 0, "REFUSED publish must not mutate the target");
    });
  });

  test("a license buried in a subdirectory (not at package root) is REFUSED — 'root' is enforced literally", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir);
      const artifact = buildArtifactWithBuriedLicense();
      assert.throws(() => {
        execFileSync("node", [
          publishScript,
          "--manifest", manifest, "--target", target, "--ledger", ledger,
          "--subject", "acct_test", "--artifact", artifact,
          "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "--no-push",
        ], { stdio: "pipe" });
      }, /Command failed/);
    });
  });

  test("a license at the true package root is ACCEPTED (positive control for the two negative fixtures above)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir);
      const artifact = buildValidArtifact();
      const out = publish({
        manifest, target, ledger, subject: "acct_test", artifact,
        "mirror-url": `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
        "r2-key": `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
        "no-push": true,
      });
      assert.match(out, /^OK —/m);
    });
  });
});

describe("check (d) / AC8 — tier vocabulary from the plugin's OWN manifest, never hardcoded (D21 publish-time half, VC-5)", () => {
  test("emitting a tier NOT declared in the manifest is REFUSED, naming the invalid tier AND the valid vocabulary", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir, { tiers: ["mapear", "forjar"] }); // the plugin's real vocabulary
      const artifact = buildValidArtifact();
      let stderr = "";
      try {
        execFileSync("node", [
          publishScript,
          "--manifest", manifest, "--target", target, "--ledger", ledger,
          "--subject", "acct_test", "--artifact", artifact,
          "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "--emit-tiers", "forjarr", // typo — not in the manifest's vocabulary
          "--no-push",
        ], { stdio: "pipe" });
        assert.fail("expected publish to be REFUSED");
      } catch (e) {
        stderr = e.stderr.toString();
      }
      assert.match(stderr, /"forjarr"/, "must name the INVALID tier");
      assert.match(stderr, /"mapear"/, "must name the VALID vocabulary");
      assert.match(stderr, /"forjar"/, "must name the VALID vocabulary");
    });
  });

  test("emitting a subset of the manifest's declared vocabulary is ACCEPTED", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir, { tiers: ["mapear", "forjar"] });
      const artifact = buildValidArtifact();
      const out = publish({
        manifest, target, ledger, subject: "acct_test", artifact,
        "mirror-url": `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
        "r2-key": `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
        "emit-tiers": "mapear",
        "no-push": true,
      });
      assert.match(out, /^OK —/m);
      const written = JSON.parse(readFileSync(target, "utf8"));
      assert.deepEqual(written.entries[0].tiers, ["mapear"]);
    });
  });
});

describe("check (a) — id immutability (D24(a), AC1, AC5 negative fixtures)", () => {
  // Publishes plugin_id/lineage/version with the given artifact bytes; returns the CLI's stderr on
  // refusal, or null when the publish was accepted. Every negative fixture below goes through the
  // REAL CLI as a subprocess, never through the library functions directly.
  function tryPublish({ dir, target, ledger, plugin_id, lineage_id, version, artifact }) {
    const manifest = writeManifest(dir, { plugin_id, lineage_id, version }, `manifest-${plugin_id}-${version}.json`);
    try {
      execFileSync("node", [
        publishScript,
        "--manifest", manifest, "--target", target, "--ledger", ledger,
        "--subject", "acct_test", "--artifact", artifact,
        "--mirror-url", `https://${GOOD_HOST}/plugins/${plugin_id}/${version}/x.tar.gz`,
        "--r2-key", `plugins/${plugin_id}/${version}/x.tar.gz`,
        "--no-push",
      ], { stdio: "pipe" });
      return null;
    } catch (e) {
      return e.stderr.toString();
    }
  }

  // ── THE F9 FIXTURE (fix-cycle-2, founder decision 2026-08-09) ─────────────────────────────────
  // This is the case D24(a) exists to prevent and the one an author actually performs: rename the
  // plugin AND bump the version, so the two identities share no bytes whatsoever. Against the
  // pre-F9 code this ran to completion with exit 0 and TWO entries in the index — reproduced
  // literally before the fix, see the story's handoff for the captured command + output. Without
  // this fixture the correction would be asserted, not proven.
  test("F9 — a rename WITH a version bump (different bytes) is REFUSED, on lineage rather than on digest", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);

      // v1 under the original name — legitimate, lands
      const artifactV1 = buildTarball({ LICENSE: "MIT\n", "SKILL.md": fixtureSkill("v1.0.0") });
      assert.equal(
        tryPublish({ dir, target, ledger, plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", artifact: artifactV1 }),
        null,
        "the first, legitimate publish must succeed",
      );

      // v1.1.0 under a NEW name, REBUILT — different bytes, so digest lineage is blind to it
      const artifactV2 = buildTarball({ LICENSE: "MIT\n", "SKILL.md": fixtureSkill("v1.1.0 — rebuilt, different content") });
      const digestV1 = createHash("sha256").update(readFileSync(artifactV1)).digest("hex");
      const digestV2 = createHash("sha256").update(readFileSync(artifactV2)).digest("hex");
      assert.notEqual(digestV1, digestV2, "the fixture is only meaningful if the bytes genuinely differ");

      const stderr = tryPublish({
        dir, target, ledger,
        plugin_id: "aiox-enterprise-renamed",
        lineage_id: LIN_ENTERPRISE, // the SAME plugin — its identity does not change when it is renamed
        version: "1.1.0",
        artifact: artifactV2,
      });
      assert.ok(stderr !== null, "expected the renamed publish to be REFUSED (pre-F9 this exited 0)");
      assert.match(stderr, /lineage_id .* is already registered under a DIFFERENT plugin_id \("aiox-enterprise"\)/);
      assert.match(stderr, /A version bump does NOT make this a different plugin/);
      assert.doesNotMatch(stderr, /these exact artifact bytes/, "the digest rule cannot see this case — lineage is what caught it");

      const index = JSON.parse(readFileSync(target, "utf8"));
      assert.equal(index.entries.length, 1, "only the first (legitimate) publish must have landed");
      assert.equal(index.entries[0].plugin_id, "aiox-enterprise");
      const ledgerData = JSON.parse(readFileSync(ledger, "utf8"));
      assert.deepEqual(Object.keys(ledgerData.plugins), ["aiox-enterprise"], "the refused rename must not have been recorded");
    });
  });

  test("F9 — a genuinely NEW plugin (its own lineage, its own bytes) still publishes: the check is not a blanket refusal", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      assert.equal(
        tryPublish({ dir, target, ledger, plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", artifact: buildTarball({ LICENSE: "MIT\n", "SKILL.md": fixtureSkill("a") }) }),
        null,
      );
      assert.equal(
        tryPublish({ dir, target, ledger, plugin_id: "sinkra-os", lineage_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", version: "1.0.0", artifact: buildTarball({ LICENSE: "MIT\n", "SKILL.md": fixtureSkill("b") }) }),
        null,
        "a distinct plugin with a distinct lineage must not be caught by the rename check",
      );
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 2);
    });
  });

  test("F9 — a legitimate version bump of the SAME plugin (same id, same lineage, new bytes) still publishes", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const args = { dir, target, ledger, plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE };
      assert.equal(tryPublish({ ...args, version: "1.0.0", artifact: buildTarball({ LICENSE: "MIT\n", "SKILL.md": fixtureSkill("v1") }) }), null);
      assert.equal(tryPublish({ ...args, version: "1.1.0", artifact: buildTarball({ LICENSE: "MIT\n", "SKILL.md": fixtureSkill("v2") }) }), null);
      const ledgerData = JSON.parse(readFileSync(ledger, "utf8"));
      assert.equal(ledgerData.plugins["aiox-enterprise"].history.length, 2);
      assert.equal(ledgerData.plugins["aiox-enterprise"].lineage_id, LIN_ENTERPRISE, "the identity is carried, not rewritten");
    });
  });

  test("F9 — relabelling an existing plugin_id's OWN lineage is REFUSED (closes the two-step evasion)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      assert.equal(
        tryPublish({ dir, target, ledger, plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "1.0.0", artifact: buildTarball({ LICENSE: "MIT\n", "SKILL.md": fixtureSkill("v1") }) }),
        null,
      );
      const stderr = tryPublish({
        dir, target, ledger,
        plugin_id: "aiox-enterprise",
        lineage_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", // step 1 of the evasion: free up the old lineage
        version: "1.1.0",
        artifact: buildTarball({ LICENSE: "MIT\n", "SKILL.md": fixtureSkill("v2") }),
      });
      assert.ok(stderr !== null, "expected the relabelling to be REFUSED");
      assert.match(stderr, /is on record with lineage_id/);
      assert.match(stderr, /set once at its first publish and never changes/);
    });
  });

  test("F9 — a manifest with NO lineage_id is refused at the CLI usage level, and the error says how to mint one", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = join(dir, "manifest-no-lineage.json");
      writeFileSync(manifest, JSON.stringify({ plugin_id: "aiox-enterprise", name: "x", description: "x", version: "1.0.0", tiers: ["enterprise"], license: "MIT" }));
      let stderr = "";
      try {
        execFileSync("node", [
          publishScript,
          "--manifest", manifest, "--target", target, "--ledger", ledger,
          "--subject", "acct_test", "--artifact", buildValidArtifact(),
          "--mirror-url", `https://${GOOD_HOST}/plugins/aiox-enterprise/1.0.0/x.tar.gz`,
          "--r2-key", `plugins/aiox-enterprise/1.0.0/x.tar.gz`,
          "--no-push",
        ], { stdio: "pipe" });
        assert.fail("expected publish to be REFUSED");
      } catch (e) {
        stderr = e.stderr.toString();
      }
      assert.match(stderr, /manifest\.lineage_id is required/);
      assert.match(stderr, /uuidgen/, "the error must tell a real publisher what to DO, not only what is missing");
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 0);
    });
  });

  // ── (a3), retained from the pre-F9 design as the byte-level net ───────────────────────────────
  test("the SAME artifact bytes, already published under plugin_id X, are REFUSED under a DIFFERENT plugin_id Y even with a forged fresh lineage", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const artifact = buildValidArtifact(); // same bytes reused for both publishes below

      assert.equal(
        tryPublish({ dir, target, ledger, plugin_id: "aiox-enterprise", lineage_id: LIN_ENTERPRISE, version: "0.0.0-fixture", artifact }),
        null,
      );

      // a fresh lineage_id dodges (a1) — (a3) must still catch it on the bytes alone
      const stderr = tryPublish({
        dir, target, ledger,
        plugin_id: "aiox-enterprise-renamed",
        lineage_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        version: "0.0.0-fixture",
        artifact,
      });
      assert.ok(stderr !== null, "expected publish to be REFUSED");
      assert.match(stderr, /already published under a DIFFERENT plugin_id \("aiox-enterprise"\)/);
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 1, "only the first (legitimate) publish must have landed");
    });
  });
});

describe("check (b) — burned name survives despublish (D24(b), AC2, VC-1, AC5 negative fixture)", () => {
  test("retiring a plugin removes its entry but the ledger keeps refusing republication under the same id — the registry SURVIVES the entry's removal", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const artifact = buildValidArtifact();
      const manifest = writeManifest(dir, { plugin_id: "acme-burn-test" });

      publish({
        manifest, target, ledger, subject: "acct_test", artifact,
        "mirror-url": `https://${GOOD_HOST}/plugins-fixtures/acme-burn-test/0.0.0-fixture/x.tar.gz`,
        "r2-key": `plugins-fixtures/acme-burn-test/0.0.0-fixture/x.tar.gz`,
        "no-push": true,
      });
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 1);

      // despublish — retire.mjs is the ONLY writer that removes an index entry
      const retireOut = execFileSync("node", [
        retireScript,
        "--plugin-id", "acme-burn-test", "--target", target, "--ledger", ledger,
        "--reason", "test: proving the registry survives entry removal",
        "--no-push",
      ]).toString();
      assert.match(retireOut, /^OK —/m);

      // the entry is GONE from the index — this is the "if it lived inside the entry" trap VC-1 warns about
      const indexAfterRetire = JSON.parse(readFileSync(target, "utf8"));
      assert.equal(indexAfterRetire.entries.length, 0, "the entry must actually be removed by retire.mjs");

      // ...but the ledger still remembers, and refuses republication under the SAME plugin_id
      const artifact2 = buildValidArtifact(); // fresh bytes — a genuinely new version attempt, not the digest-lineage check above
      let stderr = "";
      try {
        execFileSync("node", [
          publishScript,
          "--manifest", manifest, "--target", target, "--ledger", ledger,
          "--subject", "acct_test", "--artifact", artifact2,
          "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/acme-burn-test/0.0.1-fixture/x.tar.gz`,
          "--r2-key", `plugins-fixtures/acme-burn-test/0.0.1-fixture/x.tar.gz`,
          "--no-push",
        ], { stdio: "pipe" });
        assert.fail("expected republication under a burned name to be REFUSED");
      } catch (e) {
        stderr = e.stderr.toString();
      }
      assert.match(stderr, /this plugin_id was retired/);
      assert.match(stderr, /burned forever/);
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 0, "the refused republish must not have re-added the entry");
    });
  });

  test("retiring a plugin_id that was never published is REFUSED (nothing to burn)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      assert.throws(() => {
        execFileSync("node", [
          retireScript,
          "--plugin-id", "never-existed", "--target", target, "--ledger", ledger,
          "--reason", "test",
          "--no-push",
        ], { stdio: "pipe" });
      }, /Command failed/);
    });
  });
});

// ── story 055.W4.2 — allowed-tools (AC1) + DERIVED capabilities (AC3/AC5/AC6) ──────────────────
//
// Proven through the REAL CLI as a subprocess, never a mocked one — same posture as the 055.W3.3
// invariant fixtures. A gate that has only ever been exercised as a pure function has not been
// shown to be wired into the thing that actually publishes.
describe("055.W4.2 — `allowed-tools` mandatory + capabilities DERIVED, never declared", () => {
  test("AC1 — publishing a skill with NO `allowed-tools` is REFUSED (everything else about it is valid)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir);
      const artifact = buildArtifactWithoutAllowedTools();
      assert.throws(
        () =>
          publish({
            manifest, target, ledger,
            subject: "sub-1",
            "r2-key": `plugins/aiox-enterprise/1.0.0/x.tar.gz`,
            artifact,
            "mirror-url": `https://${GOOD_HOST}/plugins/aiox-enterprise/1.0.0/x.tar.gz`,
            "no-push": true,
          }),
        (e) => {
          const out = String(e.stderr ?? "") + String(e.stdout ?? "");
          assert.match(out, /allowed-tools` is REQUIRED|declares no `allowed-tools`/);
          return true;
        },
      );
      // the refusal must be REAL: nothing appended
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 0);
    });
  });

  test("AC3 — a manifest that self-declares `capabilities` is REFUSED, not ignored", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir, { capabilities: ["filesystem:read"] });
      const artifact = buildValidArtifact();
      assert.throws(
        () =>
          publish({
            manifest, target, ledger,
            subject: "sub-1",
            "r2-key": `plugins/aiox-enterprise/1.0.0/x.tar.gz`,
            artifact,
            "mirror-url": `https://${GOOD_HOST}/plugins/aiox-enterprise/1.0.0/x.tar.gz`,
            "no-push": true,
          }),
        (e) => {
          const out = String(e.stderr ?? "") + String(e.stdout ?? "");
          assert.match(out, /self-declares capabilities|NEVER self-declared/);
          return true;
        },
      );
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 0);
    });
  });

  test("AC6 — a published entry CARRIES the derived capabilities, its two signals, and its limits", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir);
      const artifact = buildArtifactWithExecutingSkill();
      publish({
        manifest, target, ledger,
        subject: "sub-1",
        "r2-key": `plugins/aiox-enterprise/1.0.0/x.tar.gz`,
        artifact,
        "mirror-url": `https://${GOOD_HOST}/plugins/aiox-enterprise/1.0.0/x.tar.gz`,
        "no-push": true,
      });
      const entry = JSON.parse(readFileSync(target, "utf8")).entries[0];
      assert.ok(entry.capabilities, "the entry must carry a derived capability block");
      assert.equal(entry.capabilities.self_declared, false);
      assert.equal(entry.capabilities.enforcement, "warn-and-display");

      const runner = entry.capabilities.skills.find((s) => s.skill === "runner");
      assert.equal(runner.owns_scripts, true, "SIGNAL 1 — it ships its own scripts/");
      assert.deepEqual(runner.instructs_execution, ["own"], "SIGNAL 2 — and instructs running it");
      assert.ok(entry.capabilities.union.includes("script:execute"));

      // AC5 — the blind spots travel WITH the capabilities, all the way onto the entry.
      assert.ok(entry.capabilities.limits.length >= 1);
      assert.match(entry.capabilities.limits.join("\n"), /MCP/);
      assert.match(entry.capabilities.limits.join("\n"), /npx/i);
    });
  });

  test("AC6 — capability findings WARN but do not block: the publish with capabilities SUCCEEDS", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir);
      const artifact = buildArtifactWithExecutingSkill();
      publish({
        manifest, target, ledger,
        subject: "sub-1",
        "r2-key": `plugins/aiox-enterprise/1.0.0/x.tar.gz`,
        artifact,
        "mirror-url": `https://${GOOD_HOST}/plugins/aiox-enterprise/1.0.0/x.tar.gz`,
        "no-push": true,
      });
      const entry = JSON.parse(readFileSync(target, "utf8")).entries[0];
      assert.ok(entry.capabilities.union.length > 0, "it DID find capabilities...");
      // ...and published anyway. That is D17's decision, made visible as a test.
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 1);
    });
  });
});
