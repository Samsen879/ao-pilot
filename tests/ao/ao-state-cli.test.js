import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLoadAoStateReport = jest.fn();
const mockRenderAoStateHumanSummary = jest.fn();

jest.unstable_mockModule('../../scripts/ao/lib/state-runner.js', () => ({
  DEFAULT_PROJECT_ID: 'my-project',
  loadAoStateReport: mockLoadAoStateReport,
}));

jest.unstable_mockModule('../../scripts/ao/lib/state-report.js', () => ({
  renderAoStateHumanSummary: mockRenderAoStateHumanSummary,
}));

const { runCli } = await import('../../scripts/ao-state.js');

function buildReport(overrides = {}) {
  return {
    schema_version: 'ao.state.v1alpha1',
    report_format: 'ao_state_report',
    project_id: 'my-project',
    bootstrapped: true,
    repo_root: '/home/user/my-project',
    state_root: '/home/user/my-project/.ao-control-plane/my-project',
    summary: {
      managed_task_count: 1,
      pr_binding_count: 1,
      active_ownership_lease_count: 1,
      active_controller_lease_count: 1,
      action_count: 1,
      active_override_count: 1,
      controller_mode_count: 1,
      controller_modes: ['default=observe'],
      controller_health: ['default:healthy:continuous'],
      audit_entry_count: 8,
    },
    controllers: [
      {
        controller_id: 'default',
        configured_mode: 'observe',
        runtime_kind: 'continuous',
        health_status: 'healthy',
        lease_status: 'active',
        holder_id: 'worker-62',
        heartbeat_at: '2026-03-29T06:01:00.000Z',
        expires_at: '2026-03-29T06:02:30.000Z',
        poll_interval_ms: 15000,
        shutdown_timeout_ms: 5000,
        last_run_started_at: '2026-03-29T06:00:45.000Z',
        last_run_completed_at: '2026-03-29T06:01:00.000Z',
        last_run_status: 'completed',
      },
    ],
    continuity: {
      summary: {
        posture_counts: {
          active_owner: 1,
          restore_ready: 0,
          handoff_pending: 0,
          handoff_granted: 0,
          orphaned: 0,
          ambiguous: 0,
          retired: 0,
        },
      },
      inspections: [
        {
          task_id: 'issue-117',
          posture: 'active_owner',
          recommended_action: 'continue_current_worker',
          owner_session_name: 'worker-59',
        },
      ],
    },
    reviews: {
      summary: {
        open_count: 0,
        claimed_count: 1,
        passed_count: 0,
        changes_required_count: 0,
        escalated_count: 0,
        freeze_active_count: 1,
      },
      inspections: [
        {
          task_id: 'issue-117',
          posture: 'review_pending',
          reviewer_session_name: 'worker-125-review',
          target_head_sha: 'abc123',
          freeze_status: 'active',
          blocking_reason: 'independent_review_active',
        },
      ],
    },
    audit: {
      recent_entries: [],
    },
    ...overrides,
  };
}

describe('ao state cli', () => {
  beforeEach(() => {
    mockLoadAoStateReport.mockReset();
    mockRenderAoStateHumanSummary.mockReset();

    mockLoadAoStateReport.mockResolvedValue(buildReport());
    mockRenderAoStateHumanSummary.mockReturnValue('state_status: bootstrapped');
  });

  it('renders project-mode human summary output', async () => {
    const stdout = [];

    const result = await runCli([], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockLoadAoStateReport).toHaveBeenCalledWith({
      cwd: process.cwd(),
      projectId: 'my-project',
      auditLimit: 5,
    });
    expect(stdout.join('')).toContain('state_status: bootstrapped');
  });

  it('renders JSON output with explicit audit limit', async () => {
    const stdout = [];

    const result = await runCli(['--json', '--audit-limit', '2'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockLoadAoStateReport).toHaveBeenCalledWith({
      cwd: process.cwd(),
      projectId: 'my-project',
      auditLimit: 2,
    });
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      schema_version: 'ao.state.v1alpha1',
      summary: {
        managed_task_count: 1,
      },
      continuity: {
        summary: {
          posture_counts: expect.objectContaining({
            active_owner: 1,
          }),
        },
        inspections: [
          expect.objectContaining({
            task_id: 'issue-117',
            posture: 'active_owner',
          }),
        ],
      },
      reviews: {
        summary: {
          claimed_count: 1,
          freeze_active_count: 1,
        },
        inspections: [
          expect.objectContaining({
            task_id: 'issue-117',
            posture: 'review_pending',
            target_head_sha: 'abc123',
          }),
        ],
      },
      controllers: [
        expect.objectContaining({
          controller_id: 'default',
          runtime_kind: 'continuous',
          health_status: 'healthy',
        }),
      ],
    });
  });

  it('rejects invalid audit-limit values and unknown flags before loading state', async () => {
    const stderr = [];

    const invalidAuditLimit = await runCli(['--audit-limit', '0'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const unknownArg = await runCli(['--bogus'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(invalidAuditLimit.exitCode).toBe(4);
    expect(unknownArg.exitCode).toBe(4);
    expect(mockLoadAoStateReport).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Invalid value for --audit-limit');
    expect(stderr.join('')).toContain('Unknown argument: --bogus');
  });

  it('rejects --project when the next token is another flag', async () => {
    const stderr = [];

    const result = await runCli(['--project', '--json'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(4);
    expect(mockLoadAoStateReport).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Missing value for --project');
  });
});
