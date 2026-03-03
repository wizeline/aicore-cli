# Agents & Skills

The CLI for the open agent ecosystem. Install and manage **agents** and **skills** for your favorite AI tools using `npx agents` or `npx skills`.

<!-- agent-list:start -->
Supports **OpenCode**, **Claude Code**, **Codex**, **Cursor**, and [37 more](#available-agents).
<!-- agent-list:end -->

> [!TIP]
> **Interchangeable Commands**: The `agents` and `skills` commands are identical aliases. You can use whichever you prefer (e.g., `npx agents add` or `npx skills add`).

## Install a Skill or Agent

```bash
npx agents add wizeline/agent-skills
```

### Source Formats

```bash
# GitHub shorthand (owner/repo)
npx agents add wizeline/agent-skills

# Full GitHub URL
npx agents add https://github.com/wizeline/agent-skills

# Direct path to a skill or agent in a repo
npx agents add https://github.com/wizeline/agent-skills/tree/main/skills/web-design-guidelines

# GitLab URL
npx agents add https://gitlab.com/org/repo

# Any git URL
npx agents add git@github.com:wizeline/agent-skills.git

# Local path
npx agents add ./my-local-skills
```

### Options

| Option                    | Description                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-g, --global`            | Install to user directory instead of project                                                                                                       |
| `-a, --agent <agents...>` | <!-- agent-names:start -->Target specific agents (e.g., `claude-code`, `codex`). See [Available Agents](#available-agents)<!-- agent-names:end -->                  |
| `-s, --skill <skills...>` | Install specific items by name (use `'*'` for all)                                                                                         |
| `-l, --list`              | List available items without installing                                                                                                           |
| `--copy`                  | Copy files instead of symlinking to agent directories                                                                                              |
| `-y, --yes`               | Skip all confirmation prompts                                                                                                                      |
| `--all`                   | Install all items to all agents without prompts                                                                                                   |

### Examples

```bash
# List items in a repository
npx agents add wizeline/agent-skills --list

# Install specific items
npx agents add wizeline/agent-skills --skill frontend-design --skill skill-creator

# Install with spaces in the name (must be quoted)
npx agents add owner/repo --skill "Convex Best Practices"

# Install to specific agents
npx agents add wizeline/agent-skills -a claude-code -a opencode

# Non-interactive installation (CI/CD friendly)
npx agents add wizeline/agent-skills --skill frontend-design -g -a claude-code -y

# Install all items from a repo to all agents
npx agents add wizeline/agent-skills --all

# Install all items to specific agents
npx agents add wizeline/agent-skills --skill '*' -a claude-code

# Install specific items to all agents
npx agents add wizeline/agent-skills --agent '*' --skill frontend-design
```

### Installation Scope

| Scope       | Flag      | Location            | Use Case                                      |
| ----------- | --------- | ------------------- | --------------------------------------------- |
| **Project** | (default) | `./<agent>/skills/` | Committed with your project, shared with team |
| **Global**  | `-g`      | `~/<agent>/skills/` | Available across all projects                 |

### Installation Methods

When installing interactively, you can choose:

| Method                    | Description                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Symlink** (Recommended) | Creates symlinks from each agent to a canonical copy. Single source of truth, easy updates. |
| **Copy**                  | Creates independent copies for each agent. Use when symlinks aren't supported.              |

## Other Commands

| Command                      | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `npx agents list`            | List installed items (alias: `ls`)            |
| `npx agents find [query]`    | Search for items interactively or by keyword  |
| `npx agents remove [items]`   | Remove installed items from agents            |
| `npx agents check`           | Check for available updates                   |
| `npx agents update`          | Update all installed items to latest versions |
| `npx agents init [name]`     | Create a new template                         |

### `list`

List all installed items. Similar to `npm ls`.

```bash
# List all installed items (project and global)
npx agents list

# List only global items
npx agents ls -g

# Filter by specific agents
npx agents ls -a claude-code -a cursor
```

### `find`

Search for items interactively or by keyword.

```bash
# Interactive search (fzf-style)
npx agents find

# Search by keyword
npx agents find typescript
```

### `check` / `update`

```bash
# Check if any installed items have updates
npx agents check

# Update all items to latest versions
npx agents update
```

### `init`

```bash
# Create SKILL.md in current directory
npx agents init

# Create a new item in a subdirectory
npx agents init my-item
```

### `remove`

Remove installed items from agents.

```bash
# Remove interactively (select from installed items)
npx agents remove

# Remove specific items by name
npx agents remove web-design-guidelines

# Remove multiple items
npx agents remove frontend-design web-design-guidelines

# Remove from global scope
npx agents remove --global web-design-guidelines

# Remove from specific agents only
npx agents remove --agent claude-code cursor my-agent

# Remove all installed items without confirmation
npx agents remove --all

# Remove all items from a specific agent
npx agents remove --skill '*' -a cursor

# Remove a specific item from all agents
npx agents remove my-item --agent '*'

# Use 'rm' alias
npx agents rm my-item
```

| Option         | Description                                      |
| -------------- | ------------------------------------------------ |
| `-g, --global` | Remove from global scope (~/) instead of project |
| `-a, --agent`  | Remove from specific agents (use `'*'` for all)  |
| `-s, --skill`  | Specify skills to remove (use `'*'` for all)     |
| `-y, --yes`    | Skip confirmation prompts                        |
| `--all`        | Shorthand for `--skill '*' --agent '*' -y`       |

## What are Agents & Skills?

**Skills** are reusable instruction sets that extend your coding agent's capabilities. They're defined in `SKILL.md`
files with YAML frontmatter containing a `name` and `description`.

**Agents** (subagents) are specialized personas or automated workflows that can be "hired" to perform tasks.

They let agents perform specialized tasks like:

- Generating release notes from git history
- Creating PRs following your team's conventions
- Integrating with external tools (Linear, Notion, etc.)

Discover more at **[skills.sh](https://skills.sh)**

## Supported Agents

Items can be installed to any of these agents:

<!-- supported-agents:start -->
| Agent | `--agent` | Project Path | Global Path |
|-------|-----------|--------------|-------------|
| Amp, Kimi Code CLI, Replit, Universal | `amp`, `kimi-cli`, `replit`, `universal` | `.agents/skills/` | `~\.config\agents\skills/` |
| Antigravity | `antigravity` | `.agent/skills/` | `~\.gemini\antigravity\skills/` |
| Augment | `augment` | `.augment/skills/` | `~\.augment\skills/` |
| Claude Code | `claude-code` | `.claude/skills/` | `~\.claude\skills/` |
| OpenClaw | `openclaw` | `skills/` | `~\.openclaw\skills/` |
| Cline | `cline` | `.agents/skills/` | `~\.agents\skills/` |
| CodeBuddy | `codebuddy` | `.codebuddy/skills/` | `~\.codebuddy\skills/` |
| Codex | `codex` | `.agents/skills/` | `~\.codex\skills/` |
| Command Code | `command-code` | `.commandcode/skills/` | `~\.commandcode\skills/` |
| Continue | `continue` | `.continue/skills/` | `~\.continue\skills/` |
| Cortex Code | `cortex` | `.cortex/skills/` | `~\.snowflake\cortex\skills/` |
| Crush | `crush` | `.crush/skills/` | `~\.config\crush\skills/` |
| Cursor | `cursor` | `.agents/skills/` | `~\.cursor\skills/` |
| Droid | `droid` | `.factory/skills/` | `~\.factory\skills/` |
| Gemini CLI | `gemini-cli` | `.agents/skills/` | `~\.gemini\skills/` |
| GitHub Copilot | `github-copilot` | `.agents/skills/` | `~\.copilot\skills/` |
| Goose | `goose` | `.goose/skills/` | `~\.config\goose\skills/` |
| Junie | `junie` | `.junie/skills/` | `~\.junie\skills/` |
| iFlow CLI | `iflow-cli` | `.iflow/skills/` | `~\.iflow\skills/` |
| Kilo Code | `kilo` | `.kilocode/skills/` | `~\.kilocode\skills/` |
| Kiro CLI | `kiro-cli` | `.kiro/skills/` | `~\.kiro\skills/` |
| Kode | `kode` | `.kode/skills/` | `~\.kode\skills/` |
| MCPJam | `mcpjam` | `.mcpjam/skills/` | `~\.mcpjam\skills/` |
| Mistral Vibe | `mistral-vibe` | `.vibe/skills/` | `~\.vibe\skills/` |
| Mux | `mux` | `.mux/skills/` | `~\.mux\skills/` |
| OpenCode | `opencode` | `.agents/skills/` | `~\.config\opencode\skills/` |
| OpenHands | `openhands` | `.openhands/skills/` | `~\.openhands\skills/` |
| Pi | `pi` | `.pi/skills/` | `~\.pi\agent\skills/` |
| Qoder | `qoder` | `.qoder/skills/` | `~\.qoder\skills/` |
| Qwen Code | `qwen-code` | `.qwen/skills/` | `~\.qwen\skills/` |
| Roo Code | `roo` | `.roo/skills/` | `~\.roo\skills/` |
| Trae | `trae` | `.trae/skills/` | `~\.trae\skills/` |
| Trae CN | `trae-cn` | `.trae/skills/` | `~\.trae-cn\skills/` |
| Windsurf | `windsurf` | `.windsurf/skills/` | `~\.codeium\windsurf\skills/` |
| Zencoder | `zencoder` | `.zencoder/skills/` | `~\.zencoder\skills/` |
| Neovate | `neovate` | `.neovate/skills/` | `~\.neovate\skills/` |
| Pochi | `pochi` | `.pochi/skills/` | `~\.pochi\skills/` |
| AdaL | `adal` | `.adal/skills/` | `~\.adal\skills/` |
<!-- supported-agents:end -->

> [!NOTE]
> **Kiro CLI users:** After installing skills, manually add them to your custom agent's `resources` in
> `.kiro/agents/<agent>.json`:
>
> ```json
> {
>   "resources": ["skill://.kiro/skills/**/SKILL.md"]
> }
> ```

The CLI automatically detects which coding agents you have installed. If none are detected, you'll be prompted to select
which agents to install to.

## Creating Skills

Skills are directories containing a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does and when to use it
---

# My Skill

Instructions for the agent to follow when this skill is activated.

## When to Use

Describe the scenarios where this skill should be used.

## Steps

1. First, do this
2. Then, do that
```

### Required Fields

- `name`: Unique identifier (lowercase, hyphens allowed)
- `description`: Brief explanation of what the skill does

### Optional Fields

- `metadata.internal`: Set to `true` to hide the skill from normal discovery. Internal skills are only visible and
  installable when `INSTALL_INTERNAL_SKILLS=1` is set. Useful for work-in-progress skills or skills meant only for
  internal tooling.

```markdown
---
name: my-internal-skill
description: An internal skill not shown by default
metadata:
  internal: true
---
```

### Skill Discovery

The CLI searches for skills in these locations within a repository:

<!-- skill-discovery:start -->
- Root directory (looks for `SKILL.md`)
- `skills/` subdirectory and sub-folders (like `.curated/`, `.experimental/`)
- Agent-specific directories (e.g., `.agents/skills/`, `.claude/skills/`, etc.)
- Plugin manifest files (`marketplace.json`, `plugin.json`)
<!-- skill-discovery:end -->

### Plugin Manifest Discovery

If `.claude-plugin/marketplace.json` or `.claude-plugin/plugin.json` exists, skills declared in those files are also discovered:

```json
// .claude-plugin/marketplace.json
{
  "metadata": { "pluginRoot": "./plugins" },
  "plugins": [
    {
      "name": "my-plugin",
      "source": "my-plugin",
      "skills": ["./skills/review", "./skills/test"]
    }
  ]
}
```

This enables compatibility with the [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) ecosystem.

If no skills are found in standard locations, a recursive search is performed.

## Compatibility

Skills are generally compatible across agents since they follow a
shared [Agent Skills specification](https://agentskills.io). However, some features may be agent-specific:

| Feature         | OpenCode | OpenHands | Claude Code | Cline | CodeBuddy | Codex | Command Code | Kiro CLI | Cursor | Antigravity | Roo Code | Github Copilot | Amp | OpenClaw | Neovate | Pi  | Qoder | Zencoder |
| --------------- | -------- | --------- | ----------- | ----- | --------- | ----- | ------------ | -------- | ------ | ----------- | -------- | -------------- | --- | -------- | ------- | --- | ----- | -------- |
| Basic skills    | Yes      | Yes       | Yes         | Yes   | Yes       | Yes   | Yes          | Yes      | Yes    | Yes         | Yes      | Yes            | Yes | Yes      | Yes     | Yes | Yes   | Yes      |
| `allowed-tools` | Yes      | Yes       | Yes         | Yes   | Yes       | Yes   | Yes          | No       | Yes    | Yes         | Yes      | Yes            | Yes | Yes      | Yes     | Yes | Yes   | No       |
| `context: fork` | No       | No        | Yes         | No    | No        | No    | No           | No       | No     | No          | No       | No             | No  | No       | No      | No  | No    | No       |
| Hooks           | No       | No        | Yes         | Yes   | No        | No    | No           | No       | No     | No          | No       | No             | No  | No       | No      | No  | No    | No       |

## Troubleshooting

### "No skills found"

Ensure the repository contains valid `SKILL.md` files with both `name` and `description` in the frontmatter.

### Skill not loading in agent

- Verify the skill was installed to the correct path
- Check the agent's documentation for skill loading requirements
- Ensure the `SKILL.md` frontmatter is valid YAML

### Permission errors

Ensure you have write access to the target directory.

## Environment Variables

| Variable                  | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| `INSTALL_INTERNAL_SKILLS` | Set to `1` or `true` to show and install skills marked as `internal: true` |
| `DISABLE_TELEMETRY`       | Set to disable anonymous usage telemetry                                   |
| `DO_NOT_TRACK`            | Alternative way to disable telemetry                                       |

```bash
# Install internal items
INSTALL_INTERNAL_SKILLS=1 npx agents add wizeline/agent-skills --list
```

## Telemetry

This CLI collects anonymous usage data to help improve the tool. No personal information is collected.

Telemetry is automatically disabled in CI environments.

## License

MIT
