import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  DEFAULT_AO_ROOT,
  MISSING_VALUE,
  ParityHarnessError,
  applyApprovedDifferences,
  buildStableFingerprint,
  canonicalize,
  diffObservables,
  loadImplementation,
  runConsolidationParity,
} from '../../scripts/consolidation/parity-harness.js';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('AO consolidation behavioral parity harness', () => {
  it('canonicalizes object order, timestamps, PIDs, and temporary paths before SHA-256', () => {
    const left = canonicalize({
      zeta: '/tmp/run-1/output.json',
      observed_at: '2026-04-03T10:00:00.000Z',
      pid: 12345,
      nested: { beta: 2, alpha: 1 },
    });
    const right = canonicalize({
      nested: { alpha: 1, beta: 2 },
      pid: 99999,
      observed_at: '2028-01-01T00:00:00.000Z',
      zeta: '/tmp/run-1/output.json',
    });

    expect(left).toEqual({
      nested: { alpha: 1, beta: 2 },
      observed_at: '<TIMESTAMP>',
      pid: '<PID>',
      zeta: '<TMP>/run-1/output.json',
    });
    expect(buildStableFingerprint(left)).toMatch(/^[a-f0-9]{64}$/);
    expect(buildStableFingerprint(left)).toBe(buildStableFingerprint(right));
  });

  it('fails closed when a parity-required internal module is unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-parity-missing-module-'));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n', 'utf8');

    await expect(loadImplementation(root, 'incomplete')).rejects.toMatchObject({
      name: 'ParityHarnessError',
      code: 'missing_parity_module',
    });
    await expect(loadImplementation(root, 'incomplete')).rejects.toBeInstanceOf(ParityHarnessError);
  });

  it('requires exact explicit approval values and reports stale approvals', () => {
    const differences = diffObservables(
      { metrics: { window: { since: '<TIMESTAMP>' } } },
      { metrics: {} },
    );
    expect(differences).toEqual([{
      path: '$.metrics.window',
      standalone: { since: '<TIMESTAMP>' },
      cie: MISSING_VALUE,
    }]);

    const classified = applyApprovedDifferences(differences, {
      differences: [
        {
          id: 'metrics-window-v1',
          path: '$.metrics.window',
          reason: 'Bounded metrics window is intentionally canonical.',
          standalone: { since: '<TIMESTAMP>' },
          cie: MISSING_VALUE,
        },
        {
          id: 'stale-approval',
          path: '$.unused',
          reason: 'This approval must not silently persist.',
          standalone: 1,
          cie: 2,
        },
      ],
    });

    expect(classified.approved).toHaveLength(1);
    expect(classified.unapproved).toHaveLength(0);
    expect(classified.unused_approvals.map((item) => item.id)).toEqual(['stale-approval']);
  });

  it('replays the checked-in generic fixture with the pinned standalone fingerprint', async () => {
    const report = await runConsolidationParity();

    expect(report.status).toBe('passed');
    expect(report.standalone_baseline).toEqual({
      expected_fingerprint: '20f79e5fb136b273b9d35519694829cc3aead64eec5c92d170ec93581bc7cd0b',
      actual_fingerprint: '20f79e5fb136b273b9d35519694829cc3aead64eec5c92d170ec93581bc7cd0b',
      matches: true,
      expectation_failure_count: 0,
    });
    expect(report.standalone.observable.policy_action.executed_vs_effect).toMatchObject({
      durable_status: 'executed',
      external_effect_count: 0,
      semantic_classification: 'durable_state_transition_without_external_command_effect',
    });
    expect(report.standalone.observable.provider).toMatchObject({
      intent: {
        command: 'ao',
        args: ['status', '-p', 'parity-project', '--json'],
        cwd: '<HARNESS_CWD>',
      },
      receipt: {
        fake_provider_call_count: 1,
        production_effect_count: 0,
      },
    });
  });

  it('supports AO_CIE_REPO-style cross-checks without source-text comparison', async () => {
    const report = await runConsolidationParity({
      cieRoot: DEFAULT_AO_ROOT,
    });

    expect(report.status).toBe('passed');
    expect(report.parity).toMatchObject({
      requested: true,
      status: 'passed',
      difference_count: 0,
      approved_difference_count: 0,
      unapproved_difference_count: 0,
      cie_expectation_failure_count: 0,
    });
    expect(report.cie.fingerprint).toBe(report.standalone.fingerprint);
  });
});
