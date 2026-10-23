import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { gitIdentity, releasePrerequisites, summarizeGo, summarizeVitest, commandOutcome, tmuxCleanupOutcome } from '../../scripts/ao/lib/current-source-evidence.js';

describe('release prerequisite identity and history', () => {
  let root;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prereq-'));
    git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    fs.writeFileSync(path.join(root, 'input'), 'baseline'); git('add', '.'); git('commit', '-m', 'baseline');
    const { head, tree } = gitIdentity(root);
    fs.mkdirSync(path.join(root, 'docs/foundation'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/foundation/trajectory-vocabulary.v1.json'), JSON.stringify({ baseline: {
      issue_body_sha: head, issue_body_tree: tree, admitted_sha: head, admitted_tree: tree,
    } }));
    git('add', '.'); git('commit', '-m', 'manifest');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  test('accepts exact clean full-history candidate', () => {
    const { head, tree } = gitIdentity(root);
    expect(releasePrerequisites(root, head, tree)).toEqual({ head, tree });
  });
  test('rejects absent, wrong and dirty candidate before execution', () => {
    const { head, tree } = gitIdentity(root);
    expect(() => releasePrerequisites(root, undefined, tree)).toThrow('required');
    expect(() => releasePrerequisites(root, head, '')).toThrow('required');
    expect(() => releasePrerequisites(root, '0'.repeat(40), tree)).toThrow('mismatch');
    expect(() => releasePrerequisites(root, head, '0'.repeat(40))).toThrow('mismatch');
    fs.writeFileSync(path.join(root, 'input'), 'dirty');
    expect(() => releasePrerequisites(root, head, tree)).toThrow('clean');
  });
  test('rejects an actual depth-one clone', () => {
    const clone = `${root}-shallow`;
    try {
      git('clone', '--depth=1', `file://${root}`, clone);
      const { head, tree } = gitIdentity(clone);
      expect(() => releasePrerequisites(clone, head, tree)).toThrow('full history');
      execFileSync('git', ['fetch', '--unshallow'], { cwd: clone, stdio: 'pipe' });
      expect(releasePrerequisites(clone, head, tree)).toEqual({ head, tree });
    } finally { fs.rmSync(clone, { recursive: true, force: true }); }
  });
  test('reports missing historical object rather than false ancestry', () => {
    const file = path.join(root, 'docs/foundation/trajectory-vocabulary.v1.json');
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    document.baseline.issue_body_sha = '0'.repeat(40);
    fs.writeFileSync(file, JSON.stringify(document)); git('add', '.'); git('commit', '-m', 'missing history');
    const { head, tree } = gitIdentity(root);
    expect(() => releasePrerequisites(root, head, tree)).toThrow('Missing historical object');
  });
});

describe('source test evidence', () => {
  test('accepts only stopped or already-stopped private tmux cleanup', () => {
    const socket = '/tmp/private/tmux-1000/default';
    expect(tmuxCleanupOutcome({ status: 0 }, socket)).toBe('STOPPED');
    expect(tmuxCleanupOutcome({ status: 1, stderr: `no server running on ${socket}\n` }, socket)).toBe('ALREADY_STOPPED');
    for (const result of [
      { status: 1, stderr: 'permission denied' },
      { status: 1, stderr: 'no server running on /tmp/another/socket' },
      { status: 0, error: { code: 'EPERM' } },
      { status: null, signal: 'SIGKILL' },
    ]) expect(tmuxCleanupOutcome(result, socket)).toBe('FAIL');
  });
  const go = events => {
    const packages = [...new Set(events.map(event => event.Package ?? 'fixture'))];
    const starts = packages.map(Package => ({ Package, Action: 'start' }));
    return [...starts, ...events.flatMap(event => event.Test ? [{ ...event, Action: 'run' }, event] : [event])].map(event => JSON.stringify({ Package: 'fixture', ...event })).join('\n');
  };
  test('counts Go top-level, subtests and no-test packages separately', () => {
    expect(summarizeGo(go([{ Action: 'pass', Test: 'TestA/sub' }, { Action: 'pass', Test: 'TestA' }, { Action: 'pass' }, { Package: 'empty', Action: 'skip' }]))).toEqual({ packages: 1, packagesFailed: 0, packagesWithoutTests: 1, topLevel: 1, subtests: 1, passed: 2, failed: 0, skipped: 0 });
  });
  test.each(['skip', 'fail'])('rejects Go %s', action => {
    expect(() => summarizeGo(go([{ Action: action, Test: 'TestA' }, { Action: 'pass' }]))).toThrow('failed, skipped, or empty');
  });
  test('rejects empty, malformed and duplicate Go reports', () => {
    for (const report of ['', 'not json', go([{ Action: 'pass' }]), go([{ Action: 'pass', Test: 'TestA' }, { Action: 'pass', Test: 'TestA' }])]) expect(() => summarizeGo(report)).toThrow();
  });
  test('rejects trailing unfinished Go package and test', () => {
    const passing = go([{ Action: 'pass', Test: 'TestA' }, { Action: 'pass' }]);
    const unfinished = [{ Package: 'other', Action: 'start' }, { Package: 'other', Test: 'TestB', Action: 'run' }].map(JSON.stringify).join('\n');
    expect(() => summarizeGo(passing + '\n' + unfinished)).toThrow('unfinished');
  });
  const vitest = () => ({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0, testResults: [{ status: 'passed', assertionResults: [{ status: 'passed' }] }] });
  test('retains failed Go and Vitest counts without overriding command failure', () => {
    const reports = [
      () => summarizeGo(go([{ Action: 'fail', Test: 'TestA' }, { Action: 'fail' }])),
      () => summarizeVitest({ ...vitest(), success: false, numPassedTests: 0, numFailedTests: 1, testResults: [{ status: 'failed', assertionResults: [{ status: 'failed' }] }] }),
    ];
    for (const read of reports) {
      const outcome = commandOutcome({ status: 1, signal: null }, read);
      expect(outcome.status).toBe('FAIL'); expect(outcome.tests).toBeDefined(); expect(outcome.report_error).toBeDefined();
      if ('packagesFailed' in outcome.tests) expect(outcome.tests).toMatchObject({ topLevel: 1, failed: 1, packagesFailed: 1 });
    }
    expect(commandOutcome({ status: 1 }, () => summarizeVitest(vitest())).status).toBe('FAIL');
    expect(commandOutcome({ status: 0, error: { code: 'EPERM', message: 'denied' } }, () => summarizeVitest(vitest())).status).toBe('FAIL');
    expect(commandOutcome({ status: null, error: { code: 'ETIMEDOUT' } }, () => { throw new Error('missing report'); }).status).toBe('TIMEOUT');
    expect(commandOutcome({ status: 1 }, () => JSON.parse('{')).status).toBe('FAIL');
  });
  test('accepts passing Vitest assertion evidence', () => expect(summarizeVitest(vitest()).numPassedTests).toBe(1));
  test.each([
    { success: false }, { numTotalTests: 0, numPassedTests: 0, testResults: [] },
    { numPendingTests: 1 }, { numTodoTests: 1 }, { numFailedTests: 1 },
    { numPendingTestSuites: 1 }, { numTotalTests: 2 }, { testResults: [] },
    { testResults: [{ status: 'passed', assertionResults: [{ status: 'skipped' }] }] },
    { numTotalTestSuites: undefined }, { numTotalTestSuites: 99, numPassedTestSuites: 0 },
  ])('rejects incomplete or contradictory Vitest report %j', change => expect(() => summarizeVitest({ ...vitest(), ...change })).toThrow());
});

describe('workflow gates', () => {
  const workflow = name => yaml.safeLoad(fs.readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  test('release depends on current-source and fetches full history', () => {
    const { jobs } = workflow('release');
    expect(jobs.package.needs).toBe('current-source');
    expect(jobs['current-source'].with.ref).toBe('${{ github.sha }}');
    expect(jobs.package.steps[0].with['fetch-depth']).toBe(0);
  });
  test('self-hosting checks one immutable candidate everywhere', () => {
    const { jobs } = workflow('self-hosting');
    expect(jobs['current-source'].with.ref).toBe('${{ needs.resolve-candidate.outputs.head }}');
    const receipt = jobs['verify-self-hosting-receipt'];
    expect(receipt.needs).toContain('current-source');
    expect(receipt.steps[0].with.ref).toBe(jobs['current-source'].with.ref);
    expect(receipt.env.AO_PHASE_ZERO_EXPECTED_HEAD).toBe(jobs['current-source'].with.ref);
    expect(receipt.env.AO_PHASE_ZERO_EXPECTED_TREE).toBe(jobs['current-source'].with.tree);
  });
  test('both source jobs preserve failure artifacts', () => {
    const { source } = workflow('current-source').jobs;
    expect(source.strategy.matrix.suite).toEqual(['native', 'browser']);
    expect(source.strategy['fail-fast']).toBe(false);
    const upload = source.steps.find(step => step.uses?.startsWith('actions/upload-artifact'));
    expect(upload.if).toBe('always()'); expect(upload.with['if-no-files-found']).toBe('error');
  });
  test('release prerequisites precede expensive root tests', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(manifest.scripts['release:check'].startsWith('npm run verify:release-prerequisites && npm test')).toBe(true);
  });
});
