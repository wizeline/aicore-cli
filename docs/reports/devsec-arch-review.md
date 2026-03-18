# Security Architecture Review: aicore-cli

**Date:** 2026-03-18
**Scope:** aicore-cli (npm packages: `aicores`, `skills`, `subagents`) — TypeScript/Node.js CLI for
installing AI agent skill files from GitHub, local paths, and RFC 8615 well-known endpoints.
**Classification:** Internal — Engineering + Security

---

## Executive Summary

aicore-cli occupies an unusual threat position: it is a developer tool that installs markdown files
that are subsequently loaded as system instructions by AI coding assistants (Claude Code, Cursor,
Copilot, etc.). A compromised skill file is not merely a data integrity issue — it is a direct
prompt injection vector into an AI agent running with full filesystem and shell access on the
developer's machine.

Six high-severity issues and several medium-severity issues were identified. The critical path is:

> **Unauthenticated download of arbitrary content** → written to `.agents/skills/` →
> loaded as AI system instructions → prompt injection with agent-level privilege.

The findings below are ordered by severity within each section.

---

## 1. Network Security Assessment

### 1.1 POST /check-updates — Skill Inventory Disclosure

**Severity: Medium**

The `runCheck` and `runUpdate` flows in `src/cli.ts` send the complete installed skill inventory to
`add-skill.vercel.sh`. Each entry includes `name`, `source` (owner/repo), `skillPath`, and
`skillFolderHash` (GitHub Git tree SHA).

```typescript
// src/cli.ts — current code (illustrative)
const body: CheckUpdatesRequest = {
  skills: skillNames.map((name) => ({
    name,
    source: lock.skills[name].source,       // "wizeline/agent-skills"
    path: lock.skills[name].skillPath,      // "skills/react-best-practices"
    skillFolderHash: lock.skills[name].skillFolderHash,  // Git tree SHA
  }))
};
fetch(CHECK_UPDATES_API_URL, { method: 'POST', body: JSON.stringify(body) });
```

**What is exposed:**
- The full list of installed skills — a fingerprint of the developer's toolchain and workflow.
- Git tree SHAs, which can be used to correlate exact commit ranges in public repositories.
- Skill paths, which may reveal internal project structure if skills are installed from private repos.

**Risk:** Enumeration of developer profiles; potential correlation with private repository structure
if an organization self-hosts skills. In enterprise environments, skill names may reflect internal
project names or confidential tooling.

**Recommendation:** Move to a pull model. Instead of sending the full inventory, fetch only the
latest SHA for a specific `owner/repo` at the time of `check` or `update`:

```typescript
// Recommended: pull model — no inventory sent outbound
async function fetchLatestHash(ownerRepo: string, skillPath: string, token: string | null): Promise<string | null> {
  // Direct GitHub Trees API call — no intermediary receives skill inventory
  const branch = 'main';
  const url = `https://api.github.com/repos/${ownerRepo}/git/trees/${branch}?recursive=1`;
  const headers: HeadersInit = { 'Accept': 'application/vnd.github.v3+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;

  const data = await res.json() as { tree: Array<{ path: string; sha: string; type: string }> };
  const entry = data.tree.find(e => e.type === 'tree' && e.path === skillPath);
  return entry?.sha ?? null;
}
```

This is already partially implemented in `src/skill-lock.ts:fetchSkillFolderHash` — the
`/check-updates` endpoint is an additional hop that should be removed. The direct GitHub Trees API
call is the correct pattern.

---

### 1.2 Unverified Remote Skill Downloads — No Content Signing

**Severity: High**

`src/git.ts:cloneRepo` performs a shallow clone of arbitrary GitHub URLs with no signature
verification. Content integrity is checked only by comparing GitHub tree SHAs — which confirms the
content matches what GitHub currently serves, but does not verify that the content was published by
a trusted party.

```typescript
// src/git.ts — current
await git.clone(url, tempDir, ['--depth', '1']);
// No signature check, no allowlist, no content policy
```

An attacker who compromises a GitHub repository (or creates a typosquat) can serve arbitrary
SKILL.md content that becomes a prompt injection payload for every developer who runs `npx skills
update`.

**Recommendation:** Implement content signing using Sigstore/cosign. Skill publishers sign a
manifest at release time; the CLI verifies before writing to disk.

```typescript
// Recommended: verify Sigstore bundle before installing
import { verify } from '@sigstore/verify';
import { createPublicKey } from 'crypto';

interface SkillManifest {
  skills: Array<{ name: string; sha256: string }>;
}

async function verifySkillBundle(
  content: string,
  bundlePath: string,          // .sigstore.json alongside SKILL.md
  trustedIdentity: string      // e.g. "https://github.com/wizeline/agent-skills/.github/workflows/release.yml"
): Promise<boolean> {
  try {
    const bundle = JSON.parse(await readFile(bundlePath, 'utf-8'));
    const encoder = new TextEncoder();
    await verify(bundle, encoder.encode(content), {
      certificateIdentityURI: trustedIdentity,
      certificateIssuer: 'https://token.actions.githubusercontent.com',
    });
    return true;
  } catch {
    return false;
  }
}

// In the install flow:
async function installWithVerification(
  content: string,
  bundlePath: string,
  source: string,
  allowUnsigned: boolean
): Promise<void> {
  const trusted = getTrustedIdentities(source); // from a local allowlist
  if (!trusted && !allowUnsigned) {
    throw new Error(`Skill from ${source} is not signed and unsigned skills are not allowed. Pass --allow-unsigned to override.`);
  }
  if (trusted) {
    const valid = await verifySkillBundle(content, bundlePath, trusted);
    if (!valid) throw new Error(`Signature verification failed for skill from ${source}`);
  }
}
```

Short-term mitigation before signing infrastructure is in place: maintain a publisher allowlist
(`~/.agents/.skill-publishers.json`) scoped by `owner/repo`, with a user-controlled flag to allow
unsigned installs from unknown sources.

---

### 1.3 Well-Known Provider — SSRF, Unbounded Response Size, Missing Timeouts

**Severity: High**

`src/providers/wellknown.ts` fetches from any HTTPS URL that does not match a known git host.
Several gaps exist:

**SSRF (API7):** The URL is validated to be `http://` or `https://` with a blocklist of known git
hosts, but there is no check against internal IP ranges. An attacker who controls a skill's
`sourceUrl` field in the lock file could cause the CLI to make requests to `http://169.254.169.254`
(AWS metadata) or `http://10.x.x.x` (internal services) if the machine is inside a corporate
network.

```typescript
// src/providers/wellknown.ts — current: insufficient allowlist
const excludedHosts = ['github.com', 'gitlab.com', 'huggingface.co'];
if (excludedHosts.includes(parsed.hostname)) {
  return { matches: false };
}
// No check for RFC 1918 / RFC 4193 / loopback addresses
```

**No response size limit:** Individual skill files are fetched with `await response.text()` without
any size cap. A malicious endpoint could return a multi-gigabyte response, causing OOM.

**No per-request timeout:** `fetchSkillByEntry` makes parallel fetch calls with no `AbortSignal`.

**Recommendation:**

```typescript
// Recommended: SSRF protection + size limits + timeouts
const INTERNAL_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,          // link-local / cloud metadata
  /^::1$/,                // IPv6 loopback
  /^fc00:/i,              // IPv6 ULA
  /^fd[0-9a-f]{2}:/i,     // IPv6 ULA
];

const MAX_SKILL_FILE_BYTES = 512 * 1024;  // 512 KB per file
const MAX_INDEX_BYTES = 64 * 1024;        // 64 KB for index.json
const FETCH_TIMEOUT_MS = 10_000;

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);

    // Only HTTPS
    if (parsed.protocol !== 'https:') return false;

    // Block internal hostnames and IP ranges
    const host = parsed.hostname;
    if (host === 'localhost') return false;
    if (INTERNAL_IP_PATTERNS.some(p => p.test(host))) return false;

    // Block raw IP addresses except for explicit allow-list
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;

    return true;
  } catch {
    return false;
  }
}

async function safeFetch(url: string, maxBytes: number): Promise<string> {
  if (!isSafeExternalUrl(url)) {
    throw new Error(`URL blocked by SSRF policy: ${url}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      throw new Error(`Response too large: ${contentLength} bytes (limit ${maxBytes})`);
    }

    // Stream-read to enforce size limit even when Content-Length is absent
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) throw new Error(`Response exceeds ${maxBytes} byte limit`);
      chunks.push(value);
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timeout);
  }
}
```

---

### 1.4 Telemetry — PII Exposure, Missing Consent, Missing CI-Default Opt-Out

**Severity: Medium**

`src/telemetry.ts` fires-and-forgets to `https://add-skill.vercel.sh/t` with:
- `source`: the full GitHub URL or well-known endpoint URL
- `skills`: comma-separated skill names
- `agents`: comma-separated agent identifiers

Issues:

1. **No consent prompt on first run.** The user is not informed that telemetry is active. Only
   `DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1` opts out.

2. **`source` may contain private repo URLs.** If a developer installs a skill from
   `https://github.com/my-company/internal-tools`, that URL is sent to Vercel on every
   install/update event.

3. **CI environments are tagged but not silenced.** `isCI()` adds `ci=1` to the query string, but
   telemetry is still sent from CI pipelines unless explicitly disabled. Many CI security policies
   prohibit outbound data collection.

4. **`find` events include the raw search query**, which may reflect internal project naming.

**Recommendation:**

```typescript
// Recommended: consent-first telemetry with PII scrubbing
function scrubSource(source: string): string {
  try {
    const url = new URL(source);
    // Keep only hostname + first path segment (owner) — remove repo name and sub-paths
    const parts = url.pathname.split('/').filter(Boolean);
    const safe = parts.length > 0 ? `/${parts[0]}` : '';
    return `${url.hostname}${safe}`;
  } catch {
    // Not a URL — could be "owner/repo" format; return just the owner
    const slash = source.indexOf('/');
    return slash > -1 ? source.slice(0, slash) : 'unknown';
  }
}

function isEnabled(): boolean {
  // Opt-out signals
  if (process.env.DISABLE_TELEMETRY || process.env.DO_NOT_TRACK) return false;
  // Default-off in CI environments
  if (isCI()) return false;
  // Require explicit opt-in flag stored in lock file
  const consent = readConsentFlag();  // ~/.agents/.skill-telemetry-consent
  return consent === true;
}
```

A one-time consent prompt should be shown on the first `install` or `add` command.

---

## 2. Authentication & Authorization Architecture

### 2.1 GitHub Token Handling — execSync Shell Injection Risk

**Severity: Medium**

`src/skill-lock.ts:getGitHubToken` calls `execSync('gh auth token', ...)` to retrieve a token from
the GitHub CLI. This is synchronous and blocks the event loop, but the more important concern is
the execution model: `execSync` with `shell: false` (the default) is safe here because no
user-controlled input is interpolated. However, the function is called from async context and the
synchronous call will block the Node.js event loop for the duration of the `gh` CLI startup.

More importantly, the token is then placed directly in the `Authorization` header of GitHub API
calls with no validation that it is a well-formed Bearer token:

```typescript
// src/skill-lock.ts — current
const token = execSync('gh auth token', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
// ...
headers['Authorization'] = `Bearer ${token}`;
```

If the `gh` binary in PATH has been replaced (PATH hijacking) or the output contains unexpected
content, the token is passed as-is.

**Recommendation:**

```typescript
// Recommended: validate token format before use
const GITHUB_TOKEN_PATTERN = /^(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{82,}|v1\.[a-f0-9]{40})$/;

function sanitizeGitHubToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!GITHUB_TOKEN_PATTERN.test(trimmed)) {
    // Log warning but do not expose the value
    console.warn('[warn] Unexpected GitHub token format from gh CLI — skipping authenticated requests');
    return null;
  }
  return trimmed;
}

export function getGitHubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return sanitizeGitHubToken(process.env.GITHUB_TOKEN);
  if (process.env.GH_TOKEN)     return sanitizeGitHubToken(process.env.GH_TOKEN);

  try {
    // Use absolute path to gh binary resolved at startup, not PATH lookup at call time
    const ghPath = which.sync('gh', { nothrow: true });
    if (!ghPath) return null;
    const token = execSync(`"${ghPath}" auth token`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    return sanitizeGitHubToken(token);
  } catch {
    return null;
  }
}
```

---

### 2.2 Token Scope — Over-Privileged GitHub Tokens

**Severity: Medium**

The CLI uses whatever GitHub token is available in the environment (`GITHUB_TOKEN` in GitHub
Actions defaults to repo-scoped read/write). For update checks, only `public_repo` read access
(or no scope for public repos) is needed. There is no guidance in the docs or CLI output about
minimum required scopes.

**Recommendation:** Document and enforce minimum scope. For public repositories, no token is
needed. For private repositories, recommend a fine-grained personal access token with
`contents: read` on the specific repository only.

```typescript
// In the help text / first-run wizard:
const REQUIRED_SCOPES_MESSAGE = `
GitHub token scopes required:
  - Public repos:  No token needed
  - Private repos: Fine-grained PAT with "Contents: Read-only" on the target repo only
  Create at: https://github.com/settings/personal-access-tokens/new
`;
```

---

### 2.3 Unauthenticated Private Repo Check

**Severity: Low**

`src/add.ts:isSourcePrivate` calls the GitHub REST API without a token to determine if a repo is
private (`GET /repos/{owner}/{repo}`). For a private repo, this returns 404, which is correctly
interpreted as "private." However, this also makes an unauthenticated request to GitHub on every
`add` invocation, contributing to rate limit consumption without needing to.

More importantly, the `isRepoPrivate` determination affects whether the user is warned about
authentication, but the actual clone in `src/git.ts` proceeds regardless — if the repo is private
and no auth is configured, the clone will fail with a less-clear error.

**Recommendation:** Run the privacy check with the token if available, which also validates the
token works before attempting the more expensive clone operation.

---

## 3. Agent Ecosystem Security

### 3.1 ACE via Prompt Injection — The Primary Threat

**Severity: Critical**

This is the highest-severity issue in the codebase. SKILL.md files are loaded directly as system
instructions by AI coding assistants. Installing a malicious skill is functionally equivalent to
injecting an adversarial system prompt into an agent that has access to the developer's filesystem,
shell, browser, and credentials.

Attack vectors:

1. **Typosquatting:** `npx skills add org/react-best-practises` (extra 's') installs from an
   attacker-controlled repo.
2. **Repository compromise:** A legitimate skill publisher's GitHub account is compromised;
   malicious content is pushed to `SKILL.md`.
3. **Well-known endpoint takeover:** A domain hosting skills at `/.well-known/skills/` lapses or
   is acquired by an attacker.
4. **Supply chain via `experimental_sync`:** Any npm package in `node_modules` can embed a
   `SKILL.md` — a transitive dependency three levels deep becomes a skill.

The current codebase has no content-level validation of SKILL.md files. The only protections are:
- `sanitizeName` prevents path traversal in the directory name.
- `isPathSafe` validates install destinations.
- The `/audit` API provides a risk score, but installation is not blocked based on it.

**OWASP LLM01 (Prompt Injection) and LLM03 (Supply Chain) both apply here.**

**Recommendation — Content Policy Framework:**

```typescript
// Recommended: multi-layer content validation before installation

interface ContentPolicyResult {
  passed: boolean;
  violations: string[];
  severity: 'block' | 'warn' | 'pass';
}

// Layer 1: Structural validation
function validateSkillStructure(content: string): ContentPolicyResult {
  const violations: string[] = [];

  // Must have valid YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return { passed: false, violations: ['Missing or malformed YAML frontmatter'], severity: 'block' };
  }

  // Frontmatter must have name and description
  const fm = frontmatterMatch[1]!;
  if (!/^name:\s*.+/m.test(fm))        violations.push('Missing required frontmatter field: name');
  if (!/^description:\s*.+/m.test(fm)) violations.push('Missing required frontmatter field: description');

  return {
    passed: violations.length === 0,
    violations,
    severity: violations.length > 0 ? 'block' : 'pass',
  };
}

// Layer 2: Heuristic threat detection (catches obvious injection patterns)
const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Attempts to override or redefine system persona
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i,           label: 'prompt-override' },
  { pattern: /you\s+are\s+now\s+(a\s+)?(?!helpful)/i,                label: 'persona-hijack' },
  { pattern: /disregard\s+(your\s+)?(previous\s+)?instructions/i,    label: 'prompt-override' },
  // Exfiltration commands
  { pattern: /curl\s+[^\s]+\s+[|>]/,                                  label: 'exfiltration-curl' },
  { pattern: /\bwget\b.+--post-(data|file)/i,                         label: 'exfiltration-wget' },
  { pattern: /base64\s+.*[\|>]\s*curl/i,                              label: 'exfiltration-base64' },
  // Secret access
  { pattern: /~\/\.ssh\/|~\/\.aws\/credentials|~\/\.config\/gh/,     label: 'credential-access' },
  { pattern: /process\.env\s*\[/,                                      label: 'env-access' },
];

function scanForThreats(content: string): ContentPolicyResult {
  const violations = HIGH_RISK_PATTERNS
    .filter(({ pattern }) => pattern.test(content))
    .map(({ label }) => label);

  return {
    passed: violations.length === 0,
    violations,
    severity: violations.length > 0 ? 'warn' : 'pass',  // warn, not block — false positives exist
  };
}

// Layer 3: Size limit (prevents resource exhaustion and embedding of large payloads)
function validateSize(content: string, maxKb = 512): ContentPolicyResult {
  const sizeKb = Buffer.byteLength(content, 'utf-8') / 1024;
  if (sizeKb > maxKb) {
    return {
      passed: false,
      violations: [`File size ${sizeKb.toFixed(0)} KB exceeds limit of ${maxKb} KB`],
      severity: 'block',
    };
  }
  return { passed: true, violations: [], severity: 'pass' };
}

export async function runContentPolicy(
  content: string,
  sourceName: string,
  opts: { interactive: boolean; force: boolean }
): Promise<void> {
  const results = [
    validateSkillStructure(content),
    validateSize(content),
    scanForThreats(content),
  ];

  const blocking = results.filter(r => !r.passed && r.severity === 'block');
  const warnings = results.filter(r => !r.passed && r.severity === 'warn');

  if (blocking.length > 0) {
    const issues = blocking.flatMap(r => r.violations).join(', ');
    throw new Error(`Skill from ${sourceName} blocked by content policy: ${issues}`);
  }

  if (warnings.length > 0 && opts.interactive) {
    const issues = warnings.flatMap(r => r.violations).join(', ');
    const confirmed = await promptConfirm(
      `Skill from ${sourceName} has suspicious patterns: ${issues}. Install anyway?`
    );
    if (!confirmed) throw new Error('Installation cancelled by user');
  }
}
```

---

### 3.2 experimental_sync — Unrestricted node_modules Crawl

**Severity: High**

`src/sync.ts:discoverNodeModuleSkills` walks the entire `node_modules` tree and installs any
`SKILL.md` file it finds — including those in transitive dependencies. There is no:
- Publisher allowlist or signature check
- Content validation before installation
- User visibility into what's being installed (until the confirmation prompt, which can be
  bypassed with `--yes`)

This is a supply chain attack surface (OWASP LLM03). Any npm package — including a deeply
transitive dependency — can inject a skill by shipping a `SKILL.md`. A malicious package update
that adds `SKILL.md` will be silently installed the next time a developer runs `experimental_sync`.

```typescript
// src/sync.ts — current: no content gate before installation
const result = await installSkillForAgent(skill, agent, {
  global: false,
  cwd,
  mode: 'symlink',  // symlink to node_modules — content mutates with npm update
});
```

The `symlink` mode is particularly dangerous: the skill points back into `node_modules`, so a
subsequent `npm update` or `npm install` can silently change skill content without any interaction
from the user.

**Recommendation:**

1. Gate `experimental_sync` behind an explicit opt-in flag stored in the project config (not just
   the `--yes` flag at invocation time).
2. Always copy, never symlink, content from `node_modules` — content in `node_modules` is
   mutable without any CLI interaction.
3. Require an explicit package allowlist: `skills.config.json` → `{ "syncAllowlist": ["@org/skills"] }`.
4. Apply the content policy framework from §3.1 to every discovered skill before installation.

```typescript
// Recommended: copy mode + allowlist for experimental_sync
function loadSyncAllowlist(cwd: string): Set<string> | null {
  try {
    const cfg = JSON.parse(readFileSync(join(cwd, 'skills.config.json'), 'utf-8'));
    if (Array.isArray(cfg.syncAllowlist)) return new Set(cfg.syncAllowlist as string[]);
  } catch { /* no config */ }
  return null;  // null = feature disabled, not "allow all"
}

// In runSync:
const allowlist = loadSyncAllowlist(cwd);
if (!allowlist) {
  throw new Error(
    'experimental_sync requires an explicit syncAllowlist in skills.config.json.\n' +
    'Add: { "syncAllowlist": ["your-skills-package"] }'
  );
}

const permittedSkills = discoveredSkills.filter(s => allowlist.has(s.packageName));
if (permittedSkills.length < discoveredSkills.length) {
  const blocked = discoveredSkills.filter(s => !allowlist.has(s.packageName));
  p.log.warn(`Blocked ${blocked.length} skill(s) not in syncAllowlist: ${blocked.map(s => s.packageName).join(', ')}`);
}
```

---

### 3.3 Trust Model for Skill Publishers

**Severity: Medium**

There is no formal trust model for who is permitted to publish skills that developers install.
The audit API (`/audit`) provides a risk score from third-party scanners but does not block
installation and is not consulted for well-known or local installs.

**Recommendation — Publisher Trust Tiers:**

| Tier | Criteria | Installation Behavior |
|------|----------|-----------------------|
| **Verified** | Signed with Sigstore; identity matches trusted CI workflow | Install without prompt |
| **Community** | No signature; risk score "low" or "safe" from audit API | Install with info message |
| **Unknown** | No signature; no audit data | Require explicit `--allow-unknown` flag |
| **Flagged** | Audit score "high" or "critical" | Block; require `--force` |

Implement this as a configurable policy in `~/.agents/.skill-policy.json` so enterprise teams can
enforce stricter rules than the defaults.

---

## 4. Filesystem and Symlink Security

### 4.1 Lock File Permissions — World-Readable Secrets

**Severity: Medium**

`src/skill-lock.ts:writeSkillLock` writes to `~/.agents/.skill-lock.json` using Node's default
file creation mode (`0o666` masked by `umask`, typically `0o644`). This means the lock file is
world-readable on shared systems (e.g., developer workstations used by multiple users, cloud
development environments).

The lock file contains `sourceUrl` values that may include private repository URLs, and
`skillFolderHash` values (Git tree SHAs) that could be used to correlate code revisions.

```typescript
// src/skill-lock.ts — current
await writeFile(lockPath, content, 'utf-8');
// Inherits process umask — 0o644 on most Linux/macOS systems
```

**Recommendation:**

```typescript
// Recommended: explicit 0o600 permissions on all lock file writes
import { open, chmod } from 'fs/promises';

async function writeFileSafe(filePath: string, content: string): Promise<void> {
  // Open with O_WRONLY | O_CREAT | O_TRUNC and mode 0o600
  const fd = await open(filePath, 'w', 0o600);
  try {
    await fd.writeFile(content, 'utf-8');
  } finally {
    await fd.close();
  }
  // On systems where umask overrides the mode parameter, chmod enforces it
  await chmod(filePath, 0o600);
}
```

---

### 4.2 Lock File Integrity — No Tamper Detection

**Severity: Medium**

The global lock file at `~/.agents/.skill-lock.json` is a JSON file with no MAC or digital
signature. An attacker with write access to the home directory (e.g., a compromised process running
as the same user, or a malicious npm post-install script) can modify the lock file to:

- Change `sourceUrl` entries to point to attacker-controlled URLs.
- Replace `skillFolderHash` values to suppress update notifications for compromised skills.
- Add new entries that trigger installation of malicious skills on the next `update` run.

```typescript
// src/skill-lock.ts — current version check: wipes on version mismatch, no integrity check
if (parsed.version < CURRENT_VERSION) {
  return createEmptyLockFile();  // version downgrade silently wipes history
}
```

The version wipe-on-downgrade behavior is also exploitable: an attacker can decrement the version
field to cause all tracked skills to be forgotten, then re-install them from attacker-controlled
sources.

**Recommendation — HMAC-protected lock file:**

```typescript
import { createHmac, randomBytes } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';

// Key stored separately from the lock file — in a file with 0o600 permissions
// or in the OS keychain via `keytar` on desktop systems
function getLockHmacKey(): Buffer {
  const keyPath = join(homedir(), '.agents', '.skill-lock-key');
  try {
    return Buffer.from(readFileSync(keyPath, 'utf-8').trim(), 'hex');
  } catch {
    const key = randomBytes(32);
    writeFileSafe(keyPath, key.toString('hex'));
    return key;
  }
}

function computeLockHmac(content: string, key: Buffer): string {
  return createHmac('sha256', key).update(content, 'utf-8').digest('hex');
}

async function writeSkillLockSigned(lock: SkillLockFile): Promise<void> {
  const content = JSON.stringify(lock, null, 2);
  const key = getLockHmacKey();
  const hmac = computeLockHmac(content, key);

  // Write HMAC to sidecar file, not embedded in JSON (avoids changing the content being authenticated)
  await writeFileSafe(getSkillLockPath(), content);
  await writeFileSafe(getSkillLockPath() + '.hmac', hmac);
}

async function readSkillLockVerified(): Promise<SkillLockFile> {
  const lockPath = getSkillLockPath();
  const content = await readFile(lockPath, 'utf-8');
  const storedHmac = await readFile(lockPath + '.hmac', 'utf-8').catch(() => null);

  if (storedHmac) {
    const key = getLockHmacKey();
    const expectedHmac = computeLockHmac(content, key);
    if (!timingSafeEqual(Buffer.from(storedHmac.trim(), 'hex'), Buffer.from(expectedHmac, 'hex'))) {
      throw new Error(
        'Lock file integrity check failed. The file may have been tampered with.\n' +
        'Run `npx skills lock reset` to regenerate from scratch after verifying your installed skills.'
      );
    }
  }

  return JSON.parse(content) as SkillLockFile;
}
```

---

### 4.3 Symlink Race Conditions

**Severity: Low**

`src/installer.ts:createSymlink` uses a check-then-act pattern (lstat → compare → symlink) that is
subject to TOCTOU race conditions on shared filesystems. Between the `lstat` call and the `symlink`
call, another process could create a symlink at the same path pointing to a sensitive directory,
causing the subsequent directory copy to write files into an unintended location.

On macOS and Linux, this is a low-probability attack on a single-user developer workstation.
On shared development servers or CI environments with parallel job execution, the risk is higher.

**Recommendation:** Use atomic file operations where possible. For skill directory creation, use
a temporary directory + `rename` (atomic on POSIX):

```typescript
// Recommended: atomic directory installation
import { mkdtemp, rename } from 'fs/promises';

async function atomicInstallDirectory(src: string, dest: string): Promise<void> {
  const parent = dirname(dest);
  await mkdir(parent, { recursive: true });

  // Write to a temp dir in the same parent (same filesystem = atomic rename)
  const tmp = await mkdtemp(join(parent, '.tmp-skill-'));
  try {
    await copyDirectory(src, tmp);
    // Atomic swap: removes dest if exists, then renames tmp to dest
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
```

---

### 4.4 Windows Junction Security

**Severity: Low**

`src/installer.ts:createSymlink` uses Windows NTFS junctions for directory skills
(`symlinkType = 'junction'`) when running on Windows. NTFS junctions are not subject to the
Developer Mode requirement but have a security property difference from symlinks: they are followed
by the kernel without user privilege checks, which can cause unexpected behavior when the junction
target is inside a directory with ACL restrictions.

More relevantly, junctions use absolute paths. The current code passes `resolve(target)` for
junction targets, which is correct. However, `rm(linkPath, { recursive: true })` on a junction
will follow the junction and delete the target's contents, not just the junction itself —
a potential data loss path if an incorrect path is passed.

**Recommendation:** Before any `rm` on a path that may be a junction, verify with `lstat` and use
`rmdir` (non-recursive) for junction removal, not `rm --recursive`:

```typescript
// Recommended: safe removal of junctions vs real directories
async function safeRemove(targetPath: string): Promise<void> {
  const st = await lstat(targetPath).catch(() => null);
  if (!st) return;  // Already gone

  if (st.isSymbolicLink()) {
    // Symlink or junction: remove the link, not the target
    await rm(targetPath);  // non-recursive: only removes the link entry
  } else if (st.isDirectory()) {
    await rm(targetPath, { recursive: true });
  } else {
    await rm(targetPath);
  }
}
```

---

## 5. Update Mechanism Security

### 5.1 shell: true on Windows — Command Injection via installUrl

**Severity: High**

`src/cli.ts` spawns a subprocess to perform updates using `spawnSync`:

```typescript
// src/cli.ts:899 — current
const result = spawnSync('npx', ['-y', binaryName, 'add', installUrl, '-g', '-y'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: process.platform === 'win32',  // shell: true on Windows
});
```

`installUrl` is constructed from the lock file's `sourceUrl` + `skillPath`:

```typescript
installUrl = update.entry.sourceUrl.replace(/\.git$/, '').replace(/\/$/, '');
installUrl = `${installUrl}/tree/main/${skillFolder}`;
```

On Windows, `shell: true` passes the command to `cmd.exe`. If `installUrl` contains shell
metacharacters — which it would if a malicious lock file entry sets `sourceUrl` to something like
`https://example.com/repo & calc.exe` — the injected command will execute with the user's
privileges.

The lock file is user-writable at `~/.agents/.skill-lock.json` with permissions `0o644`. An
attacker who can write to the home directory (malicious npm post-install script, compromised
VSCode extension, etc.) can insert a crafted `sourceUrl` that executes arbitrary commands on the
next `npx skills update`.

**This is a command injection vulnerability when `shell: true` is active on Windows.**

**Recommendation — Safe update architecture:**

Eliminate `spawnSync` entirely for the update path. Instead of re-invoking the CLI as a subprocess,
call the installation functions directly:

```typescript
// Recommended: call internal install functions directly — no subprocess, no shell
import { runAdd } from './add.ts';

async function performUpdate(
  skillName: string,
  entry: SkillLockEntry
): Promise<{ success: boolean; error?: string }> {
  // Validate sourceUrl before use
  if (!isValidSourceUrl(entry.sourceUrl)) {
    return { success: false, error: `Invalid sourceUrl in lock file for ${skillName}` };
  }

  try {
    await runAdd([entry.sourceUrl], { global: true, yes: true, quiet: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isValidSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://github.com/${url}`);
    // Only allow GitHub, GitLab, and configured well-known domains
    const allowedHosts = ['github.com', 'raw.githubusercontent.com', 'gitlab.com'];
    return allowedHosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}
```

If the subprocess approach must be kept for architectural reasons, never use `shell: true` and
validate the URL against an allowlist before passing it as an argument:

```typescript
// Minimum fix if subprocess is required: validate URL + shell: false always
function buildUpdateArgs(installUrl: string, binaryName: string): string[] {
  // Strict URL validation — reject anything with shell metacharacters
  const safe = /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\/tree\/[a-zA-Z0-9_./:-]+)?$/.test(installUrl);
  if (!safe) throw new Error(`Rejected unsafe installUrl: ${installUrl}`);

  return ['-y', binaryName, 'add', installUrl, '-g', '-y'];
}

const result = spawnSync('npx', buildUpdateArgs(installUrl, binaryName), {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: false,  // NEVER shell: true
});
```

---

## 6. Security Architecture Recommendations

### 6.1 Source Authenticity Verification — Sigstore Integration

**Priority: High**

Implement a publisher verification model using Sigstore (the same infrastructure used by npm's
provenance attestations and Homebrew's formula signing). Skill publishers sign a release manifest
in CI; the CLI verifies the signature against the publisher's GitHub Actions OIDC identity.

```typescript
// Reference implementation using @sigstore/verify
// Publisher's GitHub Actions workflow:
//   - runs: cosign sign-blob SKILL.md --bundle SKILL.md.sigstore.json
//           --certificate-identity https://github.com/org/repo/.github/workflows/release.yml@refs/heads/main
//           --certificate-oidc-issuer https://token.actions.githubusercontent.com

interface VerificationPolicy {
  owner: string;
  repo: string;
  requiredWorkflow: string;   // e.g. ".github/workflows/release.yml"
  allowUnsigned: boolean;     // false in enterprise mode
}

// ~/.agents/.skill-policy.json — user-managed trust store
interface SkillPolicy {
  defaultAllowUnsigned: boolean;
  trustedPublishers: VerificationPolicy[];
  blockedSources: string[];  // explicit deny list
}
```

For the short term (before signing infrastructure is widely adopted), enforce the `/audit` risk
score as a gate: block skills with `high` or `critical` risk scores unless `--force` is passed.
Currently the audit data is displayed but does not affect installation.

---

### 6.2 Content Policy Framework

**Priority: High**

Consolidate all content validation into a single pipeline that runs before any skill is written to
disk. The framework from §3.1 above should be the canonical validation path for all install sources:
GitHub clone, well-known endpoint, local path, and `experimental_sync`.

Validation layers in priority order:
1. **Size gate** — reject files over 512 KB (prevents resource exhaustion).
2. **Structure validation** — require valid YAML frontmatter with `name` and `description`.
3. **Heuristic threat scan** — flag known injection patterns (prompt override, exfiltration).
4. **Audit API gate** — block if risk score is `high` or `critical`.
5. **Signature verification** — verify Sigstore bundle if present; warn if absent for known publishers.

---

### 6.3 Network Security Controls

**Priority: Medium**

Implement a consistent network policy applied to all outbound HTTP calls:

```typescript
// src/http-policy.ts — centralized network controls
export interface FetchPolicy {
  maxResponseBytes: number;
  timeoutMs: number;
  allowedHosts?: string[];       // undefined = allowlist not enforced (used for GitHub API)
  blockInternalRanges: boolean;  // always true for well-known fetches
}

export const POLICIES = {
  githubApi: {
    maxResponseBytes: 10 * 1024 * 1024,   // 10 MB (tree API responses can be large)
    timeoutMs: 10_000,
    blockInternalRanges: false,            // GitHub is a known external host
  } satisfies FetchPolicy,

  wellKnownIndex: {
    maxResponseBytes: 64 * 1024,           // 64 KB
    timeoutMs: 10_000,
    blockInternalRanges: true,
  } satisfies FetchPolicy,

  wellKnownSkillFile: {
    maxResponseBytes: 512 * 1024,          // 512 KB
    timeoutMs: 10_000,
    blockInternalRanges: true,
  } satisfies FetchPolicy,

  telemetry: {
    maxResponseBytes: 1024,                // Only need status code
    timeoutMs: 3_000,
    blockInternalRanges: false,
  } satisfies FetchPolicy,
} as const;
```

---

### 6.4 Principle of Least Privilege — GitHub Token Scopes

**Priority: Medium**

Document the minimum GitHub token scopes required per operation and enforce them at call sites:

| Operation | Minimum Scope | Notes |
|-----------|--------------|-------|
| Install from public repo | None | GitHub API allows unauthenticated reads |
| Install from private repo | `contents: read` (fine-grained PAT, repo-scoped) | Classic tokens: `repo` |
| Check updates (public) | None | GitHub Trees API public access |
| Check updates (private) | `contents: read` | Same as install |
| Push/publish skills | Not applicable | CLI is read-only |

Explicitly validate that `GITHUB_TOKEN` in CI environments (which defaults to full `repo` scope)
is not used for read-only operations where a narrower scope token should be configured.

---

### 6.5 Audit Logging for Agent-Impacting Actions

**Priority: Medium**

All actions that modify files loaded by AI agents should produce an audit trail stored locally
(not just sent as telemetry). This supports incident response: if a developer suspects a skill
caused unexpected AI behavior, they can audit exactly what was installed when.

```typescript
// src/audit-log.ts — local append-only audit log
interface AuditEntry {
  timestamp: string;
  action: 'install' | 'update' | 'remove' | 'sync';
  skillName: string;
  sourceUrl: string;
  contentSha256: string;     // hash of the SKILL.md content at install time
  publisherVerified: boolean;
  auditScore?: string;       // risk score from /audit API
  agentTargets: string[];
}

async function appendAuditLog(entry: AuditEntry): Promise<void> {
  const logPath = join(homedir(), '.agents', '.skill-audit.jsonl');
  const line = JSON.stringify(entry) + '\n';
  await appendFile(logPath, line, { mode: 0o600 });
}
```

This log should be distinct from the lock file — it is append-only and records the full history of
every change, not just the current state.

---

## Summary — Risk Register

| # | Finding | Severity | Effort | Priority |
|---|---------|----------|--------|----------|
| 3.1 | Prompt injection via unvalidated SKILL.md content | Critical | Medium | 1 |
| 5.1 | Command injection via shell: true on Windows | High | Low | 2 |
| 3.2 | experimental_sync installs from transitive deps without allowlist | High | Low | 3 |
| 1.3 | SSRF + unbounded responses in well-known provider | High | Low | 4 |
| 1.2 | No content signing for remote skill downloads | High | High | 5 |
| 4.2 | Lock file tamper — no HMAC / integrity check | Medium | Medium | 6 |
| 1.1 | Skill inventory disclosed to check-updates server | Medium | Low | 7 |
| 1.4 | Telemetry sent without consent, includes source URLs | Medium | Low | 8 |
| 2.1 | GitHub token format not validated after gh CLI exec | Medium | Low | 9 |
| 2.2 | Over-privileged GitHub tokens accepted without guidance | Medium | Low | 10 |
| 4.1 | Lock file written with 0o644 (world-readable) | Medium | Low | 11 |
| 3.3 | No formal publisher trust model | Medium | High | 12 |
| 4.3 | TOCTOU race in symlink creation | Low | Medium | 13 |
| 4.4 | Windows junction removal may delete target contents | Low | Low | 14 |
| 2.3 | Private repo check made unauthenticated | Low | Low | 15 |

---

## Immediate Actions (Before Next Release)

These require minimal code change and address the highest-impact issues:

1. **Fix shell: true** (`src/cli.ts:901`): Change `shell: process.platform === 'win32'` to
   `shell: false` and add URL validation before passing `installUrl` to `spawnSync`.

2. **Add content policy** (`src/add.ts`, `src/sync.ts`): Add the structural validation function
   from §3.1 to the install pipeline. At minimum, validate YAML frontmatter before writing.

3. **Fix lock file permissions** (`src/skill-lock.ts:writeSkillLock`): Change `writeFile(lockPath,
   content, 'utf-8')` to explicitly pass mode `0o600`.

4. **Add response size limits** (`src/providers/wellknown.ts`): Apply `MAX_SKILL_FILE_BYTES` cap
   using streaming reads in `fetchSkillByEntry`.

5. **Block experimental_sync without allowlist** (`src/sync.ts`): Require `skills.config.json`
   with `syncAllowlist` before crawling node_modules.

6. **Change audit score from advisory to gating** (`src/add.ts`): Block installation when
   `fetchAuditData` returns `risk: 'high'` or `risk: 'critical'` unless `--force` is passed.

---

*This review covers the codebase as of branch `v1.0.6/refactor_update_command` (commit `47d977c`),
reviewed on 2026-03-18. Re-review is recommended after implementing the content signing
infrastructure described in §6.1.*
