import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSpawnSync = jest.fn();
const mockExistsSync = jest.fn();
const mockStatSync = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  spawnSync: mockSpawnSync,
}));

jest.unstable_mockModule('node:fs', async () => {
  const actual = await jest.requireActual('node:fs');
  return {
    ...actual,
    existsSync: mockExistsSync,
    statSync: mockStatSync,
  };
});

const { runCli: runReconcileCli } = await import('../../scripts/ao-reconcile.js');
const { runCli: runDoctorCli } = await import('../../scripts/ao-doctor.js');
const { runCli: runLifecycleCli } = await import('../../scripts/ao-lifecycle.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'acceptance');

const SCENARIOS = {
  'clean-pr-continuity': {
    prNumber: 91,
    fixtureDir: path.join(FIXTURE_ROOT, 'clean-pr-continuity'),
    githubFixture: 'github-pr-91.json',
    currentBranch: 'feat/issue-91',
    headSha: '910abc',
  },
  'ci-failed-pr': {
    prNumber: 92,
    fixtureDir: path.join(FIXTURE_ROOT, 'ci-failed-pr'),
    githubFixture: 'github-pr-92.json',
    currentBranch: 'feat/issue-92',
    headSha: 'abc123',
  },
  'approved-and-green-pr': {
    prNumber: 93,
    fixtureDir: path.join(FIXTURE_ROOT, 'approved-and-green-pr'),
    githubFixture: 'github-pr-93.json',
    currentBranch: 'feat/issue-93',
    headSha: '93abc0',
  },
  'orphaned-ownership': {
    prNumber: 94,
    fixtureDir: path.join(FIXTURE_ROOT, 'orphaned-ownership'),
    githubFixture: 'github-pr-94.json',
    currentBranch: 'feat/issue-94',
    headSha: '94abc0',
  },
  'stale-worker-ownership': {
    prNumber: 95,
    fixtureDir: path.join(FIXTURE_ROOT, 'stale-worker-ownership'),
    githubFixture: 'github-pr-95.json',
    currentBranch: 'feat/issue-95',
    headSha: '95abc0',
  },
  'ambiguous-cross-source-disagreement': {
    prNumber: 96,
    fixtureDir: path.join(FIXTURE_ROOT, 'ambiguous-cross-source-disagreement'),
    githubFixture: 'github-pr-96.json',
    currentBranch: 'feat/issue-96',
    headSha: '96abc0',
  },
};

let activeScenario = null;

function fixture(name) {
  return readFileSync(path.join(activeScenario.fixtureDir, name), 'utf8');
}

function success(stdout) {
  return {
    status: 0,
    stdout,
    stderr: '',
  };
}

function useScenario(name) {
  activeScenario = SCENARIOS[name];
  if (!activeScenario) {
    throw new Error(`Unknown scenario: ${name}`);
  }

  mockSpawnSync.mockImplementation((command, args) => {
    if (command === 'ao') {
      expect(args).toEqual(['status', '-p', 'my-project', '--json']);
      return success(fixture('ao-status.json'));
    }

    if (command === 'gh') {
      expect(args).toEqual([
        'pr',
        'view',
        String(activeScenario.prNumber),
        '--json',
        'number,state,headRefName,headRefOid,reviewDecision,mergeStateStatus,isDraft,statusCheckRollup,url,reviews',
      ]);
      return success(fixture(activeScenario.githubFixture));
    }

    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return success('/home/user/my-project\n');
    }
    if (command === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
      return success(`${activeScenario.currentBranch}\n`);
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return success(`${activeScenario.headSha}\n`);
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return success(`origin/${activeScenario.currentBranch}\n`);
    }
    if (command === 'git' && args[0] === 'status') {
      return success(`## ${activeScenario.currentBranch}...origin/${activeScenario.currentBranch}\n`);
    }

    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  });
}

describe('ao lifecycle acceptance', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockExistsSync.mockReset();
    mockStatSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it('keeps clean continuity visible while release readiness stays ambiguous on review-pending PRs', async () => {
    useScenario('clean-pr-continuity');
    const stdout = [];

    const result = await runReconcileCli(['--pr', '91', '--json', '--strict'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(12);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      top_status: 'ambiguous',
      automation_disposition: 'human_gate',
      pr_assessments: [
        {
          pr_number: 91,
          ownership: {
            status: 'clear',
            owner_session: 'worker-91',
          },
          release_readiness: {
            status: 'ambiguous',
            basis: ['review_pending'],
          },
        },
      ],
    });
  });

  it('blocks orphaned PRs in reconcile and preserves the finding through doctor', async () => {
    useScenario('orphaned-ownership');
    const reconcileStdout = [];
    const doctorStdout = [];

    const reconcileResult = await runReconcileCli(['--pr', '94', '--json', '--strict'], {
      writeStdout: (text) => reconcileStdout.push(text),
      writeStderr: () => {},
    });
    const doctorResult = await runDoctorCli(['--pr', '94', '--json', '--strict'], {
      writeStdout: (text) => doctorStdout.push(text),
      writeStderr: () => {},
    });

    expect(reconcileResult.exitCode).toBe(11);
    expect(JSON.parse(reconcileStdout.join(''))).toMatchObject({
      top_status: 'blocked',
      pr_assessments: [
        {
          pr_number: 94,
          ownership: {
            status: 'orphaned',
          },
        },
      ],
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'orphan_open_pr',
        }),
      ]),
    });

    expect(doctorResult.exitCode).toBe(21);
    expect(JSON.parse(doctorStdout.join(''))).toMatchObject({
      top_status: 'blocked',
      reconciliation_summary: {
        top_status: 'blocked',
      },
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'orphan_open_pr',
          origin: 'reconciliation',
        }),
      ]),
    });
  });

  it('flags ambiguous AO and GitHub branch disagreement at reconcile time', async () => {
    useScenario('ambiguous-cross-source-disagreement');
    const stdout = [];

    const result = await runReconcileCli(['--pr', '96', '--json', '--strict'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(12);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      top_status: 'ambiguous',
      pr_assessments: [
        {
          pr_number: 96,
          ownership: {
            status: 'ambiguous',
            reason: 'branch_mismatch_with_github',
          },
        },
      ],
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'ao_github_branch_disagreement',
        }),
      ]),
    });
    expect(JSON.parse(stdout.join('')).findings.map((finding) => finding.code)).not.toContain('multiple_candidate_workers');
  });

  it('keeps worker continuity and CI hold classification under realistic ci_failed inputs', async () => {
    useScenario('ci-failed-pr');
    const stdout = [];

    const result = await runLifecycleCli(['--pr', '92', '--trigger', 'ci_failed', '--json', '--strict'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(31);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      top_status: 'hold',
      decision_chain: {
        contract_status: 'authoritative_pr_chain',
        scope: expect.objectContaining({
          mode: 'pr',
          pr_number: 92,
          trigger: 'ci_failed',
        }),
        stages: [
          expect.objectContaining({ stage: 'reconcile', required: true }),
          expect.objectContaining({ stage: 'doctor', required: true }),
          expect.objectContaining({ stage: 'lifecycle', required: true }),
        ],
      },
      routing_decision: {
        action: 'continue_current_worker',
        owner_session: 'worker-92',
        target_pr_number: 92,
        authoritative: true,
      },
      release_decision: {
        disposition: 'await_ci',
        authoritative: true,
      },
    });
  });

  it('routes orphaned ownership to successor handoff even when doctor carries reconciliation blockers', async () => {
    useScenario('orphaned-ownership');
    const stdout = [];

    const result = await runLifecycleCli(['--pr', '94', '--trigger', 'agent_exited', '--json', '--strict'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(32);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      top_status: 'handoff',
      routing_decision: {
        action: 'handoff_to_successor',
        owner_session: null,
        target_pr_number: 94,
        authoritative: true,
      },
    });
  });

  it('restores stale ownership instead of losing continuity entirely', async () => {
    useScenario('stale-worker-ownership');
    const stdout = [];

    const result = await runLifecycleCli(['--pr', '95', '--trigger', 'agent_exited', '--json', '--strict'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(33);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      top_status: 'human_gate',
      routing_decision: {
        action: 'restore_existing_worker',
        owner_session: 'worker-95',
        target_pr_number: 95,
        authoritative: true,
      },
      release_decision: {
        disposition: 'human_gate',
      },
    });
  });

  it('notifies the human only when approved-and-green is truly clear end to end', async () => {
    useScenario('approved-and-green-pr');
    const stdout = [];

    const result = await runLifecycleCli(['--pr', '93', '--trigger', 'approved_and_green', '--json', '--strict'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      top_status: 'continue',
      decision_chain: expect.objectContaining({
        contract_status: 'authoritative_pr_chain',
        next_actions: expect.arrayContaining([
          expect.objectContaining({
            id: 'notify_human_ready',
            stage: 'lifecycle',
          }),
        ]),
      }),
      routing_decision: {
        action: 'continue_current_worker',
        owner_session: 'worker-93',
        target_pr_number: 93,
        authoritative: true,
      },
      release_decision: {
        disposition: 'notify_human_ready',
        authoritative: true,
      },
    });
  });
});
