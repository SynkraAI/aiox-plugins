// test/publish-cli.test.mjs — fix-cycle-2 (closes QG gate 4). Exercises the ACTUAL CLI entrypoint
// (publisher/publish.mjs) as a subprocess against a throwaway temp directory, always with
// `--no-push` — this suite never runs `git commit`/`git push` and never touches the real repo. The
// git-push mechanism itself was already proven live, repeatedly, by the real fixture publications
// in fixtures/index.json (see the handoff) — that is deliberately NOT re-proven here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publishScript = join(here, "..", "publisher", "publish.mjs");

const DIGEST = "9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a";
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

describe("publish.mjs CLI (--no-push only — never touches git)", () => {
  test("a correctly-formed, correctly-hosted publish succeeds and appends exactly one entry", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const manifest = writeManifest(dir);
      const out = execFileSync("node", [
        publishScript,
        "--manifest", manifest,
        "--target", target,
        "--subject", "acct_test",
        "--digest", DIGEST,
        "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
        "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
        "--no-push",
      ]).toString();
      assert.match(out, /^OK —/m);
      const written = JSON.parse(readFileSync(target, "utf8"));
      assert.equal(written.entries.length, 1);
      assert.equal(written.entries[0].plugin_id, "aiox-enterprise");
    });
  });

  test("a foreign-host mirror_url is REFUSED — nonzero exit, target file unchanged (fix-cycle-2, F-BINDING-NO-HOST-ALLOWLIST)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const before = readFileSync(target, "utf8");
      const manifest = writeManifest(dir);
      assert.throws(() => {
        execFileSync(
          "node",
          [
            publishScript,
            "--manifest", manifest,
            "--target", target,
            "--subject", "acct_test",
            "--digest", DIGEST,
            "--mirror-url", `https://evil.example.com/plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
            "--r2-key", `plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
            "--no-push",
          ],
          { stdio: "pipe" },
        );
      }, /Command failed/);
      assert.equal(readFileSync(target, "utf8"), before, "REFUSED publish must not mutate the target file");
    });
  });

  test("an entry pointing at a DIFFERENT plugin's key is REFUSED — nonzero exit, target file unchanged (fix-cycle-1, F-AC6-ARTIFACT-BINDING)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const before = readFileSync(target, "utf8");
      const manifest = writeManifest(dir); // plugin_id: aiox-enterprise
      assert.throws(() => {
        execFileSync(
          "node",
          [
            publishScript,
            "--manifest", manifest,
            "--target", target,
            "--subject", "acct_test",
            "--digest", DIGEST,
            "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/sinkra-os/0.0.0-fixture/${DIGEST}.tar.gz`,
            "--r2-key", `plugins-fixtures/sinkra-os/0.0.0-fixture/${DIGEST}.tar.gz`,
            "--no-push",
          ],
          { stdio: "pipe" },
        );
      }, /Command failed/);
      assert.equal(readFileSync(target, "utf8"), before);
    });
  });

  test("missing --r2-key is refused at the CLI usage level (required since fix-cycle-1)", () => {
    withTempDir((dir) => {
      const target = writeEmptyIndex(dir);
      const manifest = writeManifest(dir);
      assert.throws(() => {
        execFileSync(
          "node",
          [
            publishScript,
            "--manifest", manifest,
            "--target", target,
            "--subject", "acct_test",
            "--digest", DIGEST,
            "--mirror-url", `https://${GOOD_HOST}/plugins-fixtures/aiox-enterprise/0.0.0-fixture/${DIGEST}.tar.gz`,
            "--no-push",
          ],
          { stdio: "pipe" },
        );
      }, /Command failed/);
    });
  });
});
