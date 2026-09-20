#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const distPath = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
try {
  await access(distPath, constants.F_OK);
} catch {
  process.stderr.write('BUILD_REQUIRED: dist/cli/index.js not found. Run `pnpm build` first.\n');
  process.exit(2);
}

await import(pathToFileURL(distPath).href);
