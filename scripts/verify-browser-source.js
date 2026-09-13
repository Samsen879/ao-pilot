#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve('browser');
const receipt = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE_IMPORT.json'), 'utf8'));
const visualFiles = receipt.files.filter(({path: name}) =>
  name.startsWith('packages/web/src/components/') ||
  name.startsWith('packages/web/src/app/') && !name.includes('/api/') ||
  name.startsWith('packages/web/public/'));
for (const file of visualFiles) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file.path))).digest('hex');
  if (hash !== file.sha256) throw new Error(`Original visual source changed: ${file.path}`);
}
console.log(JSON.stringify({status: 'PASS', source_commit: receipt.source_commit, unchanged_visual_files: visualFiles.length}));
