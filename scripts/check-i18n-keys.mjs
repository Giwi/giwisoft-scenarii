#!/usr/bin/env node
// Checks that every `t('key')` used in the frontend exists in the English catalogue.
// Run: node scripts/check-i18n-keys.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const catalog = readFileSync(join(root, 'frontend/src/app/shared/locales/en.ts'), 'utf-8');
const known = new Set([...catalog.matchAll(/^ {2}'([^']+)':/gm)].map(m => m[1]));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|html)$/.test(path)) out.push(path);
  }
  return out;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

let failures = 0;
for (const path of walk(join(root, 'frontend/src/app'))) {
  const source = stripComments(readFileSync(path, 'utf-8'));
  for (const m of source.matchAll(/\bt\('([^']+)'/g)) {
    if (!known.has(m[1])) {
      console.error(`unknown message key '${m[1]}' in ${relative(root, path)}`);
      failures++;
    }
  }
}
console.log(`${known.size} keys known, ${failures} unknown usages`);
process.exit(failures ? 1 : 0);