import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const PROJECT_ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

describe('AO phase3 control-plane continuity contract', () => {
  it('documents the shared continuity contract across manage, handoff, state, and controller surfaces', () => {
    const controlPlaneOps = read('docs/setup/AO_CONTROL_PLANE_OPERATIONS.md');
    const controllerRunbook = read('docs/setup/AO_CONTROLLER_RUNBOOK.md');
    const lifecycleRunbook = read('docs/setup/AO_LIFECYCLE_RUNBOOK.md');

    expect(controlPlaneOps).toContain('Phase-3 Continuity Contract');
    expect(controlPlaneOps).toContain('`continuity.posture`');
    expect(controlPlaneOps).toContain('`continuity.recommended_action`');
    expect(controlPlaneOps).toContain('`ao-manage ... --json`: result-level `continuity`');
    expect(controlPlaneOps).toContain('`ao-controller` shadow/assist results: `task_results[*].continuity`');

    expect(controllerRunbook).toContain('## Read Controller Continuity');
    expect(controllerRunbook).toContain('`continuity.posture`');
    expect(controllerRunbook).toContain('`continuity.checkpoint_state`');

    expect(lifecycleRunbook).toContain('## Phase-3 Continuity Alignment');
    expect(lifecycleRunbook).toContain('lifecycle `routing_decision.action = restore_existing_worker` should only be treated as restore-ready');
  });

  it('documents the minimum phase3 incident flow for restore, handoff, and ambiguous ownership', () => {
    const controlPlaneOps = read('docs/setup/AO_CONTROL_PLANE_OPERATIONS.md');

    expect(controlPlaneOps).toContain('### Owner continuity is broken');
    expect(controlPlaneOps).toContain('If posture is `handoff_pending` or `orphaned`, request and accept a successor handoff');
    expect(controlPlaneOps).toContain('If posture is `handoff_granted`, resume the accepted successor with `ao-manage resume`');
    expect(controlPlaneOps).toContain('If posture is `restore_ready`, resume the prior owner only from the valid checkpoint path');
    expect(controlPlaneOps).toContain('If posture is `ambiguous`, stop and resolve ownership manually before any resume');
    expect(controlPlaneOps).toContain('### Worker exited but prior owner is still recoverable');
  });
});
