// test/pin.test.mjs — story 055.W4.1, AC4 (deterministic pin) + AC5 (channel separation) + AC6
// (the pin's cost travels with the resolution).
//
// WHAT IS PROVEN HERE vs. WHAT IS PROVEN LIVE: the digest this suite pins against
// (9ec01ff4...561a) is the digest of the artifact actually mirrored in R2 by story 055.W3.1, and the
// live HTTP round-trip against that endpoint was EXECUTED (see the story's handoff for the literal
// curl + shasum output). It is deliberately NOT re-run here: a unit suite that needs the network to
// pass fails for reasons that have nothing to do with the code. What this suite proves offline is
// the property that would silently rot — that the resolver still maps that pin to that exact digest,
// so a regression is caught on every push without depending on a bucket being reachable.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePin, resolvePin, resolvePinFromFile, verifyBytesAgainstPin, renderResolution, PIN_COST, CHANNEL } from "../lib/pin.mjs";
import { validateIndexData } from "../scripts/validate-index.mjs";
import { buildValidArtifact, buildTarball, fixtureSkill } from "./helpers/tarball.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const fixturesIndex = join(repoRoot, "fixtures", "index.json");
const publishScript = join(repoRoot, "publisher", "publish.mjs");
const channelGuard = join(repoRoot, "scripts", "check-channel-separation.mjs");
const resolveCli = join(repoRoot, "scripts", "resolve-pin.mjs");

const GOOD_HOST = "pub-42179e62dc3040138151ec33229dd073.r2.dev";

// The digest recorded by 055.W3.1 for the artifact it uploaded and verified over HTTP.
const W31_MIRRORED_DIGEST = "9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "aiox-plugins-pin-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function publish({ dir, target, ledger, plugin_id, lineage_id, version, artifact }) {
  const manifest = join(dir, `manifest-${plugin_id}-${version}.json`);
  writeFileSync(
    manifest,
    JSON.stringify({ plugin_id, lineage_id, name: plugin_id, description: "pin test", version, tiers: ["base"], license: "MIT" }),
  );
  execFileSync("node", [
    publishScript,
    "--manifest", manifest, "--target", target, "--ledger", ledger,
    "--subject", "acct_pin_test", "--artifact", artifact,
    "--mirror-url", `https://${GOOD_HOST}/plugins/${plugin_id}/${version}/x.tar.gz`,
    "--r2-key", `plugins/${plugin_id}/${version}/x.tar.gz`,
    "--no-push",
  ], { stdio: "pipe" });
}

function emptyIndexAndLedger(dir) {
  const target = join(dir, "index.json");
  const ledger = join(dir, "ledger.json");
  writeFileSync(target, JSON.stringify({ schema_version: "2.0.0", generated_at: null, entries: [] }, null, 2));
  writeFileSync(ledger, JSON.stringify({ schema_version: "2.0.0", plugins: {} }, null, 2));
  return { target, ledger };
}

describe("AC4 — the pin is deterministic: same pin ⇒ same digest ⇒ same bytes", () => {
  test("pin syntax is parsed strictly (a pin that means two things is not a pin)", () => {
    assert.deepEqual(parsePin("sinkra-os@1.2.0"), { plugin_id: "sinkra-os", version: "1.2.0" });
    assert.deepEqual(parsePin("sinkra-os@0.0.0-fixture"), { plugin_id: "sinkra-os", version: "0.0.0-fixture" });
    for (const bad of ["sinkra-os", "sinkra-os@latest", "sinkra-os@1.2", "@1.2.0", "Sinkra-OS@1.2.0", ""]) {
      assert.throws(() => parsePin(bad), /invalid pin/, `"${bad}" must not parse`);
    }
  });

  test("resolving the SAME pin 1000 times yields byte-identical resolutions", () => {
    const data = JSON.parse(readFileSync(fixturesIndex, "utf8"));
    const first = JSON.stringify(resolvePin(data, "sinkra-os@0.0.0-fixture"));
    for (let i = 0; i < 1000; i++) {
      assert.equal(JSON.stringify(resolvePin(data, "sinkra-os@0.0.0-fixture")), first);
    }
  });

  test("the pin resolves to the digest of the artifact 055.W3.1 actually mirrored in R2", () => {
    const r = resolvePinFromFile(fixturesIndex, "sinkra-os@0.0.0-fixture");
    assert.equal(r.digest.algorithm, "sha256");
    assert.equal(r.digest.value, W31_MIRRORED_DIGEST);
    assert.equal(
      r.artifact.mirror_url,
      `https://${GOOD_HOST}/plugins-fixtures/sinkra-os/0.0.0-fixture/${W31_MIRRORED_DIGEST}.tar.gz`,
      "the resolved URL must be the content-addressed path — the digest IS the filename",
    );
  });

  test("same digest ⇒ same bytes: local bytes are verified against the resolution, and a single flipped byte is caught", () => {
    withTempDir((dir) => {
      const artifact = buildValidArtifact();
      const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
      const resolved = { digest: { algorithm: "sha256", value: digest } };
      assert.equal(verifyBytesAgainstPin(resolved, artifact).ok, true);

      const tampered = join(dir, "tampered.tar.gz");
      const bytes = Buffer.from(readFileSync(artifact));
      bytes[bytes.length - 1] ^= 0x01;
      writeFileSync(tampered, bytes);
      const bad = verifyBytesAgainstPin(resolved, tampered);
      assert.equal(bad.ok, false);
      assert.notEqual(bad.actual, bad.expected);
    });
  });

  test("an ambiguous pin is REFUSED, never tie-broken (order-dependent bytes are not a pin)", () => {
    const data = {
      entries: [
        { plugin_id: "dup", version: "1.0.0", digest: { algorithm: "sha256", value: "a".repeat(64) }, artifact: { mirror_url: "https://x/a" } },
        { plugin_id: "dup", version: "1.0.0", digest: { algorithm: "sha256", value: "b".repeat(64) }, artifact: { mirror_url: "https://x/b" } },
      ],
    };
    assert.throws(() => resolvePin(data, "dup@1.0.0"), /DIFFERENT digests/);
  });

  // fix-cycle-1 (F5). The QG executed this: duplicates with the SAME digest were tie-broken by
  // `exact[0]`, so the same pin over two index orderings returned different `mirror_url` and
  // different `tiers`. `tiers` is the entitlement axis, so order deciding it is not cosmetic.
  test("F5 — same-digest duplicates are REFUSED too, and the resolution is not order-dependent", () => {
    const one = { plugin_id: "dup", version: "1.0.0", digest: { algorithm: "sha256", value: "a".repeat(64) }, artifact: { mirror_url: "https://x/one" }, tiers: ["base"] };
    const two = { plugin_id: "dup", version: "1.0.0", digest: { algorithm: "sha256", value: "a".repeat(64) }, artifact: { mirror_url: "https://x/two" }, tiers: ["forjar"] };

    for (const entries of [[one, two], [two, one]]) {
      assert.throws(
        () => resolvePin({ entries }, "dup@1.0.0"),
        (e) => {
          assert.match(e.message, /REFUSED: 2 entries share this plugin_id@version/);
          assert.match(e.message, /entitlement axis/, "the message must say WHY same-digest duplicates still matter");
          return true;
        },
        "both orderings must refuse — before fix-cycle-1 each returned a different answer",
      );
    }
  });

  // fix-cycle-2 (F13). The F5 tightening moved the RESOLVER and left the VALIDATOR behind, so an
  // index could be green in CI and unresolvable in use. This test is the anti-drift device: it runs
  // BOTH over the same data and asserts they agree, in both directions — so a future edit that
  // loosens one without the other fails here rather than in somebody's console.
  test("F13 — CI's validator and the resolver agree about duplicates, in both directions", () => {
    const base = {
      schema_version: "2.0.0",
      plugin_id: "dup",
      lineage_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      name: "dup",
      description: "d",
      version: "1.0.0",
      digest: { algorithm: "sha256", value: "a".repeat(64) },
      artifact: {
        mirror_url: `https://${GOOD_HOST}/plugins/dup/1.0.0/x.tar.gz`,
        r2_key: "plugins/dup/1.0.0/x.tar.gz",
      },
      publisher: { subject: "acct_test" },
      published_at: "2026-08-10T00:00:00.000Z",
      license: { spdx_or_path: "MIT" },
    };
    // Same digest, differing only in `tiers` — the exact construction the QG executed.
    const dupData = { schema_version: "2.0.0", entries: [{ ...base, tiers: ["base"] }, { ...base, tiers: ["forjar"] }] };

    const validatorErrors = validateIndexData(dupData, "fixture");
    assert.ok(
      validatorErrors.some((e) => /duplicate dup@1\.0\.0/.test(e)),
      "the validator must refuse what the resolver refuses (it returned 0 violations before fix-cycle-2)",
    );
    assert.throws(() => resolvePin(dupData, "dup@1.0.0"), /REFUSED: 2 entries share this plugin_id@version/);

    // ...and both accept the single-entry version, so the agreement is not "both refuse everything".
    const okData = { schema_version: "2.0.0", entries: [{ ...base, tiers: ["base"] }] };
    assert.deepEqual(validateIndexData(okData, "fixture"), []);
    assert.equal(resolvePin(okData, "dup@1.0.0").digest.value, "a".repeat(64));
  });

  // fix-cycle-1 (F6). A missing `digest.algorithm` used to resolve as sha256 by assumption.
  test("F6 — an entry with no digest.algorithm is REFUSED, not assumed to be sha256", () => {
    const data = {
      entries: [{ plugin_id: "noalg", version: "1.0.0", digest: { value: "a".repeat(64) }, artifact: { mirror_url: "https://x/a" } }],
    };
    assert.throws(() => resolvePin(data, "noalg@1.0.0"), /no digest\.algorithm/);
    // ...and the well-formed entry right next to it still resolves, so this is not a blanket refusal.
    assert.equal(resolvePinFromFile(fixturesIndex, "sinkra-os@0.0.0-fixture").digest.algorithm, "sha256");
  });

  test("an unresolvable pin says WHAT IS available instead of just failing", () => {
    const data = JSON.parse(readFileSync(fixturesIndex, "utf8"));
    assert.throws(() => resolvePin(data, "nope@1.0.0"), /Known plugin_ids: .*sinkra-os/);
    assert.throws(() => resolvePin(data, "sinkra-os@9.9.9"), /Published versions: 0\.0\.0-fixture/);
  });
});

describe("AC5 — the plugin channel is separate from the binary channel, proven in BOTH directions", () => {
  // The mechanism behind both directions is the same fact stated twice: `resolvePin` is a pure
  // function of (index, pin). A function that cannot observe binary-channel state cannot be
  // perturbed by it, and a binary update that cannot observe the index cannot be perturbed by a
  // re-pin. Each direction is asserted separately anyway, because "obvious from the design" is
  // exactly the kind of claim that stops being true after one edit.

  test("direction 1 — a PLUGIN can be re-pinned and updated while binary-channel state is untouched", () => {
    withTempDir((dir) => {
      const { target, ledger } = emptyIndexAndLedger(dir);
      const lineage = "11111111-1111-4111-8111-111111111111";

      publish({ dir, target, ledger, plugin_id: "pinme", lineage_id: lineage, version: "1.0.0", artifact: buildTarball({ LICENSE: "MIT\n", "SKILL.md": fixtureSkill("v1") }) });
      const v1 = resolvePinFromFile(target, "pinme@1.0.0");

      publish({ dir, target, ledger, plugin_id: "pinme", lineage_id: lineage, version: "1.1.0", artifact: buildTarball({ LICENSE: "MIT\n", "SKILL.md": fixtureSkill("v2") }) });
      const v2 = resolvePinFromFile(target, "pinme@1.1.0");

      assert.notEqual(v1.digest.value, v2.digest.value, "a new version is new bytes");
      // The old pin keeps resolving to the OLD digest — that is the pin working, and it is also
      // exactly the cost AC6 documents.
      assert.equal(resolvePinFromFile(target, "pinme@1.0.0").digest.value, v1.digest.value);

      // Nothing in the publish + re-pin path created or touched a binary-channel artifact.
      for (const id of [".aiox-core-build", "RELEASES"]) {
        assert.equal(existsSync(join(dir, id)), false, `the plugin cycle must not create ${id}`);
      }
    });
  });

  test("direction 2 — the BINARY channel can change underneath and the plugin pin resolves identically", () => {
    withTempDir((dir) => {
      const marker = join(dir, ".aiox-core-build");
      const data = JSON.parse(readFileSync(fixturesIndex, "utf8"));
      const baseline = JSON.stringify(resolvePin(data, "aiox-enterprise@0.0.0-fixture"));

      // The binary's provisioning marker moves through three distinct states — absent, one build,
      // a different build — with the plugin pin resolved at each. A resolver that read binary state
      // would change its answer here.
      for (const content of ["sha+build-a=1111", "sha+build-b=2222"]) {
        writeFileSync(marker, content);
        assert.equal(JSON.stringify(resolvePin(data, "aiox-enterprise@0.0.0-fixture")), baseline);
      }
      unlinkSync(marker);
      assert.equal(JSON.stringify(resolvePin(data, "aiox-enterprise@0.0.0-fixture")), baseline);

      // Same for anything the binary channel could plausibly export into the environment.
      const saved = { ...process.env };
      try {
        for (const v of ["stable", "canary", ""]) {
          process.env.AIOX_UPDATE_CHANNEL = v;
          process.env.AIOX_CORE_BUILD = `build-${v}`;
          assert.equal(JSON.stringify(resolvePin(data, "aiox-enterprise@0.0.0-fixture")), baseline);
        }
      } finally {
        delete process.env.AIOX_UPDATE_CHANNEL;
        delete process.env.AIOX_CORE_BUILD;
        Object.assign(process.env, saved);
      }
    });
  });

  test("the channel-separation guard runs over the whole repo and passes", () => {
    const out = execFileSync("node", [channelGuard], { stdio: "pipe" }).toString();
    assert.match(out, /OK — no executable file in this repository reads binary-channel state/);
    assert.match(out, /\.aiox-core-build/, "the guard must name what it checked, not just say OK");
  });

  // fix-cycle-1 (F4). The QG defeated the guard with one character: the exemption was line-prefix
  // textual, so a real read hidden behind a leading `/*` passed while the identical read on an
  // ordinary line was caught. The guard now blanks comment CONTENT and searches the code that is
  // left. Both halves are pinned here — the evasion must fail, and a genuine doc-comment mention
  // must still be exempt, because a fix that flagged every comment would just be a different bug.
  test("F4 — a coupling hidden behind a block-comment opener is CAUGHT (it used to pass)", () => {
    const planted = join(repoRoot, "scripts", "__channel-comment-evasion-fixture.mjs");
    try {
      writeFileSync(
        planted,
        '/* probe */ import { readFileSync } from "node:fs"; const s = readFileSync(".aiox-core-build", "utf8");\nexport default s;\n',
      );
      let stderr = "";
      try {
        execFileSync("node", [channelGuard], { stdio: "pipe" });
        assert.fail("expected the guard to REFUSE — this is the evasion that used to exit 0");
      } catch (e) {
        stderr = String(e.stderr ?? "");
      }
      assert.match(stderr, /__channel-comment-evasion-fixture\.mjs/);
      assert.match(stderr, /\[\.aiox-core-build\]/);
    } finally {
      if (existsSync(planted)) unlinkSync(planted);
    }
  });

  test("F4 — a genuine doc-comment MENTION is still exempt (the fix must not flag prose)", () => {
    const planted = join(repoRoot, "scripts", "__channel-comment-mention-fixture.mjs");
    try {
      writeFileSync(
        planted,
        '// This module is deliberately independent of .aiox-core-build and of velopack.\n/* Nor does it read RELEASES. */\nexport default 1;\n',
      );
      const out = execFileSync("node", [channelGuard], { stdio: "pipe" }).toString();
      assert.match(out, /OK — no executable file/);
    } finally {
      if (existsSync(planted)) unlinkSync(planted);
    }
  });

  // fix-cycle-2 (F12) — a regression the F4 fix itself introduced, and the reason it is fixed rather
  // than merely documented: the F4 comment CLAIMED regex confusion could only ever over-report, and
  // this construction proved that false. Under the pre-F4 line-prefix logic it was caught; under the
  // first blanker it passed. Both the regex recognition and the unterminated-block fallback are
  // exercised by this one fixture.
  test("F12 — a regex literal containing `/*` no longer hides the coupling on the next line", () => {
    const planted = join(repoRoot, "scripts", "__channel-regex-evasion-fixture.mjs");
    try {
      writeFileSync(
        planted,
        'const re = /[/*]/;\nconst s = readFileSync(".aiox-core-build", "utf8");\nexport default [re, s];\n',
      );
      let stderr = "";
      try {
        execFileSync("node", [channelGuard], { stdio: "pipe" });
        assert.fail("expected the guard to REFUSE — this construction passed after the F4 fix");
      } catch (e) {
        stderr = String(e.stderr ?? "");
      }
      assert.match(stderr, /__channel-regex-evasion-fixture\.mjs/);
      assert.match(stderr, /\[\.aiox-core-build\]/);
    } finally {
      if (existsSync(planted)) unlinkSync(planted);
    }
  });

  test("F12 — a regex literal is NOT mistaken for a comment either (no false positive from the fix)", () => {
    // The opposite failure: a fix that flagged every file containing a regex would also "close" F12.
    const planted = join(repoRoot, "scripts", "__channel-regex-benign-fixture.mjs");
    try {
      writeFileSync(planted, 'const re = /[/*]/;\nconst ok = re.test("x");\nexport default ok;\n');
      assert.match(execFileSync("node", [channelGuard], { stdio: "pipe" }).toString(), /OK — no executable file/);
    } finally {
      if (existsSync(planted)) unlinkSync(planted);
    }
  });

  test("F4 — a `//` inside a STRING does not blank the rest of the line (the dangerous direction)", () => {
    // A naive comment stripper treats the `//` in a URL as a comment opener and blanks everything
    // after it — which would hide a real coupling written later on the same line. This fixture
    // fails in that implementation and passes in this one.
    const planted = join(repoRoot, "scripts", "__channel-url-then-coupling-fixture.mjs");
    try {
      writeFileSync(
        planted,
        'const u = "https://example.invalid/x"; const s = readFileSync(".aiox-core-build");\nexport default [u, s];\n',
      );
      assert.throws(() => execFileSync("node", [channelGuard], { stdio: "pipe" }), /Command failed/);
    } finally {
      if (existsSync(planted)) unlinkSync(planted);
    }
  });

  test("the guard is not decorative: introducing a coupling makes it FAIL", () => {
    // The negative fixture for the guard itself. Written into the repo's own scanned surface,
    // executed, then removed in `finally` — the guard has to be shown catching something, or its
    // green run above proves only that it ran.
    const planted = join(repoRoot, "scripts", "__channel-coupling-fixture.mjs");
    try {
      writeFileSync(planted, 'const marker = ".aiox-core-build";\nexport default marker;\n');
      assert.throws(() => execFileSync("node", [channelGuard], { stdio: "pipe" }), /Command failed/);
    } finally {
      if (existsSync(planted)) unlinkSync(planted);
    }
    // ...and it goes back to green once the coupling is gone.
    assert.match(execFileSync("node", [channelGuard], { stdio: "pipe" }).toString(), /OK —/);
  });

  test("the channel metadata names what identifies a plugin install, and it is not a binary concept", () => {
    assert.equal(CHANNEL.name, "plugin");
    assert.match(CHANNEL.what_identifies_an_install, /version \+ tier \+ digest/);
    assert.match(CHANNEL.resolved_from, /index/);
    assert.ok(CHANNEL.binary_channel_identifiers.includes(".aiox-core-build"));
    assert.ok(CHANNEL.binary_channel_identifiers.includes("ADR-COCKPIT-UPDATE-CHANNELS"));
  });
});

describe("AC6 — the pin's COST travels with the resolution, in every output mode", () => {
  test("the resolution object carries the cost, the fix, and the non-claim", () => {
    const r = resolvePinFromFile(fixturesIndex, "sinkra-os@0.0.0-fixture");
    assert.ok(r.pin_cost, "a resolution without its cost is the 'pure gain' framing C4 measured");
    assert.match(r.pin_cost.cost, /PREVENTS AN ALREADY-INSTALLED ARTIFACT FROM BEING REPAIRED/);
    assert.match(r.pin_cost.what_gives_the_capability_back, /055\.W5\.1/);
    assert.equal(r.pin_cost, PIN_COST);
  });

  test("VC-3 — nothing here claims revocation exists", () => {
    const rendered = renderResolution(resolvePinFromFile(fixturesIndex, "sinkra-os@0.0.0-fixture"));
    assert.match(PIN_COST.not_a_revocation_claim, /NOT the same as revocation/);
    assert.match(PIN_COST.not_a_revocation_claim, /O5|055\.W1\.3/);
    // The rendered text says "repair", never "revoke".
    assert.match(rendered, /repair/i);
    assert.doesNotMatch(rendered, /\brevoked\b|\brevoking\b/i);
  });

  test("the CLI prints the cost too — a human path that shows only the benefit is the failure mode", () => {
    const out = execFileSync("node", [resolveCli, "--index", fixturesIndex, "--pin", "sinkra-os@0.0.0-fixture"], { stdio: "pipe" }).toString();
    assert.match(out, /WHAT PINNING COSTS/);
    assert.match(out, /055\.W5\.1/);
    assert.match(out, new RegExp(W31_MIRRORED_DIGEST));
  });

  test("the CLI verifies real bytes against the pin and refuses a mismatch", () => {
    withTempDir((dir) => {
      const wrong = join(dir, "wrong.tar.gz");
      writeFileSync(wrong, "not the mirrored artifact");
      assert.throws(
        () => execFileSync("node", [resolveCli, "--index", fixturesIndex, "--pin", "sinkra-os@0.0.0-fixture", "--verify", wrong], { stdio: "pipe" }),
        /Command failed/,
      );
    });
  });
});
