import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const { normalizeIssueIntake } = await import('../../scripts/ao/lib/issue-intake.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'issue-intake');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_ROOT, name), 'utf8');
}

describe('issue intake', () => {
  it('normalizes a valid issue/template fixture into a valid TaskSpec snapshot', () => {
    const result = normalizeIssueIntake({
      issueNumber: 105,
      title: 'feat(ao): add TaskSpec v1, admission normalization, and migration/backfill',
      body: readFixture('valid.md'),
      sourceKind: 'github_issue',
    });

    expect(result).toEqual({
      issue_number: 105,
      source_kind: 'github_issue',
      task_spec_snapshot: {
        schema_version: 'ao.task-spec.v1alpha1',
        valid: true,
        findings: [],
        spec: {
          problem_type: 'issue_delivery',
          acceptance_contract: [
            'fixture-backed tests exist',
            'doctor or reconcile surfaces invalid state',
          ],
          runtime_ref: 'runtime.github_local',
          policy_ref: 'policy.operator_gated',
          human_gates: ['operator_enroll', 'human_review_before_merge'],
        },
      },
    });
  });

  it('keeps partial issue/template fixtures invalid and surfaces explicit missing-field findings', () => {
    const result = normalizeIssueIntake({
      issueNumber: 105,
      title: 'feat(ao): add TaskSpec v1, admission normalization, and migration/backfill',
      body: readFixture('partial.md'),
      sourceKind: 'github_issue',
    });

    expect(result.issue_number).toBe(105);
    expect(result.task_spec_snapshot.valid).toBe(false);
    expect(result.task_spec_snapshot.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'task_spec_missing_policy_ref' }),
      expect.objectContaining({ code: 'task_spec_missing_human_gates' }),
    ]));
  });

  it('treats malformed issue/template fixtures as explicit intake findings instead of implicit parse failure', () => {
    const result = normalizeIssueIntake({
      issueNumber: 105,
      title: 'feat(ao): add TaskSpec v1, admission normalization, and migration/backfill',
      body: readFixture('malformed.md'),
      sourceKind: 'github_issue',
    });

    expect(result.task_spec_snapshot.valid).toBe(false);
    expect(result.task_spec_snapshot.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'task_spec_invalid_problem_type' }),
      expect.objectContaining({ code: 'task_spec_invalid_acceptance_contract' }),
      expect.objectContaining({ code: 'task_spec_missing_runtime_ref' }),
      expect.objectContaining({ code: 'task_spec_invalid_policy_ref' }),
      expect.objectContaining({ code: 'task_spec_invalid_human_gates' }),
    ]));
  });
});
