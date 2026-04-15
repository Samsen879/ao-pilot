import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const PROJECT_ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

describe('AO phase5 closeout and retention contract', () => {
  it('documents workflow closeout as an AO retire bridge instead of Git-only cleanup', () => {
    const controlPlaneOps = read('docs/setup/AO_CONTROL_PLANE_OPERATIONS.md');
    const workflowAutomation = read('docs/setup/ENGINEERING_WORKFLOW_AUTOMATION_V1_2.md');
    const taskLifecycle = read('docs/setup/AO_TASK_LIFECYCLE.md');

    expect(controlPlaneOps).toContain('## Phase-5 Closeout And Retention Contract');
    expect(controlPlaneOps).toContain('`npm run workflow:task:closeout -- --branch <branch> --confirm closeout`');
    expect(controlPlaneOps).toContain('`tasks.summary.closeout_status_counts`');
    expect(controlPlaneOps).toContain('`tasks.inspections[*].closeout_status`');
    expect(controlPlaneOps).toContain('durable AO state is retained as released / retired history');

    expect(workflowAutomation).toContain('如果当前 repo 存在 `scripts/ao-manage.js`，先执行 AO `retire`');
    expect(workflowAutomation).toContain('closeout 不再只清 Git 痕迹，也要同步把 AO durable task state 收口到 `retired`');

    expect(taskLifecycle).toContain('## Durable Task Status');
    expect(taskLifecycle).toContain('`ao-manage retire` retires the task and releases bound PR / ownership state');
    expect(taskLifecycle).toContain('## AO State Closeout Status');
    expect(taskLifecycle).toContain('`ready_to_retire`');
  });

  it('documents retention as state transition plus history preservation, not deletion', () => {
    const retentionPolicy = read('docs/setup/AO_STATE_RETENTION_POLICY.md');

    expect(retentionPolicy).toContain('## What Closeout Retains');
    expect(retentionPolicy).toContain('Closeout changes those records to released / retired state where appropriate. It does not delete them.');
    expect(retentionPolicy).toContain('Phase 5 retention is not long-term archival compaction.');
    expect(retentionPolicy).toContain('normal closeout should prefer traceability over aggressive cleanup');
  });
});
