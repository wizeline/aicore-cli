#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { basename, join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { runAdd, parseAddOptions, initTelemetry } from './add.ts';
import { runFind } from './find.ts';
import { runInstallFromLock } from './install.ts';
import { runList } from './list.ts';
import { removeCommand, parseRemoveOptions } from './remove.ts';
import { runSync, parseSyncOptions } from './sync.ts';
import { track } from './telemetry.ts';
import { fetchSkillFolderHash, getGitHubToken } from './skill-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const VERSION = getVersion();
initTelemetry(VERSION);

const binaryName = process.env.IS_AGENTS_CLI
  ? 'agents'
  : process.env.IS_AICORE_CLI
    ? 'aicores'
    : 'skills';
const alternativeBinary = process.env.IS_AGENTS_CLI ? 'skills' : 'agents';
const SKILL = process.env.IS_AGENTS_CLI ? 'agent' : 'skill';
const SKILLS = process.env.IS_AGENTS_CLI ? 'agents' : 'skills';
const SkillCap = process.env.IS_AGENTS_CLI ? 'Agent' : 'Skill';
const SkillsCap = process.env.IS_AGENTS_CLI ? 'Agents' : 'Skills';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
// 256-color grays - visible on both light and dark backgrounds
const DIM = '\x1b[38;5;102m'; // darker gray for secondary text
const TEXT = '\x1b[38;5;145m'; // lighter gray for primary text

const LOGO_LINES_SKILLS = [
  '███████╗██╗  ██╗██╗██╗     ██╗     ███████╗',
  '██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝',
  '███████╗█████╔╝ ██║██║     ██║     ███████╗',
  '╚════██║██╔═██╗ ██║██║     ██║     ╚════██║',
  '███████║██║  ██╗██║███████╗███████╗███████║',
  '╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝',
];

const LOGO_LINES_AGENTS = [
  ' █████╗  ██████╗ ███████╗███╗   ██╗████████╗███████╗',
  '██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔════╝',
  '███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ███████╗',
  '██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ╚════██║',
  '██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ███████║',
  '╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝',
];

const LOGO_LINES_AICORE = [
  ' █████╗ ██╗ ██████╗ ██████╗ ██████╗ ███████╗███████╗',
  '██╔══██╗██║██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝',
  '███████║██║██║     ██║   ██║██████╔╝█████╗  ███████╗',
  '██╔══██║██║██║     ██║   ██║██╔══██╗██╔══╝  ╚════██║',
  '██║  ██║██║╚██████╗╚██████╔╝██║  ██║███████╗███████║',
  '╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝',
];

// 256-color middle grays - visible on both light and dark backgrounds
const GRAYS = [
  '\x1b[38;5;250m', // lighter gray
  '\x1b[38;5;248m',
  '\x1b[38;5;245m', // mid gray
  '\x1b[38;5;243m',
  '\x1b[38;5;240m',
  '\x1b[38;5;238m', // darker gray
];

function showLogo(): void {
  const logo = process.env.IS_AICORE_CLI
    ? LOGO_LINES_AICORE
    : process.env.IS_AGENTS_CLI
      ? LOGO_LINES_AGENTS
      : LOGO_LINES_SKILLS;
  console.log();
  logo.forEach((line, i) => {
    console.log(`${GRAYS[i]}${line}${RESET}`);
  });
}

function showBanner(): void {
  showLogo();
  console.log();
  console.log(`${DIM}The open agent skills & subagents ecosystem${RESET}`);
  console.log();
  if (process.env.IS_AICORE_CLI) {
    console.log(
      `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} ${DIM}<package>${RESET}            ${DIM}Install an aicore (agents + skills)${RESET}`
    );
    console.log(
      `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} add ${DIM}<package>${RESET}        ${DIM}Add a new ${SKILL}${RESET}`
    );
  } else {
    console.log(
      `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} add ${DIM}<package>${RESET}        ${DIM}Add a new ${SKILL}${RESET}`
    );
  }
  console.log(
    `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} remove${RESET}               ${DIM}Remove installed ${SKILLS}${RESET}`
  );
  console.log(
    `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} list${RESET}                 ${DIM}List installed ${SKILLS}${RESET}`
  );
  console.log(
    `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} find ${DIM}[query]${RESET}         ${DIM}Search for ${SKILLS}${RESET}`
  );
  console.log();
  console.log(
    `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} check${RESET}                ${DIM}Check for updates${RESET}`
  );
  console.log(
    `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} update${RESET}               ${DIM}Update all ${SKILLS}${RESET}`
  );
  console.log();
  console.log(
    `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} experimental_install${RESET} ${DIM}Restore from ${SKILLS}-lock.json${RESET}`
  );
  console.log(
    `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} init ${DIM}[name]${RESET}          ${DIM}Create a new ${SKILL}${RESET}`
  );
  console.log(
    `  ${DIM}$${RESET} ${TEXT}npx ${binaryName} experimental_sync${RESET}    ${DIM}Sync ${SKILLS} from node_modules${RESET}`
  );
  console.log();
  if (process.env.IS_AICORE_CLI) {
    console.log(`${DIM}try:${RESET} npx ${binaryName} wizeline/agent-skills`);
  } else {
    console.log(`${DIM}try:${RESET} npx ${binaryName} add wizeline/agent-skills`);
  }
  console.log();
  console.log(`Discover more ${SKILLS} at ${TEXT}https://skills.sh/${RESET}`);
  console.log(
    `${DIM}Note:${RESET} You can also use ${TEXT}npx ${alternativeBinary}${RESET} to manage ${alternativeBinary} specifically.`
  );
  console.log();
}

function showHelp(): void {
  const aicoreUsageLine = process.env.IS_AICORE_CLI
    ? `  <package>            Install an aicore package (agents + skills)
                       e.g. wizeline/my-aicore
                            https://github.com/owner/my-aicore
  add <package>        Add agents or skills from a package (alias: a)
`
    : `  add <package>        Add a ${SKILL} package (alias: a)
                       e.g. wizeline/agent-skills
                            https://github.com/wizeline/agent-skills
`;
  console.log(`
${BOLD}Usage:${RESET} ${binaryName} <command> [options]

${BOLD}Manage ${SkillsCap}:${RESET}
${aicoreUsageLine}  remove [${SKILLS}]      Remove installed ${SKILLS}
  list, ls             List installed ${SKILLS}
  find [query]         Search for ${SKILLS} interactively

${BOLD}Updates:${RESET}
  check                Check for available ${SKILL} updates
  update               Update all ${SKILLS} to latest versions

${BOLD}Project:${RESET}
  experimental_install Restore ${SKILLS} from ${SKILLS}-lock.json
  init [name]          Initialize a ${SKILL} (creates <name>/SKILL.md or ./SKILL.md)
  experimental_sync    Sync ${SKILLS} from node_modules into agent directories

${BOLD}Add Options:${RESET}
  -g, --global           Install ${SKILL} globally (user-level) instead of project-level
  -a, --agent <agents>   Specify agents to install to (use '*' for all agents)
  -s, --skill <${SKILLS}>   Specify ${SKILL} names to install (use '*' for all ${SKILLS})
  -l, --list             List available ${SKILLS} in the repository without installing
  -y, --yes              Skip confirmation prompts
  --copy                 Copy files instead of symlinking to agent directories
  --all                  Shorthand for --skill '*' --agent '*' -y
  --full-depth           Search all subdirectories even when a root SKILL.md exists

${BOLD}Remove Options:${RESET}
  -g, --global           Remove from global scope
  -a, --agent <agents>   Remove from specific agents (use '*' for all agents)
  -s, --skill <${SKILLS}>   Specify ${SKILLS} to remove (use '*' for all ${SKILLS})
  -y, --yes              Skip confirmation prompts
  --all                  Shorthand for --skill '*' --agent '*' -y

${BOLD}Experimental Sync Options:${RESET}
  -a, --agent <agents>   Specify agents to install to (use '*' for all agents)
  -y, --yes              Skip confirmation prompts

${BOLD}List Options:${RESET}
  -g, --global           List global ${SKILLS} (default: project)
  -a, --agent <agents>   Filter by specific agents
  --json                 Output as JSON (machine-readable, no ANSI codes)

${BOLD}Options:${RESET}
  --help, -h        Show this help message
  --version, -v     Show version number

${BOLD}Examples:${RESET}
  ${DIM}$${RESET} ${binaryName} add wizeline/agent-skills
  ${DIM}$${RESET} ${binaryName} add wizeline/agent-skills -g
  ${DIM}$${RESET} ${binaryName} add wizeline/agent-skills --agent claude-code cursor
  ${DIM}$${RESET} ${binaryName} add wizeline/agent-skills --skill pr-review commit
  ${DIM}$${RESET} ${binaryName} remove                        ${DIM}# interactive remove${RESET}
  ${DIM}$${RESET} ${binaryName} remove web-design             ${DIM}# remove by name${RESET}
  ${DIM}$${RESET} ${binaryName} rm --global frontend-design
  ${DIM}$${RESET} ${binaryName} list                          ${DIM}# list project ${SKILLS}${RESET}
  ${DIM}$${RESET} ${binaryName} ls -g                         ${DIM}# list global ${SKILLS}${RESET}
  ${DIM}$${RESET} ${binaryName} ls -a claude-code             ${DIM}# filter by agent${RESET}
  ${DIM}$${RESET} ${binaryName} find                          ${DIM}# interactive search${RESET}
  ${DIM}$${RESET} ${binaryName} find typescript               ${DIM}# search by keyword${RESET}
  ${DIM}$${RESET} ${binaryName} check
  ${DIM}$${RESET} ${binaryName} update
  ${DIM}$${RESET} ${binaryName} experimental_install            ${DIM}# restore from ${SKILLS}-lock.json${RESET}
  ${DIM}$${RESET} ${binaryName} init my-${SKILL}
  ${DIM}$${RESET} ${binaryName} experimental_sync              ${DIM}# sync from node_modules${RESET}
  ${DIM}$${RESET} ${binaryName} experimental_sync -y           ${DIM}# sync without prompts${RESET}

Discover more ${SKILLS} at ${TEXT}https://skills.sh/${RESET}
`);
}

function showRemoveHelp(): void {
  console.log(`
${BOLD}Usage:${RESET} ${binaryName} remove [${SKILLS}...] [options]

${BOLD}Description:${RESET}
  Remove installed ${SKILLS} from agents. If no ${SKILL} names are provided,
  an interactive selection menu will be shown.

${BOLD}Arguments:${RESET}
  ${SKILLS}            Optional ${SKILL} names to remove (space-separated)

${BOLD}Options:${RESET}
  -g, --global       Remove from global scope (~/) instead of project scope
  -a, --agent        Remove from specific agents (use '*' for all agents)
  -s, --skill        Specify ${SKILLS} to remove (use '*' for all ${SKILLS})
  -y, --yes          Skip confirmation prompts
  --all              Shorthand for --skill '*' --agent '*' -y

${BOLD}Examples:${RESET}
  ${DIM}$${RESET} ${binaryName} remove                           ${DIM}# interactive selection${RESET}
  ${DIM}$${RESET} ${binaryName} remove my-${SKILL}                   ${DIM}# remove specific ${SKILL}${RESET}
  ${DIM}$${RESET} ${binaryName} remove ${SKILL}1 ${SKILL}2 -y           ${DIM}# remove multiple ${SKILLS}${RESET}
  ${DIM}$${RESET} ${binaryName} remove --global my-${SKILL}          ${DIM}# remove from global scope${RESET}
  ${DIM}$${RESET} ${binaryName} rm --agent claude-code my-${SKILL}   ${DIM}# remove from specific agent${RESET}
  ${DIM}$${RESET} ${binaryName} remove --all                      ${DIM}# remove all ${SKILLS}${RESET}
  ${DIM}$${RESET} ${binaryName} remove --skill '*' -a cursor      ${DIM}# remove all ${SKILLS} from cursor${RESET}

Discover more ${SKILLS} at ${TEXT}https://skills.sh/${RESET}
`);
}

function runInit(args: string[]): void {
  const cwd = process.cwd();
  const name = args[0] || basename(cwd);
  const hasName = args[0] !== undefined;

  // Aicore init: scaffold the full aicore directory structure
  if (process.env.IS_AICORE_CLI) {
    const aicoreDir = hasName ? join(cwd, name) : cwd;
    const agentsDir = join(aicoreDir, 'agents');
    const skillsDir = join(aicoreDir, 'skills');
    const sampleSkillDir = join(skillsDir, 'my-skill');
    const agentFile = join(agentsDir, 'my-agent.md');
    const skillFile = join(sampleSkillDir, 'SKILL.md');
    const displayBase = hasName ? `${name}/` : '';

    if (existsSync(aicoreDir) && (existsSync(agentsDir) || existsSync(skillsDir))) {
      console.log(`${TEXT}AICore already initialized at ${DIM}${hasName ? name : '.'}${RESET}`);
      return;
    }

    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(sampleSkillDir, { recursive: true });

    writeFileSync(
      agentFile,
      `---
name: my-agent
description: A brief description of what this agent does
---

# My Agent

Instructions for the AI agent. Define the persona, goals, and behavior here.

## Role

Describe the role and responsibilities of this agent.

## Instructions

1. First behavior rule
2. Second behavior rule
3. Additional rules as needed
`
    );

    writeFileSync(
      skillFile,
      `---
name: my-skill
description: A brief description of what this skill does
---

# My Skill

Instructions for the agent to follow when this skill is activated.

## When to use

Describe when this skill should be used.

## Instructions

1. First step
2. Second step
3. Additional steps as needed
`
    );

    console.log(`${TEXT}Initialized AICore: ${DIM}${name}${RESET}`);
    console.log();
    console.log(`${DIM}Created:${RESET}`);
    console.log(`  ${displayBase}agents/my-agent.md`);
    console.log(`  ${displayBase}skills/my-skill/SKILL.md`);
    console.log();
    console.log(`${DIM}Structure:${RESET}`);
    console.log(`  ${name}/`);
    console.log(`  ├── agents/          ${DIM}← AI assistant instructions (.md files)${RESET}`);
    console.log(`  └── skills/          ${DIM}← Reusable skills (folders with SKILL.md)${RESET}`);
    console.log(`      └── my-skill/`);
    console.log(`          └── SKILL.md`);
    console.log();
    console.log(`${DIM}Next steps:${RESET}`);
    console.log(`  1. Edit ${TEXT}${displayBase}agents/my-agent.md${RESET} to define your agent`);
    console.log(
      `  2. Edit ${TEXT}${displayBase}skills/my-skill/SKILL.md${RESET} to define your skill`
    );
    console.log();
    console.log(`${DIM}Publishing:${RESET}`);
    console.log(
      `  ${DIM}GitHub:${RESET}  Push to a repo, then ${TEXT}npx ${binaryName} <owner>/<repo>${RESET}`
    );
    console.log();
    return;
  }

  // Default init: create a single SKILL.md
  const skillName = name;
  const skillDir = hasName ? join(cwd, skillName) : cwd;
  const skillFile = join(skillDir, 'SKILL.md');
  const displayPath = hasName ? `${skillName}/SKILL.md` : 'SKILL.md';

  if (existsSync(skillFile)) {
    console.log(`${TEXT}${SkillCap} already exists at ${DIM}${displayPath}${RESET}`);
    return;
  }

  if (hasName) {
    mkdirSync(skillDir, { recursive: true });
  }

  const skillContent = `---
name: ${skillName}
description: A brief description of what this ${SKILL} does
---

# ${skillName}

Instructions for the agent to follow when this ${SKILL} is activated.

## When to use

Describe when this ${SKILL} should be used.

## Instructions

1. First step
2. Second step
3. Additional steps as needed
`;

  writeFileSync(skillFile, skillContent);

  console.log(`${TEXT}Initialized ${SKILL}: ${DIM}${skillName}${RESET}`);
  console.log();
  console.log(`${DIM}Created:${RESET}`);
  console.log(`  ${displayPath}`);
  console.log();
  console.log(`${DIM}Next steps:${RESET}`);
  console.log(`  1. Edit ${TEXT}${displayPath}${RESET} to define your ${SKILL} instructions`);
  console.log(
    `  2. Update the ${TEXT}name${RESET} and ${TEXT}description${RESET} in the frontmatter`
  );
  console.log();
  console.log(`${DIM}Publishing:${RESET}`);
  console.log(
    `  ${DIM}GitHub:${RESET}  Push to a repo, then ${TEXT}npx ${binaryName} add <owner>/<repo>${RESET}`
  );
  console.log(
    `  ${DIM}URL:${RESET}     Host the file, then ${TEXT}npx ${binaryName} add https://example.com/${displayPath}${RESET}`
  );
  console.log();
  console.log(`Browse existing ${SKILLS} for inspiration at ${TEXT}https://skills.sh/${RESET}`);
  console.log();
}

// ============================================
// Check and Update Commands
// ============================================

const AGENTS_DIR = '.agents';
const LOCK_FILE = '.skill-lock.json';
const CHECK_UPDATES_API_URL = 'https://add-skill.vercel.sh/check-updates';
const CURRENT_LOCK_VERSION = 3; // Bumped from 2 to 3 for folder hash support

interface SkillLockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath?: string;
  /** GitHub tree SHA for the entire skill folder (v3) */
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
}

interface SkillLockFile {
  version: number;
  skills: Record<string, SkillLockEntry>;
}

interface CheckUpdatesRequest {
  skills: Array<{
    name: string;
    source: string;
    path?: string;
    skillFolderHash: string;
  }>;
}

interface CheckUpdatesResponse {
  updates: Array<{
    name: string;
    source: string;
    currentHash: string;
    latestHash: string;
  }>;
  errors?: Array<{
    name: string;
    source: string;
    error: string;
  }>;
}

function getSkillLockPath(): string {
  return join(homedir(), AGENTS_DIR, LOCK_FILE);
}

function readSkillLock(): SkillLockFile {
  const lockPath = getSkillLockPath();
  try {
    const content = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as SkillLockFile;
    if (typeof parsed.version !== 'number' || !parsed.skills) {
      return { version: CURRENT_LOCK_VERSION, skills: {} };
    }
    // If old version, wipe and start fresh (backwards incompatible change)
    // v3 adds skillFolderHash - we want fresh installs to populate it
    if (parsed.version < CURRENT_LOCK_VERSION) {
      return { version: CURRENT_LOCK_VERSION, skills: {} };
    }
    return parsed;
  } catch {
    return { version: CURRENT_LOCK_VERSION, skills: {} };
  }
}

function writeSkillLock(lock: SkillLockFile): void {
  const lockPath = getSkillLockPath();
  const dir = join(homedir(), AGENTS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf-8');
}

interface SkippedSkill {
  name: string;
  reason: string;
  sourceUrl: string;
}

/**
 * Determine why a skill cannot be checked for updates automatically.
 */
function getSkipReason(entry: SkillLockEntry): string {
  if (entry.sourceType === 'local') {
    return 'Local path';
  }
  if (entry.sourceType === 'git') {
    return 'Git URL (hash tracking not supported)';
  }
  if (!entry.skillFolderHash) {
    return 'No version hash available';
  }
  if (!entry.skillPath) {
    return 'No skill path recorded';
  }
  return 'No version tracking';
}

/**
 * Print a list of skills that cannot be checked automatically,
 * with the reason and a manual update command for each.
 */
function printSkippedSkills(skipped: SkippedSkill[]): void {
  if (skipped.length === 0) return;
  console.log();
  console.log(`${DIM}${skipped.length} skill(s) cannot be checked automatically:${RESET}`);
  for (const skill of skipped) {
    console.log(`  ${TEXT}•${RESET} ${skill.name} ${DIM}(${skill.reason})${RESET}`);
    console.log(`    ${DIM}To update: ${TEXT}npx skills add ${skill.sourceUrl} -g -y${RESET}`);
  }
}

async function runCheck(args: string[] = []): Promise<void> {
  console.log(`${TEXT}Checking for ${SKILL} updates...${RESET}`);
  console.log();

  const lock = readSkillLock();
  const skillNames = Object.keys(lock.skills);

  if (skillNames.length === 0) {
    console.log(`${DIM}No ${SKILLS} tracked in lock file.${RESET}`);
    console.log(
      `${DIM}Install ${SKILLS} with${RESET} ${TEXT}npx ${binaryName} add <package>${RESET}`
    );
    return;
  }

  // Get GitHub token from user's environment for higher rate limits
  const token = getGitHubToken();

  // Group skills by source (owner/repo) to batch GitHub API calls
  const skillsBySource = new Map<string, Array<{ name: string; entry: SkillLockEntry }>>();
  const skipped: SkippedSkill[] = [];

  for (const skillName of skillNames) {
    const entry = lock.skills[skillName];
    if (!entry) continue;

    // Only check skills with folder hash and skill path
    if (!entry.skillFolderHash || !entry.skillPath) {
      skipped.push({ name: skillName, reason: getSkipReason(entry), sourceUrl: entry.sourceUrl });
      continue;
    }

    const existing = skillsBySource.get(entry.source) || [];
    existing.push({ name: skillName, entry });
    skillsBySource.set(entry.source, existing);
  }

  const totalSkills = skillNames.length - skipped.length;
  if (totalSkills === 0) {
    console.log(`${DIM}No GitHub ${SKILLS} to check.${RESET}`);
    return;
  }

  console.log(`${DIM}Checking ${totalSkills} ${SKILL}(s) for updates...${RESET}`);

  const updates: Array<{ name: string; source: string }> = [];
  const errors: Array<{ name: string; source: string; error: string }> = [];

  // Check each source (one API call per repo)
  for (const [source, skills] of skillsBySource) {
    for (const { name, entry } of skills) {
      try {
        const latestHash = await fetchSkillFolderHash(source, entry.skillPath!, token);

        if (!latestHash) {
          errors.push({ name, source, error: 'Could not fetch from GitHub' });
          continue;
        }

        if (latestHash !== entry.skillFolderHash) {
          updates.push({ name, source });
        }
      } catch (err) {
        errors.push({
          name,
          source,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  }

  console.log();

  if (updates.length === 0) {
    console.log(`${TEXT}✓ All ${SKILLS} are up to date${RESET}`);
  } else {
    console.log(`${TEXT}${updates.length} update(s) available:${RESET}`);
    console.log();
    for (const update of updates) {
      console.log(`  ${TEXT}↑${RESET} ${update.name}`);
      console.log(`    ${DIM}source: ${update.source}${RESET}`);
    }
    console.log();
    console.log(
      `${DIM}Run${RESET} ${TEXT}npx ${binaryName} update${RESET} ${DIM}to update all ${SKILLS}${RESET}`
    );
  }

  if (errors.length > 0) {
    console.log();
    console.log(`${DIM}Could not check ${errors.length} ${SKILL}(s) (may need reinstall)${RESET}`);
  }

  printSkippedSkills(skipped);

  // Track telemetry
  track({
    event: 'check',
    skillCount: String(totalSkills),
    updatesAvailable: String(updates.length),
  });

  console.log();
}

async function runUpdate(): Promise<void> {
  console.log(`${TEXT}Checking for ${SKILL} updates...${RESET}`);
  console.log();

  const lock = readSkillLock();
  const skillNames = Object.keys(lock.skills);

  if (skillNames.length === 0) {
    console.log(`${DIM}No ${SKILLS} tracked in lock file.${RESET}`);
    console.log(
      `${DIM}Install ${SKILLS} with${RESET} ${TEXT}npx ${binaryName} add <package>${RESET}`
    );
    return;
  }

  // Get GitHub token from user's environment for higher rate limits
  const token = getGitHubToken();

  // Find skills that need updates by checking GitHub directly
  const updates: Array<{ name: string; source: string; entry: SkillLockEntry }> = [];
  const skipped: SkippedSkill[] = [];

  for (const skillName of skillNames) {
    const entry = lock.skills[skillName];
    if (!entry) continue;

    // Only check skills with folder hash and skill path
    if (!entry.skillFolderHash || !entry.skillPath) {
      skipped.push({ name: skillName, reason: getSkipReason(entry), sourceUrl: entry.sourceUrl });
      continue;
    }

    try {
      const latestHash = await fetchSkillFolderHash(entry.source, entry.skillPath, token);

      if (latestHash && latestHash !== entry.skillFolderHash) {
        updates.push({ name: skillName, source: entry.source, entry });
      }
    } catch {
      // Skip skills that fail to check
    }
  }

  const checkedCount = skillNames.length - skipped.length;

  if (checkedCount === 0) {
    console.log(`${DIM}No ${SKILLS} to check.${RESET}`);
    return;
  }

  if (updates.length === 0) {
    console.log(`${TEXT}✓ All ${SKILLS} are up to date${RESET}`);
    console.log();
    return;
  }

  console.log(`${TEXT}Found ${updates.length} update(s)${RESET}`);
  console.log();

  // Reinstall each skill that has an update
  let successCount = 0;
  let failCount = 0;

  for (const update of updates) {
    console.log(`${TEXT}Updating ${update.name}...${RESET}`);

    // Build the URL with subpath to target the specific skill directory
    // e.g., https://github.com/owner/repo/tree/main/skills/my-skill
    let installUrl = update.entry.sourceUrl;
    if (update.entry.skillPath) {
      // Extract the skill folder path (remove /SKILL.md suffix)
      let skillFolder = update.entry.skillPath;
      if (skillFolder.endsWith('/SKILL.md')) {
        skillFolder = skillFolder.slice(0, -9);
      } else if (skillFolder.endsWith('SKILL.md')) {
        skillFolder = skillFolder.slice(0, -8);
      }
      if (skillFolder.endsWith('/')) {
        skillFolder = skillFolder.slice(0, -1);
      }

      // Convert git URL to tree URL with path
      // https://github.com/owner/repo.git -> https://github.com/owner/repo/tree/main/path
      installUrl = update.entry.sourceUrl.replace(/\.git$/, '').replace(/\/$/, '');
      installUrl = `${installUrl}/tree/main/${skillFolder}`;
    }

    // Use skills CLI to reinstall with -g -y flags
    const result = spawnSync('npx', ['-y', binaryName, 'add', installUrl, '-g', '-y'], {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    if (result.status === 0) {
      successCount++;
      console.log(`  ${TEXT}✓${RESET} Updated ${update.name}`);
    } else {
      failCount++;
      console.log(`  ${DIM}✗ Failed to update ${update.name}${RESET}`);
    }
  }

  console.log();
  if (successCount > 0) {
    console.log(`${TEXT}✓ Updated ${successCount} ${SKILL}(s)${RESET}`);
  }
  if (failCount > 0) {
    console.log(`${DIM}Failed to update ${failCount} ${SKILL}(s)${RESET}`);
  }

  // Track telemetry
  track({
    event: 'update',
    skillCount: String(updates.length),
    successCount: String(successCount),
    failCount: String(failCount),
  });

  console.log();
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showBanner();
    return;
  }

  const command = args[0];
  const restArgs = args.slice(1);

  switch (command) {
    case 'find':
    case 'search':
    case 'f':
    case 's':
      showLogo();
      console.log();
      await runFind(restArgs);
      break;
    case 'init':
      showLogo();
      console.log();
      runInit(restArgs);
      break;
    case 'experimental_install': {
      showLogo();
      await runInstallFromLock(restArgs);
      break;
    }
    case 'i':
    case 'install':
    case 'a':
    case 'add': {
      showLogo();
      const { source: addSource, options: addOpts } = parseAddOptions(restArgs);
      await runAdd(addSource, addOpts);
      break;
    }
    case 'remove':
    case 'rm':
    case 'r':
      // Check for --help or -h flag
      if (restArgs.includes('--help') || restArgs.includes('-h')) {
        showRemoveHelp();
        break;
      }
      const { skills, options: removeOptions } = parseRemoveOptions(restArgs);
      await removeCommand(skills, removeOptions);
      break;
    case 'experimental_sync': {
      showLogo();
      const { options: syncOptions } = parseSyncOptions(restArgs);
      await runSync(restArgs, syncOptions);
      break;
    }
    case 'list':
    case 'ls': {
      // If a source (URL or path) is provided, list available aicores from that source
      const listSources = restArgs.filter((a) => !a.startsWith('-'));
      if (listSources.length > 0) {
        showLogo();
        const { source: addSource, options: addOpts } = parseAddOptions([...restArgs, '--list']);
        await runAdd(addSource, addOpts);
      } else {
        await runList(restArgs);
      }
      break;
    }
    case 'check':
      runCheck(restArgs);
      break;
    case 'update':
    case 'upgrade':
      runUpdate();
      break;
    case '--help':
    case '-h':
      showHelp();
      break;
    case '--version':
    case '-v':
      console.log(VERSION);
      break;

    default:
      if (process.env.IS_AICORE_CLI) {
        // For the aicore CLI, treat any unknown first arg as a source to install/list from
        showLogo();
        const { source: addSource, options: addOpts } = parseAddOptions(args);
        await runAdd(addSource, addOpts);
      } else {
        console.log(`Unknown command: ${command}`);
        console.log(`Run ${BOLD}${binaryName} --help${RESET} for usage.`);
      }
  }
}

main();
