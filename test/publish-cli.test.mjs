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
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildValidArtifact, buildArtifactWithoutLicense, buildArtifactWithBuriedLicense } from "./helpers/tarball.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publishScript = join(here, "..", "publisher", "publish.mjs");
const retireScript = join(here, "..", "publisher", "retire.mjs");

const GOOD_HOST = "pub-42179e62dc3040138151ec33229dd073.r2.dev";

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
  writeFileSync(target, JSON.stringify({ schema_version: "1.0.0", generated_at: null, entries: [] }, null, 2));
  return target;
}

function writeEmptyLedger(dir) {
  const ledger = join(dir, "ledger.json");
  writeFileSync(ledger, JSON.stringify({ schema_version: "1.0.0", plugins: {} }, null, 2));
  return ledger;
}

function writeManifest(dir, overrides = {}) {
  const manifest = join(dir, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      { plugin_id: "aiox-enterprise", name: "test", description: "test", version: "0.0.0-fixture", tiers: ["enterprise"], license: "MIT", ...overrides },
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

describe("check (a) — id immutability via digest lineage (D24(a), AC1, AC5 negative fixture)", () => {
  test("the SAME artifact bytes, already published under plugin_id X, are REFUSED under a DIFFERENT plugin_id Y", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const ledger = writeEmptyLedger(dir);
      const artifact = buildValidArtifact(); // same bytes reused for both publishes below

      // first publish, under plugin_id "aiox-enterprise" — succeeds, records the digest in the ledger
      const manifestX = writeManifest(dir, { plugin_id: "aiox-enterprise" });
      publish({
        manifest: manifestX, target, ledger, subject: "acct_test", artifact,
        "mirror-url": `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
        "r2-key": `plugins-fixtures/aiox-enterprise/0.0.0-fixture/x.tar.gz`,
        "no-push": true,
      });

      // second publish attempt, SAME bytes, under a DIFFERENT plugin_id "aiox-enterprise-renamed"
      const manifestY = join(dir, "manifest-y.json");
      writeFileSync(manifestY, JSON.stringify({ plugin_id: "aiox-enterprise-renamed", name: "renamed", description: "x", version: "0.0.0-fixture", tiers: ["enterprise"], license: "MIT" }));
      let stderr = "";
      try {
        execFileSync("node", [
          publishScript,
          "--manifest", manifestY, "--target", target, "--ledger", ledger,
          "--subject", "acct_test", "--artifact", artifact,
          "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise-renamed/0.0.0-fixture/x.tar.gz`,
          "--r2-key", `plugins-fixtures/aiox-enterprise-renamed/0.0.0-fixture/x.tar.gz`,
          "--no-push",
        ], { stdio: "pipe" });
        assert.fail("expected publish to be REFUSED");
      } catch (e) {
        stderr = e.stderr.toString();
      }
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
