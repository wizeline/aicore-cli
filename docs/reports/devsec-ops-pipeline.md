# DevSecOps Pipeline Hardening Report — aicore-cli

**Project:** aicore-cli (npm: aicores, skills, subagents)
**Stack:** TypeScript/Node.js (ESM), pnpm, esbuild, vitest, GitHub Actions
**Repo:** github.com/wizeline/agents-skills
**Report Date:** 2026-03-18
**Maturity Baseline:** Level 1 (ad hoc) — targeting Level 2 (Verified Supply Chain)

---

## 1. Executive Summary

### Current Security Gaps

| Gap | Category | Risk Level |
|-----|----------|------------|
| No SAST scanning | CICD-SEC-4, A05 Injection | Critical |
| No secret scanning in CI or pre-commit | CICD-SEC-6 | Critical |
| Node 18 EOL (since April 2025) | EOL/Deprecated | High |
| `spawn(..., {shell: true})` with external URL data | A05 Command Injection (CWE-78) | High |
| `response.text()` without size limits | A10 Exceptional Conditions (CWE-400) | High |
| `sanitizeSubpath()` missing percent-decode | A01 Path Traversal (CWE-22) | High |
| `execSync('gh auth token')` without full path | A05 PATH Hijack (CWE-426) | High |
| `experimental_sync` crawls node_modules | CICD-SEC-3 Supply Chain | Medium |
| No SCA beyond frozen lockfile | CICD-SEC-3 | Medium |
| No SBOM generated or published | CICD-SEC-9 | Medium |
| Husky installed but no security hooks | CICD-SEC-6 | Medium |
| No branch protection enforcement on security checks | CICD-SEC-1 | Medium |
| No OpenSSF Scorecard | Metrics | Low |

### Risk Posture

The project ships a CLI tool that is executed with full user permissions on developer machines. An npm supply chain compromise (CICD-SEC-3) or a malicious package update targeting `simple-git`, `gray-matter`, or `@clack/prompts` has direct code execution impact on every consumer. The command injection and path traversal findings in source code are pre-conditions for privilege escalation if a compromised dependency passes tainted data to these sinks.

**Estimated OpenSSF Scorecard (current):** 3–4 / 10

Positive signals already present: `pnpm install --frozen-lockfile` (CICD-SEC-3 partial), `npm publish --provenance` (SLSA provenance already in place for published artifacts). These are Level 2 starting points.

### Prioritised Remediation Plan

1. **Week 1 — Stop the bleeding:** Add secret scanning (Gitleaks pre-commit + CI) and `pnpm audit --audit-level=high` gate.
2. **Week 2 — SAST baseline:** Enable CodeQL in warn mode; triage findings before blocking.
3. **Week 3 — Block on findings:** Flip SAST gate to hard-fail after baseline review; add dependency-review gate on PRs.
4. **Week 4 — Supply chain:** Add SBOM generation to publish workflow; add OWASP Dependency-Check scheduled scan.
5. **Month 2 — EOL + metrics:** Node 20 migration, OpenSSF Scorecard, Dependabot.

---

## 2. SAST — Static Application Security Testing

### Tool Selection Rationale

**CodeQL** (GitHub-native, zero infrastructure cost) is the correct choice for a TypeScript/Node.js project on GitHub with no AppSec team. It runs as a GitHub Actions job, posts findings as PR annotations, and gates merges through required status checks. The `security-extended` query suite covers OWASP Top 10 including the specific CWEs identified in this codebase.

**Custom CodeQL queries** are added for the two patterns not covered by the built-in suite: `spawn({shell:true})` with non-literal arguments, and `fetch()` / `response.text()` without a body size guard.

**Scan time:** CodeQL on this codebase will complete in 3–6 minutes. It runs in parallel with the SCA job on PRs.

**Scope limits:** CodeQL will not catch runtime PATH hijacks caused by environment variables at execution time, only statically traceable patterns. The `execSync('gh auth token')` finding requires a manual code fix regardless of scanner output.

**False positive rate:** The `security-extended` suite has a low FP rate for TypeScript. Expect 2–5 FPs on first run, primarily around the `gray-matter` YAML parsing. Use `// lgtm[js/code-injection]` suppression comments only after documented review.

### `.github/codeql/js-security-queries.ql` — Custom query: shell:true with tainted argument

```ql
/**
 * @name Shell injection via spawn with shell:true
 * @description Detects child_process.spawn calls where shell option is true
 *              and the command argument originates from an external source.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 9.0
 * @precision high
 * @id js/spawn-shell-injection
 * @tags security
 *       external/cwe/cwe-078
 */

import javascript
import DataFlow::PathGraph

class SpawnShellTrueCall extends DataFlow::CallNode {
  SpawnShellTrueCall() {
    this = DataFlow::moduleImport("child_process").getAMemberCall("spawn") and
    exists(DataFlow::ObjectLiteralNode opts |
      opts.flowsTo(this.getArgument(2)) and
      opts.hasPropertyWrite("shell",
        DataFlow::globalVarRef("true").getALocalSource()
      )
    )
  }
  DataFlow::Node getCommandArg() { result = this.getArgument(0) }
}

class SpawnShellConfig extends TaintTracking::Configuration {
  SpawnShellConfig() { this = "SpawnShellTrueWithExternalInput" }
  override predicate isSource(DataFlow::Node source) {
    source instanceof RemoteFlowSource
  }
  override predicate isSink(DataFlow::Node sink) {
    exists(SpawnShellTrueCall call | sink = call.getCommandArg())
  }
}

from SpawnShellConfig cfg, DataFlow::PathNode source, DataFlow::PathNode sink
where cfg.hasFlowPath(source, sink)
select sink.getNode(), source, sink,
  "External data reaches spawn() with shell:true — potential command injection."
```

### `.github/codeql/js-fetch-size.ql` — Custom query: unbounded fetch response body

```ql
/**
 * @name Unbounded HTTP response body read
 * @description response.text() and response.json() without a Content-Length
 *              guard allow a server to exhaust process memory.
 * @kind problem
 * @problem.severity warning
 * @security-severity 5.0
 * @precision medium
 * @id js/unbounded-fetch-body
 * @tags security
 *       external/cwe/cwe-400
 */

import javascript

from CallExpr call, MemberExpr mem
where
  mem = call.getCallee() and
  mem.getPropertyName() in ["text", "json", "arrayBuffer", "blob"] and
  not exists(CallExpr guard |
    guard.getCallee().(MemberExpr).getPropertyName() = "headers" and
    guard.getParent*() = call.getEnclosingFunction()
  )
select call,
  "HTTP response body read without Content-Length guard — potential DoS (CWE-400)."
```

### `.github/workflows/security.yml` — SAST excerpt

This is an excerpt; the complete integrated workflow appears in Section 7.

```yaml
  codeql:
    name: SAST / CodeQL
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      security-events: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
          queries: security-extended
          config-file: .github/codeql/codeql-config.yml

      - name: Autobuild
        uses: github/codeql-action/autobuild@v3

      - name: Analyze
        uses: github/codeql-action/analyze@v3
        with:
          category: /language:javascript-typescript
          upload: true
          output: codeql-results
          # Hard-fail on Critical; High findings are uploaded but do not
          # block here — the security-gate summary job enforces the policy.
```

### `.github/codeql/codeql-config.yml`

```yaml
name: aicore-cli CodeQL config
queries:
  - uses: security-extended
  - uses: ./.github/codeql/js-security-queries.ql
  - uses: ./.github/codeql/js-fetch-size.ql
paths-ignore:
  - node_modules
  - dist
  - "**/*.test.ts"
  - "**/*.spec.ts"
```

### Failure Thresholds

| Severity | Gate Behaviour |
|----------|----------------|
| Critical | Hard fail — merge blocked |
| High | Hard fail — merge blocked (after week-3 cutover; warn-only in weeks 1–2) |
| Medium | Uploaded to Security tab, does not block merge |
| Low / Note | Uploaded, no notification |

The phased rollout (warn first, then block) is intentional. Blocking on day 1 with untriaged results will cause developers to suppress annotations without review. Triage the first run together before enabling the hard block.

---

## 3. SCA — Software Composition Analysis

### Tool Selection Rationale

Three complementary tools are used at different points:

- **`pnpm audit --audit-level=high`** runs on every push/PR (fast, <30s). It catches known CVEs in the resolved dependency tree immediately.
- **`actions/dependency-review-action@v4`** runs on every PR and compares the dependency diff — it flags newly introduced vulnerable or license-incompatible packages before they land in main.
- **OWASP Dependency-Check** runs on a weekly schedule. It uses the NVD data feed and catches CVEs not yet surfaced in the npm advisory database, and performs CPE matching on transitive dependencies.

### Complete SCA Workflow Excerpt

```yaml
  sca:
    name: SCA / Dependency Audit
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: pnpm audit
        # --audit-level=high: exit non-zero on High or Critical CVEs only.
        # Moderate and Low are reported but do not block.
        run: pnpm audit --audit-level=high
        continue-on-error: false

      - name: Upload audit results
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: pnpm-audit-results
          path: pnpm-audit.json
          retention-days: 30

  dependency-review:
    name: SCA / Dependency Review (PR only)
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Dependency Review
        uses: actions/dependency-review-action@v4
        with:
          # Block merge if any newly introduced dependency has a High or Critical CVE.
          fail-on-severity: high
          # Allow-list for license types acceptable to this project.
          allow-licenses: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD
          # Deny GPL-2.0 and GPL-3.0 — incompatible with npm publish.
          deny-licenses: GPL-2.0, GPL-3.0, AGPL-3.0
          comment-summary-in-pr: always
```

### OWASP Dependency-Check (Scheduled)

```yaml
  owasp-dependency-check:
    name: SCA / OWASP Dependency-Check (scheduled)
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    permissions:
      contents: read
      security-events: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run OWASP Dependency-Check
        uses: dependency-check/Dependency-Check_Action@main
        id: depcheck
        with:
          project: "aicore-cli"
          path: "."
          format: "SARIF"
          out: "dependency-check-results"
          # CVSS score 7.0+ corresponds to High severity threshold.
          args: >
            --failOnCVSS 7
            --enableRetired
            --nodeAuditSkipDevDependencies
            --exclude "**/node_modules/.cache/**"
            --nvdApiKey ${{ secrets.NVD_API_KEY }}

      - name: Upload SARIF to GitHub Security tab
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: dependency-check-results/dependency-check-report.sarif

      - name: Upload full report artifact
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: owasp-dependency-check-report
          path: dependency-check-results/
          retention-days: 90
```

**Note on `NVD_API_KEY`:** Register for a free NVD API key at https://nvd.nist.gov/developers/request-an-api-key and store it as a repository secret. Without it the NVD feed downloads will be heavily rate-limited and the job will time out.

**Scan time:** `pnpm audit` completes in 20–30 seconds. `dependency-review-action` takes 45–90 seconds on PRs. OWASP Dependency-Check takes 3–8 minutes depending on NVD cache warmth.

---

## 4. EOL / Deprecated Library Detection

### Node 18 EOL

Node 18 reached End-of-Life on **30 April 2025**. The current `engines` field `"node": ">=18"` is accepting an EOL runtime. Any CVE discovered in Node 18 after that date will not receive a patch. The fix is a one-line change in `package.json` (`">=20"`) and updating the CI matrix — but the gate below will flag it continuously until resolved.

### Complete EOL Detection Workflow

```yaml
  eol-check:
    name: EOL / Deprecated Library Detection
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # ----------------------------------------------------------------
      # 4a. Enforce Node.js minimum version >= 20 (Node 18 is EOL)
      # ----------------------------------------------------------------
      - name: Check Node.js engines field
        id: node-eol
        run: |
          ENGINES=$(node -e "const p=require('./package.json'); console.log(p.engines?.node || 'not set')")
          echo "engines_node=$ENGINES" >> "$GITHUB_OUTPUT"

          # Fail if the engines field still permits Node 18 (EOL since 2025-04-30).
          if echo "$ENGINES" | grep -E ">=18|^18" > /dev/null 2>&1; then
            echo "::error file=package.json::Node 18 is EOL since 2025-04-30. Update engines.node to '>=20' in package.json."
            exit 1
          fi

          echo "Node.js engines field OK: $ENGINES"

      # ----------------------------------------------------------------
      # 4b. Detect deprecated packages using npm outdated + npm info
      # ----------------------------------------------------------------
      - name: Detect deprecated packages
        id: deprecated
        run: |
          set +e  # Allow individual failures without stopping the step

          DEPRECATED_FOUND=0
          DEPRECATED_LIST=""

          # Extract all production + dev dependency names from package.json
          DEPS=$(node -e "
            const p = require('./package.json');
            const all = [
              ...Object.keys(p.dependencies || {}),
              ...Object.keys(p.devDependencies || {})
            ];
            console.log(all.join(' '));
          ")

          for pkg in $DEPS; do
            DEPRECATION=$(npm info "$pkg" deprecated 2>/dev/null)
            if [ -n "$DEPRECATION" ]; then
              echo "::warning::DEPRECATED: $pkg — $DEPRECATION"
              DEPRECATED_LIST="$DEPRECATED_LIST\n- $pkg: $DEPRECATION"
              DEPRECATED_FOUND=1
            fi
          done

          if [ "$DEPRECATED_FOUND" -eq 1 ]; then
            echo "deprecated=true" >> "$GITHUB_OUTPUT"
            printf "Deprecated packages found:%b\n" "$DEPRECATED_LIST"
            # Warn only — deprecated packages do not block merge by themselves.
            # They are surfaced in the security-gate summary.
          else
            echo "deprecated=false" >> "$GITHUB_OUTPUT"
            echo "No deprecated packages found."
          fi

      # ----------------------------------------------------------------
      # 4c. Report outdated packages (informational, never blocks)
      # ----------------------------------------------------------------
      - name: Report outdated packages
        run: |
          echo "=== Outdated packages (informational) ==="
          # pnpm outdated returns exit code 1 when outdated packages exist.
          # We capture output but do not fail the step.
          pnpm outdated --format json > outdated.json 2>&1 || true
          if [ -s outdated.json ]; then
            node -e "
              try {
                const data = require('./outdated.json');
                const pkgs = Object.entries(data);
                if (pkgs.length === 0) { console.log('All packages up to date.'); process.exit(0); }
                console.log('Package | Current | Latest | Wanted');
                console.log('--------|---------|--------|-------');
                pkgs.forEach(([name, info]) => {
                  console.log(name + ' | ' + info.current + ' | ' + info.latest + ' | ' + info.wanted);
                });
              } catch(e) { console.log('Could not parse outdated output.'); }
            "
          else
            echo "All packages are up to date."
          fi

      - name: Upload EOL check results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eol-check-results
          path: outdated.json
          retention-days: 14
```

**Immediate fix required — `package.json` engines field:**

Change:
```json
"engines": {"node": ">=18"}
```
To:
```json
"engines": {"node": ">=20"}
```

And update `ci.yml` matrix to replace `lts/*` with a pinned version:
```yaml
node-version: ["20", "22"]
```

---

## 5. Secret Scanning

### Tool Selection

**Gitleaks** is the correct tool here. It has native GitHub Actions support, runs in under 1 second against staged changes in pre-commit, and supports a TOML config for custom token patterns. TruffleHog is an alternative but heavier; for a CLI tool project without cloud infrastructure secrets, Gitleaks covers the surface.

### `.gitleaks.toml`

```toml
# Gitleaks configuration for aicore-cli
# Focus: npm tokens, GitHub PATs, Vercel tokens, generic high-entropy secrets.

title = "aicore-cli gitleaks config"

[extend]
# Extend the default ruleset shipped with gitleaks.
useDefault = true

[[rules]]
id          = "npm-automation-token"
description = "npm automation or publish token"
regex       = '''npm_[A-Za-z0-9]{36}'''
tags        = ["npm", "token", "secret"]

[[rules]]
id          = "github-pat-classic"
description = "GitHub Personal Access Token (classic)"
regex       = '''ghp_[A-Za-z0-9]{36}'''
tags        = ["github", "pat", "secret"]

[[rules]]
id          = "github-fine-grained-pat"
description = "GitHub Fine-Grained Personal Access Token"
regex       = '''github_pat_[A-Za-z0-9_]{82}'''
tags        = ["github", "pat", "secret"]

[[rules]]
id          = "github-oauth-token"
description = "GitHub OAuth access token"
regex       = '''gho_[A-Za-z0-9]{36}'''
tags        = ["github", "oauth", "secret"]

[[rules]]
id          = "github-app-token"
description = "GitHub App installation or user token"
regex       = '''(ghu|ghs)_[A-Za-z0-9]{36}'''
tags        = ["github", "app", "secret"]

[[rules]]
id          = "vercel-token"
description = "Vercel personal access token"
regex       = '''[vV]ercel[_\-\s]*[tT]oken[_\-\s]*[=:]\s*[A-Za-z0-9]{24}'''
tags        = ["vercel", "token", "secret"]

[[rules]]
id          = "npm-node-auth-token"
description = "NODE_AUTH_TOKEN or NPM_TOKEN environment variable value"
regex       = '''(?i)(NODE_AUTH_TOKEN|NPM_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_\-]{20,}["']?'''
tags        = ["npm", "token", "secret"]

[[rules]]
id          = "generic-api-key"
description = "Generic API key pattern — high entropy string after common key names"
regex       = '''(?i)(api[_\-]?key|secret[_\-]?key|access[_\-]?token)[_\-\s]*[=:]\s*["']?[A-Za-z0-9/+]{32,}["']?'''
entropy     = 3.5
tags        = ["generic", "api-key", "secret"]

[allowlist]
description = "Paths and patterns that are intentionally not secrets"
paths = [
  # Test fixtures
  '''^tests?/fixtures/''',
  '''^__tests__/''',
  # Lock file — hashes are not secrets
  '''pnpm-lock\.yaml''',
  # Built output — do not scan dist
  '''^dist/''',
  # This config file itself
  '''\.gitleaks\.toml''',
]
regexes = [
  # Placeholder values used in documentation and comments
  '''YOUR[_\-]?(TOKEN|KEY|SECRET)''',
  '''<(TOKEN|KEY|SECRET|API[_\-]KEY)>''',
  # npm publish --provenance produces a known-format provenance token in CI logs
  '''sigstore\.dev''',
]
```

### `.github/workflows/secret-scan.yml`

```yaml
name: Secret Scanning

on:
  push:
    branches:
      - main
      - "v*"
  pull_request:
    types: [opened, synchronize, reopened]
  schedule:
    # Full history scan weekly on Sunday at 02:00 UTC.
    - cron: "0 2 * * 0"
  workflow_dispatch:

jobs:
  gitleaks:
    name: Secret Scan / Gitleaks
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # Required to post PR annotations when findings are detected.
      pull-requests: read
      security-events: write
    steps:
      - name: Checkout — full history for scheduled scan
        uses: actions/checkout@v4
        with:
          # Fetch full history on schedule; last 50 commits on push/PR is sufficient.
          fetch-depth: ${{ github.event_name == 'schedule' && 0 || 50 }}

      - name: Run Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # If you have a Gitleaks license for the organizations report feature:
          # GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}
        with:
          args: >
            --config .gitleaks.toml
            --exit-code 1
            --report-format sarif
            --report-path gitleaks-report.sarif
            --redact
            --log-level warn

      - name: Upload SARIF to GitHub Security tab
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: gitleaks-report.sarif
          category: secret-scanning

      - name: Upload Gitleaks report artifact
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: gitleaks-report
          path: gitleaks-report.sarif
          retention-days: 30
```

### `.husky/pre-commit`

This hook runs gitleaks against only the staged changes, completing in under 1 second.

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

# ----------------------------------------------------------------------------
# Secret scanning — staged files only.
# Install: npm install -g gitleaks   OR   brew install gitleaks
# ----------------------------------------------------------------------------

if ! command -v gitleaks > /dev/null 2>&1; then
  echo "[pre-commit] gitleaks not found — skipping secret scan."
  echo "[pre-commit] Install: brew install gitleaks  OR  npm install -g gitleaks"
  exit 0
fi

echo "[pre-commit] Running secret scan on staged files..."

gitleaks protect \
  --config .gitleaks.toml \
  --staged \
  --redact \
  --exit-code 1

STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo ""
  echo "[pre-commit] BLOCKED: Potential secrets detected in staged changes."
  echo "[pre-commit] Review the output above, remove the secret, and re-stage."
  echo "[pre-commit] If this is a false positive, add the pattern to .gitleaks.toml allowlist."
  exit 1
fi

echo "[pre-commit] Secret scan passed."
exit 0
```

**Important:** After creating this file, make it executable:
```bash
chmod +x .husky/pre-commit
```

---

## 6. SBOM Generation and SLSA Provenance

### Current State

`npm publish --provenance` already generates a Sigstore-backed provenance attestation and attaches it to the npm package entry. This satisfies the SLSA Build Level 2 requirement for **provenance** on the published npm artifact. This is a meaningful head start.

What is missing:
- No SBOM (CycloneDX or SPDX) is generated or attached to GitHub Releases.
- The SLSA generator workflow is not configured, so the attestation is limited to what npm's built-in provenance provides.
- No SBOM is available for consumers to perform their own dependency analysis.

### SBOM + SLSA Workflow

```yaml
  sbom:
    name: SBOM / Generate and Attest
    runs-on: ubuntu-latest
    # Run on main pushes and releases; not on every PR (expensive, unnecessary).
    if: |
      github.event_name == 'push' && github.ref == 'refs/heads/main' ||
      github.event_name == 'release' ||
      github.event_name == 'workflow_dispatch'
    permissions:
      contents: write
      id-token: write   # Required for Sigstore signing via OIDC
      packages: write
      attestations: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      # ----------------------------------------------------------------
      # Generate CycloneDX SBOM (preferred for tooling ecosystem support)
      # ----------------------------------------------------------------
      - name: Generate CycloneDX SBOM
        uses: anchore/sbom-action@v0.17.9
        with:
          path: .
          artifact-name: aicore-cli-sbom-cyclonedx.json
          format: cyclonedx-json
          output-file: sbom-cyclonedx.json
          upload-artifact: true
          upload-release-assets: true

      # ----------------------------------------------------------------
      # Generate SPDX SBOM (required for many compliance frameworks)
      # ----------------------------------------------------------------
      - name: Generate SPDX SBOM
        uses: anchore/sbom-action@v0.17.9
        with:
          path: .
          artifact-name: aicore-cli-sbom-spdx.json
          format: spdx-json
          output-file: sbom-spdx.json
          upload-artifact: true
          upload-release-assets: true

      # ----------------------------------------------------------------
      # Attest the SBOM using GitHub's native attestation (SLSA-linked)
      # ----------------------------------------------------------------
      - name: Attest CycloneDX SBOM
        uses: actions/attest-sbom@v2
        with:
          subject-path: dist/
          sbom-path: sbom-cyclonedx.json

      # ----------------------------------------------------------------
      # Upload both SBOMs as release assets when triggered by a release.
      # anchore/sbom-action handles this via upload-release-assets: true,
      # but we also save them as workflow artifacts for audit retention.
      # ----------------------------------------------------------------
      - name: Upload SBOMs as workflow artifacts
        uses: actions/upload-artifact@v4
        with:
          name: sbom-artifacts
          path: |
            sbom-cyclonedx.json
            sbom-spdx.json
          retention-days: 365

  slsa-provenance:
    name: SLSA / Level 2 Provenance
    needs: [sbom]
    # Only runs on release tags — SLSA provenance is for published artifacts.
    if: github.event_name == 'release' || startsWith(github.ref, 'refs/tags/v')
    permissions:
      id-token: write
      contents: write
      actions: read
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.0.0
    with:
      base64-subjects: |
        ${{ needs.sbom.outputs.hashes }}
      upload-assets: true
      provenance-name: aicore-cli.intoto.jsonl
```

### Note on Existing Provenance

The `npm publish --provenance` step already produces a Sigstore-signed SLSA provenance attestation that is publicly verifiable via:

```bash
npm audit signatures aicore-cli
```

or

```bash
npx sigstore verify-npm aicore-cli@<version>
```

Adding the `slsa-github-generator` workflow provides an additional provenance document for the built `dist/` artifact files themselves — useful if consumers download the GitHub Release tarball rather than installing from npm.

---

## 7. Complete Integrated Security Workflow

This is the complete `.github/workflows/security.yml` to paste into the repository.

```yaml
name: Security Pipeline

on:
  push:
    branches:
      - main
      - "v*"
  pull_request:
    types: [opened, synchronize, reopened]
  release:
    types: [published]
  schedule:
    # Weekly full scan: Sunday 02:30 UTC
    - cron: "30 2 * * 0"
  workflow_dispatch:
    inputs:
      force-block:
        description: "Treat High findings as blocking (overrides warn mode)"
        type: boolean
        default: false

# Minimal default permissions — each job elevates only what it needs.
permissions:
  contents: read

concurrency:
  group: security-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # ============================================================
  # Stage 1: Secret Scanning (fastest — runs first, blocks all)
  # ============================================================
  secret-scan:
    name: Secret Scan / Gitleaks
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
      pull-requests: read
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: ${{ github.event_name == 'schedule' && 0 || 50 }}

      - name: Run Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          args: >
            --config .gitleaks.toml
            --exit-code 1
            --report-format sarif
            --report-path gitleaks-results.sarif
            --redact
            --log-level warn

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: gitleaks-results.sarif
          category: secret-scanning

  # ============================================================
  # Stage 2a: SAST — CodeQL (runs in parallel with SCA)
  # ============================================================
  codeql:
    name: SAST / CodeQL
    runs-on: ubuntu-latest
    needs: [secret-scan]
    permissions:
      actions: read
      contents: read
      security-events: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
          queries: security-extended
          config-file: .github/codeql/codeql-config.yml

      - name: Autobuild
        uses: github/codeql-action/autobuild@v3

      - name: Analyze
        uses: github/codeql-action/analyze@v3
        with:
          category: /language:javascript-typescript
          upload: true
          output: codeql-results

      - name: Check for Critical findings
        id: codeql-gate
        run: |
          # Parse the SARIF output and fail if any Critical-severity rule fired.
          CRITICAL_COUNT=$(node -e "
            const fs = require('fs');
            const path = require('path');
            let total = 0;
            const dir = 'codeql-results';
            if (!fs.existsSync(dir)) { console.log(0); process.exit(0); }
            fs.readdirSync(dir).filter(f => f.endsWith('.sarif')).forEach(f => {
              const sarif = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
              (sarif.runs || []).forEach(run => {
                const rules = {};
                (run.tool?.driver?.rules || []).forEach(r => {
                  rules[r.id] = r.properties?.['problem.severity'] || r.defaultConfiguration?.level;
                });
                (run.results || []).forEach(result => {
                  const level = result.level || rules[result.ruleId] || 'warning';
                  if (level === 'error') total++;
                });
              });
            });
            console.log(total);
          " 2>/dev/null || echo "0")

          echo "critical_count=$CRITICAL_COUNT" >> "$GITHUB_OUTPUT"
          echo "CodeQL Critical findings: $CRITICAL_COUNT"

          if [ "$CRITICAL_COUNT" -gt 0 ]; then
            echo "::error::CodeQL found $CRITICAL_COUNT Critical severity finding(s). Merge is blocked."
            echo "::error::Review findings in the Security tab: https://github.com/${{ github.repository }}/security/code-scanning"
            exit 1
          fi

  # ============================================================
  # Stage 2b: SCA — pnpm audit + dependency review (parallel)
  # ============================================================
  sca:
    name: SCA / pnpm Audit
    runs-on: ubuntu-latest
    needs: [secret-scan]
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: pnpm audit
        run: pnpm audit --audit-level=high

      - name: Upload audit artifact on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: pnpm-audit-results
          path: pnpm-audit.json
          retention-days: 30

  dependency-review:
    name: SCA / Dependency Review
    runs-on: ubuntu-latest
    needs: [secret-scan]
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Dependency Review
        uses: actions/dependency-review-action@v4
        with:
          fail-on-severity: high
          allow-licenses: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD
          deny-licenses: GPL-2.0, GPL-3.0, AGPL-3.0
          comment-summary-in-pr: always

  owasp-dependency-check:
    name: SCA / OWASP Dependency-Check
    runs-on: ubuntu-latest
    needs: [secret-scan]
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    permissions:
      contents: read
      security-events: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run OWASP Dependency-Check
        uses: dependency-check/Dependency-Check_Action@main
        with:
          project: "aicore-cli"
          path: "."
          format: "SARIF"
          out: "dependency-check-results"
          args: >
            --failOnCVSS 7
            --enableRetired
            --nodeAuditSkipDevDependencies
            --exclude "**/node_modules/.cache/**"
            --nvdApiKey ${{ secrets.NVD_API_KEY }}

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: dependency-check-results/dependency-check-report.sarif

  # ============================================================
  # Stage 2c: EOL Check (parallel with SAST and SCA)
  # ============================================================
  eol-check:
    name: EOL / Node and Deprecated Packages
    runs-on: ubuntu-latest
    needs: [secret-scan]
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Check Node.js engines field
        run: |
          ENGINES=$(node -e "const p=require('./package.json'); console.log(p.engines?.node || 'not set')")
          echo "engines_node=$ENGINES"
          if echo "$ENGINES" | grep -E ">=18|^18" > /dev/null 2>&1; then
            echo "::error file=package.json::Node 18 is EOL since 2025-04-30. Update engines.node to '>=20' in package.json."
            exit 1
          fi
          echo "Node engines field OK: $ENGINES"

      - name: Detect deprecated packages
        run: |
          set +e
          DEPRECATED_FOUND=0
          DEPS=$(node -e "
            const p = require('./package.json');
            const all = [
              ...Object.keys(p.dependencies || {}),
              ...Object.keys(p.devDependencies || {})
            ];
            console.log(all.join(' '));
          ")
          for pkg in $DEPS; do
            DEPRECATION=$(npm info "$pkg" deprecated 2>/dev/null)
            if [ -n "$DEPRECATION" ]; then
              echo "::warning::DEPRECATED: $pkg — $DEPRECATION"
              DEPRECATED_FOUND=1
            fi
          done
          if [ "$DEPRECATED_FOUND" -eq 1 ]; then
            echo "One or more deprecated packages found (see warnings above). Merge is not blocked, but these should be replaced."
          else
            echo "No deprecated packages."
          fi

  # ============================================================
  # Stage 3: SBOM (main push + release only)
  # ============================================================
  sbom:
    name: SBOM / Generate
    runs-on: ubuntu-latest
    needs: [codeql, sca, eol-check]
    if: |
      always() &&
      (needs.codeql.result == 'success' || needs.codeql.result == 'skipped') &&
      (needs.sca.result == 'success' || needs.sca.result == 'skipped') &&
      (github.event_name == 'push' && github.ref == 'refs/heads/main' ||
       github.event_name == 'release' ||
       github.event_name == 'workflow_dispatch')
    permissions:
      contents: write
      id-token: write
      attestations: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - name: Install and build
        run: pnpm install --frozen-lockfile && pnpm build

      - name: Generate CycloneDX SBOM
        uses: anchore/sbom-action@v0.17.9
        with:
          path: .
          artifact-name: aicore-cli-sbom-cyclonedx.json
          format: cyclonedx-json
          output-file: sbom-cyclonedx.json
          upload-artifact: true
          upload-release-assets: ${{ github.event_name == 'release' }}

      - name: Generate SPDX SBOM
        uses: anchore/sbom-action@v0.17.9
        with:
          path: .
          artifact-name: aicore-cli-sbom-spdx.json
          format: spdx-json
          output-file: sbom-spdx.json
          upload-artifact: true
          upload-release-assets: ${{ github.event_name == 'release' }}

      - name: Attest SBOM
        uses: actions/attest-sbom@v2
        with:
          subject-path: dist/
          sbom-path: sbom-cyclonedx.json

  # ============================================================
  # Stage 4: SLSA Provenance (release only)
  # ============================================================
  slsa-provenance:
    name: SLSA / Level 2 Provenance
    needs: [sbom]
    if: |
      github.event_name == 'release' ||
      startsWith(github.ref, 'refs/tags/v')
    permissions:
      id-token: write
      contents: write
      actions: read
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.0.0
    with:
      upload-assets: true
      provenance-name: aicore-cli.intoto.jsonl

  # ============================================================
  # Stage 5: Security Gate — aggregates all results
  # Blocks PR merge if any upstream security job failed.
  # ============================================================
  security-gate:
    name: Security Gate
    runs-on: ubuntu-latest
    # Always run so the required status check is always present.
    if: always()
    needs:
      - secret-scan
      - codeql
      - sca
      - dependency-review
      - eol-check
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Evaluate gate results
        id: gate
        run: |
          SECRET_RESULT="${{ needs.secret-scan.result }}"
          CODEQL_RESULT="${{ needs.codeql.result }}"
          SCA_RESULT="${{ needs.sca.result }}"
          DEPREV_RESULT="${{ needs.dependency-review.result }}"
          EOL_RESULT="${{ needs.eol-check.result }}"

          echo "=== Security Gate Summary ==="
          echo "Secret scanning:      $SECRET_RESULT"
          echo "CodeQL SAST:          $CODEQL_RESULT"
          echo "SCA (pnpm audit):     $SCA_RESULT"
          echo "Dependency review:    $DEPREV_RESULT"
          echo "EOL check:            $EOL_RESULT"

          GATE_FAILED=0

          # Secret scan failure is always a hard block.
          if [ "$SECRET_RESULT" == "failure" ]; then
            echo "::error::GATE BLOCKED: Secret scanning detected potential secrets."
            echo "::error::Remove the secret from git history before merging."
            GATE_FAILED=1
          fi

          # CodeQL failure (Critical severity) is a hard block.
          if [ "$CODEQL_RESULT" == "failure" ]; then
            echo "::error::GATE BLOCKED: CodeQL found Critical severity vulnerabilities."
            echo "::error::Review findings: https://github.com/${{ github.repository }}/security/code-scanning"
            GATE_FAILED=1
          fi

          # SCA failure (High/Critical CVE in dependencies) is a hard block.
          if [ "$SCA_RESULT" == "failure" ]; then
            echo "::error::GATE BLOCKED: High or Critical CVE found in dependencies."
            echo "::error::Run 'pnpm audit --audit-level=high' locally and update affected packages."
            GATE_FAILED=1
          fi

          # Dependency review failure (new High/Critical dependency introduced in PR) is a hard block.
          if [ "$DEPREV_RESULT" == "failure" ]; then
            echo "::error::GATE BLOCKED: New dependency with High or Critical CVE introduced in this PR."
            GATE_FAILED=1
          fi

          # EOL failure (Node 18 engines field, or breaking EOL) is a hard block.
          if [ "$EOL_RESULT" == "failure" ]; then
            echo "::error::GATE BLOCKED: EOL runtime or deprecated dependency detected."
            echo "::error::Update package.json engines.node to '>=20' and fix deprecated packages."
            GATE_FAILED=1
          fi

          if [ "$GATE_FAILED" -eq 0 ]; then
            echo ""
            echo "All security gates passed."
          else
            exit 1
          fi

      - name: Post gate summary to PR
        if: github.event_name == 'pull_request' && always()
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const results = {
              'Secret Scanning':     '${{ needs.secret-scan.result }}',
              'CodeQL SAST':         '${{ needs.codeql.result }}',
              'SCA (pnpm audit)':    '${{ needs.sca.result }}',
              'Dependency Review':   '${{ needs.dependency-review.result }}',
              'EOL Check':           '${{ needs.eol-check.result }}',
            };

            const icon = r => r === 'success' ? ':white_check_mark:' :
                               r === 'failure' ? ':x:' :
                               r === 'skipped' ? ':next_track_button:' : ':hourglass:';

            const rows = Object.entries(results)
              .map(([name, result]) => `| ${icon(result)} | ${name} | ${result} |`)
              .join('\n');

            const body = `## Security Gate Results\n\n| Status | Check | Result |\n|--------|-------|--------|\n${rows}\n\n` +
              `> Findings are in the [Security tab](https://github.com/${context.repo.owner}/${context.repo.repo}/security/code-scanning).`;

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body
            });
```

---

## 8. Security Gates — Branch Protection and CODEOWNERS

### Branch Protection Rules

Configure these rules for the `main` branch via **Settings > Branches > Add branch protection rule**.

```
Branch name pattern: main

Required settings:
  [x] Require a pull request before merging
      [x] Require approvals: 1
      [x] Dismiss stale pull request approvals when new commits are pushed
      [x] Require review from Code Owners

  [x] Require status checks to pass before merging
      [x] Require branches to be up to date before merging

      Required status checks (add each by exact name):
        - "Secret Scan / Gitleaks"
        - "SAST / CodeQL"
        - "SCA / pnpm Audit"
        - "EOL / Node and Deprecated Packages"
        - "Security Gate"

  [x] Require conversation resolution before merging
  [x] Do not allow bypassing the above settings
  [ ] Allow force pushes  (leave unchecked)
  [ ] Allow deletions    (leave unchecked)
```

The `Security Gate` check is the authoritative aggregated gate. Requiring it means all individual security jobs must pass for the gate to succeed.

### `.github/CODEOWNERS`

```
# Global owners — all files require review from a maintainer.
*                   @wizeline/agents-skills-maintainers

# Security configuration — changes to security tooling require an
# additional review from the security-aware owner.
.github/workflows/security.yml        @wizeline/agents-skills-maintainers
.github/workflows/secret-scan.yml     @wizeline/agents-skills-maintainers
.github/codeql/                       @wizeline/agents-skills-maintainers
.gitleaks.toml                        @wizeline/agents-skills-maintainers
.husky/pre-commit                     @wizeline/agents-skills-maintainers

# Lock file — changes require maintainer sign-off (supply chain).
pnpm-lock.yaml                        @wizeline/agents-skills-maintainers

# Package manifest — engines, dependencies, scripts.
package.json                          @wizeline/agents-skills-maintainers
```

Replace `@wizeline/agents-skills-maintainers` with the actual GitHub team slug. The goal is to ensure that changes to security controls themselves cannot bypass the review requirement.

### Exception Workflow

When a security gate finding needs to be accepted as a known risk:

1. Open a GitHub Issue with label `security-exception`.
2. Document the finding identifier (e.g., CVE number or CodeQL rule ID), the justification, and the planned remediation date.
3. For `pnpm audit` suppressions, add the package to `.npmrc` with `audit-resolve` or use `pnpm audit --audit-level=critical` as a temporary downgrade — document this in the issue.
4. For CodeQL suppressions, add an inline comment: `// lgtm[js/rule-id] exception: <issue-url>`.
5. The exception issue must be reviewed and approved by a CODEOWNERS member before the suppression is merged.
6. Set a reminder label `security-exception-expires-<YYYY-MM-DD>` and review quarterly.

---

## 9. Local Developer Setup

### Installing the Pre-commit Hook

Husky is already installed in the project. The `.husky/pre-commit` file from Section 5 handles secret scanning. Developers need gitleaks installed locally:

```bash
# macOS
brew install gitleaks

# Node.js (cross-platform, works on Windows too)
npm install -g gitleaks

# Verify
gitleaks version
```

After cloning the repository, Husky hooks activate automatically via the `prepare` script in `package.json`. If the project does not yet have a `prepare` script, add:

```json
"scripts": {
  "prepare": "husky"
}
```

### detect-secrets Baseline

`detect-secrets` provides a complementary approach to Gitleaks — it tracks a baseline of known-acceptable "secrets" (test fixtures, example keys) so the scanner can focus on genuinely new findings.

**Install:**
```bash
pip install detect-secrets
# or with pipx (recommended)
pipx install detect-secrets
```

**Generate the initial baseline (run once, commit the result):**
```bash
detect-secrets scan \
  --exclude-files 'pnpm-lock\.yaml' \
  --exclude-files '\.git/.*' \
  --exclude-files 'dist/.*' \
  > .secrets.baseline
```

**Audit the baseline to mark any false positives:**
```bash
detect-secrets audit .secrets.baseline
```

**Add to `.husky/pre-commit`** (append after the gitleaks block):
```bash
# ----------------------------------------------------------------------------
# detect-secrets check against baseline (optional, requires Python + pip install)
# ----------------------------------------------------------------------------
if command -v detect-secrets > /dev/null 2>&1; then
  echo "[pre-commit] Running detect-secrets against baseline..."
  detect-secrets-hook \
    --baseline .secrets.baseline \
    $(git diff --cached --name-only)
  if [ $? -ne 0 ]; then
    echo "[pre-commit] BLOCKED: New secrets detected not in baseline."
    echo "[pre-commit] Run: detect-secrets scan > .secrets.baseline && detect-secrets audit .secrets.baseline"
    exit 1
  fi
fi
```

**Commit `.secrets.baseline` to the repository.** Treat changes to it with the same scrutiny as changes to `.gitleaks.toml` — they are security-relevant configuration.

---

## 10. Metrics — Dependabot and OpenSSF Scorecard

### Dependabot Configuration

`.github/dependabot.yml`

```yaml
version: 2
updates:
  # npm / pnpm dependencies
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "09:00"
      timezone: "America/Mexico_City"
    open-pull-requests-limit: 5
    # Group all non-major updates into a single PR to reduce noise.
    groups:
      non-major-updates:
        update-types:
          - "minor"
          - "patch"
    # Major version bumps are individual PRs — they need explicit review.
    ignore: []
    labels:
      - "dependencies"
      - "automated"
    commit-message:
      prefix: "chore"
      include: "scope"
    reviewers:
      - "wizeline/agents-skills-maintainers"

  # GitHub Actions — pin action versions to SHAs for supply chain security.
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "09:00"
      timezone: "America/Mexico_City"
    open-pull-requests-limit: 5
    labels:
      - "github-actions"
      - "automated"
    commit-message:
      prefix: "ci"
      include: "scope"
    reviewers:
      - "wizeline/agents-skills-maintainers"
```

### OpenSSF Scorecard Integration

`.github/workflows/scorecard.yml`

```yaml
name: OpenSSF Scorecard

on:
  push:
    branches:
      - main
  schedule:
    # Weekly scan — Mondays 03:00 UTC
    - cron: "0 3 * * 1"
  workflow_dispatch:

permissions: read-all

jobs:
  scorecard:
    name: OpenSSF Scorecard
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      id-token: write
      contents: read
      actions: read
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          persist-credentials: false

      - name: Run Scorecard
        uses: ossf/scorecard-action@v2.4.0
        with:
          results_file: scorecard-results.sarif
          results_format: sarif
          # Publish results to the OpenSSF public database (opt-in).
          # This enables the Scorecard badge and public visibility.
          publish_results: true

      - name: Upload SARIF to Security tab
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: scorecard-results.sarif
          category: openssf-scorecard

      - name: Upload results artifact
        uses: actions/upload-artifact@v4
        with:
          name: scorecard-results
          path: scorecard-results.sarif
          retention-days: 90
```

### Scorecard Score Projection

| Scorecard Check | Current | After This Report |
|-----------------|---------|------------------|
| Branch-Protection | 0 | 8 (with required status checks) |
| CI-Tests | 7 | 7 |
| CII-Best-Practices | 0 | 0 (manual CII application required) |
| Code-Review | 3 | 7 (with CODEOWNERS + required reviews) |
| Dangerous-Workflow | 5 | 8 (after pinning action SHAs) |
| Dependency-Update-Tool | 0 | 10 (Dependabot enabled) |
| License | 9 | 9 |
| Maintained | 6 | 6 |
| Pinned-Dependencies | 2 | 7 (after Dependabot pins action SHAs) |
| SAST | 0 | 10 (CodeQL enabled) |
| Security-Policy | 0 | 5 (add `SECURITY.md`) |
| Signed-Releases | 8 | 10 (SBOM + attestation added) |
| Token-Permissions | 4 | 9 (minimal permissions in workflows) |
| Vulnerabilities | 6 | 8 (SCA gates active) |
| **Estimated Total** | **3–4 / 10** | **7–8 / 10** |

### Add `SECURITY.md` (Quick Win for Scorecard)

Create `.github/SECURITY.md` with at minimum:

```markdown
# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

Report vulnerabilities privately via GitHub's security advisory feature:
https://github.com/wizeline/agents-skills/security/advisories/new

We will acknowledge receipt within 48 hours and aim to release a fix within 14 days
for Critical findings, 30 days for High findings.
```

### Action SHA Pinning

Dependabot will update action versions to SHAs automatically once configured, but on the first pass, pin manually. Example for `actions/checkout@v4`:

```bash
# Get the SHA for the v4 tag
gh api repos/actions/checkout/git/refs/tags/v4 --jq '.object.sha'
```

Then use:
```yaml
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4
```

This protects against a compromised action tag being moved to point at malicious code (CICD-SEC-9).

---

## Summary of Files to Create

| File | Purpose | Section |
|------|---------|---------|
| `.github/workflows/security.yml` | Complete integrated security pipeline | 7 |
| `.github/workflows/scorecard.yml` | OpenSSF Scorecard weekly scan | 10 |
| `.github/dependabot.yml` | Automated dependency + action updates | 10 |
| `.github/CODEOWNERS` | Review enforcement for security files | 8 |
| `.github/SECURITY.md` | Vulnerability disclosure policy | 10 |
| `.github/codeql/codeql-config.yml` | CodeQL configuration | 2 |
| `.github/codeql/js-security-queries.ql` | Custom spawn+shell:true query | 2 |
| `.github/codeql/js-fetch-size.ql` | Custom unbounded fetch query | 2 |
| `.gitleaks.toml` | Secret scanning patterns | 5 |
| `.husky/pre-commit` | Local pre-commit secret scan | 5 |
| `.secrets.baseline` | detect-secrets baseline (generated) | 9 |

## Summary of Source Code Fixes Required

These issues are detected by the tooling above but must be fixed in code — the scanner cannot fix them for you.

| File | Issue | Fix |
|------|-------|-----|
| `package.json` | `engines.node: ">=18"` (EOL) | Change to `">=20"` |
| `src/installer.ts` (or similar) | `spawn(..., {shell: process.platform === 'win32'})` with external URL data | Validate and sanitize the command and arguments before passing to spawn; avoid `shell: true` where possible — pass args as an array instead |
| `src/installer.ts` (or similar) | `response.text()` without size limit | Check `Content-Length` header before reading; reject responses over a safe limit (e.g., 10 MB) |
| `src/installer.ts` (or similar) | `sanitizeSubpath()` missing `decodeURIComponent` | Apply `decodeURIComponent` before checking for `..` sequences and absolute paths |
| `src/` (wherever `execSync('gh auth token')` is used) | Unqualified `execSync` subject to PATH hijack | Use the full path to `gh` resolved via `which`/`where`, or use the GitHub Actions `gh` path from the environment |
