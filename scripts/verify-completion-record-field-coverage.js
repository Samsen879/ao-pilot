#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCompletionRecordFieldCoverageReport,
  loadCompletionRecordFieldCoverage,
  stableDigest,
} from './ao/lib/completion-record-field-coverage.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledgerPath = path.join(repositoryRoot, 'docs/foundation/completion-record-field-coverage.v1.json');
const ledger = loadCompletionRecordFieldCoverage(ledgerPath);
const first = buildCompletionRecordFieldCoverageReport(ledger, { repositoryRoot });
const replay = buildCompletionRecordFieldCoverageReport(JSON.parse(JSON.stringify(ledger)), { repositoryRoot });

if (stableDigest(first) !== stableDigest(replay)) {
  throw new Error('Completion Record field coverage replay drifted');
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(first, null, 2)}\n`);
} else {
  process.stdout.write([
    'Completion Record field coverage: PASS',
    `candidates: ${first.summary.candidate_count}`,
    `required/conditional/unsupported: ${first.summary.required_count}/${first.summary.conditional_count}/${first.summary.unsupported_count}`,
    `established/not-established/omitted: ${first.summary.established_count}/${first.summary.not_established_count}/${first.summary.omission_count}`,
    `oracle sources: ${first.source_digests.length}`,
    `report fingerprint: ${first.report_fingerprint}`,
    '',
  ].join('\n'));
}
