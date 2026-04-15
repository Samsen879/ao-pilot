import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const PROJECT_ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

describe('AO phase4 assist execution contract', () => {
  it('documents the bounded assist execution surface and explanation fields', () => {
    const controlPlaneOps = read('docs/setup/AO_CONTROL_PLANE_OPERATIONS.md');
    const controllerRunbook = read('docs/setup/AO_CONTROLLER_RUNBOOK.md');
    const lifecycleRunbook = read('docs/setup/AO_LIFECYCLE_RUNBOOK.md');

    expect(controlPlaneOps).toContain('## Phase-4 Assist Execution Contract');
    expect(controlPlaneOps).toContain('Current allowlist:');
    expect(controlPlaneOps).toContain('`continue_worker`');
    expect(controlPlaneOps).toContain('`notify_human_ready`');
    expect(controlPlaneOps).toContain('`ao-controller --json`: `task_results[*].assist_actions[*]`');
    expect(controlPlaneOps).toContain('`ao-state --json`: `actions.recent[*]`');
    expect(controlPlaneOps).toContain('`model_executable`');
    expect(controlPlaneOps).toContain('`execution_reason`');
    expect(controlPlaneOps).toContain('`idempotency_mode`');
    expect(controlPlaneOps).toContain('`rollback_mode`');
    expect(controlPlaneOps).toContain('assist does not auto-merge');

    expect(controllerRunbook).toContain('## Read Assist Execution Verdict');
    expect(controllerRunbook).toContain('`task_results[*]` now also carries `assist_actions[*]`');
    expect(controllerRunbook).toContain('`idempotency_mode=action_status_gate`');

    expect(lifecycleRunbook).toContain('Phase-4 assist note:');
    expect(lifecycleRunbook).toContain('assist execution only auto-runs the phase-4 Class A allowlist');
    expect(lifecycleRunbook).toContain('`notify_human_ready` remains notification-only; it is not auto-merge');
  });
});
