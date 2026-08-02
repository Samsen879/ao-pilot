import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSpawnSync = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  spawn: jest.fn(),
  spawnSync: mockSpawnSync,
}));

const { loadAoProjectObservation } = await import('../../scripts/ao/lib/ao-observation-source.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OBSERVATION_FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'observation-source');
const ORIGINAL_AO_FIXTURE_ROOT = process.env.AO_FIXTURE_ROOT;
const verifiedRuntimeResolver = () => ({ binary_path: '/managed/runtime/bin/ao' });

function useObservationFixture(name) {
  process.env.AO_FIXTURE_ROOT = path.join(OBSERVATION_FIXTURE_ROOT, name);
}

describe('ao observation source', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    delete process.env.AO_FIXTURE_ROOT;
  });

  afterAll(() => {
    if (ORIGINAL_AO_FIXTURE_ROOT == null) {
      delete process.env.AO_FIXTURE_ROOT;
      return;
    }

    process.env.AO_FIXTURE_ROOT = ORIGINAL_AO_FIXTURE_ROOT;
  });

  it('normalizes top-level array fixtures from captured AO payloads', async () => {
    useObservationFixture('top-level-array');

    const observation = await loadAoProjectObservation({
      projectId: 'my-project',
      now: '2026-03-29T10:00:00.000Z',
    });

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(observation.orchestrator).toMatchObject({
      session_name: 'ao-orchestrator',
      lifecycle_state: 'observing',
    });
    expect(observation.workers).toEqual([
      expect.objectContaining({
        session_name: 'worker-44',
        pr_number: 87,
        issue_number: 87,
        branch_name: 'feat/87',
      }),
    ]);
  });

  it('normalizes object payload fixtures with sessions arrays', async () => {
    useObservationFixture('object-with-sessions');

    const observation = await loadAoProjectObservation({
      projectId: 'fallback-project',
      now: '2026-03-29T10:00:00.000Z',
    });

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(observation.project_id).toBe('my-project');
    expect(observation.raw_summary).toMatchObject({
      session_count: 2,
      orchestrator_count: 1,
      worker_count: 1,
    });
    expect(observation.workers[0]).toMatchObject({
      session_name: 'worker-87',
      pr_number: 87,
      freshness: {
        status: 'fresh',
        stale_after_ms: 900000,
      },
    });
  });

  it('surfaces malformed AO payload shapes as explicit source failures', async () => {
    useObservationFixture('malformed-payload');

    const observation = await loadAoProjectObservation({
      projectId: 'my-project',
      now: '2026-03-29T10:00:00.000Z',
    });

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(observation).toMatchObject({
      project_id: 'my-project',
      source_ok: false,
      orchestrator: null,
      workers: [],
    });
    expect(observation.source_error).toMatch(/invalid ao fixture payload/i);
  });

  it('normalizes orchestrator and worker sessions from the managed session list', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        project: { id: 'my-project' },
        sessions: [
          {
            name: 'ao-orchestrator',
            branch: 'runtime-post-pilot-0323-2239',
            role: 'orchestrator',
            updatedAt: '2026-03-24T10:00:00.000Z',
          },
          {
            name: 'worker-17',
            branch: 'feat/issue-44',
            prNumber: 44,
            role: 'worker',
            updatedAt: '2026-03-24T10:05:00.000Z',
          },
        ],
      }),
      stderr: '',
    });

    const observation = await loadAoProjectObservation({
      projectId: 'my-project',
      now: '2026-03-24T10:10:00.000Z',
      runtimeResolver: verifiedRuntimeResolver,
    });

    expect(mockSpawnSync).toHaveBeenCalledWith(
      '/managed/runtime/bin/ao',
      ['session', 'ls', '--all', '--project', 'my-project', '--json'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(observation.orchestrator.session_name).toBe('ao-orchestrator');
    expect(observation.workers[0]).toMatchObject({
      session_name: 'worker-17',
      pr_number: 44,
      freshness: {
        status: 'fresh',
        stale_after_ms: 900000,
      },
    });
  });

  it('normalizes the locked Go runtime data envelope and field names', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        data: [{
          id: 'session-9',
          projectId: 'my-project',
          role: 'orchestrator',
          issueId: '61',
          harness: 'codex',
          status: 'running',
          lastActivityAt: '2026-03-24T10:09:00.000Z',
        }],
        meta: { hiddenTerminatedCount: 0 },
      }),
      stderr: '',
    });

    const observation = await loadAoProjectObservation({
      projectId: 'my-project',
      now: '2026-03-24T10:10:00.000Z',
      runtimeResolver: verifiedRuntimeResolver,
    });

    expect(observation).toMatchObject({
      source_ok: true,
      orchestrator: {
        session_name: 'session-9',
        session_runtime_id: 'session-9',
        issue_number: 61,
        agent_label: 'codex',
        freshness: { status: 'fresh' },
      },
    });
  });

  it('marks old sessions stale using the frozen 15-minute threshold', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        project: { id: 'my-project' },
        sessions: [
          {
            name: 'worker-9',
            role: 'worker',
            updatedAt: '2026-03-24T09:30:00.000Z',
          },
        ],
      }),
      stderr: '',
    });

    const observation = await loadAoProjectObservation({
      projectId: 'my-project',
      now: '2026-03-24T10:10:00.000Z',
      runtimeResolver: verifiedRuntimeResolver,
    });

    expect(observation.workers[0].freshness.status).toBe('stale');
  });

  it('accepts top-level ao status arrays and current field names', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify([
        {
          name: 'worker-32',
          role: 'worker',
          branch: 'feat/62',
          prNumber: 74,
          issue: '62',
          status: 'mergeable',
          lastActivity: '10m ago',
        },
        {
          name: 'ao-orchestrator',
          role: 'orchestrator',
          branch: 'runtime-post-pilot-0323-2239',
          status: 'idle',
          lastActivity: '27m ago',
        },
      ]),
      stderr: '',
    });

    const observation = await loadAoProjectObservation({
      projectId: 'my-project',
      now: '2026-03-24T10:10:00.000Z',
      runtimeResolver: verifiedRuntimeResolver,
    });

    expect(observation.orchestrator).toMatchObject({
      session_name: 'ao-orchestrator',
      issue_number: null,
      pr_number: null,
      lifecycle_state: 'idle',
      freshness: {
        status: 'stale',
        stale_after_ms: 900000,
      },
    });
    expect(observation.workers[0]).toMatchObject({
      session_name: 'worker-32',
      branch_name: 'feat/62',
      pr_number: 74,
      issue_number: 62,
      lifecycle_state: 'mergeable',
      freshness: {
        status: 'fresh',
        stale_after_ms: 900000,
      },
    });
    expect(observation.raw_summary).toMatchObject({
      session_count: 2,
      orchestrator_count: 1,
      worker_count: 1,
      branch_count: 2,
      pr_count: 1,
    });
  });

  it('returns a source error when ao status fails', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'ao unavailable',
    });

    const observation = await loadAoProjectObservation({
      projectId: 'my-project',
      now: '2026-03-24T10:10:00.000Z',
      runtimeResolver: verifiedRuntimeResolver,
    });

    expect(observation.source_ok).toBe(false);
    expect(observation.source_error).toMatch(/ao unavailable/);
  });

  it('surfaces multiple orchestrators without collapsing them', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        project: { id: 'my-project' },
        sessions: [
          { name: 'ao-orchestrator', role: 'orchestrator' },
          { name: 'ao-orchestrator-2', role: 'orchestrator' },
        ],
      }),
      stderr: '',
    });

    const observation = await loadAoProjectObservation({
      projectId: 'my-project',
      now: '2026-03-24T10:10:00.000Z',
      runtimeResolver: verifiedRuntimeResolver,
    });

    expect(observation.raw_summary.session_count).toBe(2);
    expect(observation.raw_summary.orchestrator_count).toBe(2);
    expect(observation.raw_summary.orchestrator_session_names).toEqual([
      'ao-orchestrator',
      'ao-orchestrator-2',
    ]);
    expect(observation.orchestrator.session_name).toBe('ao-orchestrator');
  });

  it('fails closed without executing a PATH ao when runtime verification fails', async () => {
    const observation = await loadAoProjectObservation({
      projectId: 'my-project',
      now: '2026-03-24T10:10:00.000Z',
      runtimeResolver: () => {
        const error = new Error('PATH contains a different ao');
        error.code = 'runtime_path_shadowed';
        throw error;
      },
    });

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(observation).toMatchObject({
      source_ok: false,
      source_error: expect.stringContaining('runtime_path_shadowed'),
    });
  });
});
