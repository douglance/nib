#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const tracked = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
  cwd: root,
  encoding: 'utf8',
  },
).split('\0').filter(Boolean);

const forbiddenPaths = [
  /^apps\/web(?:\/|$)/,
  /^artifacts(?:\/|$)/,
  /^migrations(?:\/|$)/,
  /^worker(?:\/|$)/,
  /^wrangler\.dogfood\.jsonc$/,
  /^docs\/(?:architecture|billing|deployment|dogfood|operations|security)\.md$/,
];

const forbiddenContent = [
  /\bSTRIPE_SECRET_KEY\b/,
  /\bGEMINI_API_KEY\b/,
  /\bCF_ACCESS_CLIENT_SECRET\b/,
  /\bCLOUDFLARE_API_TOKEN\b/,
  /\bMETER_EVENT_DESTINATION\b/,
];

const failures = [];
for (const file of tracked) {
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    failures.push(`${file}: private runtime path`);
    continue;
  }

  const contents = fs.readFileSync(path.join(root, file));
  if (contents.includes(0)) continue;
  const text = contents.toString('utf8');
  for (const pattern of forbiddenContent) {
    if (pattern.test(text)) failures.push(`${file}: contains ${pattern.source}`);
  }
}

const rootLicense = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
if (!rootLicense.includes('Apache License') || !rootLicense.includes('Version 2.0')) {
  failures.push('LICENSE: must contain the Apache License 2.0 text');
}

const cargoManifests = tracked.filter((file) => file.endsWith('Cargo.toml'));
for (const manifest of cargoManifests) {
  const text = fs.readFileSync(path.join(root, manifest), 'utf8');
  if (!text.includes('publish = false')) failures.push(`${manifest}: missing publish = false`);
  if (text.includes('license-file')) failures.push(`${manifest}: uses license-file instead of Apache-2.0 metadata`);
}

if (failures.length > 0) {
  console.error('Open-core boundary check failed:\n' + failures.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}

console.log(`Open-core boundary check passed for ${tracked.length} publish candidates.`);
