import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function gitIdentity(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Source worktree must be clean');
  return { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

export function releasePrerequisites(root, expectedHead, expectedTree) {
  for (const [name, value] of [['HEAD', expectedHead], ['tree', expectedTree]]) {
    if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error(`Expected ${name} is required (full Git SHA)`);
  }
  const identity = gitIdentity(root);
  if (identity.head !== expectedHead || identity.tree !== expectedTree) throw new Error('Release candidate identity mismatch');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('rev-parse', '--is-shallow-repository') !== 'false') throw new Error('Release checks require full history; fetch with --unshallow');
  const { baseline } = JSON.parse(fs.readFileSync(path.join(root, 'docs/foundation/trajectory-vocabulary.v1.json'), 'utf8'));
  for (const prefix of ['issue_body', 'admitted']) {
    const sha = baseline[`${prefix}_sha`];
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`Invalid historical ${prefix} SHA`);
    let tree;
    try { tree = git('rev-parse', '--verify', `${sha}^{tree}`); }
    catch { throw new Error(`Missing historical object ${prefix}: ${sha}; fetch full repository history`); }
    if (tree !== baseline[`${prefix}_tree`]) throw new Error(`Historical ${prefix} tree mismatch`);
  }
  git('merge-base', '--is-ancestor', baseline.issue_body_sha, baseline.admitted_sha);
  return identity;
}

export function summarizeGo(text) {
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  const counts = { packages: 0, packagesWithoutTests: 0, topLevel: 0, subtests: 0, passed: 0, failed: 0, skipped: 0 };
  const terminal = new Set();
  const started = new Set();
  for (const event of events) {
    if (!event.Package) throw new Error('Go event missing package');
    const key = `${event.Package}:${event.Test ?? ''}`;
    if (['start', 'run'].includes(event.Action)) {
      if (started.has(key)) throw new Error('Duplicate Go start event');
      started.add(key);
    }
    if (!['pass', 'fail', 'skip'].includes(event.Action)) continue;
    if (!started.has(key)) throw new Error('Go terminal event without start');
    if (terminal.has(key)) throw new Error('Duplicate Go terminal event');
    terminal.add(key);
    if (event.Test) {
      counts[event.Test.includes('/') ? 'subtests' : 'topLevel']++;
      counts[{ pass: 'passed', fail: 'failed', skip: 'skipped' }[event.Action]]++;
    } else if (event.Action === 'skip') counts.packagesWithoutTests++;
    else if (event.Action === 'pass') counts.packages++;
    else counts.failed++;
  }
  if (started.size !== terminal.size) throw Object.assign(new Error('Go report has unfinished packages or tests'), { counts });
  if (!counts.packages || !counts.topLevel || counts.failed || counts.skipped) throw Object.assign(new Error('Go tests failed, skipped, or empty'), { counts });
  return counts;
}

export function summarizeVitest(report) {
  const fields = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites'];
  for (const field of fields) if (!Number.isInteger(report[field]) || report[field] < 0) throw new Error(`Invalid Vitest ${field}`);
  const assertions = report.testResults?.flatMap(result => result.assertionResults ?? []);
  if (!Array.isArray(assertions) || assertions.length !== report.numTotalTests) throw new Error('Vitest assertion count mismatch');
  const counts = Object.fromEntries(fields.map(field => [field, report[field]]));
  if (report.success !== true || !report.numTotalTests || !report.numTotalTestSuites ||
      report.numPassedTests !== report.numTotalTests || report.numFailedTests || report.numPendingTests || report.numTodoTests ||
      report.numPassedTestSuites !== report.numTotalTestSuites || report.numTotalTestSuites < report.testResults.length ||
      report.numFailedTestSuites || report.numPendingTestSuites || assertions.some(test => test.status !== 'passed') ||
      report.testResults.some(result => result.status !== 'passed')) throw Object.assign(new Error('Vitest tests failed, skipped, or empty'), { counts });
  return counts;
}

// A report never overrides a failed process; failed reports still retain counts.
export function commandOutcome(result, readReport) {
  const outcome = { exit_code: result.status, signal: result.signal,
    status: result.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : result.status === 0 ? 'PASS' : 'FAIL' };
  if (result.error) outcome.error = result.error.message;
  try { if (readReport) outcome.tests = readReport(); }
  catch (error) {
    if (error.counts) outcome.tests = error.counts;
    outcome.report_error = error.message;
    if (outcome.status === 'PASS') outcome.status = 'FAIL';
  }
  return outcome;
}
