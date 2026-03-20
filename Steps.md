# Project Analysis: aicore-cli

Welcome to the **aicore-cli** project! This document provides a high-level overview of the project structure, how its components interact, and how to work with it using different package managers.

## 1. Project Structure

The project is organized into several key directories:

- **`bin/`**: The "entry points" of the application. These are the files that actually run when you use the CLI (e.g., `aicore`, `subagents`, `skills`). They are small wrappers that load the real logic from the `dist/` folder (where the code goes after it's compiled).
- **`src/`**: This is where the "brain" of the project lives. It's written in TypeScript.
    - `cli.ts`: The main controller. It reads your commands and decides which part of the code should handle them.
    - `add.ts`, `remove.ts`, `list.ts`, `find.ts`, `sync.ts`: These files contain the specific logic for each CLI command.
    - `providers/`: Logic for talking to external sources like GitHub or a registry to find skills.
    - `prompts/`: Code that creates interactive menus (like when the CLI asks you to pick from a list).
    - `skill-lock.ts`: Manages the `.skill-lock.json` file, which keeps track of what you've installed.
- **`tests/`**: Contains automated tests to make sure everything works correctly. If you change something, you should run these tests.
- **`scripts/`**: Small helper tools used by developers to automate tasks like validating data or updating documentation.
- **`skills/`**: Examples of "skills" (sets of instructions for AI agents) used within the project.

## 2. How Everything Works Together (Interactions)

Think of the CLI as a restaurant:
1.  **The Menu (`bin/`)**: You (the user) call a command like `skills add`.
2.  **The Waiter (`src/cli.ts`)**: The CLI receives your request, figures out what you want, and takes the order to the kitchen.
3.  **The Kitchen (`src/add.ts`, `src/remove.ts`, etc.)**: The specific command logic executes. If it needs to "buy ingredients" (fetch a skill from GitHub), it uses the **Providers** (`src/providers/`).
4.  **The Pantry (`.skill-lock.json`)**: The project records what it has "cooked" and "stored" in a lock file so it can find it or update it later.
5.  **The Result**: A new skill is installed on your computer, usually as a link (symlink) to the actual files, making it ready for your AI agent to use.

## 3. Using Package Managers (npm, pnpm, yarn)

This project mainly uses **pnpm**, but you might see references to others. Here is where each one is used:

### **pnpm** (The Primary Tool)
This is the main tool used for developing this project.
- **Installing Dependencies**: `pnpm install` (Installs all the libraries the project needs).
- **Building the Project**: `pnpm build` (Converts the TypeScript code in `src/` into JavaScript that can run).
- **Running Tests**: `pnpm test` (Runs the automated tests in the `tests/` folder).
- **Formatting Code**: `pnpm format` (Makes the code look clean and consistent).
- **Development**: `pnpm dev` (Runs the CLI directly from source for testing).

### **npm** (The Publishing Tool)
Mainly used for releasing the project to the public.
- **Publishing**: `npm publish` (Sends the finished package to the npm registry so others can install it).
- **Version Management**: `npm version` (Increases the version number of the project).
- **Global Install**: Users of your tool will often run `npm install -g aicores`.

### **yarn** (Alternative for Users)
This project doesn't use Yarn for development, but it's mentioned as an option for people who want to *use* the tool.
- **Global Install**: Users can run `yarn global add aicores` if they prefer Yarn over npm.

## 4. Directory and Function Reference

Here is a breakdown of what each part of the code does. Don't worry about technical names, each has a clear purpose.

### `src/` (The Heart of the Project)

This directory contains the main logic. It is divided into several files according to their function:

#### **Main Commands**
- **`cli.ts`**: It is the entry point. It analyzes what you type in the terminal and calls the correct function.
- **`add.ts`**:
    - `runAdd()`: The main function to add new "skills" or "subagents".
    - `parseAddOptions()`: Understands the options you type (like `-g` for global).
- **`remove.ts`**:
    - `removeCommand()`: Handles deleting skills you no longer want.
- **`list.ts`**:
    - `runList()`: Displays everything you have installed on the screen.
- **`find.ts`**:
    - `runFind()`: Allows you to search for new skills online interactively.
- **`sync.ts`**:
    - `runSync()`: Synchronizes your local files with those in the `node_modules` folder.

#### **Installation Logic and Files**
- **`installer.ts`**: It is the builder.
    - `installSkillForAgent()`: Copies or links skill files to a specific agent.
    - `getCanonicalPath()`: Calculates the exact path where everything should be saved.
- **`skill-lock.ts`** and **`local-lock.ts`**:
    - `readSkillLock()` / `writeSkillLock()`: Read and save the `.skill-lock.json` file to keep track of what is installed.
- **`source-parser.ts`**:
    - `parseSource()`: Analyzes if what you typed is a GitHub URL, a local path, or a package name.
- **`git.ts`**:
    - `cloneRepo()`: Temporarily downloads code from GitHub to extract skills.

#### **Utilities and Configuration**
- **`agents.ts`**: Defines which AI agents are compatible (like Claude Code, Cursor, Windsurf) and where they store their files.
- **`skills.ts`**: Contains functions to read and understand `SKILL.md` files.
- **`telemetry.ts`**:
    - `track()`: Sends anonymous usage data to help improve the tool (if enabled).

---

### `scripts/` (Developer Tools)

These are not for the end user, but for those who help build `aicore-cli`:

- **`execute-tests.ts`**: Runs all tests to ensure there are no errors.
- **`sync-agents.ts`**: Keeps the `README.md` file updated with the list of compatible agents.
- **`validate-agents.ts`**: Checks that the agent configuration is correct.
- **`generate-licenses.ts`**: Creates a file with all the licenses of the libraries we use.

---

### `bin/` (Shortcuts)

- **`aicore.mjs`**, **`cli.mjs`**, **`agents.mjs`**: These are very small files that only serve to start the main program located in `src/`.

---

## 5. Tips for Newcomers

1.  **Modify a function**: If you want to change how something is installed, look in `src/installer.ts`.
2.  **Add a command**: You would need to create a file in `src/` and register it in `src/cli.ts`.
3.  **Test your changes**: Use `pnpm build` and then run the command from `bin/` to see if it works as you expect.
