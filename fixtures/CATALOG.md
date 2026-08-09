# Catalog — rendered from `fixtures/index.json`

_3 entries, generated_at: 2026-08-09T15:56:04.279Z_

## AIOX Enterprise (fixture) — `aiox-enterprise`@0.0.0-fixture

FIXTURE ENTRY (055.W3.1 pipeline proof) — plugin #0 per D15. Not a real production package.

- Tiers: enterprise
- Digest: `sha256:9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a`
- Artifact: https://pub-42179e62dc3040138151ec33229dd073.r2.dev/plugins-fixtures/aiox-enterprise/0.0.0-fixture/9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a.tar.gz
- Published by: `acct\_fixture\_devops\_055w31` at 2026-08-09T15:56:00.930Z
- License: MIT

## SINKRA OS (fixture) — `sinkra-os`@0.0.0-fixture

FIXTURE ENTRY (055.W3.1 pipeline proof) — plugin #1 per D15. Not the real sinkra-os bundle (that ships via npm from sinkra-hub).

- Tiers: mapear, forjar
- Digest: `sha256:9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a`
- Artifact: https://pub-42179e62dc3040138151ec33229dd073.r2.dev/plugins-fixtures/sinkra-os/0.0.0-fixture/9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a.tar.gz
- Published by: `acct\_fixture\_devops\_055w31` at 2026-08-09T15:56:02.636Z
- License: MIT

> **⚠ DECLARED SHADOW** — this plugin replaces the following base skill(s). This is a
> declared, visible choice (D23), never an accident:
>
> - `review` — the Enterprise pack's own /review — declared, not accidental (D23 test case)

## Acme \*Hostile\* &lt;b&gt;Fixture&lt;/b&gt; ⏎ # FAKE HEADING — `acme-hostile-fixture`@0.0.0-fixture

Proves render-catalog.mjs sanitizes manifest-controlled text (fix-cycle-1, F-CR-PLUGINS-5). Contains: &lt;script&gt;alert(1)&lt;/script&gt;, a fake heading attempt, and a table-breaking pipe: \| x \| y \|

- Tiers: base\`; DROP
- Digest: `sha256:9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a`
- Artifact: https://pub-42179e62dc3040138151ec33229dd073.r2.dev/plugins-fixtures/acme-hostile-fixture/0.0.0-fixture/9ec01ff45d2966fde7de79e46b31fa97a9485f28e2b625fdfe0af0aaa433561a.tar.gz
- Published by: `acct\_&lt;script&gt;alert(1)&lt;/script&gt;\_hostile` at 2026-08-09T15:56:04.278Z
- License: MIT\` \`injected &lt;img src=x onerror=alert(1)&gt;

> **⚠ DECLARED SHADOW** — this plugin replaces the following base skill(s). This is a
> declared, visible choice (D23), never an accident:
>
> - `review` — Hostile reason: \`code\`, &lt;img src=x onerror=alert(1)&gt;, a \] ( markdown-link-break ) attempt, and a ⏎ newline that tries to start a new blockquote line
