import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const PROJECT_ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

describe('AO phase2 orchestrator decision matrix contract', () => {
  it('encodes phase2 control flow in explicit matrices instead of long-form orchestrator prose', () => {
    const configText = read('agent-orchestrator.yaml');

    expect(configText).toContain('AO_PHASE2_CHAIN_MATRIX');
    expect(configText).toContain('AO_WORKFLOW_MATRIX');
    expect(configText).toContain('AO_TRIGGER_MATRIX');
    expect(configText).toContain('C2 known_pr_trigger_entry = node scripts/ao-lifecycle.js --pr <number> --trigger <trigger> --json --strict');
    expect(configText).toContain('C3 chain_fields = decision_chain.contract_status | decision_chain.blocking_reasons | decision_chain.next_actions | decision_chain.next_commands');
    expect(configText).toContain('W4 task_create = npm run workflow:task:create -- --id <id> --slug <slug> --base baseline/origin-main');
  });

  it('reduces orchestrator trigger reactions to matrix references', () => {
    const configText = read('agent-orchestrator.yaml');

    expect(configText).toMatch(/approved-and-green:\n(?:.*\n){0,6}\s+message: "Event=approved-and-green\. Apply `AO_TRIGGER_MATRIX\[approved-and-green\]`\."/);
    expect(configText).toMatch(/agent-stuck:\n(?:.*\n){0,6}\s+message: "Event=agent-stuck\. Apply `AO_TRIGGER_MATRIX\[agent-stuck\]`\."/);
    expect(configText).toMatch(/agent-needs-input:\n(?:.*\n){0,6}\s+message: "Event=agent-needs-input\. Apply `AO_TRIGGER_MATRIX\[agent-needs-input\]`\."/);
    expect(configText).toMatch(/agent-exited:\n(?:.*\n){0,6}\s+message: "Event=agent-exited\. Apply `AO_TRIGGER_MATRIX\[agent-exited\]`\."/);
    expect(configText).not.toContain('Run `node scripts/ao-lifecycle.js --pr <number> --trigger approved_and_green --json --strict`, then inspect `decision_chain.blocking_reasons`, `decision_chain.next_actions`, and `decision_chain.next_commands`.');
  });
});
