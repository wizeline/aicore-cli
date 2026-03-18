# Secure Code Review Report — aicore-cli

## Review Metadata

| Field | Value |
| ------- | ------- |
| **Application / Component** | aicore-cli (TypeScript/Node.js CLI — skill installer) |
| **Reviewer** | Security Agent (Claude Sonnet 4.6) |
| **Date** | 2026-03-18 |
| **Files Reviewed** | `src/cli.ts`, `src/installer.ts`, `src/source-parser.ts`, `src/skill-lock.ts`, `src/local-lock.ts`, `src/git.ts`, `src/sync.ts`, `src/telemetry.ts`, `src/providers/wellknown.ts` |
| **Language / Framework** | TypeScript 5 / Node.js ESM, pnpm, esbuild, vitest |
| **ASVS Target Level** | L2 — tool distributes executable content to developer machines, handles GitHub tokens, and communicates with external APIs |
| **Review Scope** | Full source files for all security-relevant modules listed above |

---

## Executive Summary

aicore-cli installs AI agent "skills" (markdown prompt files and associated assets) from
GitHub repositories, GitLab repositories, local paths, and arbitrary HTTPS endpoints into
developer workstations and CI environments. Because the tool fetches remote content and
writes it into directories that AI coding assistants read as instructions, the security
surface is unusually wide: a compromised install path can silently alter the behaviour of
an AI assistant for every user who has that skill installed.

Three risks dominate the threat model:

**1. Supply-chain code execution via `shell: true` spawn (CR-01).** The update command in
`src/cli.ts` calls `spawnSync('npx', [..., installUrl, ...], { shell: process.platform === 'win32' })`.
On Windows, `shell: true` passes the entire argument list through `cmd.exe`, enabling shell
metacharacter injection if `installUrl` contains characters such as `&`, `;`, `$(`, or
backticks. An attacker who can write to the project's lock file — or who supplies a
malicious `sourceUrl` through a shared repository — can achieve arbitrary command execution
on the developer's Windows machine.

**2. Unvalidated content from `experimental_sync` (CR-02).** The sync feature crawls
`node_modules` for SKILL.md files and installs whatever it finds without verifying the
package's integrity or authenticity against any allow-list. Any malicious npm package that
ships a SKILL.md will silently gain persistent access to the user's AI assistant context
with no warning beyond a one-time confirmation prompt that is bypassable with `-y`.

**3. Unbounded remote response ingestion in the well-known provider (HI-01).** The
`WellKnownProvider.fetchSkillByEntry` method calls `response.text()` on arbitrary HTTPS
responses with no size limit. A hostile or compromised skill server can return a
gigabyte-scale response, causing the Node.js process to exhaust heap memory and crash.

---

## Risk Summary

| Severity | Count | Recommended Action |
| ---------- | ------- | -------------------- |
| Critical | 2 | Block — must fix before next release |
| High | 4 | Fix within 7 days |
| Medium | 4 | Schedule in next sprint |
| Low / Info | 5 | Backlog / best-practice improvements |

---

## Findings — Prioritized

---

### Critical Findings

---

#### [CR-01] Shell Injection via `shell: true` in Update Spawn Call

| Field | Detail |
| ------- | -------- |
| **File / Line** | `src/cli.ts` — `runUpdate` / `spawnSync` block |
| **OWASP Category** | A05:2025 — Injection |
| **CWE** | CWE-78 — Improper Neutralization of Special Elements used in an OS Command (OS Command Injection) [Base, ALLOWED] |
| **ASVS Requirement** | V5.2.4 — Verify that the application does not use `eval()` or other dynamic code execution features. When calling OS commands the application must not pass user-controlled data to the shell interpreter. |
| **Exploitability** | 4 / 5 — Requires write access to the project lock file or supply of a malicious `sourceUrl` via a shared repository. |
| **Business Impact** | Arbitrary command execution as the developer running `npx skills update` on Windows, enabling credential theft, persistence, or lateral movement. |

**What was found:**

```typescript
// src/cli.ts — spawn with shell enabled on Windows
// installUrl is built by string-concatenating lock-file fields (sourceUrl, skillPath)
const result = spawnSync('npx', ['-y', binaryName, 'add', installUrl, '-g', '-y'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: process.platform === 'win32',  // resolves to true on Windows
});
```text

On Windows, `shell: true` causes Node.js to invoke `cmd.exe /C npx ... <installUrl> ...`.
Because `installUrl` is constructed from the lock file's `sourceUrl` field and the lock
file is a plain JSON file without integrity protection, a poisoned entry such as:

```text
https://github.com/owner/repo/tree/main/skills/foo & calc.exe
```text

would execute `calc.exe` (or any arbitrary payload) during `npx skills update` on Windows.
Even on non-Windows platforms the `installUrl` string is built by concatenating lock-file
fields without URL validation, so an unexpected `skillPath` value could produce a
malformed `add` command argument.

**Fix (in-language):**

```typescript
// src/cli.ts — validate the install URL before use; never enable shell

function assertSafeInstallUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[security] Invalid install URL in lock file: ${url}`);
  }
  const allowedHosts = new Set(['github.com', 'gitlab.com']);
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
    throw new Error(
      `[security] Lock file contains an untrusted install URL host: ${parsed.hostname}. ` +
      `Only github.com and gitlab.com are permitted.`
    );
  }
}

// Replace the existing spawnSync call:
assertSafeInstallUrl(installUrl);
const result = spawnSync('npx', ['-y', binaryName, 'add', installUrl, '-g', '-y'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: false,   // NEVER enable shell — arguments are passed as an array, not a shell string
});
```text

**Why this matters:** The lock file lives at a user-writable path and contains
externally-sourced strings. Any mechanism that can poison `sourceUrl` — a supply-chain
attack, a shared project lock file, or a symlink race — can escalate to arbitrary command
execution on every Windows developer machine that runs `update`. The fix costs one
function call and closes the entire injection surface.

**Automation note:** ESLint `no-restricted-syntax` can flag `shell: true` and
`shell: process.platform` in spawn calls. The Semgrep rule
`nodejs.child_process.security.child-process-injection` catches this pattern in CI.

---

#### [CR-02] Unvalidated node_modules Content Installation in `experimental_sync`

| Field | Detail |
| ------- | -------- |
| **File / Line** | `src/sync.ts:59–89` (`discoverNodeModuleSkills`), `src/sync.ts:329–333` |
| **OWASP Category** | A03:2025 — Software Supply Chain Failures |
| **CWE** | CWE-494 — Download of Code Without Integrity Check [Base, ALLOWED] |
| **ASVS Requirement** | V10.3.2 — Verify that the application does not execute code from untrusted sources without verification of integrity and authenticity. |
| **Exploitability** | 4 / 5 — Any npm package the developer installs (including transitive dependencies) can ship a SKILL.md. Dependency confusion, typosquatting, and malicious transitive dependencies are all viable vectors. |
| **Business Impact** | Persistent injection of adversarial instructions into the AI assistant context of every developer and CI environment that runs `experimental_sync`. Skills run with full agent permissions — acknowledged in the tool's own outro message. |

**What was found:**

```typescript
// src/sync.ts:61–64 — reads SKILL.md from any npm package, no signature or allow-list check
const rootSkill = await parseSkillMd(join(pkgDir, 'SKILL.md'));
if (rootSkill) {
  skills.push({ ...rootSkill, packageName });
  return;
}
// Also searches pkgDir/skills/ and pkgDir/.agents/skills/ — same trust level.
// The only gate is YAML frontmatter parsing (structure only, not authenticity).
```text

The `discoverNodeModuleSkills` function discovers skills in every installed npm package
directory. No signature, checksum, or allow-list check is performed. The confirmation
prompt is bypassable with `--yes` / `-y`, which is the default in CI and scripted
environments.

**Fix (in-language):**

```typescript
// src/sync.ts — require an explicit allow-list before installing any node_modules skill

interface SkillsConfig {
  syncAllowList?: string[];  // e.g., ["@acme/my-skill-pkg", "some-skill"]
}

async function loadSyncAllowList(cwd: string): Promise<Set<string>> {
  try {
    const pkgPath = join(cwd, 'package.json');
    const pkg = JSON.parse(
      await readFile(pkgPath, 'utf-8')
    ) as { skills?: SkillsConfig };
    const list = pkg.skills?.syncAllowList ?? [];
    return new Set(list);
  } catch {
    return new Set();
  }
}

// In discoverNodeModuleSkills — gate on the allow-list:
export async function discoverNodeModuleSkills(
  cwd: string
): Promise<Array<Skill & { packageName: string }>> {
  const allowList = await loadSyncAllowList(cwd);

  if (allowList.size === 0) {
    console.warn(
      '[skills] experimental_sync: no syncAllowList configured in package.json.\n' +
      '  Add "skills": { "syncAllowList": ["package-name"] } to enable sync.'
    );
    return [];
  }

  const processPackageDir = async (pkgDir: string, packageName: string) => {
    if (!allowList.has(packageName)) return;  // skip all packages not explicitly trusted
    // ... rest of existing discovery logic unchanged
  };
  // ... rest of function unchanged
}
```text

**Why this matters:** The npm ecosystem has a well-documented history of malicious packages
shipping hidden payloads. Allowing any installed dependency to inject AI assistant
instructions without an explicit trust declaration creates a persistent, silent
supply-chain attack surface. The tool's own outro text acknowledges this: "Review skills
before use; they run with full agent permissions."

**Automation note:** Add a vitest integration test that verifies a package not in
`syncAllowList` is never installed even when `--force` is passed.

---

### High Findings

---

#### [HI-01] Unbounded HTTP Response Size in Well-Known Provider

| Field | Detail |
| ------- | -------- |
| **File / Line** | `src/providers/wellknown.ts:247–253` (`fetchSkillByEntry`), line 121 (`fetchIndex`) |
| **OWASP Category** | A06:2025 — Insecure Design |
| **CWE** | CWE-400 — Uncontrolled Resource Consumption [Base, ALLOWED] |
| **ASVS Requirement** | V13.2.6 — Verify that the application rejects input that is excessively large (impose response body size limits on all HTTP client calls). |
| **Exploitability** | 3 / 5 — Requires control of a well-known endpoint (MITM, DNS hijack, or a malicious server the user intentionally points at). |
| **Business Impact** | Process memory exhaustion causing CLI crash (DoS). On memory-constrained CI runners this can cause job failure and OOM kills. |

**What was found:**

```typescript
// src/providers/wellknown.ts:252–253 — no size limit on response body
const content = await response.text();   // can be arbitrarily large
const { data } = matter(content);        // parses unbounded YAML/Markdown

// Same pattern for the index JSON (line 121):
const index = (await response.json()) as WellKnownIndex;

// And for each additional file in filePromises (line 271):
const fileContent = await fileResponse.text();
```text

**Fix (in-language):**

```typescript
// src/providers/wellknown.ts — enforce hard size caps before consuming bodies

const MAX_SKILL_FILE_BYTES = 512 * 1024;   // 512 KB per skill file
const MAX_INDEX_BYTES      = 64 * 1024;    // 64 KB for index.json

async function fetchTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(`Response too large: ${contentLength} bytes (limit ${maxBytes})`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Response body exceeded ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

// In fetchSkillByEntry — replace response.text():
const content = await fetchTextWithLimit(response, MAX_SKILL_FILE_BYTES);

// In fetchIndex — replace response.json():
const indexText = await fetchTextWithLimit(response, MAX_INDEX_BYTES);
const index = JSON.parse(indexText) as WellKnownIndex;

// In filePromises map — replace fileResponse.text():
const fileContent = await fetchTextWithLimit(fileResponse, MAX_SKILL_FILE_BYTES);
```text

**Why this matters:** A single attacker-controlled endpoint delivering a multi-megabyte
"skill file" would be indistinguishable from a legitimate skill until the OOM killer
terminates the process. This is a one-line-per-call fix that eliminates the entire class
of memory exhaustion attacks from the well-known provider.

---

#### [HI-02] Global Lock File Wiped on Version Mismatch — Silent Data Loss

| Field | Detail |
| ------- | -------- |
| **File / Line** | `src/skill-lock.ts:84–88` (`readSkillLock`) |
| **OWASP Category** | A10:2025 — Mishandling of Exceptional Conditions |
| **CWE** | CWE-755 — Improper Handling of Exceptional Conditions [Base, ALLOWED] |
| **ASVS Requirement** | V1.1.6 — Verify that all security controls fail securely (fail closed, not fail open). |
| **Exploitability** | 2 / 5 — Requires the attacker to decrement the `version` field in the lock file to a value less than 3. Trivially achievable if the attacker has write access to `~/.agents/.skill-lock.json`. |
| **Business Impact** | Complete loss of all skill tracking data. A targeted attacker can silently erase the lock file's hash records before installing a malicious skill, ensuring no hash comparison occurs on subsequent `update` runs. |

**What was found:**

```typescript
// src/skill-lock.ts:84–88 — silently discards all skill tracking data in-memory
if (parsed.version < CURRENT_VERSION) {
  return createEmptyLockFile();
  // Returns empty structure but does NOT write it back to disk.
  // The on-disk file still holds old-version entries; the first subsequent
  // writeSkillLock() call will overwrite the file with only the new entry,
  // permanently discarding every prior entry.
}
```text

**Fix (in-language):**

```typescript
// src/skill-lock.ts — migrate instead of wiping; preserve skill history

export async function readSkillLock(): Promise<SkillLockFile> {
  const lockPath = getSkillLockPath();
  try {
    const content = await readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as SkillLockFile;

    if (typeof parsed.version !== 'number' || !parsed.skills) {
      return createEmptyLockFile();
    }

    if (parsed.version < CURRENT_VERSION) {
      // Migrate: preserve skill names and source URLs; clear hash fields that
      // changed format. Users retain install history; hashes are re-fetched
      // on the next `update` or `check` run.
      console.warn(
        '[skills] Lock file schema migrated from v' + parsed.version +
        ' to v' + CURRENT_VERSION +
        '. Skill hashes will be refreshed on next update.'
      );
      const migrated: SkillLockFile = {
        version: CURRENT_VERSION,
        skills: {},
        dismissed: parsed.dismissed,
      };
      for (const [name, entry] of Object.entries(parsed.skills)) {
        migrated.skills[name] = {
          ...entry,
          skillFolderHash: '',  // repopulated on next check/update
        };
      }
      await writeSkillLock(migrated);  // write the migration immediately and atomically
      return migrated;
    }

    return parsed;
  } catch {
    return createEmptyLockFile();
  }
}
```text

**Why this matters:** Silent data destruction eliminates the audit trail needed to detect
tampered skills. An attacker who decrements the `version` field from 3 to 2 causes all
existing hash records to be silently dropped, bypassing the entire update-check mechanism
on the next write cycle.

---

#### [HI-03] `sanitizeSubpath` Does Not Canonicalize Before Checking — Path Traversal Bypass

| Field | Detail |
| ------- | -------- |
| **File / Line** | `src/source-parser.ts:89–105` (`sanitizeSubpath`) |
| **OWASP Category** | A01:2025 — Broken Access Control |
| **CWE** | CWE-22 — Improper Limitation of a Pathname to a Restricted Directory (Path Traversal) [Base, ALLOWED] |
| **ASVS Requirement** | V5.1.3 — Verify that all input is validated using positive (allow-list) validation on canonicalized input. |
| **Exploitability** | 3 / 5 — Requires a specially crafted GitHub tree URL passed to the CLI. Social engineering via a malicious link in a README, blog post, or chat is the primary delivery mechanism. |
| **Business Impact** | A crafted URL can place skill files outside the intended `.agents/skills/` directory, potentially overwriting arbitrary files in the developer's project. |

**What was found:**

```typescript
// src/source-parser.ts:89–105
export function sanitizeSubpath(subpath: string): string {
  const normalized = subpath.replace(/\\/g, '/');  // only replaces backslashes
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..') {         // checks for literal ".." only — no decoding first
      throw new Error(`Unsafe subpath: ...`);
    }
  }
  return subpath;  // returns the ORIGINAL un-canonicalized subpath
}
```text

The function normalizes backslashes but does not call `decodeURIComponent` or
`path.normalize` before splitting. An input such as `skills/foo/%2e%2e/evil`
(URL-encoded `..`) or `skills/foo/./../../evil` (dot-segment collapse) passes the
`segment === '..'` check because no literal `..` segment appears. The original
un-canonicalized subpath is then used in `join(clonedDir, subpath)` during the `add` flow.

**Fix (in-language):**

```typescript
// src/source-parser.ts — decode and canonicalize before checking
import { posix } from 'path';

export function sanitizeSubpath(subpath: string): string {
  // 1. Decode percent-encoding to surface encoded traversal sequences
  let decoded: string;
  try {
    decoded = decodeURIComponent(subpath);
  } catch {
    throw new Error(
      `Unsafe subpath: "${subpath}" contains invalid percent-encoding.`
    );
  }

  // 2. Normalize to forward slashes
  const forwardSlashed = decoded.replace(/\\/g, '/');

  // 3. Use posix.normalize to resolve . and .. segments without going absolute
  const canonicalized = posix.normalize(forwardSlashed);

  // 4. Reject any path that still starts with ".." or is absolute after canonicalization
  if (canonicalized.startsWith('..') || canonicalized.startsWith('/')) {
    throw new Error(
      `Unsafe subpath: "${subpath}" resolves to "${canonicalized}" which escapes the repository root.`
    );
  }

  // 5. "." means root — return empty string so callers handle it cleanly
  if (canonicalized === '.') {
    return '';
  }

  return canonicalized;
}
```text

**Why this matters:** Percent-encoding bypass is one of the most common techniques against
naive `..` detection. Because this function is the only guard between a user-supplied URL
and the filesystem write path for cloned content, a bypass directly enables writing files
outside the intended skills directory.

**Automation note:** Add a vitest unit test parameterized with the payloads `%2e%2e/evil`,
`./../../evil`, and `%252e%252e/evil` (double-encoded). Semgrep rule
`javascript.lang.security.detect-non-literal-fs-filename` flags related patterns.

---

#### [HI-04] GitHub Token Obtained via `execSync` — Blocking Call and Potential Token Exposure

| Field | Detail |
| ------- | -------- |
| **File / Line** | `src/skill-lock.ts:139–143` (`getGitHubToken`) |
| **OWASP Category** | A02:2025 — Security Misconfiguration |
| **CWE** | CWE-200 — Exposure of Sensitive Information to an Unauthorized Actor [Base, ALLOWED] |
| **ASVS Requirement** | V7.4.1 — Verify that sensitive information is not written to logs or debugging output. |
| **Exploitability** | 2 / 5 — Requires ability to intercept stdout/stderr in a CI context or to observe the child process argument list. |
| **Business Impact** | Exposure of a GitHub personal access token or OAuth token, enabling repository read (potentially write) access under the developer's identity. |

**What was found:**

```typescript
// src/skill-lock.ts:139–143
const token = execSync('gh auth token', {
  encoding: 'utf-8',
  stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
```text

`execSync` (not `execFileSync`) passes the command through a shell, making it vulnerable
to `PATH` hijacking (LO-03). Additionally, `execSync` blocks the event loop indefinitely
if `gh` hangs. If an error path upstream logs `token` or includes it in a thrown
`Error` message, the token value appears in captured CI output. No timeout is set.

**Fix (in-language):**

```typescript
// src/skill-lock.ts — use execFileSync with timeout; never log the returned value
import { execFileSync } from 'child_process';  // already imported as execSync — swap here

export function getGitHubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  try {
    // execFileSync (not execSync) avoids shell interpretation of arguments
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,   // prevent indefinite blocking
    }).trim();
    return token || null;
  } catch {
    // gh not installed, not authenticated, or timed out — caller falls back gracefully
    return null;
  }
}
```text

Also add a documentation note in the README and CI guidance that `GITHUB_TOKEN` or
`GH_TOKEN` should be set as a CI secret rather than relying on the `gh` CLI in automated
pipelines.

---

### Medium Findings

---

#### [ME-01] Telemetry Collected Without Explicit User Consent or First-Run Notice

| Field | Detail |
| ------- | -------- |
| **File / Line** | `src/telemetry.ts:79–81` (`isEnabled`), `src/telemetry.ts:131–158` (`track`) |
| **OWASP Category** | A06:2025 — Insecure Design |
| **CWE** | CWE-359 — Exposure of Private Personal Information to an Unauthorized Actor [Base, ALLOWED] |
| **ASVS Requirement** | V8.3.3 — Verify that users have methods to remove their data on request. V8.3.1 — Verify that sensitive data is identified and classified. |
| **Exploitability** | N/A — This is a privacy design gap, not a runtime exploit. |
| **Business Impact** | Potential GDPR/CCPA compliance exposure. Telemetry events include `source` (GitHub repository URL), `skills` (skill names), `agents` (agent directory names), and `query` strings from search. In regulated environments these may constitute personal or organizational data. |

**What was found:**

```typescript
// src/telemetry.ts:79–81 — opt-out only, no first-run notice
function isEnabled(): boolean {
  return !process.env.DISABLE_TELEMETRY && !process.env.DO_NOT_TRACK;
  // Telemetry is active from the very first invocation.
  // No consent screen, no README disclosure above the fold,
  // no mention in --help output.
}
```text

**Fix (in-language):**

```typescript
// src/telemetry.ts — display a one-time notice on first run; do not send telemetry
// until the notice has been shown (stored in the lock file's dismissed field)

export function maybePrintTelemetryNotice(hasSeenNotice: boolean): void {
  if (!hasSeenNotice && !process.env.DISABLE_TELEMETRY && !process.env.DO_NOT_TRACK) {
    process.stderr.write(
      '\n[skills] Usage analytics are enabled to help improve this tool.\n' +
      '  Set DISABLE_TELEMETRY=1 to opt out at any time.\n' +
      '  Details: https://skills.sh/privacy\n\n'
    );
  }
}

// isEnabled() remains unchanged for subsequent runs once notice has been shown.
// Call maybePrintTelemetryNotice() in cli.ts before the first command executes,
// passing the value of lock.dismissed?.telemetryNotice from readSkillLock().
```text

Additionally: document the telemetry data collected, the retention policy, and the
opt-out mechanism in `README.md` and in `--help` output.

---

#### [ME-02] Audit API Response Blindly Cast Without Runtime Schema Validation

| Field | Detail |
| ------- | -------- |
| **File / Line** | `src/telemetry.ts:118–128` (`fetchAuditData`) |
| **OWASP Category** | A08:2025 — Software and Data Integrity Failures |
| **CWE** | CWE-502 — Deserialization of Untrusted Data [Base, ALLOWED] |
| **ASVS Requirement** | V5.5.3 — Verify that deserialization of untrusted data uses safe parsing approaches that do not permit object instantiation or code execution. |
| **Exploitability** | 2 / 5 — Requires MITM or compromise of `add-skill.vercel.sh`. |
| **Business Impact** | A compromised audit server returning non-enum `risk` values could cause downstream code to display misleading risk scores (e.g., showing `safe` for a malicious skill). |

**What was found:**

```typescript
// src/telemetry.ts:125–126 — blind TypeScript cast, zero runtime validation
return (await response.json()) as AuditResponse;
```text

**Fix (in-language):**

```typescript
// src/telemetry.ts — validate the audit response structure at runtime before trusting it

const VALID_RISK_LEVELS = new Set(['safe', 'low', 'medium', 'high', 'critical', 'unknown']);

function isValidAuditResponse(data: unknown): data is AuditResponse {
  if (!data || typeof data !== 'object') return false;
  for (const skillData of Object.values(data as Record<string, unknown>)) {
    if (!skillData || typeof skillData !== 'object') return false;
    for (const audit of Object.values(skillData as Record<string, unknown>)) {
      const a = audit as Record<string, unknown>;
      if (!a || typeof a.risk !== 'string' || !VALID_RISK_LEVELS.has(a.risk)) return false;
    }
  }
  return true;
}

const raw = await response.json();
if (!isValidAuditResponse(raw)) return null;
return raw;
```text

---

#### [ME-03] Global Lock File Written with Default Permissions — Readable by All Local Users

| Field | Detail |
| ------- | -------- |
| **File / Line** | `src/skill-lock.ts:101–110` (`writeSkillLock`) |
| **OWASP Category** | A02:2025 — Security Misconfiguration |
| **CWE** | CWE-732 — Incorrect Permission Assignment for Critical Resource [Base, ALLOWED] |
| **ASVS Requirement** | V8.2.1 — Verify that the application sets appropriate file permissions when creating files. |
| **Exploitability** | 2 / 5 — Requires local filesystem access (another user or process on the same machine). |
| **Business Impact** | The lock file contains `sourceUrl` fields that include internal GitHub repository paths and may reflect tooling not publicly disclosed. On multi-user systems or shared CI agents the file is readable by all local users under default umask settings. |

**What was found:**

```typescript
// src/skill-lock.ts:108 — writes with default umask (typically 0o644 — world-readable)
await writeFile(lockPath, content, 'utf-8');
```text

**Fix (in-language):**

```typescript
// src/skill-lock.ts — write with owner-only permissions
await writeFile(lockPath, content, { encoding: 'utf-8', mode: 0o600 });
// 0o600 = owner read/write only; no group or world access
```text

---

#### [ME-04] `isRepoPrivate` GitHub API Call Is Unauthenticated — Rate Limit Risk

| Field | Detail |
| ------- | -------- |
| **File / Line** | `src/source-parser.ts:68–81` (`isRepoPrivate`) |
| **OWASP Category** | A07:2025 — Authentication Failures |
| **CWE** | CWE-306 — Missing Authentication for Critical Function [Base, ALLOWED] |
| **ASVS Requirement** | V13.2.1 — Verify that API requests include appropriate authentication. |
| **Exploitability** | 2 / 5 — The GitHub unauthenticated rate limit is 60 requests/hour per IP. On shared CI IPs this is easily exhausted. |
| **Business Impact** | In a rate-limited environment `isRepoPrivate` silently returns `null` (treated as "unable to determine"), disabling the private-repo detection that guards against accidentally disclosing private repository paths. |

**What was found:**

```typescript
// src/source-parser.ts:68–70 — unauthenticated GitHub API call
const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
// getGitHubToken() exists in skill-lock.ts but is not used here
```text

**Fix (in-language):**

```typescript
// src/source-parser.ts — use the existing token helper for authenticated requests
import { getGitHubToken } from './skill-lock.ts';

export async function isRepoPrivate(owner: string, repo: string): Promise<boolean | null> {
  try {
    const token = getGitHubToken();
    const headers: HeadersInit = { 'User-Agent': 'skills-cli' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      { headers }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { private?: boolean };
    return data.private === true;
  } catch {
    return null;
  }
}
```text

---

### Low / Informational Findings

| ID | Title | OWASP | CWE | ASVS | Note |
| ---- | ------- | ------- | ----- | ------ | ------ |
| LO-01 | `sanitizeName` preserves interior dots — `my.env` installs as `my.env/` | A01:2025 | CWE-73 — External Control of File Name or Path | V5.1.3 | `sanitizeName('my.env')` returns `my.env`. Benign in the skills directory today but note for future agent types that read dotfiles. Consider blocking names matching dotfile patterns if the agent directory list expands. |
| LO-02 | `cloneRepo` `ref` parameter unvalidated before passing to `simple-git` | A05:2025 | CWE-77 — Command Injection | V5.2.4 | `simple-git` passes `ref` as an array element (safe today). If the implementation ever changes to `execSync`, the unvalidated `ref` — sourced from a URL `#fragment` — becomes injectable. Validate `ref` against `/^[a-zA-Z0-9._\/-]+$/` as precaution. |
| LO-03 | `execSync('gh auth token')` trusts `PATH` — vulnerable to `PATH` hijacking | A02:2025 | CWE-426 — Untrusted Search Path | V14.2.1 | A malicious binary named `gh` earlier in `PATH` (e.g., in a compromised npm `.bin/`) will be executed. Switching to `execFileSync` (HI-04 fix) is necessary but not sufficient; document the known-good `gh` binary path or validate via `which gh` before use. |
| LO-04 | `copyDirectory` uses `dereference: true` — follows symlinks in cloned repos | A01:2025 | CWE-61 — UNIX Symbolic Link Following | V5.1.3 | A malicious skill repository containing a symlink pointing to `/etc/passwd` or `~/.ssh/id_rsa` would cause that file to be copied into the destination skill directory. Add a pre-copy check that rejects symlinks in the cloned source tree that resolve outside the clone directory. |
| LO-05 | `GitCloneError` embeds full clone URL in error message — token exposure risk | A09:2025 | CWE-209 — Generation of Error Message Containing Sensitive Information | V7.4.1 | If the URL is of the form `https://token@github.com/...`, the token appears in the thrown error. Sanitize URLs before including them in error messages: `url.replace(/:\/\/[^@]+@/, '://<redacted>@')`. |

---

## Remediation Guides for Critical Findings

---

### Remediation Guide — CR-01: Shell Injection in Update Spawn Call

| Field | Value |
| ------- | ------- |
| **Finding ID** | CR-01 |
| **Title** | Shell Injection via `shell: true` in Update Spawn Call |
| **Severity** | Critical |
| **OWASP Category** | A05:2025 — Injection |
| **CWE** | CWE-78 — OS Command Injection |
| **ASVS Requirement** | V5.2.4 |
| **Reported On** | 2026-03-18 |
| **Target Fix Date** | Before next public release |
| **Owner** | — |
| **Status** | Open |

#### What Is the Problem?

On Windows, `spawnSync(..., { shell: process.platform === 'win32' })` evaluates to
`shell: true`, which causes Node.js to invoke `cmd.exe /C npx ... <installUrl> ...`.
Any shell metacharacters present in `installUrl` — which is built from the lock file's
`sourceUrl` field — are interpreted by `cmd.exe`. Because the lock file is a
user-writable JSON file without integrity protection, an attacker who can modify it (or
supply a malicious project lock file via a shared repository) can inject arbitrary commands.

#### Why Does It Matter?

An attacker who controls `sourceUrl` in the lock file can execute arbitrary commands
as the developer running `npx skills update` on Windows. This enables credential theft
(reading `~/.ssh` keys, `GITHUB_TOKEN`), persistence (adding startup entries), or lateral
movement in corporate environments.

#### Root Cause

`installUrl` is built by string-concatenating `update.entry.sourceUrl` with a skill path.
No URL allow-listing or shell metacharacter validation is applied before the value is
passed to `spawnSync` with `shell: true` on Windows.

---

#### Step 1: Understand the Scope

Find all spawn/exec calls in the codebase:

```bash
grep -rn "spawn\|execSync\|exec(" /Users/pablo.andres/Workspace/github/aicore-cli/src --include="*.ts"
```text

Verify that `installUrl` is the only external-sourced string passed to a shell-enabled
spawner. Confirm no other `spawn`/`exec`/`execSync` calls receive lock-file-derived values
without prior validation.

---

#### Step 2: Apply the Fix

**Before (vulnerable on Windows):**

```typescript
// src/cli.ts — shell enabled; installUrl from lock file is unsanitized
const result = spawnSync('npx', ['-y', binaryName, 'add', installUrl, '-g', '-y'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
```text

**After (remediated — all platforms):**

```typescript
// src/cli.ts — validate URL before use; shell always false

function assertSafeInstallUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[security] Invalid install URL in lock file: ${url}`);
  }
  const allowedHosts = new Set(['github.com', 'gitlab.com']);
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
    throw new Error(
      `[security] Lock file contains an untrusted install URL host: ${parsed.hostname}. ` +
      `Only github.com and gitlab.com are permitted.`
    );
  }
}

// In the update flow, before the spawnSync call:
assertSafeInstallUrl(installUrl);
const result = spawnSync('npx', ['-y', binaryName, 'add', installUrl, '-g', '-y'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: false,   // NEVER shell: true — arguments passed as array, not shell string
});
```text

**Key changes:**
1. `shell: false` on all platforms — arguments bypass `cmd.exe`/`sh` entirely.
2. `assertSafeInstallUrl` validates URL protocol and host against an explicit allow-list.
3. Validation runs on all platforms (not just Windows) as defence-in-depth.

---

#### Step 3: Test the Fix

**Functional test:**

```typescript
// vitest — verify a valid GitHub URL passes validation
import { describe, it, expect } from 'vitest';

describe('assertSafeInstallUrl', () => {
  it('accepts a valid github.com HTTPS URL', () => {
    expect(() =>
      assertSafeInstallUrl('https://github.com/owner/repo/tree/main/skills/my-skill')
    ).not.toThrow();
  });

  it('accepts a valid gitlab.com HTTPS URL', () => {
    expect(() =>
      assertSafeInstallUrl('https://gitlab.com/owner/repo')
    ).not.toThrow();
  });
});
```text

**Security test:**

```typescript
describe('assertSafeInstallUrl — injection payloads', () => {
  const payloads = [
    'https://github.com/owner/repo & calc.exe',   // Windows metachar — URL parse error
    'https://evil.com/owner/repo',                // wrong host
    'http://github.com/owner/repo',               // HTTP not HTTPS
    'file:///etc/passwd',                         // file protocol
    '',                                           // empty string
  ];
  for (const payload of payloads) {
    it(`rejects: "${payload}"`, () => {
      expect(() => assertSafeInstallUrl(payload)).toThrow();
    });
  }
});
```text

| Test | Input | Expected Result |
| ------ | ------- | ----------------- |
| Valid URL | `https://github.com/owner/repo/tree/main/skills/foo` | Passes silently |
| Shell metachar | `https://github.com/owner/repo & calc.exe` | Throws — URL parse fails |
| Wrong host | `https://evil.com/skill` | Throws — untrusted host |
| HTTP | `http://github.com/owner/repo` | Throws — wrong protocol |
| Empty | `` | Throws — URL parse fails |

---

#### Step 4: Prevent Recurrence

| Mechanism | Action |
| ----------- | -------- |
| ESLint rule | `no-restricted-syntax` — flag `shell: true` and `shell: process.platform` in spawn calls |
| Semgrep | Enable `nodejs.child_process.security.child-process-injection` in CI |
| Code review checklist | Add: "No `shell: true` in spawn/exec calls with external string arguments" |
| CI gate | Fail build on any Semgrep finding of type `child-process-injection` |
| Developer training | OWASP Command Injection: https://owasp.org/www-community/attacks/Command_Injection |

---

#### Step 5: Deploy and Verify

- [ ] Code review approved
- [ ] Security tests (`assertSafeInstallUrl`) passing in vitest
- [ ] Semgrep scan shows CR-01 pattern resolved
- [ ] Manual test on Windows: `npx skills update` works with a valid lock file
- [ ] Manual test on Windows: lock file with `sourceUrl` containing `& calc.exe` is rejected before spawn
- [ ] Deployed to staging; behaviour confirmed
- [ ] Finding marked **Resolved** in issue tracker

---

#### References

| Resource | Link |
| ---------- | ------ |
| OWASP Command Injection | https://owasp.org/www-community/attacks/Command_Injection |
| CWE-78 Definition | https://cwe.mitre.org/data/definitions/78.html |
| ASVS V5.2.4 | https://owasp.org/www-project-application-security-verification-standard/ |
| Node.js child_process safety | https://nodejs.org/api/child_process.html#child_processspawncommand-args-options |

---

#### Verification Sign-Off

| Role | Name | Date | Signature |
| ------ | ------ | ------ | ----------- |
| Developer (fix implemented) | | | |
| Reviewer (fix verified) | | | |
| Security (finding closed) | | | |

---

### Remediation Guide — CR-02: Unvalidated node_modules Content in `experimental_sync`

| Field | Value |
| ------- | ------- |
| **Finding ID** | CR-02 |
| **Title** | Unvalidated node_modules Content Installation in `experimental_sync` |
| **Severity** | Critical |
| **OWASP Category** | A03:2025 — Software Supply Chain Failures |
| **CWE** | CWE-494 — Download of Code Without Integrity Check |
| **ASVS Requirement** | V10.3.2 |
| **Reported On** | 2026-03-18 |
| **Target Fix Date** | Before `experimental_sync` exits experimental status |
| **Owner** | — |
| **Status** | Open |

#### What Is the Problem?

`experimental_sync` crawls the entire `node_modules` tree and installs any SKILL.md it
finds into AI assistant context directories. Any malicious or compromised npm package that
ships a SKILL.md file gains persistent, unsandboxed access to the developer's AI assistant
instructions with no verification beyond YAML frontmatter parsing.

#### Why Does It Matter?

The npm ecosystem has a well-documented history of malicious packages shipping hidden
payloads via dependency confusion, typosquatting, and compromised transitive dependencies.
Allowing any installed dependency to inject AI assistant instructions without an explicit
trust declaration creates a persistent, silent supply-chain attack surface. The tool's own
outro text acknowledges this: "Review skills before use; they run with full agent
permissions."

#### Root Cause

The trust model assumes that every npm package in `node_modules` is implicitly trusted as
a skill source. There is no allow-list, no package provenance check, no content hash
verification, and no explicit per-package user acknowledgement. The `-y` flag bypasses
the sole confirmation prompt.

---

#### Step 1: Understand the Scope

Find all paths that read skill content from `node_modules`:

```bash
grep -rn "node_modules" /Users/pablo.andres/Workspace/github/aicore-cli/src --include="*.ts"
```text

Confirm that `discoverNodeModuleSkills` in `src/sync.ts` is the only entry point for
node_modules-sourced content, and that `parseSkillMd` is the sole parser used.

---

#### Step 2: Apply the Fix

**Before (vulnerable — trusts all node_modules packages):**

```typescript
// src/sync.ts:61–64
const rootSkill = await parseSkillMd(join(pkgDir, 'SKILL.md'));
if (rootSkill) {
  skills.push({ ...rootSkill, packageName });
  return;
}
```text

**After (remediated — allow-list required):**

```typescript
// src/sync.ts — add allow-list gating before any skill discovery

interface SkillsConfig {
  syncAllowList?: string[];
}

async function loadSyncAllowList(cwd: string): Promise<Set<string>> {
  try {
    const pkgPath = join(cwd, 'package.json');
    const pkg = JSON.parse(
      await readFile(pkgPath, 'utf-8')
    ) as { skills?: SkillsConfig };
    const list = pkg.skills?.syncAllowList ?? [];
    return new Set(list);
  } catch {
    return new Set();
  }
}

// In discoverNodeModuleSkills — add this at the top of the function:
export async function discoverNodeModuleSkills(
  cwd: string
): Promise<Array<Skill & { packageName: string }>> {
  const allowList = await loadSyncAllowList(cwd);

  if (allowList.size === 0) {
    console.warn(
      '[skills] experimental_sync: no syncAllowList configured.\n' +
      '  Add "skills": { "syncAllowList": ["package-name"] } to package.json to enable sync.'
    );
    return [];
  }

  const processPackageDir = async (pkgDir: string, packageName: string) => {
    if (!allowList.has(packageName)) return;  // skip all unlisted packages

    const rootSkill = await parseSkillMd(join(pkgDir, 'SKILL.md'));
    if (rootSkill) {
      skills.push({ ...rootSkill, packageName });
      return;
    }
    // ... rest of existing discovery logic
  };
  // ... rest of function
}
```text

**Key changes:**
1. `loadSyncAllowList` reads an explicit `skills.syncAllowList` array from `package.json`.
2. Any package not in the allow-list is silently skipped during discovery.
3. If the allow-list is absent or empty, the function returns no skills and prints a warning.

---

#### Step 3: Test the Fix

**Security test:**

```typescript
// vitest
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { discoverNodeModuleSkills } from '../src/sync.ts';

describe('discoverNodeModuleSkills — allow-list enforcement', () => {
  const testCwd = '/tmp/skill-sync-test';

  beforeAll(async () => {
    // Create a mock package with a SKILL.md
    await mkdir(join(testCwd, 'node_modules', 'evil-package'), { recursive: true });
    await writeFile(
      join(testCwd, 'node_modules', 'evil-package', 'SKILL.md'),
      '---\nname: evil\ndescription: malicious\n---\n# Evil Skill\n'
    );
    // package.json with NO syncAllowList
    await writeFile(join(testCwd, 'package.json'), JSON.stringify({}));
  });

  afterAll(async () => { await rm(testCwd, { recursive: true, force: true }); });

  it('returns no skills when syncAllowList is absent', async () => {
    const skills = await discoverNodeModuleSkills(testCwd);
    expect(skills).toHaveLength(0);
  });

  it('returns no skills when package is not in syncAllowList', async () => {
    await writeFile(
      join(testCwd, 'package.json'),
      JSON.stringify({ skills: { syncAllowList: ['trusted-package'] } })
    );
    const skills = await discoverNodeModuleSkills(testCwd);
    expect(skills).toHaveLength(0);
  });
});
```text

| Test | Setup | Expected Result |
| ------ | ------- | ----------------- |
| No allow-list | `package.json` has no `skills` field | 0 skills discovered |
| Package not in list | `syncAllowList: ['other-pkg']` | 0 skills discovered |
| Package in list | `syncAllowList: ['evil-package']` | 1 skill discovered |
| `--force` with no list | `--force` flag, no allow-list | Still 0 skills |

---

#### Step 4: Prevent Recurrence

| Mechanism | Action |
| ----------- | -------- |
| CLI guard | Exit with error if `syncAllowList` is absent and display setup instructions |
| Help text | Document `syncAllowList` requirement in `experimental_sync --help` output |
| Feature flag | Maintain `experimental_` prefix until allow-list mechanism is validated in production use |
| README | Add a security notice to the `experimental_sync` documentation section |

---

#### Step 5: Deploy and Verify

- [ ] Code review approved
- [ ] Security tests passing in vitest
- [ ] Manual test: `experimental_sync` with no `syncAllowList` prints warning and installs nothing
- [ ] Manual test: `experimental_sync` with an allow-listed package installs correctly
- [ ] Manual test: `experimental_sync --yes` with no allow-list still installs nothing
- [ ] Finding marked **Resolved** in issue tracker

---

#### References

| Resource | Link |
| ---------- | ------ |
| OWASP Supply Chain | https://owasp.org/www-project-top-ten/2021/A06_2021-Vulnerable_and_Outdated_Components |
| CWE-494 Definition | https://cwe.mitre.org/data/definitions/494.html |
| npm supply chain attacks | https://github.com/nicowillis/npm-supply-chain-attacks |

---

#### Verification Sign-Off

| Role | Name | Date | Signature |
| ------ | ------ | ------ | ----------- |
| Developer (fix implemented) | | | |
| Reviewer (fix verified) | | | |
| Security (finding closed) | | | |

---

## Secure Code Review Checklist — TypeScript CLI with Filesystem and Remote Operations

**Application:** aicore-cli
**Reviewer:** Security Agent
**Date:** 2026-03-18
**Language / Framework:** TypeScript / Node.js ESM

### Child Process Safety
- [ ] No `shell: true` (or `shell: process.platform === 'win32'`) in `spawn`/`spawnSync` calls that receive external string arguments
- [ ] All strings passed as child process arguments are validated against an allow-list before use
- [ ] `execSync` replaced with `execFileSync` wherever possible to avoid shell interpretation
- [ ] Child process calls have explicit timeouts set
- [ ] No subprocess argument is derived from untrusted input (lock files, remote URLs) without prior validation

### Path and Filesystem Safety
- [ ] All user-supplied paths are canonicalized with `path.resolve` or `posix.normalize` before `..` checks
- [ ] Percent-encoded path segments are decoded with `decodeURIComponent` before traversal checks
- [ ] `isPathSafe(base, target)` is called after construction of every filesystem target path
- [ ] File writes on sensitive paths use restrictive permissions (`mode: 0o600`)
- [ ] Symlinks followed during directory copy are validated to remain within the source tree
- [ ] Temporary directories created with `mkdtemp` are cleaned up in `finally` or `catch` blocks

### HTTP Client Safety
- [ ] All HTTP responses have explicit body size limits before `response.text()` or `response.json()`
- [ ] JSON responses from external servers are validated against a schema at runtime (not just `as Type`)
- [ ] GitHub API calls use an authentication token when one is available
- [ ] HTTP timeouts are set on all `fetch` calls (using `AbortController` and `setTimeout`)
- [ ] Only `https:` URLs are accepted for remote skill sources (reject `http:` and `file:`)

### Supply Chain and Integrity
- [ ] Content installed from `node_modules` requires an explicit allow-list in project config
- [ ] Lock file entries are validated (URL allow-listed, source type known) before use in spawn calls
- [ ] Lock file schema migrations preserve existing data rather than silently wiping it
- [ ] Lock file is written with restrictive permissions (`mode: 0o600`)

### Secret Management
- [ ] GitHub tokens are never written to logs, error messages, or telemetry
- [ ] `execFileSync` is used instead of `execSync` for credential-retrieving commands
- [ ] Error messages containing URLs strip any credential components (`user:pass@host`)
- [ ] Tokens retrieved via child process are not stored in variables that persist beyond immediate use

### Telemetry and Privacy
- [ ] Telemetry is opt-out with a visible first-run notice
- [ ] The opt-out mechanism is documented in `README.md` and `--help` output
- [ ] Telemetry payloads do not include tokens, filesystem paths outside the project, or PII
- [ ] Telemetry is automatically suppressed when `CI` environment variables are present

### Input Validation
- [ ] Subpaths from user-supplied URLs are decoded and canonicalized before traversal checks
- [ ] Skill names are sanitized with `sanitizeName` before use in filesystem paths
- [ ] Git `ref` values are validated against `/^[a-zA-Z0-9._\/-]+$/` before use
- [ ] Agent type values from CLI arguments are validated against the known agent registry

### Error Handling
- [ ] No sensitive data (tokens, full filesystem paths, internal error details) in user-facing error messages
- [ ] All async install/remove operations have `try/catch` with safe fallback behaviour
- [ ] Version migration failures produce a warning and preserve existing data rather than silently wiping

---

## ASVS Level 2 Gap Analysis

| ASVS Chapter | L2 Status | Gap / Finding |
| -------------- | ----------- | --------------- |
| **V1 — Architecture, Design & Threat Modeling** | Partial | No formal threat model documented. Trust boundaries between the CLI, lock file, and remote endpoints are implemented in code but not documented architecturally. |
| **V2 — Authentication** | N/A | Not applicable — CLI tool has no user authentication. GitHub token handling addressed under V7/V8. |
| **V3 — Session Management** | N/A | No sessions. |
| **V4 — Access Control** | Partial | `isPathSafe` is implemented and called before every write. Gap: `sanitizeSubpath` does not canonicalize before checking (HI-03). Lock file write permissions too permissive (ME-03). |
| **V5 — Validation, Sanitization and Encoding** | Partial | `sanitizeName` well-implemented. `sanitizeSubpath` has a percent-encoding bypass (HI-03). HTTP response bodies not size-limited (HI-01). Audit response lacks runtime schema validation (ME-02). |
| **V6 — Stored Cryptography** | Meets L1 | SHA-256 used for local hash computation. GitHub tree SHAs for remote comparison. No cryptographic signing of lock file entries — design choice that enables lock-file-poisoning risk in CR-01. |
| **V7 — Error Handling and Logging** | Partial | `GitCloneError` embeds full URLs in messages (LO-05). No centralized error handler. Gap: token values could surface in error paths from `getGitHubToken`. |
| **V8 — Data Protection** | Partial | Lock file written without restrictive permissions (ME-03). Telemetry collects source URLs and skill names without first-run consent notice (ME-01). No data classification policy documented. |
| **V9 — Communications** | Meets L1 | All external HTTP calls use `https:`. Node.js default certificate validation. No custom certificate pinning — acceptable at L2. |
| **V10 — Malicious Code Verification** | Fails L2 | `experimental_sync` installs SKILL.md from any npm package without integrity verification (CR-02). No SBOM generated for distributed releases. No content hash verification for well-known provider files. |
| **V13 — API and Web Service** | Partial | `isRepoPrivate` GitHub API call unauthenticated (ME-04). No rate-limit handling for HTTP 429 responses. Audit API response not schema-validated at runtime (ME-02). |
| **V14 — Configuration** | Partial | `shell: true` on Windows in spawn call (CR-01). Lock file permissions not restricted (ME-03). `execSync` for `gh auth token` trusts `PATH` (LO-03, HI-04). |

**L2 Compliance Summary:** The project meets L1 requirements in most categories. The most
significant L2 gaps are in supply-chain integrity (V10), input validation (V5), and
configuration hardening (V14). Addressing CR-01, CR-02, HI-01, HI-02, and HI-03 would
close the highest-priority L2 gaps.

---

## OWASP Top 10 (2025) Coverage

| OWASP Category | Status | Findings |
| ---------------- | -------- | ---------- |
| A01 — Broken Access Control | Has findings | HI-03 (`sanitizeSubpath` traversal bypass), LO-04 (symlink following in `copyDirectory`) |
| A02 — Security Misconfiguration | Has findings | HI-04 (`execSync` / `PATH` trust), ME-03 (lock file permissions), LO-03 (`PATH` hijack), LO-05 (URL in error messages) |
| A03 — Software Supply Chain Failures | Has findings | CR-02 (unvalidated `node_modules` sync) |
| A04 — Cryptographic Failures | No issues found | SHA-256 and GitHub tree SHAs used appropriately; no weak or deprecated algorithms observed |
| A05 — Injection | Has findings | CR-01 (shell injection on Windows in update spawn), LO-02 (unvalidated `ref` — precautionary) |
| A06 — Insecure Design | Has findings | HI-01 (unbounded HTTP response), HI-02 (silent lock file wipe), ME-01 (telemetry without consent notice) |
| A07 — Authentication Failures | Minor concern | ME-04 (unauthenticated `isRepoPrivate` API call) |
| A08 — Software and Data Integrity Failures | Has findings | CR-02 (no integrity check for `node_modules` skills), ME-02 (unvalidated audit API response cast) |
| A09 — Logging and Alerting Failures | Minor concern | LO-05 (sensitive URL in error messages), HI-04 (token logging risk in error paths) |
| A10 — Mishandling of Exceptional Conditions | Has findings | HI-02 (version mismatch causes data loss rather than safe migration) |

Legend: No issues found = checked and clear | Minor concern = low-severity finding | Has findings = one or more findings present

---

## Automation Potential

| Finding / Pattern | SAST Rule / Tool | Linting Config | CI Gate |
| ------------------- | ------------------ | ---------------- | --------- |
| CR-01: `shell: true` in spawn | Semgrep `nodejs.child_process.security.child-process-injection` | ESLint `no-restricted-syntax` on `shell: true` | Fail on critical |
| HI-03: No canonicalization before path check | Semgrep `javascript.lang.security.detect-non-literal-fs-filename` | Custom ESLint rule for path join without prior `normalize` | Warn on high |
| HI-01: Unbounded `response.text()` | Custom Semgrep: flag `response.text()` without preceding size check | — | Warn |
| ME-02: `as Type` cast on external JSON | `@typescript-eslint/no-unsafe-assignment` (strict mode) | Enable in `tsconfig.json` `strict: true` | Fail on error |
| LO-05: URL in `GitCloneError` messages | Custom Semgrep: `new GitCloneError(.*url` without sanitization | — | Warn |
| ME-03: `writeFile` without `mode` on sensitive paths | Custom Semgrep: `writeFile(lockPath, content, 'utf-8')` | — | Warn |

---

## Next Steps

- [ ] Fix CR-01 (`shell: true` injection on Windows) — block release until resolved
- [ ] Fix CR-02 (unvalidated `node_modules` sync) — block `experimental_sync` promotion until resolved
- [ ] Fix HI-03 (`sanitizeSubpath` percent-encoding bypass) — schedule in current sprint
- [ ] Fix HI-01 (unbounded HTTP response in `WellKnownProvider`) — schedule in current sprint
- [ ] Fix HI-02 (silent lock file wipe on version mismatch) — schedule in current sprint
- [ ] Fix HI-04 (`execSync` / token exposure risk) — schedule in current sprint
- [ ] Add ME-01 telemetry first-run notice — before next marketing push or 1.0 release
- [ ] Apply ME-03 restrictive file permissions — one-line fix, high value
- [ ] Add Semgrep rules for CR-01 and HI-03 patterns to CI pipeline
- [ ] Write parameterized unit tests for `sanitizeSubpath` with percent-encoded bypass payloads
- [ ] Write unit tests for `assertSafeInstallUrl` covering shell metacharacter payloads
- [ ] Open GitHub issues to track each finding above

---

_Generated by Security Agent | 2026-03-18 | Review before sharing externally_
