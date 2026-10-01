import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.(?:mjs|js|ts|tsx)$/.test(entry.name) ? [path] : [];
  }).sort();
}

if (!process.versions.bun) {
  throw new Error('Run with pnpm dlx bun@1.3.10 scripts/test-isolated.mjs');
}

const files = testFiles(join(frontend, 'tests'));
if (files.length === 0) throw new Error('No frontend tests found');

// Bun shares global properties and module mocks within one test process.
// A fresh process per file prevents browser/Tauri fixtures leaking into peers.
const failed = [];
for (const file of files) {
  const label = relative(frontend, file);
  console.log(`Running ${label}`);
  const result = spawnSync(process.execPath, ['test', file], {
    cwd: frontend,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error);
    failed.push(label);
  }
}

console.log(`${files.length - failed.length}/${files.length} isolated test files passed`);
if (failed.length) {
  console.error(`Failed files:\n${failed.join('\n')}`);
  process.exitCode = 1;
}
