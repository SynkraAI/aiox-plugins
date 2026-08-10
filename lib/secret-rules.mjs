// lib/secret-rules.mjs — the DETECTION CORPUS for story 055.W4.1 (D20(1)).
//
// ── WHERE THESE RULES COME FROM (VC-1: REUSE before writing a scanner) ────────────────────────────
//
// Every rule below is a VERBATIM REUSE of a rule from **gitleaks** — `config/gitleaks.toml` on the
// `master` branch (222 rules; the file is auto-generated from `cmd/generate/config/`), fetched
// 2026-08-09. Latest release at the time of vendoring: **v8.30.1**; the config declares
// `minVersion = "v8.25.0"`. gitleaks is MIT-licensed (Copyright (c) 2019 Zachary Rice) — the same
// permissive terms this repository ships under, so vendoring the corpus with attribution is
// license-clean. Nothing here was invented: the `id`, `description`, `entropy` threshold, `keywords`
// prefilter and the regex body are the upstream values.
//
// WHY VENDORED AND NOT DEPENDED ON — the trade-off, recorded rather than assumed:
//
//   1. `secretlint` (or any npm scanner) would introduce the FIRST `package.json`/`node_modules`
//      into this repository. Today every script here is stdlib `node:` plus shelling out to system
//      binaries (`tar`, `git`) — deliberately, so `node --test test/*.test.mjs` and
//      `publisher/publish.mjs` run on a bare checkout with zero install step. Adding an install step
//      to the PUBLISH path means the blocking gate can fail for reasons that have nothing to do with
//      the package being published (registry outage, lockfile drift, transitive advisory). A gate
//      whose most likely failure mode is unrelated to its subject gets disabled by whoever is on
//      call. REJECTED.
//
//   2. The `gitleaks` BINARY (or its GitHub Action) is the natural choice for CI — but AC1 requires
//      the gate to BLOCK inside `publisher/publish.mjs`, which runs wherever the AIOX publish
//      service runs, not only in GitHub Actions. Shelling out to a binary that may be absent leaves
//      exactly two options: fail-open (a gate that silently stops gating — the precise defect this
//      lineage already shipped once) or fail-closed on a missing binary (a publish pipeline that
//      breaks on a machine without gitleaks installed). REJECTED as the primary mechanism.
//
//   3. VENDORING THE RULESET — reuse of the DETECTION CORPUS (the part that is actually hard and
//      that a hand-rolled scanner would get worse) without a runtime dependency of any kind. The
//      engine that runs them (`lib/secret-scanner.mjs`) is ~200 lines of regex + Shannon entropy,
//      which is genuinely small; the 222 curated provider patterns are what took an ecosystem years.
//      CHOSEN.
//
// THE COST OF (3), NAMED: a vendored corpus does not update itself. New provider formats land
// upstream and never reach this file until someone re-vendors. `SECRET_RULES_PROVENANCE` below
// records exactly which upstream snapshot this is so the staleness is measurable rather than
// invisible, and `docs/SECRET-SCANNING.md` carries it as a declared limit, not a footnote.
//
// ── RE2 → JavaScript PORTING NOTES (the only edits made to upstream text) ─────────────────────────
//
// gitleaks regexes are Go RE2. Two constructs do not exist in JavaScript:
//
//   * `(?i)` inline flag → carried as `flags: "i"` on the rule instead. Semantics are identical
//     (Go applies `(?i)` to the whole pattern when it is the leading token, which it is in every
//     rule below that uses it).
//   * `(?-i:...)` (a case-SENSITIVE island inside a case-insensitive pattern) → has NO JavaScript
//     equivalent. It appears only in `generic-api-key`'s allowlist, which is why that rule is NOT
//     vendored — see `DELIBERATELY_NOT_VENDORED` at the bottom of this file.
//
// No other character of any pattern was modified. A rule whose regex could not be ported faithfully
// was left out rather than approximated: an approximated pattern is a rule whose behaviour nobody
// can predict from the upstream docs, which defeats the point of reusing an established corpus.

export const SECRET_RULES_PROVENANCE = Object.freeze({
  source: "gitleaks — https://github.com/gitleaks/gitleaks",
  file: "config/gitleaks.toml (auto-generated from cmd/generate/config/)",
  ref: "master",
  upstream_latest_release_when_vendored: "v8.30.1",
  config_min_version: "v8.25.0",
  upstream_rule_count: 222,
  vendored_at: "2026-08-09",
  license: "MIT — Copyright (c) 2019 Zachary Rice",
  vendored_by: "story 055.W4.1 (D20(1)), aiox-plugins",
});

// Each rule:
//   id          — upstream rule id, unchanged (so a finding is greppable against gitleaks' docs)
//   class       — the human-facing CLASS name this repo uses in docs + tests (AC2/AC3). Several
//                 upstream rules can map to one class (e.g. the two Cloudflare rules), which is why
//                 this field exists separately from `id`.
//   description — upstream description, unchanged
//   pattern     — upstream regex, `(?i)` lifted into `flags`
//   flags       — "" or "i"
//   entropy     — upstream Shannon-entropy floor on the captured secret (undefined = no floor)
//   keywords    — upstream case-insensitive prefilter; a rule whose keyword is absent from the text
//                 is skipped entirely (this is gitleaks' own optimisation, kept for fidelity)
//   allowMatch  — upstream `[[rules.allowlists]] regexes` with regexTarget = match
//   allowPaths  — upstream `[[rules.allowlists]] paths`
export const SECRET_RULES = Object.freeze([
  {
    id: "private-key",
    class: "private-key",
    description:
      "Identified a Private Key, which may compromise cryptographic security and sensitive data encryption.",
    pattern: "-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?KEY(?: BLOCK)?-----",
    flags: "i",
    keywords: ["-----begin"],
  },
  {
    id: "aws-access-token",
    class: "aws-access-key",
    description:
      "Identified a pattern that may indicate AWS credentials, risking unauthorized cloud resource access and data breaches on AWS platforms.",
    pattern: "\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b",
    flags: "",
    entropy: 3,
    keywords: ["a3t", "akia", "asia", "abia", "acca"],
    allowMatch: [".+EXAMPLE$"],
  },
  {
    id: "github-pat",
    class: "github-token",
    description:
      "Uncovered a GitHub Personal Access Token, potentially leading to unauthorized repository access and sensitive content exposure.",
    pattern: "ghp_[0-9a-zA-Z]{36}",
    flags: "",
    entropy: 3,
    keywords: ["ghp_"],
    allowPaths: ["(?:^|/)@octokit/auth-token/README\\.md$"],
  },
  {
    id: "github-fine-grained-pat",
    class: "github-fine-grained-token",
    description:
      "Found a GitHub Fine-Grained Personal Access Token, risking unauthorized repository access and code manipulation.",
    pattern: "github_pat_\\w{82}",
    flags: "",
    entropy: 3,
    keywords: ["github_pat_"],
  },
  {
    id: "cloudflare-api-key",
    class: "cloudflare-api-token",
    description:
      "Detected a Cloudflare API Key, potentially compromising cloud application deployments and operational security.",
    pattern:
      "[\\w.-]{0,50}?(?:cloudflare)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9_-]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    flags: "i",
    entropy: 2,
    keywords: ["cloudflare"],
  },
  {
    id: "cloudflare-global-api-key",
    class: "cloudflare-global-api-key",
    description:
      "Detected a Cloudflare Global API Key, potentially compromising cloud application deployments and operational security.",
    pattern:
      "[\\w.-]{0,50}?(?:cloudflare)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{37})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    flags: "i",
    entropy: 2,
    keywords: ["cloudflare"],
  },
  {
    id: "slack-bot-token",
    class: "slack-token",
    description:
      "Identified a Slack Bot token, which may compromise bot integrations and communication channel security.",
    pattern: "xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*",
    flags: "",
    entropy: 3,
    keywords: ["xoxb"],
  },
  {
    id: "slack-user-token",
    class: "slack-user-token",
    description:
      "Found a Slack User token, posing a risk of unauthorized user impersonation and data access within Slack workspaces.",
    pattern: "xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}",
    flags: "",
    entropy: 2,
    keywords: ["xoxp-", "xoxe-"],
  },
  {
    id: "stripe-access-token",
    class: "stripe-key",
    description:
      "Found a Stripe Access Token, posing a risk to payment processing services and sensitive financial data.",
    pattern: "\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    flags: "",
    entropy: 2,
    keywords: ["sk_test", "sk_live", "sk_prod", "rk_test", "rk_live", "rk_prod"],
  },
  {
    id: "openai-api-key",
    class: "openai-api-key",
    description:
      "Found an OpenAI API Key, posing a risk of unauthorized access to AI services and data manipulation.",
    pattern:
      "\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    flags: "",
    entropy: 3,
    keywords: ["t3blbkfj"],
  },
  {
    id: "anthropic-api-key",
    class: "anthropic-api-key",
    description:
      "Identified an Anthropic API Key, which may compromise AI assistant integrations and expose sensitive data to unauthorized access.",
    pattern: "\\b(sk-ant-api03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    flags: "",
    keywords: ["sk-ant-api03"],
  },
  {
    id: "gcp-api-key",
    class: "gcp-api-key",
    description:
      "Uncovered a GCP API key, which could lead to unauthorized access to Google Cloud services and data breaches.",
    pattern: "\\b(AIza[\\w-]{35})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    flags: "",
    entropy: 4,
    keywords: ["aiza"],
    // The upstream allowlist is a literal list of 16 well-known fake keys that circulate in docs and
    // test suites. Carried verbatim (as an alternation) so a package quoting Google's own sample key
    // is not refused.
    allowMatch: [
      "^(?:AIzaSyabcdefghijklmnopqrstuvwxyz1234567|AIzaSyAnLA7NfeLquW1tJFpx_eQCxoX-oo6YyIs|AIzaSyCkEhVjf3pduRDt6d1yKOMitrUEke8agEM|AIzaSyDMAScliyLx7F0NPDEJi1QmyCgHIAODrlU|AIzaSyD3asb-2pEZVqMkmL6M9N6nHZRR_znhrh0|AIzayDNSXIbFmlXbIE6mCzDLQAqITYefhixbX4A|AIzaSyAdOS2zB6NCsk1pCdZ4-P6GBdi_UUPwX7c|AIzaSyASWm6HmTMdYWpgMnjRBjxcQ9CKctWmLd4|AIzaSyANUvH9H9BsUccjsu2pCmEkOPjjaXeDQgY|AIzaSyA5_iVawFQ8ABuTZNUdcwERLJv_a_p4wtM|AIzaSyA4UrcGxgwQFTfaI3no3t7Lt1sjmdnP5sQ|AIzaSyDSb51JiIcB6OJpwwMicseKRhhrOq1cS7g|AIzaSyBF2RrAIm4a0mO64EShQfqfd2AFnzAvvuU|AIzaSyBcE-OOIbhjyR83gm4r2MFCu4MJmprNXsw|AIzaSyB8qGxt4ec15vitgn44duC5ucxaOi4FmqE|AIzaSyA8vmApnrHNFE0bApF4hoZ11srVL_n0nvY)$",
    ],
  },
  {
    id: "npm-access-token",
    class: "npm-token",
    description:
      "Uncovered an npm access token, potentially compromising package management and code repository access.",
    pattern: "\\b(npm_[a-z0-9]{36})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    flags: "i",
    entropy: 2,
    keywords: ["npm_"],
  },
  {
    id: "jwt",
    class: "jwt",
    description:
      "Uncovered a JSON Web Token, which may lead to unauthorized access to web applications and sensitive user data.",
    pattern:
      "\\b(ey[a-zA-Z0-9]{17,}\\.ey[a-zA-Z0-9\\/\\\\_-]{17,}\\.(?:[a-zA-Z0-9\\/\\\\_-]{10,}={0,2})?)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
    flags: "",
    entropy: 3,
    keywords: ["ey"],
  },
]);

// The 14 rules above collapse to this many distinct CLASSES. Exported (rather than recomputed at
// each call site) because AC2's contract is per-CLASS: every entry here must have a negative fixture
// that is REFUSED through the real CLI, and `test/publish-cli.test.mjs` iterates this exact list —
// so adding a rule without adding its fixture makes the test suite fail on the missing fixture
// rather than silently shipping an unproven class.
export const SECRET_CLASSES = Object.freeze([...new Set(SECRET_RULES.map((r) => r.class))].sort());

// ── DELIBERATELY NOT VENDORED, and why ───────────────────────────────────────────────────────────
//
// This list is part of the deliverable, not an apology. AC3's whole point is that the boundary of a
// control is as load-bearing as its coverage, and an omission nobody wrote down becomes, six weeks
// later, a coverage claim nobody can check.
export const DELIBERATELY_NOT_VENDORED = Object.freeze([
  {
    id: "generic-api-key",
    reason:
      "gitleaks' catch-all for unknown providers (any `key`/`token`/`secret`-ish assignment whose value clears entropy 3.5). Its usability depends entirely on a large allowlist that uses Go RE2's `(?-i:...)` case-sensitive island, which has no JavaScript equivalent — porting the rule WITHOUT its allowlist inverts the cost of a mistake from 'a secret slips through' to 'a legitimate publish is refused because a skill wrote `api_version: 2026-08-09`'. A blocking gate that cries wolf is a gate that gets bypassed. Consequence, stated plainly: a credential from a provider not in the vendored list, or one with no recognisable prefix, is NOT detected here.",
  },
  {
    id: "(the other ~208 upstream rules)",
    reason:
      "The vendored subset covers the providers this catalog's threat model actually touches (cloud + git forge + package registry + payment + AI + the org's own Cloudflare/R2 infra) plus the format-recognisable generics (PEM private keys, JWTs). Vendoring all 222 would multiply the per-class negative-fixture obligation of AC2 by ~16 without adding a class this catalog is plausibly exposed to — and an unproven rule is exactly the 'gate that passes verde using a tool blind to the defect' failure this lineage already shipped once. Re-vendoring more is a small, mechanical change: add the rule here, add its fixture, the test suite enforces the pairing.",
  },
]);
