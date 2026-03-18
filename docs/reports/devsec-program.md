# Security Program Design Report: aicore-cli

**Organization:** Wizeline
**Project:** aicore-cli (npm packages: `aicores`, `skills`, `subagents`)
**Date:** 2026-03-18
**Classification:** Internal — Engineering Leadership
**Frameworks Referenced:** OWASP SAMM 2.0, NIST SSDF 1.1 (SP 800-218), OpenSSF Scorecard, OWASP ASVS 4.0, NIST CSF 2.0

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [OWASP SAMM Scorecard](#2-owasp-samm-scorecard)
3. [Security Champions Program](#3-security-champions-program)
4. [12-Month Security Roadmap](#4-12-month-security-roadmap)
5. [Vulnerability Disclosure Program (VDP)](#5-vulnerability-disclosure-program-vdp)
6. [Developer Security Training Plan](#6-developer-security-training-plan)
7. [Metrics and KPIs](#7-metrics-and-kpis)
8. [Executive Stakeholder Summary](#8-executive-stakeholder-summary)

---

## 1. Executive Summary

### Current Risk Posture

aicore-cli is a supply chain tool: it downloads third-party Markdown files from arbitrary GitHub repositories and installs them as AI agent instructions into user environments (Claude Code, Cursor, and similar tools). This architectural pattern means the project's security posture directly determines the security posture of every developer who installs a skill.

The project has meaningful security hygiene in place: npm provenance publishing, frozen lockfile installs, git clone timeouts, environment-variable-only token handling, and basic CI gates. These controls demonstrate a security-aware team. However, several gaps create real, exploitable risk chains that affect not just Wizeline but the entire user ecosystem downstream.

The three highest-severity gaps, in order of exploitability and blast radius:

**Gap 1 — Command injection via `shell: true` on Windows (Critical)**
`spawn('npx', [...sourceUrl...], {shell: true})` allows an attacker who controls the source URL argument — whether through a malformed CLI invocation or a crafted skill file — to inject arbitrary shell commands on Windows hosts. This is a pre-authentication remote code execution vector in the install path.

**Gap 2 — Path traversal via percent-encoding bypass (Critical)**
`sanitizeSubpath()` checks for `..` sequences but does not decode percent-encoded variants (`%2e%2e`, `%2e%2e%2f`, etc.) before the check. An attacker who controls a skill repository can craft a subpath that bypasses sanitization and writes files outside the intended `.agents/` directory. This enables arbitrary file write on the user's machine.

**Gap 3 — No content integrity verification on installed skills (High)**
Skills are installed via git clone from arbitrary GitHub repositories. There is no cryptographic verification that the content received matches what was published, and the lock file has no HMAC or signature. A compromised GitHub account, a dependency confusion attack, or a MITM can substitute malicious Markdown — which is then loaded as AI agent instructions, creating a prompt injection vector against every downstream user's AI coding assistant.

### Business Case

aicore-cli is Wizeline's public-facing contribution to the AI developer tooling ecosystem. Its reputation risk profile is asymmetric: a single supply chain incident affecting downstream users would cause immediate, visible harm to Wizeline's brand in the developer community — the exact audience Wizeline recruits from and sells to. The controls needed to close the critical gaps are almost entirely free open-source tooling and configuration changes. The investment is weeks of developer time, not budget.

### Top 3 Investments for Maximum ROI

| Priority | Investment | Effort | Risk Reduction |
|----------|-----------|--------|----------------|
| 1 | Fix `shell: true` command injection + path traversal percent-decode | 2–3 days | Eliminates two Critical RCE/LFI vectors |
| 2 | CodeQL SAST + Dependency Review + Secret Scanning in GitHub Actions | 1 day config | Prevents future introduction of similar flaws; satisfies NIST SSDF PW.7, PW.4 |
| 3 | Lock file HMAC + content integrity verification for installed skills | 1 week | Closes the supply chain tamper vector; enables downstream users to trust installs |

---

## 2. OWASP SAMM Scorecard

### Scoring Basis

Scores reflect consistent, verified practice against available evidence. A practice scores at Level N only if all criteria for that level are demonstrably met. Aspirational goals are excluded. Evidence is drawn from the repository, CI configuration, and the project context provided.

### Scorecard Table

| Function | Practice | Current Level | Evidence (Exists) | Evidence (Missing) | Target Level |
|----------|----------|:---:|---|---|:---:|
| **Governance** | Strategy & Metrics | 0 | None identified | Security strategy doc, KPIs, SAMM baseline | 2 |
| | Policy & Compliance | 0 | MIT license, basic CI gates | SECURITY.md, secure coding policy, SLAs | 2 |
| | Education & Guidance | 0 | None identified | Secure coding guidelines, training records | 1 |
| **Design** | Threat Assessment | 0 | None identified | Threat model for install pipeline, DFDs | 2 |
| | Security Requirements | 0 | None identified | Documented security requirements per feature | 1 |
| | Security Architecture | 1 | Path sanitization, env-var token handling, temp dir validation | Reference architecture doc, trust boundary diagram | 2 |
| **Implementation** | Secure Build | 1 | Frozen lockfile, npm provenance, git clone timeout, type-check in CI | SAST (CodeQL), SCA (Dependency Review), secret scanning, SBOM | 2 |
| | Secure Deployment | 1 | GitHub Actions CI, env-var secrets, npm provenance | SLSA Level 2, signed artifacts, deployment runbook | 2 |
| | Defect Management | 0 | None identified | Vulnerability tracking, remediation SLAs, severity triage | 1 |
| **Verification** | Architecture Assessment | 0 | None identified | Documented architecture review, trust boundary validation | 1 |
| | Requirements Testing | 0 | Vitest unit tests (functional) | Security test cases derived from requirements | 1 |
| | Security Testing | 0 | None identified | SAST in CI, DAST, penetration test | 2 |
| **Operations** | Incident Management | 0 | None identified | SECURITY.md, incident response runbook, VDP | 1 |
| | Environment Management | 1 | GitHub Actions hardening (CI env), frozen lockfile | Branch protection rules (enforced), CODEOWNERS | 1 |
| | Operational Management | 0 | Telemetry opt-out mechanism | Telemetry consent (opt-in), data retention policy | 1 |

### Overall Score

```
Current:  0.4 / 3.0  (weighted average across 15 practices)
Target:   1.7 / 3.0  (12-month horizon — appropriate for OSS project without dedicated AppSec)
```

### ASCII Radar Chart

```
                    GOVERNANCE
                        3
                        |
                   2    |    2
                  /     |     \
                 1      |      1
                /       |       \
OPERATIONS ----0--------0--------0---- DESIGN
                \       |       /
                 1      |      1
                  \     |     /
                   2    |    2
                        |
                   IMPLEMENTATION --- VERIFICATION
                        3

Legend:
  [*] Current state (approx 0.4 average)
  [ ] Target state  (approx 1.7 average)

Current averages by function:
  Governance:     0.0
  Design:         0.3
  Implementation: 0.7
  Verification:   0.0
  Operations:     0.3
```

### Gap Analysis by Priority

**Critical gaps (implement in 30–60 days):**
- Implementation / Secure Build: No SAST, no SCA, no secret scanning in CI
- Operations / Incident Management: No VDP, no SECURITY.md, no response process
- Implementation / Defect Management: No tracking, no SLAs for found vulnerabilities

**High gaps (implement in 60–90 days):**
- Governance / Strategy: No security strategy or metrics baseline
- Design / Threat Assessment: No threat model for the install pipeline (highest-risk component)
- Verification / Security Testing: No automated security testing beyond functional tests

**Medium gaps (implement in 3–6 months):**
- Governance / Education: No secure coding training or guidelines for contributors
- Design / Security Requirements: No documented security requirements per feature
- Operations / Operational Management: Telemetry requires consent, not opt-out

---

## 3. Security Champions Program

### Context and Constraints

aicore-cli operates in a specific context that shapes the Champions program design:
- No dedicated AppSec team; 10–30 engineers across Wizeline
- Open-source project with external contributors (GitHub community)
- OSS community champions (external maintainers) are as important as internal ones
- Primary risk vector is the install pipeline — a narrow, high-impact code path

The program has two tracks: **Internal Champions** (Wizeline engineers) and **Community Champions** (trusted external contributors).

### Selection Criteria

**Internal Champion Candidates**

A strong candidate for the aicore-cli Security Champion:
- Has shipped or reviewed code in the install pipeline (`src/installer.ts`, `src/list.ts`)
- Demonstrates curiosity about how things can go wrong, not just that they work
- Is respected by peers — their code review comments get read, not dismissed
- Is willing to spend approximately 20% of their time on security activities
- Has explicit manager buy-in for that time allocation

Disqualifying signals: Someone assigned against their will, someone without manager support for the time commitment, the most senior engineer who is already overcommitted.

**Community Champion Candidates**

- External contributors with 3+ merged pull requests to core install paths
- Maintainers of widely-used skill repositories (they have skin in the supply chain game)
- OSS security researchers who have engaged constructively with the project

### Nomination Process

**Month 1, Week 1–2: Internal Nomination**

1. Engineering lead sends a direct, personal ask to 2–3 candidates — not a broadcast
2. Frame the ask: "We want to make aicore-cli one of the most trusted OSS tools in the AI dev space. That starts with one engineer who cares about getting the install pipeline right."
3. Confirm manager sign-off in the same conversation
4. Identify a backup candidate if the first declines

**Month 1, Week 3–4: Community Champion Outreach**

1. Review contributor history on GitHub — who has engaged with security-adjacent PRs?
2. Draft a personal GitHub message (not a GitHub Discussion broadcast)
3. Offer concrete value: early access to VDP findings, SECURITY.md Hall of Fame credit, conference talk co-authorship opportunity
4. Target: 1 internal champion, 1 community champion by end of Month 1

### Launch Plan

**Month 1 — Foundation**

| Activity | Owner | Output |
|----------|-------|--------|
| Champion identification and nomination | Engineering Lead | 1 internal, 1 community champion confirmed |
| Kickoff call (1 hour) | Engineering Lead + Champion | Shared understanding of role, first 30-day focus |
| Set up `#security-champions` Slack channel | Champion | Communication channel live |
| Champion reviews this report and selects 3 quick wins to own | Champion | Personal 30-day plan |
| Champion completes OWASP Top 10 module (free, owasp.org) | Champion | Foundation training complete |

**Month 2 — First Deliverables**

| Activity | Owner | Output |
|----------|-------|--------|
| Champion leads SECURITY.md draft | Champion | First VDP policy in place |
| Champion implements secret scanning in CI | Champion | Automated secret detection live |
| Champion runs first threat model on install pipeline | Champion + Lead | Documented threat model, risk register |
| Champion reviews all open PRs for security impact (starting now) | Champion | PR review checklist applied to 100% of PRs |
| First monthly champion sync (30 min) | Champion + Lead | Issues surfaced, blockers removed |

**Month 3 — Community Engagement**

| Activity | Owner | Output |
|----------|-------|--------|
| Community champion conducts first VDP triage alongside internal champion | Both | VDP workflow tested |
| Champions co-author a blog post: "How we secured the aicore-cli install pipeline" | Both | Community trust signal, recruitment |
| Champions present at one Wizeline internal tech talk | Internal champion | Internal visibility, recruits next cohort |
| OpenSSF Scorecard integrated into CI | Champion | Automated score tracking live |
| Champion completes SANS SEC522 or equivalent intermediate training | Champion | Intermediate training milestone |

**Month 4–6 — Sustaining**

| Activity | Owner | Output |
|----------|-------|--------|
| Second champion nominated and onboarded (from external contributor pool) | Internal champion | Cohort grows to 3 |
| Champions own threat model for `experimental_sync` feature | Champion | High-risk feature threat model complete |
| Monthly CTF or security challenge (internal Wizeline) | Champion | Engagement maintained |
| Champions present SAMM progress to engineering leadership | Champion + Lead | Quarterly security review cadence established |
| Hall of Fame added to SECURITY.md with community champion recognition | Champion | Recognition system live |

### Training Progression

**Foundation Track (Month 1–2, all engineers + champion)**

| Module | Source | Duration | Covers |
|--------|--------|----------|--------|
| OWASP Top 10 for Developers | owasp.org (free) | 4 hours | Web/API vulnerability fundamentals |
| Node.js Security Best Practices | nodejs.org Security docs | 2 hours | Path traversal, command injection, prototype pollution |
| Supply Chain Security Basics | OpenSSF (free) | 3 hours | Dependency risks, SBOM, SCA concepts |
| GitHub Actions Security Hardening | GitHub docs | 2 hours | Secrets, OIDC, permissions minimization |

Total: ~11 hours. Completion target: all engineers by end of Month 2.

**Intermediate Track (Month 3–6, champions only)**

| Module | Source | Duration | Covers |
|--------|--------|----------|--------|
| OWASP ASVS Deep Dive | owasp.org (free) | 6 hours | Verification requirements, testing methodology |
| Threat Modeling with STRIDE | OWASP Threat Dragon (free tool) | 4 hours | DFD creation, STRIDE analysis, risk rating |
| Secure Code Review for TypeScript | Snyk Learn (free tier) | 4 hours | TS/JS-specific patterns, async security |
| AI/LLM Prompt Injection | OWASP LLM Top 10 (free) | 3 hours | Prompt injection mechanics, defense patterns |
| Supply Chain Attacks: Case Studies | CISA advisories (free) | 2 hours | SolarWinds, XZ utils, 3CX — lessons for CLI tools |

Total: ~19 hours over 4 months for champions.

**Advanced Track (Month 7–12, champion with 6+ months tenure)**

| Module | Source | Duration | Covers |
|--------|--------|----------|--------|
| SLSA Framework Implementation | slsa.dev (free) | 4 hours | Build provenance, artifact signing, verification |
| Fuzzing with Node.js | OSS-Fuzz, jsfuzz docs | 6 hours | Input parsing, path handling, fuzzing harness setup |
| Penetration Testing for CLI Tools | PTES methodology (free) | 8 hours | Practical attack simulation, write-up skills |
| OpenSSF Security Scorecard Deep Dive | scorecard.dev (free) | 3 hours | Scorecard checks, GitHub Actions integration |

Total: ~21 hours. Champions at this level are qualified to co-author security advisories and represent Wizeline at security conferences.

### Champion Responsibilities

**Every Pull Request**

The champion applies the following checklist to every PR that touches install paths, file I/O, network I/O, or subprocess execution. For other PRs, the champion is a resource, not a gatekeeper.

```
PR Security Review Checklist (Security Champion)
-------------------------------------------------
[ ] Does this PR touch subprocess execution? Check for shell:true or user-controlled args.
[ ] Does this PR touch file paths? Verify path normalization + percent-decode before ../ check.
[ ] Does this PR add or change network requests? Verify size limits, timeout, TLS validation.
[ ] Does this PR add or change lock file logic? Verify integrity check is preserved/added.
[ ] Does this PR add new dependencies? Run `pnpm audit` result reviewed, license checked.
[ ] Does this PR touch telemetry? Verify opt-in consent flow is preserved.
[ ] Does this PR touch AI agent instruction loading? Check for prompt injection mitigations.
```

**Monthly**

- Lead or participate in the monthly champion sync (30 min)
- Review open VDP reports and triage any new submissions
- Review Dependabot / npm audit alerts and ensure they are tracked
- Update the threat model if a significant new feature was shipped

**Quarterly**

- Prepare a one-page security health summary for engineering leadership
- Review the SAMM scorecard and update practice scores
- Run the OpenSSF Scorecard and compare to previous quarter
- Assess whether the training plan is on schedule

**Annually**

- Run a full threat model refresh against the install pipeline
- Coordinate or participate in external penetration test scoping
- Recruit and onboard the next champion cohort

### Recognition Model

**README Badges**

The project README will display:
- OpenSSF Scorecard badge (auto-updated via GitHub Actions)
- OpenSSF Best Practices badge (when earned)
- A "Security Champion" section in CONTRIBUTING.md naming current champions

**SECURITY.md Hall of Fame**

All VDP reporters who submit valid findings receive named credit in SECURITY.md. Champions who achieve advanced training track completion are listed as "Security Champions Alumni."

**Conference and Community Talks**

Wizeline commits to sponsoring champion attendance at one security conference per year (OWASP Global AppSec, BSides, or equivalent). Champions with the community blog post completed are eligible to submit a conference talk proposal with Wizeline's support. This is the highest-value recognition signal for developers who care about career growth.

**Career Credential**

The Security Champion role is documented in the internal performance review system as a formal responsibility, not volunteer work. Time spent on champion activities counts toward performance goals, not against them. This is non-negotiable for the program to function.

---

## 4. 12-Month Security Roadmap

### Milestone Overview

```
Month  1  2  3  4  5  6  7  8  9  10 11 12
       |--|--|--|--|--|--|--|--|--|--|--|--|
Phase  [Quick Wins][Foundation][Hardening ][Sustaining        ]
```

### 30-Day Quick Wins (Days 1–30)

**Goal:** Eliminate exploitable Critical vulnerabilities and establish the minimum security baseline.

| # | Action | Owner | Effort | NIST SSDF | SAMM Impact |
|---|--------|-------|--------|-----------|-------------|
| 1 | Create SECURITY.md with VDP policy, scope, SLAs, and reporting email | Champion | 0.5 day | RV.1 | Operations/Incident L1 |
| 2 | Enable GitHub Secret Scanning (free for public repos) | Champion | 0.5 day | PW.5, PS.1 | Implementation/Secure Build L1 |
| 3 | Add `npm audit --audit-level=high` to GitHub Actions CI | Champion | 0.5 day | PW.4, PW.9 | Implementation/Secure Build L1 |
| 4 | Fix `spawn(..., {shell: true})` — remove shell option, use execFile or absolute npx path | Engineer | 1 day | PW.5 | Implementation/Secure Build (closes Critical) |
| 5 | Add `pnpm audit` to release workflow (blocks publish on Critical) | Champion | 0.5 day | PW.4 | Implementation/Secure Build L1 |
| 6 | Nominate and confirm Security Champion | Engineering Lead | 0.5 day | PO.2 | Governance/Education L1 |
| 7 | Enable branch protection: require 1 reviewer, require status checks to pass | Lead | 0.5 day | PS.1 | Implementation/Secure Deployment L1 |
| 8 | Add response size limit to all `WellKnownProvider` fetches (e.g., 10 MB cap) | Engineer | 0.5 day | PW.5 | Implementation/Secure Build |

**30-Day Success Criteria:**
- Zero Critical vulnerabilities with known exploit paths remaining open
- SECURITY.md published and linked from README
- Secret scanning, npm audit, and branch protection active
- Security Champion confirmed and onboarded

### 60-Day Foundation (Days 31–60)

**Goal:** Systematic detection of vulnerability classes, supply chain integrity, and explicit telemetry consent.

| # | Action | Owner | Effort | NIST SSDF | SAMM Impact |
|---|--------|-------|--------|-----------|-------------|
| 1 | Enable CodeQL SAST via GitHub Actions (JavaScript/TypeScript analysis) | Champion | 1 day | PW.5, PW.7 | Verification/Security Testing L1 |
| 2 | Add GitHub Dependency Review action (blocks PRs introducing known-vuln deps) | Champion | 0.5 day | PW.4 | Implementation/Secure Build L2 |
| 3 | Generate SBOM on release (use `@cyclonedx/cyclonedx-npm`, attach to GitHub Release) | Engineer | 1 day | PW.4, PS.3 | Implementation/Secure Build L2 |
| 4 | Fix `sanitizeSubpath()` — decode percent-encoding before `..` check | Engineer | 0.5 day | PW.5 | Implementation/Secure Build (closes Critical) |
| 5 | Add HMAC to lock file entries (sign `source + version + sha` on install; verify on update) | Engineer | 2 days | PS.2, PW.4 | Implementation/Secure Build |
| 6 | Replace telemetry opt-out with opt-in consent prompt on first run | Engineer | 1 day | PW.8 | Operations/Operational Management L1 |
| 7 | Add content validation to `experimental_sync` (validate .md structure, size, no executable content markers) | Engineer | 1 day | PW.5 | Implementation/Secure Build |
| 8 | Add CODEOWNERS file routing security-sensitive paths to Security Champion for review | Champion | 0.5 day | PO.4, PS.1 | Governance/Policy L1 |
| 9 | Champion completes Foundation training track | Champion | 11 hours | PO.3 | Governance/Education L1 |
| 10 | Document initial SAMM baseline (this report) in project wiki | Champion | 1 day | PO.1 | Governance/Strategy L1 |

**60-Day Success Criteria:**
- All Critical vulnerabilities patched and verified
- CodeQL running on every PR with results visible in PR checks
- SBOM generated and published with each release
- Telemetry requires explicit first-run consent
- Lock file integrity verification active

### 90-Day Hardening (Days 61–90)

**Goal:** Supply chain trust, formal threat model, VDP operational, OpenSSF Scorecard tracked.

| # | Action | Owner | Effort | NIST SSDF | SAMM Impact |
|---|--------|-------|--------|-----------|-------------|
| 1 | Implement SLSA Level 2: use `slsa-github-generator` in release workflow | Champion + Engineer | 2 days | PS.2 | Implementation/Secure Deployment L2 |
| 2 | Security Champions program launched (internal + 1 community champion active) | Lead + Champion | — | PO.2 | Governance/Education L1 |
| 3 | Run first threat model on install pipeline using OWASP Threat Dragon | Champion | 1 day | PW.1, PW.2 | Design/Threat Assessment L1 |
| 4 | Publish VDP on GitHub Security Advisories tab; link from SECURITY.md | Champion | 0.5 day | RV.1 | Operations/Incident Management L1 |
| 5 | Add OpenSSF Scorecard GitHub Action; publish score badge in README | Champion | 0.5 day | PO.1 | Governance/Strategy L1 |
| 6 | Enable Dependabot for npm dependencies (weekly PRs, auto-merge for patch) | Champion | 0.5 day | PW.9, RV.2 | Implementation/Defect Management L1 |
| 7 | Define vulnerability remediation SLAs in SECURITY.md (Critical/High/Medium/Low) | Champion | 0.5 day | RV.2 | Implementation/Defect Management L1 |
| 8 | Implement symlink attack prevention in install path (resolve symlinks before path operations) | Engineer | 1 day | PW.5 | Implementation/Secure Build |
| 9 | First security metrics report: OpenSSF score, open vulnerability count, MTTR | Champion | 1 day | PO.1 | Governance/Strategy L1 |

**90-Day Success Criteria:**
- OpenSSF Scorecard score: target 5.0+ (from estimated current ~2.0)
- SLSA Level 2 provenance attached to every release
- Threat model document published in project wiki
- VDP publicly visible and tested with at least one synthetic report
- Dependabot active with defined SLAs

### 6-Month Milestone (Days 91–180)

**Goal:** OpenSSF Passing badge, ASVS Level 2 compliance for relevant controls, SAMM L1 across all practices.

| # | Action | Owner | Effort |
|---|--------|-------|--------|
| 1 | Complete OpenSSF Best Practices self-certification (target: Passing badge) | Champion | 3 days |
| 2 | ASVS Level 2 gap analysis for V1 (Architecture), V5 (Validation), V7 (Error Handling) | Champion | 2 days |
| 3 | Implement structured error handling: no stack traces in user-visible output, no path leakage | Engineer | 1 day |
| 4 | Add DAST: run `zap-baseline.py` or `nuclei` against test install flows in CI | Champion | 2 days |
| 5 | Second threat model: `experimental_sync` crawling behavior | Champion | 1 day |
| 6 | Intermediate training track complete for champion | Champion | 19 hours |
| 7 | First external security review: community security researcher invited via VDP | Champion | — |
| 8 | Security metrics dashboard: GitHub Actions summary publishing score per quarter | Champion | 1 day |
| 9 | Document reference architecture with trust boundaries for project wiki | Champion | 1 day |
| 10 | SAMM reassessment: target L1 across all 15 practices | Champion | 1 day |

**6-Month Success Criteria:**
- OpenSSF Passing badge earned
- SAMM L1 verified across all 15 practices
- OpenSSF Scorecard score: target 7.0+
- ASVS Level 2 compliance for validation and error handling controls
- At least 1 external security researcher engaged via VDP

### 12-Month Milestone (Days 181–365)

**Goal:** OpenSSF Silver badge readiness, self-sustaining champions program, SAMM L2 across core practices.

| # | Action | Owner | Effort |
|---|--------|-------|--------|
| 1 | OpenSSF Silver badge: complete additional criteria (CII Best Practices Silver) | Champion | 1 week |
| 2 | Annual threat model refresh against updated attack surface | Champion | 1 day |
| 3 | Second champion cohort onboarded (3 total: 2 internal, 1 community) | Internal champion | — |
| 4 | External penetration test: scoped to install pipeline, path handling, supply chain | Lead + Champion | 2 days scoping |
| 5 | Advanced training track complete for 12-month champion | Champion | 21 hours |
| 6 | SAMM reassessment: target L2 for Implementation, Governance; L1+ for all others | Champion | 1 day |
| 7 | Signed commits enabled for all maintainers (GPG or SSH signing) | Lead | 0.5 day |
| 8 | Champions co-author public blog post or conference talk on OSS CLI security | Champions | — |
| 9 | Annual security review with engineering leadership: metrics, roadmap, budget | Champion + Lead | 2 hours |

**12-Month Success Criteria:**
- OpenSSF Silver badge criteria met (self-certification complete)
- SAMM L2 verified for Governance/Policy, Implementation/Secure Build, Implementation/Defect Management
- 3 active champions with clear succession plan
- External pen test completed with all findings remediated
- OpenSSF Scorecard score: target 8.5+

---

## 5. Vulnerability Disclosure Program (VDP)

### Policy

**Version:** 1.0
**Effective Date:** [Date of SECURITY.md publication]
**Contact:** GitHub Security Advisory (preferred) | security@wizeline.com (alternate)
**PGP Key:** [Publish key fingerprint in SECURITY.md]

### Scope

The following are in scope for aicore-cli VDP reports:

| Category | Examples |
|----------|---------|
| Path traversal | Bypassing `sanitizeSubpath()` to write files outside `.agents/` |
| Remote code execution via skill install | Command injection in install pipeline, spawn argument injection |
| Lock file tampering | Modifying the lock file to redirect installs to malicious sources |
| Supply chain via `experimental_sync` | Exploiting the node_modules crawler to execute arbitrary code |
| Symlink attacks | Using symlinks in skill repositories to escape sandbox |
| Prompt injection via Markdown | Crafting skill content that hijacks AI agent behavior in a novel, demonstrable way |
| Unauthorized telemetry data collection | Sending data beyond what is disclosed, without consent |
| Dependency confusion attacks | Exploiting the install resolution to substitute malicious packages |

### Out of Scope

The following are explicitly out of scope:

- Denial of service attacks (network flooding, CPU exhaustion)
- Social engineering of Wizeline employees or users
- Security issues in third-party skill repositories (not maintained by Wizeline)
- Theoretical vulnerabilities with no demonstrated attack path
- Issues in dependencies that have a published upstream fix not yet applied (use Dependabot instead)
- Reports generated entirely by automated scanners without analyst triage
- Physical security attacks

### Response SLAs

| Severity | Definition | Acknowledgment | Patch Target | Escalation |
|----------|-----------|:--------------:|:------------:|-----------|
| Critical | Exploitable RCE, LFI, or supply chain compromise with PoC | 24 hours | 7 days | 12h without triage start |
| High | Exploitable with significant user impact, no active exploitation evidence | 48 hours | 30 days | 3 days without remediation plan |
| Medium | Limited impact, requires specific conditions to exploit | 7 days | 90 days | 14 days without scheduling |
| Low | Defense-in-depth issues, information disclosure, no direct exploitability | 30 days | 180 days | 60 days without plan |

Acknowledgment means: the reporter receives a response confirming the report was received and a named person is assigned to triage it.

### Triage Workflow (7 Steps)

**Step 1: Receive and Acknowledge**
- Reporter submits via GitHub Security Advisory ("Report a vulnerability") or security@wizeline.com
- Automated acknowledgment sent within 1 hour (GitHub Advisory handles this automatically)
- Champion assigns the report to themselves and sets status to "Needs Triage"
- Timeline clock starts at receipt, not at assignment

**Step 2: Reproduce**
- Champion attempts to reproduce the reported behavior in a clean environment
- If reproduction fails within 48 hours: request clarification from reporter with specific questions
- If reproduction succeeds: proceed to Step 3
- Document exact reproduction steps in the GitHub Advisory (private)

**Step 3: Assess Severity**
- Apply CVSS 3.1 base score using the NVD calculator
- Adjust for context: is this exploitable in the default install? Does it require a malicious skill repo?
- Classify as Critical / High / Medium / Low per VDP severity definitions
- Notify reporter of severity assessment with rationale

**Step 4: Identify Fix**
- Champion and responsible engineer identify the fix approach
- For Critical/High: draft fix within 24–48 hours of confirmation
- Create a private fork or branch for the fix (GitHub Advisory workspace supports this)
- Fix must include: code change, test case that fails before and passes after, documentation update if behavior changes

**Step 5: Review and Test Fix**
- Champion reviews the fix using the PR security checklist
- Run the full CI suite (including SAST) against the fix branch
- For Critical: second engineer reviews the fix before merge
- For High+: regression test specifically for the reported attack vector

**Step 6: Coordinate Disclosure**
- Default disclosure timeline: patch release + 7 days (allows users to update)
- For Critical with active exploitation: immediate disclosure after patch is available
- Notify reporter of release date and advisory publication date in advance
- Prepare GitHub Security Advisory text: description, affected versions, patched version, CVSS score, credit

**Step 7: Publish and Close**
- Merge fix to main, tag a new patch release, publish to npm
- Publish GitHub Security Advisory (auto-generates CVE request if appropriate)
- Add reporter to SECURITY.md Hall of Fame (with their permission)
- Run RV.3 root cause analysis: was this a design flaw, coding error, dependency issue, or missing control?
- Feed root cause back into: training plan, code review checklist, threat model, or SAST custom rules

### Hall of Fame

The SECURITY.md file will maintain a Hall of Fame section listing researchers who reported valid, in-scope vulnerabilities. Each entry includes: name/handle (with permission), severity of finding, date of disclosure, and a thank-you note. This is the primary non-monetary recognition mechanism for external reporters.

---

## 6. Developer Security Training Plan

### Audience Segmentation

| Audience | Who | Goal |
|----------|-----|------|
| All engineers | Wizeline engineers who contribute to aicore-cli | Recognize and avoid the top 5 vulnerability classes in this codebase |
| Security Champions | 1–3 engineers per the Champions program | Deep expertise in the full attack surface; ability to lead threat models and triage VDP reports |
| External contributors | OSS contributors via GitHub | Awareness of the project's security requirements; how to write a secure skill |

### Module 1: Node.js and TypeScript Secure Coding (All Engineers)

**Duration:** 6 hours
**Delivery:** Self-paced, links in CONTRIBUTING.md
**Prerequisites:** None

Topics:
- Path traversal in Node.js: `path.normalize()`, `path.resolve()`, percent-decoding pitfalls
- Command injection: when `spawn({shell: true})` is dangerous, using `execFile` safely, argument validation
- Prototype pollution: `Object.assign`, deep merge vulnerabilities in TypeScript
- Async security: race conditions in file operations, TOCTOU vulnerabilities
- Error handling: avoiding stack trace leakage, structured error classes
- Dependency security: reading `npm audit` output, understanding CVSS scores, when to accept vs. fix

Assessment: 10-question quiz. Pass mark: 80%. Available via Google Forms or GitHub Discussions (pinned post).

### Module 2: Supply Chain Security for CLI Tools (All Engineers)

**Duration:** 4 hours
**Delivery:** Self-paced
**Prerequisites:** Module 1

Topics:
- What is a supply chain attack? XZ utils, SolarWinds, and eslint-scope as case studies
- How aicore-cli is a supply chain tool: the install pipeline as the attack surface
- SBOM: what it is, how to read CycloneDX output, why consumers care
- Lock files as integrity controls: what they protect and what they do not
- SLSA: what Level 1/2/3 means, how to verify provenance of an npm package
- npm provenance: what it guarantees, how to check it
- OpenSSF Scorecard: the 18 checks and what each one means for this project

Assessment: Walkthrough exercise: "Using only npm, verify that a specific aicore-cli release was built from the tagged commit." Documented answer submitted to champion.

### Module 3: CLI Security Patterns (Champions Only)

**Duration:** 4 hours
**Delivery:** Workshop with champion leading
**Prerequisites:** Modules 1 and 2

Topics:
- Attack surface of a CLI tool: argument parsing, file I/O, network requests, subprocess execution
- Sandboxing approaches: what Node.js can and cannot sandbox, OS-level alternatives
- Telemetry and consent: privacy regulations relevant to CLI tools, opt-in patterns
- GitHub Actions security: OIDC tokens, permission scoping, artifact integrity, pinning action SHA
- Secrets in CI: env vars vs. GitHub Actions secrets vs. OIDC, what gets logged
- Code signing for npm: npm provenance, keyless signing with Sigstore

Assessment: Threat model exercise using OWASP Threat Dragon on a simplified install flow diagram. Output: at least 5 identified threats with STRIDE classification and proposed mitigation.

### Module 4: AI and LLM Prompt Injection (All Engineers + Champions)

**Duration:** 3 hours
**Delivery:** Self-paced, with 1-hour discussion session
**Prerequisites:** None

Topics:
- What is prompt injection? Direct vs. indirect prompt injection
- Why Markdown files are a prompt injection vector: how AI coding assistants process skill files
- The aicore-cli threat model: a malicious skill repository as a prompt injection delivery mechanism
- Mitigations: content validation, user confirmation on install, warning messages in skill output
- OWASP LLM Top 10: LLM01 (Prompt Injection), LLM09 (Misinformation), LLM10 (Unbounded Consumption)
- Designing skill file formats to resist injection: structural constraints, content policies

Assessment: Design exercise: "Propose a content validation function for skill Markdown files that would prevent the top 3 prompt injection patterns." Reviewed by champion.

### Module 5: Threat Modeling for CLI Install Pipelines (Champions Only)

**Duration:** 4 hours
**Delivery:** Hands-on workshop
**Prerequisites:** Modules 1–3 plus Intermediate training track

Topics:
- STRIDE applied to CLI install flows: each threat category with a concrete aicore-cli example
- Data flow diagrams: how to draw the install pipeline at the right level of abstraction
- Trust boundaries in aicore-cli: CLI process, GitHub API, npm registry, AI agent config dirs
- Attack trees: documenting multi-step attacks (e.g., compromised skill repo → path traversal → AI agent hijack)
- Risk rating: DREAD vs. CVSS for CLI-specific threats
- Updating threat models when features change: the minimum viable threat model update

Deliverable: A published, version-controlled threat model document for the install pipeline. This is a champion graduation requirement for the intermediate track.

### External Contributor Security Guide

Published as `SECURITY-CONTRIBUTING.md` in the repository root:

- How to write a skill file that meets content validation requirements
- What the VDP covers and how to report a vulnerability responsibly
- How to run the project's security checks locally before submitting a PR
- The PR security review checklist (abridged version)
- Links to the OWASP LLM Top 10 and supply chain security resources

---

## 7. Metrics and KPIs

### OpenSSF Scorecard Baseline and Targets

The OpenSSF Scorecard evaluates 18 checks across code review, dependency management, build security, and vulnerability management. The following table shows the estimated current baseline, quarterly targets, and the specific actions that drive each score.

| Scorecard Check | Estimated Baseline | Q1 Target | Q2 Target | Q3 Target | Q4 Target | Key Action |
|----------------|:-----------------:|:---------:|:---------:|:---------:|:---------:|-----------|
| Binary Artifacts | 8/10 | 8 | 8 | 8 | 10 | SLSA provenance removes binaries from release artifacts |
| Branch Protection | 3/10 | 8 | 8 | 8 | 8 | Enforce reviews, status checks, dismiss stale reviews |
| CI Tests | 7/10 | 7 | 7 | 7 | 8 | Add security test cases to existing test suite |
| CII Best Practices | 0/10 | 0 | 5 | 8 | 9 | OpenSSF Passing badge in Q2, Silver in Q4 |
| Code Review | 5/10 | 7 | 8 | 8 | 8 | CODEOWNERS + required reviewers for all PRs |
| Contributors | 7/10 | 7 | 7 | 7 | 7 | Already in good shape |
| Dangerous Workflow | 5/10 | 8 | 8 | 8 | 8 | Remove shell injection patterns from workflows |
| Dependency Update Tool | 8/10 | 9 | 9 | 9 | 9 | Dependabot enabled (may already be partially active) |
| Fuzzing | 0/10 | 0 | 0 | 3 | 5 | OSS-Fuzz integration for path handling in H2 |
| License | 9/10 | 9 | 9 | 9 | 9 | MIT license already present |
| Maintained | 7/10 | 7 | 7 | 7 | 8 | Sustained release cadence |
| Pinned Dependencies | 4/10 | 6 | 7 | 8 | 8 | Pin GitHub Actions to SHA, pin npm devDependencies |
| SAST | 0/10 | 0 | 8 | 8 | 8 | CodeQL enabled in Q2 |
| Secret Scanning | 0/10 | 8 | 8 | 8 | 8 | GitHub Secret Scanning enabled in Q1 |
| Security Policy | 0/10 | 9 | 9 | 9 | 9 | SECURITY.md published in Q1 |
| Signed Releases | 0/10 | 0 | 0 | 6 | 8 | SLSA provenance in Q3, GPG signing in Q4 |
| Token Permissions | 5/10 | 7 | 8 | 8 | 8 | Minimize workflow permissions to least-privilege |
| Vulnerabilities | 5/10 | 7 | 8 | 9 | 10 | Clear known Critical/High findings in Q1–Q2 |
| **Overall Estimate** | **~2.5/10** | **~4.5** | **~6.5** | **~7.5** | **~8.5** | |

Note: Scorecard scores are computed by the OpenSSF Scorecard tool. The above are estimates based on the described security posture. Run `scorecard --repo=github.com/wizeline/aicore-cli` for the actual baseline.

### MTTD and MTTR Targets

| Metric | Current (Estimated) | Q1 Target | Q2 Target | Q4 Target |
|--------|:------------------:|:---------:|:---------:|:---------:|
| MTTD — Critical vulns | Unknown / weeks | <7 days | <3 days | <1 day |
| MTTD — High vulns | Unknown / months | <30 days | <14 days | <7 days |
| MTTR — Critical | No defined SLA | <7 days | <7 days | <7 days |
| MTTR — High | No defined SLA | <30 days | <30 days | <14 days |
| MTTR — Medium | No defined SLA | <90 days | <60 days | <30 days |

MTTD improves as SAST (Q2) and secret scanning (Q1) are enabled. MTTR improves as the VDP workflow is practiced and remediation SLAs are enforced.

### Vulnerability Density

| Metric | Definition | Baseline | Q4 Target |
|--------|-----------|:--------:|:---------:|
| Critical open findings | Count of unmitigated Critical vulns | 2 (path traversal, command injection) | 0 |
| High open findings | Count of unmitigated High vulns | 3 (lock file, `experimental_sync`, prompt injection) | 0 |
| Vulnerability introduction rate | New vulns introduced per 100 PRs (from SAST) | Unknown | <2 |
| SLA compliance rate | % of findings remediated within SLA | Unknown | >90% |

### Security Champion Program Health

| Metric | Q1 | Q2 | Q3 | Q4 Target |
|--------|:--:|:--:|:--:|:---------:|
| Active champions | 1 | 2 | 2 | 3 |
| Champion training completion (Foundation) | 100% | 100% | 100% | 100% |
| Champion training completion (Intermediate) | 0% | 0% | 100% | 100% |
| PRs with security review applied | ~10% | ~50% | ~80% | 100% (critical paths) |
| Threat models completed | 0 | 1 | 2 | 3 |
| VDP reports triaged within SLA | N/A | 100% | 100% | 100% |
| Champion retention | N/A | N/A | N/A | >80% |

### Training Completion

| Module | Target Audience | Q1 | Q2 | Q3 | Q4 |
|--------|----------------|:--:|:--:|:--:|:--:|
| Node.js Secure Coding | All engineers | 0% | 75% | 100% | 100% |
| Supply Chain Security | All engineers | 0% | 50% | 100% | 100% |
| CLI Security Patterns | Champions | 0% | 0% | 100% | 100% |
| AI/LLM Prompt Injection | All engineers | 0% | 50% | 75% | 100% |
| Threat Modeling | Champions | 0% | 0% | 100% | 100% |

### Quarterly Security Review Agenda

Each quarter, the champion prepares a one-page summary covering:
1. OpenSSF Scorecard score (previous vs. current)
2. Open vulnerability count by severity (previous vs. current)
3. MTTR for any findings closed during the quarter
4. Training completion rate
5. One risk that increased (new feature, new dependency, new threat intelligence)
6. One improvement that reduced risk
7. Roadmap milestone status (on track / at risk / complete)

---

## 8. Executive Stakeholder Summary

### The Risk in Plain Language

aicore-cli is a tool that installs third-party code — specifically, Markdown files — into AI agent configuration directories on developer machines. When a developer runs `npx aicores add <repo>`, they are trusting that the content downloaded from that GitHub repository is safe, and that the CLI itself will not execute malicious code during the install.

Right now, that trust is partially warranted. The team has taken real steps: packages are published with cryptographic provenance, installs use frozen lock files, network timeouts are in place, and secrets are never embedded in code. These are not trivial choices — most OSS projects skip them.

However, two vulnerabilities in the install pipeline can be exploited by anyone who can influence the content of a skill repository or a source URL argument:

1. On Windows, the subprocess call that runs npm during install uses `shell: true`, which allows shell metacharacters in the source URL to execute arbitrary commands on the user's machine. This is a remote code execution vulnerability — the researcher who discovers this can publish a proof-of-concept exploit within hours.

2. The path sanitization function that prevents skills from writing files outside the `.agents/` directory does not decode URL-encoded characters before checking for `../` sequences. Encoding a traversal as `%2e%2e%2f` bypasses the check entirely, allowing a malicious skill to write files anywhere the user has write access.

Both vulnerabilities affect end users — the developers installing skills — not just Wizeline. A public exploit would affect the entire aicore ecosystem immediately.

### Why This Matters to the Business

**Brand and ecosystem trust.** aicore-cli is Wizeline's contribution to the AI developer tooling ecosystem. Developers are the primary audience for Wizeline's services, and they are also the users of this tool. A supply chain incident that affects developer machines — especially AI coding assistant configurations — would generate immediate, visible, negative coverage in the exact communities Wizeline depends on.

**Liability surface.** aicore-cli is MIT-licensed, which limits contractual liability. However, the reputational damage from a disclosed vulnerability affecting user machines is not limited by license terms. Comparison: the XZ utils backdoor (2024) affected a project used by millions; the two engineers who discovered it became security community heroes, and the project that introduced it became a cautionary tale — regardless of how it was licensed.

**Competitive differentiation.** The AI developer tools space is crowded and moving fast. Security is a differentiator that is difficult to copy quickly. Publishing a SLSA-verified, OpenSSF-badged, SBOM-attached release is a signal that resonates with enterprise buyers and security-conscious developer communities. This is not a compliance checkbox — it is a trust signal that compounds over time.

**Regulatory trajectory.** The White House Executive Order on Software Supply Chain Security (2021) and subsequent CISA guidance have established SBOM and SLSA as expectations for software procured by the US government. While aicore-cli is not a government procurement target today, enterprise buyers increasingly apply these standards to their own vendor assessments. Building the capability now costs far less than retrofitting it under deadline pressure.

### The Investment Required

The controls needed to close the Critical vulnerabilities and achieve a credible security baseline require almost no budget. The investment is engineering time:

| Phase | Engineering Time | External Cost | Outcome |
|-------|:---------------:|:-------------:|---------|
| 30-day quick wins | ~5 engineer-days | $0 | Critical vulns patched, minimum baseline established |
| 60-day foundation | ~8 engineer-days | $0 | SAST, SBOM, SLSA L2, telemetry consent |
| 90-day hardening | ~6 engineer-days | $0 | OpenSSF Scorecard 5+, VDP operational, threat model |
| 6-month milestone | ~8 engineer-days | $0 | OpenSSF Passing badge, SAMM L1 across all practices |
| 12-month milestone | ~10 engineer-days + 1 pen test | ~$8–15K (pen test) | OpenSSF Silver candidate, self-sustaining program |

The only significant external cost is a scoped penetration test in Month 12, which is optional but strongly recommended. All tools — CodeQL, Dependabot, GitHub Secret Scanning, OpenSSF Scorecard, SLSA generators, CycloneDX SBOM — are free for public repositories.

The ongoing cost of the Security Champions program is the time allocation: approximately 20% of one senior engineer's time. For a project of this size and risk profile, that is the correct investment. A Security Champion who catches one supply chain vulnerability before it ships saves far more than their allocated time costs.

### The Risk of Inaction

The path traversal and command injection vulnerabilities are not hypothetical. They follow well-known patterns that security researchers actively search for in OSS projects. The codebase is public. The exploitable code paths are in functions with obvious security-relevant names (`sanitizeSubpath`, `spawn`). Discovery is a matter of time, not capability.

The question is not whether these vulnerabilities will be found — it is whether Wizeline finds them first and patches them before they are exploited or disclosed publicly.

The recommended approach is to patch the Critical vulnerabilities this month, establish the security baseline over 60 days, and build the program that prevents the next generation of vulnerabilities from shipping in the first place. Done well, this becomes a story Wizeline tells publicly: how a small team built one of the most trustworthy AI skill distribution tools in the OSS ecosystem.

### Recommended Decisions for Leadership

1. **Authorize 5 engineer-days in the next 30 days** to patch the Critical vulnerabilities and establish the security baseline described in this report.

2. **Designate one engineer as Security Champion** with explicit manager sign-off for 20% time allocation. The Security Champion role is the force multiplier that makes everything else sustainable.

3. **Approve publication of SECURITY.md and a Vulnerability Disclosure Program** this month. This is the minimum signal the security research community needs to engage responsibly. Without it, researchers have no incentive to contact Wizeline before publishing their findings.

4. **Include security metrics in the quarterly engineering review.** OpenSSF Scorecard score, open vulnerability count, and training completion rate take 10 minutes to review and signal to the team that security is measured — and therefore matters.

---

*Report prepared by: Security Program Advisor (Claude Sonnet 4.6)*
*Based on: OWASP SAMM 2.0, NIST SSDF 1.1 (SP 800-218), OpenSSF Scorecard v5, OWASP ASVS 4.0, NIST CSF 2.0*
*Skill references: `devsec-building-security-programs`, `devsec-managing-compliance-frameworks`*
*Next review: 2026-06-18 (90-day checkpoint)*
