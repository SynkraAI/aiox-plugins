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
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTarball, buildValidArtifact, buildArtifactWithoutLicense, buildArtifactWithBuriedLicense, buildArtifactWithoutAllowedTools, buildArtifactWithExecutingSkill, fixtureSkill, FIXTURE_SKILL } from "./helpers/tarball.mjs";
import {
  PLANTED_SECRETS,
  buildArtifactWithPlantedSecret,
  buildCleanArtifact,
  buildArtifactWithNulPrefixedSecret,
  buildArtifactWithOversizedSecret,
  buildArtifactWithShadowedDuplicate,
  buildArtifactWithSymlinkMember,
  buildArtifactWithDirectoryShapedFileMember,
  buildArtifactWithForgedUnameDirectoryMember,
  buildArtifactWithHiddenAppleDoubleMember,
} from "./helpers/secret-fixtures.mjs";
import { SECRET_CLASSES } from "../lib/secret-rules.mjs";
import { scanArtifact, unscannableMembers, renderScanReport, classifyMembers, tarMemberTable } from "../lib/secret-scanner.mjs";

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

// ── story 055.W4.1 — BLOCKING secret scanning (D20(1)), AC1 + AC2 ──────────────────────────────
//
// AC2 is explicit that a per-class NEGATIVE fixture is the evidence, and that green-against-a-clean-
// package is not: "a scanner that passes verde against a clean package proves nothing — it is
// literally the failure mode this lineage already produced". So every covered class gets its own
// planted credential, pushed through the REAL CLI as a subprocess, and the assertion is on the
// REFUSAL plus on the target file being untouched. The positive control at the end is what keeps the
// whole block from being satisfiable by a gate that refuses everything.
describe("055.W4.1 — secret scanning is BLOCKING at publish (D20(1)/AC1), per-class fixtures (AC2)", () => {
  test("the fixture set covers EVERY class the scanner claims — a claimed-but-unfixtured class fails here", () => {
    assert.deepEqual([...new Set(PLANTED_SECRETS.map((p) => p.class))].sort(), [...SECRET_CLASSES]);
  });

  for (const planted of PLANTED_SECRETS) {
    test(`AC2 — a package carrying a planted ${planted.class} is REFUSED (nonzero exit, index untouched)`, () => {
      withTempDir((dir) => {
        const target = writeEmptyIndex(dir);
        const ledger = writeEmptyLedger(dir);
        const before = readFileSync(target, "utf8");
        const manifest = writeManifest(dir);
        const artifact = buildArtifactWithPlantedSecret(planted);

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
          assert.fail(`expected publish to be REFUSED for a planted ${planted.class}`);
        } catch (e) {
          stderr = String(e.stderr ?? "");
        }

        assert.match(stderr, /REFUSED — secret scanning found/, "the refusal must name secret scanning as the reason");
        assert.match(stderr, new RegExp(`\\[${planted.class}\\]`), "the refusal must name the CLASS that was found");
        assert.match(stderr, new RegExp(planted.where.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the refusal must name the FILE, so it is actionable");
        assert.match(stderr, /ROTATE it/, "a credential prepared for publication is exposed whether or not the publish went through");
        assert.equal(readFileSync(target, "utf8"), before, "a REFUSED publish must not mutate the index");
        assert.equal(JSON.parse(readFileSync(ledger, "utf8")).plugins.hasOwnProperty("aiox-enterprise"), false, "nor the ledger");
      });
    });
  }

  test("AC2 POSITIVE CONTROL — the same package shape WITHOUT a credential publishes fine (not a blanket refusal)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const manifest = writeManifest(dir);
      const out = publish({
        manifest, target, ledger, subject: "acct_test", artifact: buildCleanArtifact(),
        "mirror-url": `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
        "r2-key": `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
        "no-push": true,
      });
      assert.match(out, /^OK —/m);
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 1);
    });
  });

  test("AC1 — a credential in the MANIFEST is blocking too (the manifest becomes a PUBLIC catalog entry)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const planted = PLANTED_SECRETS.find((p) => p.class === "aws-access-key");
      const manifest = writeManifest(dir, { description: `see ${planted.render().trim()}` });
      let stderr = "";
      try {
        execFileSync("node", [
          publishScript,
          "--manifest", manifest, "--target", target, "--ledger", ledger,
          "--subject", "acct_test", "--artifact", buildValidArtifact(),
          "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
          "--no-push",
        ], { stdio: "pipe" });
        assert.fail("expected publish to be REFUSED");
      } catch (e) {
        stderr = String(e.stderr ?? "");
      }
      assert.match(stderr, /\[aws-access-key\] manifest\.json/);
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 0);
    });
  });

  // AC3's deliverable is not a document nobody opens — it is that the limits are IN FRONT OF the
  // operator on the success path, which is the only path a happy publisher ever sees. `spawnSync` is
  // used because `execFileSync` returns stdout only, and the report (with its blind spots) is
  // deliberately written to stderr so it cannot be swallowed by a caller piping stdout to a file.
  test("AC3 — the limits are printed on a publish that SUCCEEDS, not only on a refusal", () => {
    withTempDir((dir) => {
      const res = spawnSync("node", [
        publishScript,
        "--manifest", writeManifest(dir), "--target", writeEmptyIndex(dir), "--ledger", writeEmptyLedger(dir),
        "--subject", "acct_test", "--artifact", buildCleanArtifact(),
        "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
        "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
        "--no-push",
      ], { encoding: "utf8" });

      assert.equal(res.status, 0, "the clean package must publish");
      assert.match(res.stdout, /^OK —/m);
      assert.match(res.stderr, /WHAT THIS SCAN CANNOT SEE/);
      assert.match(res.stderr, /POINTER, NOT THE TARGET/, "limit (a) — the MCP pointer is not the target");
      assert.match(res.stderr, /OBFUSCATED OR ENCODED SECRET ESCAPES/, "limit (b)");
      assert.match(res.stderr, /Corpus: gitleaks/, "the corpus + its snapshot date are part of the honest claim");
      assert.match(res.stderr, /A CLEAN SCAN IS NOT A SECURITY VERDICT/);
    });
  });
});

// ── fix-cycle-1 (F2) — the two evasions the QG EXECUTED, now proven to be REFUSED ───────────────
//
// Before this cycle each of these published with exit 0 while carrying a live-shaped AWS key,
// because an unscannable member was listed and then ignored. The disposition taken is fail-closed:
// unscannable => not publishable. These fixtures are what makes that decision provable rather than
// merely argued — see the decision site in lib/secret-scanner.mjs for the trade-off, the named cost,
// and why there is deliberately no override flag.
describe("055.W4.1 fix-cycle-1 — an UNSCANNABLE member is fail-closed (F2)", () => {
  function attempt(dir, artifact) {
    const target = writeEmptyIndex(dir);
    const ledger = writeEmptyLedger(dir);
    const before = readFileSync(target, "utf8");
    const manifest = writeManifest(dir);
    const res = spawnSync("node", [
      publishScript,
      "--manifest", manifest, "--target", target, "--ledger", ledger,
      "--subject", "acct_test", "--artifact", artifact,
      "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
      "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
      "--no-push",
    ], { encoding: "utf8" });
    return { res, unchanged: readFileSync(target, "utf8") === before, target };
  }

  test("evasion A — a leading NUL byte (member reads as binary) no longer publishes a real credential", () => {
    withTempDir((dir) => {
      const { res, unchanged, target } = attempt(dir, buildArtifactWithNulPrefixedSecret());
      assert.notEqual(res.status, 0, "this exited 0 before fix-cycle-1 — that was the defect");
      assert.match(res.stderr, /REFUSED — 1 member\(s\) could NOT be scanned/);
      assert.match(res.stderr, /config\/creds\.env/, "the refusal must name the member");
      assert.match(res.stderr, /NUL byte in the first 8000 bytes/, "and say WHY it could not be read");
      assert.match(res.stderr, /There is no override flag by design/);
      assert.ok(unchanged, "a REFUSED publish must not mutate the index");
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 0);
    });
  });

  test("evasion B — padding past the scan cap no longer publishes a real credential", () => {
    withTempDir((dir) => {
      const { res, unchanged } = attempt(dir, buildArtifactWithOversizedSecret());
      assert.notEqual(res.status, 0, "this exited 0 before fix-cycle-1 — that was the defect");
      assert.match(res.stderr, /REFUSED — 1 member\(s\) could NOT be scanned/);
      assert.match(res.stderr, /config\/creds\.env/);
      assert.match(res.stderr, /larger than the \d+-byte scan cap/);
      assert.ok(unchanged);
    });
  });

  test("fail-closed is not a blanket refusal: the clean package still publishes (positive control)", () => {
    withTempDir((dir) => {
      const { res } = attempt(dir, buildCleanArtifact());
      assert.equal(res.status, 0, "a package with nothing unscannable in it must still publish");
      assert.match(res.stdout, /^OK —/m);
    });
  });

  test("the refusal is on UNSCANNABLE specifically — a clean BINARY member blocks even with no credential in it", () => {
    // The honest reading of the rule, stated as a test: the gate refuses because it could not look,
    // not because it found something. An implementation that only refused when it happened to also
    // detect a credential would be back to disclosure-instead-of-enforcement.
    withTempDir((dir) => {
      const artifact = buildTarball({
        LICENSE: "MIT\n",
        "SKILL.md": FIXTURE_SKILL,
        "assets/icon.bin": String.fromCharCode(0, 1) + "no credential whatsoever, just binary bytes",
      });
      const { res } = attempt(dir, artifact);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /could NOT be scanned/);
      assert.match(res.stderr, /assets\/icon\.bin/);
      assert.doesNotMatch(res.stderr, /secret scanning found/, "nothing was FOUND — the refusal is about not being able to look");
    });
  });
});

// ── fix-cycle-2 (F10/F11) — STRUCTURAL evasions: the archive is enumerated, not the extraction ───
//
// Round 1 closed the evasions where the scanner said out loud it had not looked. These are the ones
// where it said nothing at all: a shadowed duplicate member (the credential ships and is recoverable
// from the published bytes) and a non-regular member (dropped before it could even be counted). One
// root fix closes both — the member table is the inventory — and both land in the fail-closed path
// built and tested in cycle 1 rather than a second mechanism.
describe("055.W4.1 fix-cycle-2 — structural members are enumerated and fail-closed (F10/F11)", () => {
  function attempt(dir, artifact) {
    const target = writeEmptyIndex(dir);
    const ledger = writeEmptyLedger(dir);
    const before = readFileSync(target, "utf8");
    const manifest = writeManifest(dir);
    const res = spawnSync("node", [
      publishScript,
      "--manifest", manifest, "--target", target, "--ledger", ledger,
      "--subject", "acct_test", "--artifact", artifact,
      "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
      "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
      "--no-push",
    ], { encoding: "utf8" });
    return { res, unchanged: readFileSync(target, "utf8") === before, target };
  }

  test("F10 — a SHADOWED duplicate member no longer publishes, and the credential really was in the bytes", () => {
    withTempDir((dir) => {
      const artifact = buildArtifactWithShadowedDuplicate();

      // The fixture is only meaningful if the credential is genuinely recoverable from the published
      // artifact. Assert that FIRST, from the archive itself — otherwise a later refusal could be
      // passing for the wrong reason (e.g. a fixture that never carried the secret at all).
      const dumped = execFileSync("tar", ["-xOzf", artifact, "./config/app.env"], { encoding: "utf8" });
      assert.match(dumped, /AKIA[A-Z2-7]{16}/, "the shadowed member must actually carry the credential");
      assert.match(dumped, /APP_ENV=production/, "...and the innocent shadow must also be present");

      const { res, unchanged, target } = attempt(dir, artifact);
      assert.notEqual(res.status, 0, "this exited 0 before fix-cycle-2 — the credential shipped silently");
      assert.match(res.stderr, /REFUSED — 1 member\(s\) could NOT be scanned/);
      assert.match(res.stderr, /\[duplicate\] config\/app\.env/, "the refusal must name the shadowed path");
      assert.match(res.stderr, /appears 2 times in the archive/, "and say WHY, so it is actionable");
      assert.ok(unchanged);
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 0);
    });
  });

  test("F11 — a non-regular (symlink) member is enumerated and refused, not dropped before counting", () => {
    withTempDir((dir) => {
      const { res, unchanged } = attempt(dir, buildArtifactWithSymlinkMember());
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /\[non-regular\] config\/outside\.env/);
      assert.match(res.stderr, /member type 'l' is not a regular file/);
      assert.ok(unchanged);
    });
  });

  test("F11 — the member count now means what it says: 3 members are reported as 3, not 2", () => {
    // The honesty half of F11, separate from the refusal: before fix-cycle-2 a 3-member archive
    // reported "2/2 file(s) scanned" — which reads as COMPLETE coverage of an archive it had not
    // fully seen, in the very report AC3 makes load-bearing.
    const report = scanArtifact(buildArtifactWithSymlinkMember());
    assert.equal(report.files_total, 3, "LICENSE + SKILL.md + the symlink");
    assert.equal(report.files_scanned, 2);
    assert.equal(unscannableMembers(report).length, 1);
    assert.match(renderScanReport(report), /2\/3 file\(s\) scanned/);
  });

  test("the positive control still publishes — enumerating from the archive is not a blanket refusal", () => {
    withTempDir((dir) => {
      const { res } = attempt(dir, buildCleanArtifact());
      assert.equal(res.status, 0, "an ordinary all-regular-member package must still publish");
      assert.match(res.stdout, /^OK —/m);
    });
  });

  test("directories are NOT treated as unscannable (every normal artifact contains them)", () => {
    // The failure mode this guards against is the opposite of F10: a fix that refuses every archive
    // would also "close" the finding, and would be useless.
    const report = scanArtifact(buildCleanArtifact());
    assert.equal(unscannableMembers(report).length, 0);
    assert.ok(report.files_total >= 4);
  });

  test("what the member table cannot see is DECLARED in the limits printed on every run", () => {
    // The F2 lesson, applied to its own fix: an undeclared blind spot is the disqualifying kind.
    const joined = scanArtifact(buildCleanArtifact()).limits.join("\n");
    assert.match(joined, /WHAT THE MEMBER TABLE ITSELF CANNOT SEE/);
    assert.match(joined, /parser differential/);
    assert.match(joined, /nested archive/);
  });
});

// Does the LOCAL tar unpack this archive at all? Measured per-run, never assumed from the platform
// name (fix-cycle-4): bsdtar unpacks the forged F14/F17 archives, GNU tar 1.34 refuses them. Both
// end in a correct fail-closed refusal, but at different stages and with different messages, and
// hardcoding either one is what turned the CI red while macOS stayed green.
function tarCanUnpack(artifact) {
  const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-canunpack-"));
  try {
    return spawnSync("tar", ["-xzf", artifact, "-C", dir], { stdio: "ignore" }).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── fix-cycle-3 (F14) — the classifier is an ALLOWLIST: exemption requires positive evidence ─────
//
// AC2 requires a negative test PER CLASS, and "a member with a regular-file typeflag whose name ends
// in `/`" is a class — one that passed green for three cycles. The fixture below is the class's
// negative test. It is also the reason this cycle happened at all: a bypass proven by execution
// means a control named BLOCKING does not do what its name says.
describe("055.W4.1 fix-cycle-3 — a member that only LOOKS like a directory is refused (F14)", () => {
  function attempt(dir, artifact) {
    const target = writeEmptyIndex(dir);
    const ledger = writeEmptyLedger(dir);
    const before = readFileSync(target, "utf8");
    const manifest = writeManifest(dir);
    const res = spawnSync("node", [
      publishScript,
      "--manifest", manifest, "--target", target, "--ledger", ledger,
      "--subject", "acct_test", "--artifact", artifact,
      "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
      "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
      "--no-push",
    ], { encoding: "utf8" });
    return { res, unchanged: readFileSync(target, "utf8") === before, target };
  }

  test("F14 — typeflag '0' + a name ending in '/' + a credential inside is REFUSED", () => {
    withTempDir((dir) => {
      const artifact = buildArtifactWithDirectoryShapedFileMember();

      // The fixture only proves something if the archive is VALID and the credential is genuinely
      // in the published bytes. The second engine's own attempt at this produced a damaged archive
      // that yielded only NUL bytes — an unproven assertion dressed as a finding.
      //
      // fix-cycle-4 / CI: this precondition is now checked HERMETICALLY, against the archive's own
      // decompressed bytes, instead of via `tar -xOzf <member>`. Measured on GNU tar 1.34: that
      // command prints NOTHING for a trailing-slash member name and exits 0, so the old assertion
      // failed on Linux — the CI platform — while passing on macOS. It was asserting "this tar will
      // hand me the member", which is not the claim. The claim is "the bytes ship", and gunzip
      // proves that on every platform.
      assert.match(gunzipSync(readFileSync(artifact)).toString("latin1"), /AKIA[A-Z2-7]{16}/,
        "the credential must really ship inside the published bytes");
      const members = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" }).trim().split("\n");
      assert.equal(members.length, 3, "the archive must have 3 members");
      assert.ok(members.includes("./config/payload/"), "including the directory-shaped one");

      const { res, unchanged, target } = attempt(dir, artifact);
      assert.notEqual(res.status, 0, "this exited 0 for three cycles — it is the F14 bypass");
      assert.match(res.stderr, /REFUSED — 1 member\(s\) could NOT be scanned/);
      // WHY THE REASON IS DERIVED AND NOT HARDCODED. The two tars disagree about this archive, and
      // pretending otherwise is what broke on CI. bsdtar unpacks it, so the member reaches the
      // classifier and is refused as `directory-with-data`. GNU tar REFUSES TO UNPACK IT AT ALL, so
      // the archive is refused one step earlier, as `unextractable-archive`. Both are correct
      // fail-closed refusals of the same archive; the invariant asserted unconditionally above is
      // that it is REFUSED and the index is untouched. The CLASSIFIER itself — the thing fix-cycle-4
      // actually changed — is proven separately and hermetically, in the test below, so that CI
      // enforces it rather than exercising a refusal that happens for a different reason.
      if (tarCanUnpack(artifact)) {
        assert.match(res.stderr, /\[directory-with-data\] config\/payload/, "the refusal must name the member");
        assert.match(res.stderr, /carries 39 bytes of data/, "and cite the evidence: a real directory carries none");
      } else {
        assert.match(res.stderr, /\[unextractable-archive\] \(whole archive\)/);
      }
      assert.ok(unchanged, "a REFUSED publish must not mutate the index");
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 0);
    });
  });

  test("F14/F17 — the CLASSIFICATION is proven without depending on WHICH tar is installed", () => {
    // THIS is the test that makes CI enforce fix-cycle-4, and it exists because of a defect the CI
    // caught in the tests themselves: on GNU tar the end-to-end fixtures are refused as
    // `unextractable-archive` BEFORE the classifier ever runs, so a green CI would have proven only
    // that GNU tar cannot unpack the archive — a test passing for the wrong reason, which is the
    // exact class this story keeps catching. The classifier is asserted directly instead.
    for (const [label, build] of [
      ["F14 (typeflag '0' + trailing-slash name)", buildArtifactWithDirectoryShapedFileMember],
      ["F17 (the same, plus a forged `uname`)", buildArtifactWithForgedUnameDirectoryMember],
    ]) {
      const table = tarMemberTable(build());
      assert.ok(table.aligned, `${label}: the header walk must enumerate cleanly`);
      assert.equal(table.members.length, 3, `${label}: the member is COUNTED, not dropped`);

      // The heart of it: the header says REGULAR FILE carrying 39 bytes, on every platform, because
      // these come from fixed offsets (156 and 124) and not from anyone's rendering.
      const payload = table.members.find((m) => m.raw_path === "./config/payload/");
      assert.ok(payload, `${label}: the forged member must be enumerated`);
      assert.equal(payload.type, "-", `${label}: typeflag at offset 156 says regular file`);
      assert.equal(payload.size, 39, `${label}: size at offset 124 says 39 bytes`);

      const { readable, structural } = classifyMembers(table);
      assert.deepEqual(structural.map((s) => s.kind), ["directory-with-data"], `${label}: classified as the anomaly`);
      assert.match(structural[0].why, /carries 39 bytes of data/, `${label}: the evidence is cited`);
      assert.equal(readable.length, 2, `${label}: the two ordinary members are still readable`);
    }
  });

  test("F14 — REAL directories are still exempt (the carve-out that must not tighten)", () => {
    // A fix that refused directories would also "close" F14 — and would refuse every package ever
    // built with `tar -czf x.tgz -C dir .`. This is the control that keeps the inversion honest.
    const report = scanArtifact(buildCleanArtifact());
    assert.equal(unscannableMembers(report).length, 0);
    assert.equal(report.findings.length, 0);
    assert.ok(report.files_scanned >= 4);
  });

  test("F14 — exemption requires POSITIVE evidence: a directory whose size is unknown is refused", () => {
    // The allowlist property itself, independent of the trailing-slash instance: `classifyMembers`
    // exempts only a member it can positively identify as a directory (rendered `d` AND size 0).
    // An unverifiable claim to be a directory is unscannable, not a pass.
    const table = {
      aligned: true,
      members: [
        { raw_path: "./", path: "", type: "d", size: 0 },              // real -> exempt
        { raw_path: "./a/", path: "a", type: "d", size: null },        // size unknown -> refuse
        { raw_path: "./b/", path: "b", type: "d", size: 12 },          // data -> refuse
        { raw_path: "./c.txt", path: "c.txt", type: "-", size: 5 },    // ordinary -> readable
      ],
    };
    const { readable, structural } = classifyMembers(table);
    assert.deepEqual(readable.map((m) => m.path), ["c.txt"]);
    assert.deepEqual(structural.map((s) => s.kind), ["directory-with-data", "directory-with-data"]);
    // fix-cycle-4 (F17): the size now comes from the ustar header at offset 124, so the message
    // names its source. The PROPERTY under test is unchanged — an unverifiable claim is not a pass.
    assert.match(structural[0].why, /size could not be read from the ustar header/);
    assert.match(structural[1].why, /carries 12 bytes/);
  });
});

// ── fix-cycle-4 (F17) — classification reads the ustar HEADER, not `tar`'s rendered listing ───────
//
// AC2 requires a negative test PER CLASS. The class here is not "a trailing-slash name" (that was
// F14) — it is "the evidence the allowlist depends on is attacker-controlled". Cycle 3 inverted the
// classifier correctly in FORM (exemption requires positive evidence) but read that evidence from
// `tar -tvzf`, a human-readable rendering whose columns are a function of attacker-supplied header
// fields. ONE forged `uname` re-exempted the member and the credential published at exit 0.
describe("055.W4.1 fix-cycle-4 — a forged header FIELD cannot move a header OFFSET (F17)", () => {
  function attempt(dir, artifact) {
    const target = writeEmptyIndex(dir);
    const ledger = writeEmptyLedger(dir);
    const before = readFileSync(target, "utf8");
    const manifest = writeManifest(dir);
    const res = spawnSync("node", [
      publishScript,
      "--manifest", manifest, "--target", target, "--ledger", ledger,
      "--subject", "acct_test", "--artifact", artifact,
      "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
      "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
      "--no-push",
    ], { encoding: "utf8" });
    return { res, unchanged: readFileSync(target, "utf8") === before, target };
  }

  test("F17 — the F14 member plus ONE forged `uname` is REFUSED", () => {
    withTempDir((dir) => {
      const artifact = buildArtifactWithForgedUnameDirectoryMember();

      // Same discipline as the F14 fixture: prove the archive is VALID and the credential genuinely
      // recoverable BEFORE asserting anything about the gate. A probe that produced a damaged archive
      // would prove nothing, and this lineage has already been bitten by exactly that.
      assert.match(gunzipSync(readFileSync(artifact)).toString("latin1"), /AKIA[A-Z2-7]{16}/,
        "the credential must really ship inside the published bytes");
      const members = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" }).trim().split("\n");
      assert.equal(members.length, 3, "the archive must have 3 members");
      assert.ok(members.includes("./config/payload/"), "including the directory-shaped one");

      const { res, unchanged, target } = attempt(dir, artifact);
      assert.notEqual(res.status, 0, "this exited 0 after fix-cycle-3 — it is the F17 bypass");
      assert.match(res.stderr, /REFUSED — 1 member\(s\) could NOT be scanned/);
      if (tarCanUnpack(artifact)) {
        assert.match(res.stderr, /\[directory-with-data\] config\/payload/, "the refusal must name the member");
        assert.match(res.stderr, /carries 39 bytes of data/, "read from the header, not from the rendered size column");
      } else {
        assert.match(res.stderr, /\[unextractable-archive\] \(whole archive\)/);
      }
      assert.ok(unchanged, "a REFUSED publish must not mutate the index");
      assert.equal(JSON.parse(readFileSync(target, "utf8")).entries.length, 0);
    });
  });

  test("F17 — where the forged `uname` DOES poison the rendering, the scan is no longer fooled", () => {
    // Without this, the tests above could pass for the wrong reason — e.g. if the fixture simply
    // failed to inject the field. It asserts the poisoned rendering EXISTS and that the scan reads
    // past it.
    //
    // fix-cycle-4 / CI: the poisoning is a property of BSDTAR'S RENDERER, and that is the honest
    // scope. bsdtar prints uname and gname as separate free-text columns, so an injected `0 Aug 1`
    // lands exactly where the size column is expected. GNU tar prints `user/group` as one combined
    // field, so the same bytes do NOT reproduce the bypass — measured on GNU tar 1.34, where the
    // cycle-3 regex reads the true `39`. The condition is therefore detected, never assumed from a
    // platform name, and skipped LOUDLY rather than failed where it cannot exist. The refusal that
    // matters is proven unconditionally by the hermetic classifier test above.
    const artifact = buildArtifactWithForgedUnameDirectoryMember();
    const line = execFileSync("tar", ["-tvzf", artifact], { encoding: "utf8" })
      .split("\n").find((l) => l.includes("./config/payload/"));
    // The cycle-3 size regex, verbatim.
    const cycle3Regex = /\s(\d+)\s+(?:[A-Z][a-z]{2}\s+\d{1,2}|\d{4}-\d{2}-\d{2})\s/;
    const rendered = cycle3Regex.exec(line)?.[1];
    if (rendered !== "0") {
      console.log(`  ↷ SKIPPED — this tar's long listing does not reproduce the F17 poisoning (size column read as ${JSON.stringify(rendered)}, not "0"). The bypass is specific to bsdtar's separate uname/gname columns; the refusal itself is covered by the hermetic classifier test.`);
      return;
    }

    const report = scanArtifact(artifact);
    assert.equal(report.files_total, 3);
    const un = unscannableMembers(report);
    assert.equal(un.length, 1);
    assert.equal(un[0].kind, "directory-with-data");
    assert.match(un[0].why, /carries 39 bytes/, "the header says 39 where the rendering said 0");
  });

  test("F17 — a member the archive's own listing HIDES is enumerated and refused (macOS trigger)", () => {
    // The differential half, against the REAL trigger. macOS `tar -czf` writes an AppleDouble
    // `._name` companion for every file carrying an extended attribute, and `tar -tzf` does not list
    // it — so a credential stored in an xattr ships inside the artifact and appears in no listing
    // this scanner has ever read. Every cycle before this one enumerated from that listing.
    //
    // The fixture is null off macOS (see the helper: GNU tar has no AppleDouble concept, so there is
    // nothing to reproduce rather than something skipped). The refusal LOGIC is pinned for CI by the
    // portable unit test below, which runs `classifyMembers` for both directions everywhere.
    const artifact = buildArtifactWithHiddenAppleDoubleMember();
    if (artifact === null) return;

    // The blindness is real before anything is asserted about the gate: tar's own listing does not
    // mention the member, and the credential is recoverable from the published bytes anyway.
    const listing = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" });
    assert.ok(!listing.includes("._LICENSE"), "the archive's own listing must not admit the member exists");
    const rawBytes = gunzipSync(readFileSync(artifact)).toString("latin1");
    assert.match(rawBytes, /AKIA[A-Z2-7]{16}/, "yet the credential ships inside the published bytes");

    const report = scanArtifact(artifact);
    const un = unscannableMembers(report);
    const hidden = un.filter((u) => u.kind === "hidden-member");
    assert.ok(hidden.length >= 1, "the hidden member must be COUNTED and REFUSED, not silently dropped");
    assert.ok(hidden.some((h) => h.path.endsWith("._LICENSE")), "and named");
    assert.match(hidden[0].why, /AppleDouble/);
    assert.match(hidden[0].why, /COPYFILE_DISABLE=1/, "the refusal must tell the operator how to rebuild");
  });

  test("F17 — both directions of the parser differential are refusals, not drops", () => {
    // The property in isolation, independent of any platform's tar: a member only one of the two
    // parses can see is uncertifiable in either direction. Declared residual (i) said "nothing here
    // detects a parser differential" — this is what changed.
    const { readable, structural } = classifyMembers({
      aligned: true,
      tar_only: ["ghost.txt"],
      members: [
        { raw_path: "./ok.txt", path: "ok.txt", type: "-", size: 5, listed_by_tar: true },
        { raw_path: "./._LICENSE", path: "._LICENSE", type: "-", size: 163, listed_by_tar: false },
        { raw_path: "./other", path: "other", type: "-", size: 9, listed_by_tar: false },
      ],
    });
    assert.deepEqual(readable.map((m) => m.path), ["ok.txt"]);
    assert.deepEqual(structural.map((s) => s.kind), ["phantom-member", "hidden-member", "hidden-member"]);
    assert.match(structural[1].why, /AppleDouble/, "the `._` case names the cause the operator will actually hit");
    assert.match(structural[2].why, /absent from `tar`'s own enumeration/);
  });

  test("F17 — a stream whose headers cannot be walked refuses WHOLE, naming why", () => {
    // The walk's own fail-closed edge. A corrupted header must not yield invented members.
    const good = buildCleanArtifact();
    const raw = gunzipSync(readFileSync(good));
    raw[124] = 0x39; // '9' — not a valid octal digit, so the size field cannot be read
    const broken = join(mkdtempSync(join(tmpdir(), "aiox-plugins-brokenhdr-")), "artifact.tar.gz");
    writeFileSync(broken, gzipSync(raw));

    const report = scanArtifact(broken);
    const un = unscannableMembers(report);
    assert.equal(un.length, 1);
    assert.equal(un[0].path, "(whole archive)");
    // Either gate may catch it first depending on what `tar` itself makes of the damage — both are
    // named, fail-closed refusals. Before this cycle an archive tar cannot unpack threw an uncaught
    // exception with a stack trace instead of producing a report at all.
    assert.ok(["unparseable-member-table", "unextractable-archive"].includes(un[0].kind), un[0].kind);
    assert.equal(report.files_scanned, 0, "nothing may be certified from a stream that cannot be walked");
  });

  test("F17 — the positive controls still pass: tightening must not refuse legitimate work", () => {
    // This story's own named failure mode pointed at itself four times. A fix that refuses every
    // package would "close" F17 and break the product.
    const report = scanArtifact(buildCleanArtifact());
    assert.equal(unscannableMembers(report).length, 0);
    assert.equal(report.findings.length, 0);
    assert.ok(report.files_scanned >= 4);
  });
});
