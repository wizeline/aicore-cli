#!/usr/bin/env node

process.env.IS_AGENTS_CLI = "1";

import module from 'node:module';

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

await import('../dist/cli.mjs');
