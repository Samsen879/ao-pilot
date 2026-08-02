#!/usr/bin/env node

import path from 'node:path';

import { loadAndVerifySelfHostingReceipt } from './ao/lib/self-hosting-receipt.js';

function usage() {
  return 'Usage: npm run verify:self-hosting -- --receipt <path>';
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
} else {
  const receiptIndex = argv.indexOf('--receipt');
  const receiptPath = receiptIndex === -1 ? null : argv[receiptIndex + 1];
  if (receiptPath == null || receiptPath.startsWith('-') || argv.length !== 2) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 4;
  } else {
    try {
      const result = loadAndVerifySelfHostingReceipt(path.resolve(receiptPath));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        status: 'blocked',
        code: 'self_hosting_receipt_invalid',
        message: error.message,
      }, null, 2)}\n`);
      process.exitCode = 2;
    }
  }
}
