import { homedir } from 'os';
import type { AgentType } from './types.ts';
import { agents } from './agents.ts';
import { listInstalledSkills, type InstalledSkill } from './installer.ts';
import { getAllLockedSkills } from './skill-lock.ts';

const IS_AICORE_CLI = !!process.env.IS_AICORE_CLI;
const IS_AGENTS_CLI = !!process.env.IS_AGENTS_CLI;

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[38;5;102m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

interface ListOptions {
  global?: boolean;
  agent?: string[];
  json?: boolean;
}

/**
 * Shortens a path for display: replaces homedir with ~ and cwd with .
 */
function shortenPath(fullPath: string, cwd: string): string {
  const home = homedir();
  if (fullPath.startsWith(home)) {
    return fullPath.replace(home, '~');
  }
  if (fullPath.startsWith(cwd)) {
    return '.' + fullPath.slice(cwd.length);
  }
  return fullPath;
}

/**
 * Formats a list of items, truncating if too many
 */
function formatList(items: string[], maxShow: number = 5): string {
  if (items.length <= maxShow) {
    return items.join(', ');
  }
  const shown = items.slice(0, maxShow);
  const remaining = items.length - maxShow;
  return `${shown.join(', ')} +${remaining} more`;
}

/**
 * Converts kebab-case to Title Case for display headers.
 */
function kebabToTitle(s: string): string {
  return s
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function parseListOptions(args: string[]): ListOptions {
  const options: ListOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-g' || arg === '--global') {
      options.global = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-a' || arg === '--agent') {
      options.agent = options.agent || [];
      // Collect all following arguments until next flag
      while (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
        options.agent.push(args[++i]!);
      }
    }
  }

  return options;
}

/**
 * Print a single skill with path and agent associations (skills mode).
 */
function printSkill(skill: InstalledSkill, cwd: string, indent: boolean = false): void {
  const prefix = indent ? '  ' : '';
  const shortPath = shortenPath(skill.canonicalPath, cwd);
  const agentNames = skill.agents.map((a) => agents[a].displayName);
  const agentInfo =
    skill.agents.length > 0 ? formatList(agentNames) : `${YELLOW}not linked${RESET}`;
  console.log(`${prefix}${CYAN}${skill.name}${RESET} ${DIM}${shortPath}${RESET}`);
  console.log(`${prefix}  ${DIM}Agents:${RESET} ${agentInfo}`);
}

/**
 * Print a single subagent with path and description (subagents/aicores mode).
 */
function printSubagent(item: InstalledSkill, cwd: string, indent: boolean = false): void {
  const prefix = indent ? '  ' : '';
  const shortPath = shortenPath(item.canonicalPath, cwd);
  console.log(`${prefix}${CYAN}${item.name}${RESET} ${DIM}${shortPath}${RESET}`);
  if (item.description) {
    console.log(`${prefix}  ${DIM}${item.description}${RESET}`);
  }
}

/**
 * Print a single skill item without agent info (for aicores mode).
 */
function printSkillItem(skill: InstalledSkill, cwd: string, indent: boolean = false): void {
  const prefix = indent ? '  ' : '';
  const shortPath = shortenPath(skill.canonicalPath, cwd);
  console.log(`${prefix}${CYAN}${skill.name}${RESET} ${DIM}${shortPath}${RESET}`);
  if (skill.description) {
    console.log(`${prefix}  ${DIM}${skill.description}${RESET}`);
  }
}

/**
 * List installed aicores: group skills by pluginName (aicore), show subagents separately.
 */
async function runListAicores(options: ListOptions, scope: boolean): Promise<void> {
  const cwd = process.cwd();
  const scopeLabel = scope ? 'Global' : 'Project';

  // Scan skills (.agents/skills/) and subagents (.agents/agents/) in parallel
  const [skills, subagents] = await Promise.all([
    listInstalledSkills({ global: scope }),
    listInstalledSkills({ global: scope, subdir: 'agents' }),
  ]);

  if (options.json) {
    const lockedSkills = await getAllLockedSkills();
    const output = {
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        path: s.canonicalPath,
        scope: s.scope,
        aicore: lockedSkills[s.name]?.pluginName ?? null,
      })),
      subagents: subagents.map((s) => ({
        name: s.name,
        description: s.description,
        path: s.canonicalPath,
        scope: s.scope,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (skills.length === 0 && subagents.length === 0) {
    console.log(`${DIM}No ${scopeLabel.toLowerCase()} aicores found.${RESET}`);
    if (scope) {
      console.log(`${DIM}Try listing project aicores without -g${RESET}`);
    } else {
      console.log(`${DIM}Try listing global aicores with -g${RESET}`);
    }
    return;
  }

  const lockedSkills = await getAllLockedSkills();

  // Group skills by pluginName (aicore)
  const aicoreGroups: Record<string, InstalledSkill[]> = {};
  const standaloneSkills: InstalledSkill[] = [];

  for (const skill of skills) {
    const pluginName = lockedSkills[skill.name]?.pluginName;
    if (pluginName) {
      if (!aicoreGroups[pluginName]) aicoreGroups[pluginName] = [];
      aicoreGroups[pluginName].push(skill);
    } else {
      standaloneSkills.push(skill);
    }
  }

  console.log(`${BOLD}${scopeLabel} Aicores${RESET}`);
  console.log();

  const hasGroups = Object.keys(aicoreGroups).length > 0;

  if (hasGroups) {
    for (const groupName of Object.keys(aicoreGroups).sort()) {
      const title = kebabToTitle(groupName);
      const groupSkills = aicoreGroups[groupName]!;
      console.log(`${BOLD}${title}${RESET}`);
      if (groupSkills.length > 0) {
        console.log(`  ${DIM}Skills:${RESET}`);
        for (const skill of groupSkills) {
          printSkillItem(skill, cwd, true);
        }
      }
      console.log();
    }
  }

  if (standaloneSkills.length > 0) {
    console.log(`${BOLD}${hasGroups ? 'Standalone Skills' : 'Skills'}${RESET}`);
    for (const skill of standaloneSkills) {
      printSkillItem(skill, cwd, hasGroups);
    }
    console.log();
  }

  if (subagents.length > 0) {
    console.log(`${BOLD}Subagents${RESET}`);
    for (const sa of subagents) {
      printSubagent(sa, cwd, true);
    }
    console.log();
  }
}

/**
 * List installed subagents: simple flat list of .md files from .agents/agents/.
 */
async function runListSubagents(options: ListOptions, scope: boolean): Promise<void> {
  const cwd = process.cwd();
  const scopeLabel = scope ? 'Global' : 'Project';

  // SKILLS_SUBDIR='agents' when IS_AGENTS_CLI, so this already scans .agents/agents/
  const subagents = await listInstalledSkills({ global: scope });

  if (options.json) {
    const output = subagents.map((s) => ({
      name: s.name,
      description: s.description,
      path: s.canonicalPath,
      scope: s.scope,
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (subagents.length === 0) {
    console.log(`${DIM}No ${scopeLabel.toLowerCase()} subagents found.${RESET}`);
    if (scope) {
      console.log(`${DIM}Try listing project subagents without -g${RESET}`);
    } else {
      console.log(`${DIM}Try listing global subagents with -g${RESET}`);
    }
    return;
  }

  console.log(`${BOLD}${scopeLabel} Subagents${RESET}`);
  console.log();

  for (const sa of subagents) {
    printSubagent(sa, cwd);
  }
  console.log();
}

export async function runList(args: string[]): Promise<void> {
  const options = parseListOptions(args);

  // Default to project only (local), use -g for global
  const scope = options.global === true ? true : false;

  if (IS_AICORE_CLI) {
    await runListAicores(options, scope);
    return;
  }

  if (IS_AGENTS_CLI) {
    await runListSubagents(options, scope);
    return;
  }

  // --- Default: skills mode ---

  // Validate agent filter if provided
  let agentFilter: AgentType[] | undefined;
  if (options.agent && options.agent.length > 0) {
    const validAgents = Object.keys(agents);
    const invalidAgents = options.agent.filter((a) => !validAgents.includes(a));

    if (invalidAgents.length > 0) {
      console.log(`${YELLOW}Invalid agents: ${invalidAgents.join(', ')}${RESET}`);
      console.log(`${DIM}Valid agents: ${validAgents.join(', ')}${RESET}`);
      process.exit(1);
    }

    agentFilter = options.agent as AgentType[];
  }

  const installedSkills = await listInstalledSkills({
    global: scope,
    agentFilter,
  });

  // JSON output mode: structured, no ANSI, untruncated agent lists
  if (options.json) {
    const jsonOutput = installedSkills.map((skill) => ({
      name: skill.name,
      path: skill.canonicalPath,
      scope: skill.scope,
      agents: skill.agents.map((a) => agents[a].displayName),
    }));
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  // Fetch lock entries to get plugin grouping info
  const lockedSkills = await getAllLockedSkills();

  const cwd = process.cwd();
  const scopeLabel = scope ? 'Global' : 'Project';

  if (installedSkills.length === 0) {
    console.log(`${DIM}No ${scopeLabel.toLowerCase()} skills found.${RESET}`);
    if (scope) {
      console.log(`${DIM}Try listing project skills without -g${RESET}`);
    } else {
      console.log(`${DIM}Try listing global skills with -g${RESET}`);
    }
    return;
  }

  console.log(`${BOLD}${scopeLabel} Skills${RESET}`);
  console.log();

  // Group skills by plugin
  const groupedSkills: Record<string, InstalledSkill[]> = {};
  const ungroupedSkills: InstalledSkill[] = [];

  for (const skill of installedSkills) {
    const lockEntry = lockedSkills[skill.name];
    if (lockEntry?.pluginName) {
      const group = lockEntry.pluginName;
      if (!groupedSkills[group]) {
        groupedSkills[group] = [];
      }
      groupedSkills[group].push(skill);
    } else {
      ungroupedSkills.push(skill);
    }
  }

  const hasGroups = Object.keys(groupedSkills).length > 0;

  if (hasGroups) {
    // Print groups sorted alphabetically
    const sortedGroups = Object.keys(groupedSkills).sort();
    for (const group of sortedGroups) {
      const title = kebabToTitle(group);
      console.log(`${BOLD}${title}${RESET}`);
      const skills = groupedSkills[group];
      if (skills) {
        for (const skill of skills) {
          printSkill(skill, cwd, true);
        }
      }
      console.log();
    }

    // Print ungrouped skills if any exist
    if (ungroupedSkills.length > 0) {
      console.log(`${BOLD}General${RESET}`);
      for (const skill of ungroupedSkills) {
        printSkill(skill, cwd, true);
      }
      console.log();
    }
  } else {
    // No groups, print flat list as before
    for (const skill of installedSkills) {
      printSkill(skill, cwd);
    }
    console.log();
  }
}
