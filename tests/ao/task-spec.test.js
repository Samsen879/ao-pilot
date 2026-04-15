import { describe, expect, it } from '@jest/globals';

const {
  TASK_SPEC_SCHEMA_VERSION,
  createTaskSpecSnapshot,
} = await import('../../scripts/ao/lib/task-spec.js');

describe('task spec', () => {
  it('creates a normalized v1 snapshot when all required fields are present', () => {
    const result = createTaskSpecSnapshot({
      problem_type: 'issue_delivery',
      acceptance_contract: [
        'fixture-backed tests exist',
        'doctor or reconcile surfaces invalid state',
      ],
      runtime_ref: 'runtime.github_local',
      policy_ref: 'policy.operator_gated',
      human_gates: ['operator_enroll', 'human_review_before_merge'],
    });

    expect(result).toEqual({
      schema_version: TASK_SPEC_SCHEMA_VERSION,
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
    });
  });

  it('fails closed with explicit findings when required fields are missing', () => {
    const result = createTaskSpecSnapshot({
      problem_type: 'issue_delivery',
      acceptance_contract: [],
      runtime_ref: '   ',
      policy_ref: null,
      human_gates: [],
    });

    expect(result).toEqual({
      schema_version: TASK_SPEC_SCHEMA_VERSION,
      valid: false,
      findings: [
        expect.objectContaining({ code: 'task_spec_missing_acceptance_contract' }),
        expect.objectContaining({ code: 'task_spec_missing_runtime_ref' }),
        expect.objectContaining({ code: 'task_spec_missing_policy_ref' }),
        expect.objectContaining({ code: 'task_spec_missing_human_gates' }),
      ],
      spec: {
        problem_type: 'issue_delivery',
        acceptance_contract: [],
        runtime_ref: null,
        policy_ref: null,
        human_gates: [],
      },
    });
  });

  it('surfaces mixed-version snapshots as explicit findings instead of accepting them silently', () => {
    const result = createTaskSpecSnapshot({
      schema_version: 'ao.task-spec.v0',
      problem_type: 'issue_delivery',
      acceptance_contract: ['fixture-backed tests exist'],
      runtime_ref: 'runtime.github_local',
      policy_ref: 'policy.operator_gated',
      human_gates: ['operator_enroll'],
    });

    expect(result.valid).toBe(false);
    expect(result.schema_version).toBe(TASK_SPEC_SCHEMA_VERSION);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'task_spec_schema_version_mismatch',
      }),
    ]));
  });

  it('fails closed on non-string programmatic inputs instead of coercing them through regex checks', () => {
    const result = createTaskSpecSnapshot({
      problem_type: true,
      acceptance_contract: ['fixture-backed tests exist', 7, null],
      runtime_ref: 42,
      policy_ref: { ref: 'policy.operator_gated' },
      human_gates: ['operator_enroll', false],
    });

    expect(result).toEqual({
      schema_version: TASK_SPEC_SCHEMA_VERSION,
      valid: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'task_spec_invalid_problem_type' }),
        expect.objectContaining({ code: 'task_spec_invalid_acceptance_contract' }),
        expect.objectContaining({ code: 'task_spec_invalid_runtime_ref' }),
        expect.objectContaining({ code: 'task_spec_invalid_policy_ref' }),
        expect.objectContaining({ code: 'task_spec_invalid_human_gates' }),
      ]),
      spec: {
        problem_type: null,
        acceptance_contract: ['fixture-backed tests exist'],
        runtime_ref: null,
        policy_ref: null,
        human_gates: ['operator_enroll'],
      },
    });
  });
});
