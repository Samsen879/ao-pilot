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

const { loadDoctorLocalState } = await import('../../scripts/ao/lib/doctor-local-state-source.js');

function successfulSpawn(stdout) {
  return {
    status: 0,
    stdout,
    stderr: '',
  };
}

describe('doctor local state source', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockExistsSync.mockReset();
    mockStatSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it('normalizes a clean repo with upstream tracking', async () => {
    mockSpawnSync
      .mockReturnValueOnce(successfulSpawn('/home/user/my-project\n'))
      .mockReturnValueOnce(successfulSpawn('feat/issue-44\n'))
      .mockReturnValueOnce(successfulSpawn('abc123\n'))
      .mockReturnValueOnce(successfulSpawn('origin/feat/issue-44\n'))
      .mockReturnValueOnce(successfulSpawn('## feat/issue-44...origin/feat/issue-44\n'));

    const state = await loadDoctorLocalState({
      cwd: '/home/user/my-project',
    });

    expect(state).toMatchObject({
      repo_root: '/home/user/my-project',
      cwd: '/home/user/my-project',
      current_branch: 'feat/issue-44',
      head_sha: 'abc123',
      detached_head: false,
      upstream_branch: 'origin/feat/issue-44',
      upstream_tracking: 'present',
      worktree_dirty: false,
      staged_changes: false,
      unstaged_changes: false,
      untracked_file_count: 0,
      untracked_file_samples: [],
      ao_artifact_paths: [],
      git_observable: true,
      git_error: null,
    });
  });

  it('runs git probes with an explicit timeout budget', async () => {
    mockSpawnSync
      .mockReturnValueOnce(successfulSpawn('/home/user/my-project\n'))
      .mockReturnValueOnce(successfulSpawn('feat/issue-44\n'))
      .mockReturnValueOnce(successfulSpawn('abc123\n'))
      .mockReturnValueOnce(successfulSpawn('origin/feat/issue-44\n'))
      .mockReturnValueOnce(successfulSpawn('## feat/issue-44...origin/feat/issue-44\n'));

    await loadDoctorLocalState({
      cwd: '/home/user/my-project',
    });

    for (const call of mockSpawnSync.mock.calls) {
      expect(call[0]).toBe('git');
      expect(call[2]).toMatchObject({
        cwd: '/home/user/my-project',
        encoding: 'utf8',
        timeout: 5000,
      });
    }
  });

  it('captures dirty worktree state and caps untracked file samples', async () => {
    mockSpawnSync
      .mockReturnValueOnce(successfulSpawn('/home/user/my-project\n'))
      .mockReturnValueOnce(successfulSpawn('feat/issue-44\n'))
      .mockReturnValueOnce(successfulSpawn('abc123\n'))
      .mockReturnValueOnce(successfulSpawn('origin/feat/issue-44\n'))
      .mockReturnValueOnce(successfulSpawn([
        '## feat/issue-44...origin/feat/issue-44',
        ' M scripts/ao-reconcile.js',
        'A  tests/ao/doctor-engine.test.js',
        '?? ao-artifacts/last-report.json',
        '?? ao-task-state.json',
        '?? ao-queue.txt',
        '?? .ao-current-issue',
        '?? docs/setup/AO_DOCTOR_RUNBOOK.md',
      ].join('\n')));

    const state = await loadDoctorLocalState({
      cwd: '/home/user/my-project',
      untrackedSampleLimit: 3,
    });

    expect(state.worktree_dirty).toBe(true);
    expect(state.staged_changes).toBe(true);
    expect(state.unstaged_changes).toBe(true);
    expect(state.untracked_file_count).toBe(5);
    expect(state.untracked_file_samples).toEqual([
      '.ao-current-issue',
      'ao-artifacts/last-report.json',
      'ao-queue.txt',
    ]);
  });

  it('detects detached head and missing upstream', async () => {
    mockSpawnSync
      .mockReturnValueOnce(successfulSpawn('/home/user/my-project\n'))
      .mockReturnValueOnce(successfulSpawn('\n'))
      .mockReturnValueOnce(successfulSpawn('def456\n'))
      .mockReturnValueOnce({
        status: 128,
        stdout: '',
        stderr: 'fatal: no upstream configured',
      })
      .mockReturnValueOnce(successfulSpawn('## HEAD (no branch)\n'));

    const state = await loadDoctorLocalState({
      cwd: '/home/user/my-project',
    });

    expect(state.detached_head).toBe(true);
    expect(state.current_branch).toBe(null);
    expect(state.upstream_tracking).toBe('missing');
    expect(state.upstream_branch).toBe(null);
  });

  it('preserves cwd when run from a repo subdirectory', async () => {
    mockSpawnSync
      .mockReturnValueOnce(successfulSpawn('/home/user/my-project\n'))
      .mockReturnValueOnce(successfulSpawn('feat/issue-44\n'))
      .mockReturnValueOnce(successfulSpawn('abc123\n'))
      .mockReturnValueOnce(successfulSpawn('origin/feat/issue-44\n'))
      .mockReturnValueOnce(successfulSpawn('## feat/issue-44...origin/feat/issue-44\n'));

    const state = await loadDoctorLocalState({
      cwd: '/home/user/my-project/scripts',
    });

    expect(state.cwd).toBe('/home/user/my-project/scripts');
    expect(state.repo_root).toBe('/home/user/my-project');
  });

  it('returns a usable state outside a git worktree', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });

    const state = await loadDoctorLocalState({
      cwd: '/tmp/not-a-repo',
    });

    expect(state.git_observable).toBe(false);
    expect(state.git_error).toMatch(/not a git repository/);
    expect(state.repo_root).toBe(null);
    expect(state.cwd).toBe('/tmp/not-a-repo');
  });

  it('surfaces explicit timeout failures when git probing times out', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync git ETIMEDOUT'), {
        code: 'ETIMEDOUT',
      }),
    });

    const state = await loadDoctorLocalState({
      cwd: '/tmp/slow-repo',
    });

    expect(state.git_observable).toBe(false);
    expect(state.git_error).toMatch(/ETIMEDOUT/);
  });

  it('detects AO artifact leftovers from known local paths', async () => {
    mockSpawnSync
      .mockReturnValueOnce(successfulSpawn('/home/user/my-project\n'))
      .mockReturnValueOnce(successfulSpawn('feat/issue-44\n'))
      .mockReturnValueOnce(successfulSpawn('abc123\n'))
      .mockReturnValueOnce(successfulSpawn('origin/feat/issue-44\n'))
      .mockReturnValueOnce(successfulSpawn('## feat/issue-44...origin/feat/issue-44\n'));

    mockExistsSync.mockImplementation((filePath) => (
      filePath.endsWith('.ao-current-issue')
      || filePath.endsWith('ao-task-state.json')
      || filePath.endsWith('ao-artifacts')
    ));
    mockStatSync.mockImplementation((filePath) => ({
      isDirectory: () => filePath.endsWith('ao-artifacts'),
    }));

    const state = await loadDoctorLocalState({
      cwd: '/home/user/my-project',
    });

    expect(state.ao_artifact_paths).toEqual([
      '.ao-current-issue',
      'ao-artifacts/',
      'ao-task-state.json',
    ]);
  });
});
