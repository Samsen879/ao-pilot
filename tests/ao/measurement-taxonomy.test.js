import { describe, expect, it } from '@jest/globals';

import {
  CONTROLLER_RUN_MEASUREMENT_FORMAT,
  CONTROLLER_RUN_MEASUREMENT_SCHEMA_VERSION,
  EXECUTION_ATTEMPT_MEASUREMENT_FORMAT,
  EXECUTION_ATTEMPT_MEASUREMENT_SCHEMA_VERSION,
  MEASUREMENT_ACTION_CLASSES,
  MEASUREMENT_FAILURE_CLASSES,
  MEASUREMENT_INTERVENTION_KINDS,
  MEASUREMENT_RETRY_CAUSES,
  MEASUREMENT_TRIGGER_KINDS,
  createMeasurementCountMap,
  normalizeMeasurementTrigger,
  resolveControllerRunFailureClass,
  resolveExecutionAttemptFailureClass,
  resolveExecutionAttemptRetryCause,
  resolveMeasurementActionClass,
} from '../../scripts/ao/lib/measurement-taxonomy.js';

describe('measurement taxonomy', () => {
  it('freezes the durable schema identities and stable vocabularies', () => {
    expect(CONTROLLER_RUN_MEASUREMENT_SCHEMA_VERSION).toBe('ao.controller-run-measurement.v1alpha1');
    expect(CONTROLLER_RUN_MEASUREMENT_FORMAT).toBe('ao_controller_run_measurement');
    expect(EXECUTION_ATTEMPT_MEASUREMENT_SCHEMA_VERSION).toBe('ao.execution-attempt-measurement.v1alpha1');
    expect(EXECUTION_ATTEMPT_MEASUREMENT_FORMAT).toBe('ao_execution_attempt_measurement');
    expect(MEASUREMENT_TRIGGER_KINDS).toEqual([
      'manual',
      'ci_failed',
      'changes_requested',
      'bugbot_comments',
      'merge_conflicts',
      'approved_and_green',
      'agent_stuck',
      'agent_needs_input',
      'agent_exited',
    ]);
    expect(MEASUREMENT_ACTION_CLASSES).toEqual([
      'continue_worker',
      'notify_human',
      'hold',
      'human_gate',
      'restore_worker',
      'handoff_worker',
      'unknown',
    ]);
    expect(MEASUREMENT_INTERVENTION_KINDS).toEqual([
      'human_gate',
      'override',
      'explicit_resume',
      'successor_handoff',
      'policy_block',
      'preflight_block',
    ]);
    expect(MEASUREMENT_RETRY_CAUSES).toEqual([
      'none',
      'explicit_resume',
      'successor_handoff',
      'policy_retry',
      'preflight_retry',
      'unknown',
    ]);
    expect(MEASUREMENT_FAILURE_CLASSES).toEqual([
      'none',
      'ci_failure',
      'review_blocked',
      'merge_conflict',
      'source_failure',
      'human_gate',
      'override',
      'policy_block',
      'preflight_block',
      'worker_exit',
      'successor_handoff',
      'unknown',
    ]);
  });

  it('normalizes trigger and action taxonomies into stable measurement classes', () => {
    expect(normalizeMeasurementTrigger()).toBe('manual');
    expect(normalizeMeasurementTrigger('approved-and-green')).toBe('approved_and_green');
    expect(normalizeMeasurementTrigger('agent-needs-input')).toBe('agent_needs_input');

    expect(resolveMeasurementActionClass({
      actionKind: 'continue_worker',
    })).toBe('continue_worker');
    expect(resolveMeasurementActionClass({
      actionKind: 'notify_human_ready',
      actionClass: 'notify_human',
    })).toBe('notify_human');
    expect(resolveMeasurementActionClass({
      actionKind: 'hold_ci',
      actionClass: 'hold',
    })).toBe('hold');
    expect(resolveMeasurementActionClass({
      actionKind: 'mystery_action',
      actionClass: 'not_real',
    })).toBe('unknown');
  });

  it('classifies retry causes, intervention counts, and stable failure classes', () => {
    expect(resolveExecutionAttemptRetryCause({
      command: 'enroll',
      acceptedHandoff: false,
    })).toBe('none');
    expect(resolveExecutionAttemptRetryCause({
      command: 'resume',
      acceptedHandoff: false,
    })).toBe('explicit_resume');
    expect(resolveExecutionAttemptRetryCause({
      command: 'resume',
      acceptedHandoff: true,
    })).toBe('successor_handoff');

    expect(createMeasurementCountMap(MEASUREMENT_INTERVENTION_KINDS, {
      policy_block: 2,
      explicit_resume: 1,
    })).toEqual({
      human_gate: 0,
      override: 0,
      explicit_resume: 1,
      successor_handoff: 0,
      policy_block: 2,
      preflight_block: 0,
    });

    expect(resolveExecutionAttemptFailureClass({
      reason: 'override_hold_autonomy',
    })).toBe('override');
    expect(resolveExecutionAttemptFailureClass({
      reason: 'runtime_preflight_clean',
    })).toBe('preflight_block');
    expect(resolveExecutionAttemptFailureClass({
      reason: 'policy_allow_required',
    })).toBe('policy_block');
    expect(resolveExecutionAttemptFailureClass({
      reason: 'worker_exited',
    })).toBe('worker_exit');

    expect(resolveControllerRunFailureClass({
      triggerKind: 'ci_failed',
      interventionCounts: createMeasurementCountMap(MEASUREMENT_INTERVENTION_KINDS),
      lifecycleTopStatus: 'hold',
    })).toBe('ci_failure');
    expect(resolveControllerRunFailureClass({
      triggerKind: 'approved_and_green',
      interventionCounts: createMeasurementCountMap(MEASUREMENT_INTERVENTION_KINDS, {
        human_gate: 1,
      }),
      lifecycleTopStatus: 'human_gate',
    })).toBe('human_gate');
    expect(resolveControllerRunFailureClass({
      triggerKind: 'manual',
      interventionCounts: createMeasurementCountMap(MEASUREMENT_INTERVENTION_KINDS, {
        policy_block: 1,
      }),
      lifecycleTopStatus: 'continue',
    })).toBe('policy_block');
  });
});
