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

## 4. Referencia de Directorios y Funciones

Aquí tienes un desglose de qué hace cada parte del código. No te preocupes por los nombres técnicos, cada uno tiene un propósito claro.

### `src/` (El Corazón del Proyecto)

Este directorio contiene la lógica principal. Se divide en varios archivos según su función:

#### **Comandos Principales**
- **`cli.ts`**: Es el punto de entrada. Analiza lo que escribes en la terminal y llama a la función correcta.
- **`add.ts`**:
    - `runAdd()`: La función principal para añadir nuevas "skills" o "subagents".
    - `parseAddOptions()`: Entiende las opciones que escribes (como `-g` para global).
- **`remove.ts`**:
    - `removeCommand()`: Se encarga de borrar las skills que ya no quieres.
- **`list.ts`**:
    - `runList()`: Muestra en pantalla todo lo que tienes instalado.
- **`find.ts`**:
    - `runFind()`: Te permite buscar nuevas skills en internet de forma interactiva.
- **`sync.ts`**:
    - `runSync()`: Sincroniza tus archivos locales con los que están en la carpeta `node_modules`.

#### **Lógica de Instalación y Archivos**
- **`installer.ts`**: Es el "constructor".
    - `installSkillForAgent()`: Copia o enlaza los archivos de una skill a un agente específico.
    - `getCanonicalPath()`: Calcula la ruta exacta donde debe guardarse cada cosa.
- **`skill-lock.ts`** y **`local-lock.ts`**:
    - `readSkillLock()` / `writeSkillLock()`: Leen y guardan el archivo `.skill-lock.json` para no perder la cuenta de lo instalado.
- **`source-parser.ts`**:
    - `parseSource()`: Analiza si lo que escribiste es una URL de GitHub, una ruta local o un nombre de paquete.
- **`git.ts`**:
    - `cloneRepo()`: Descarga código desde GitHub temporalmente para poder extraer las skills.

#### **Utilidades y Configuración**
- **`agents.ts`**: Define qué agentes de IA son compatibles (como Claude Code, Cursor, Windsurf) y dónde guardan sus archivos.
- **`skills.ts`**: Contiene funciones para leer y entender los archivos `SKILL.md`.
- **`telemetry.ts`**:
    - `track()`: Envía datos anónimos sobre el uso para ayudar a mejorar la herramienta (si está activado).

---

### `scripts/` (Herramientas para Desarrolladores)

Estos no son para el usuario final, sino para quienes ayudan a construir `aicore-cli`:

- **`execute-tests.ts`**: Ejecuta todas las pruebas para asegurar que no hay errores.
- **`sync-agents.ts`**: Mantiene actualizado el archivo `README.md` con la lista de agentes compatibles.
- **`validate-agents.ts`**: Revisa que la configuración de los agentes sea correcta.
- **`generate-licenses.ts`**: Crea un archivo con todas las licencias de las librerías que usamos.

---

### `bin/` (Los Accesos Directos)

- **`aicore.mjs`**, **`cli.mjs`**, **`agents.mjs`**: Son archivos muy pequeños que solo sirven para arrancar el programa principal que está en `src/`.

---

## 5. Consejos para Novatos

1.  **Modificar una función**: Si quieres cambiar cómo se instala algo, busca en `src/installer.ts`.
2.  **Añadir un comando**: Tendrías que crear un archivo en `src/` y registrarlo en `src/cli.ts`.
3.  **Probar tus cambios**: Usa `pnpm build` y luego ejecuta el comando desde `bin/` para ver si funciona como esperas.
