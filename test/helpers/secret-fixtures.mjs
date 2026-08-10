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

import { buildTarball, FIXTURE_SKILL } from "./tarball.mjs";

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
