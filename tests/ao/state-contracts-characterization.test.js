import { describe, expect, it } from '@jest/globals';

import * as StateContracts from '../../scripts/ao/lib/state-contracts.js';

const {
  createCheckpointRecord,
  createCheckpointSnapshot,
  createControllerRunMetricRecord,
  createExecutionAttemptMetricRecord,
  createReviewRecord,
} = StateContracts;

const NOW = '2026-03-29T04:40:00.000Z';

describe('canonical AO state contracts characterization', () => {
  it('pins the state-contract module vocabulary migrated from the embedded oracle', () => {
    expect(Object.keys(StateContracts).sort()).toEqual([
      'ACTION_STATUSES',
      'AO_EVAL_HARNESS_RUN_FORMAT',
      'AO_EVAL_HARNESS_RUN_SCHEMA_VERSION',
      'AO_EVAL_SCORECARD_FORMAT',
      'AO_EVAL_SCORECARD_SCHEMA_VERSION',
      'CHECKPOINT_FORMAT',
      'CHECKPOINT_SCHEMA_VERSION',
      'CONTROLLER_LEASE_STATUSES',
      'CONTROLLER_MODES',
      'CONTROLLER_RUNTIME_KINDS',
      'CONTROLLER_RUN_STATUSES',
      'CONTROL_PLANE_AUDIT_FORMAT',
      'CONTROL_PLANE_AUDIT_SCHEMA_VERSION',
      'CONTROL_PLANE_DEFAULT_CONTROLLER_ID',
      'CONTROL_PLANE_LATEST_VERSION',
      'CONTROL_PLANE_SCHEMA_FORMAT',
      'CONTROL_PLANE_SCHEMA_VERSION',
      'CONTROL_PLANE_STATE_FORMAT',
      'CONTROL_PLANE_STATE_SCHEMA_VERSION',
      'CREDENTIAL_PROVENANCE_TRUST_DECISIONS',
      'DELIVERY_EVENT_FAMILIES',
      'EXECUTION_ATTEMPT_KINDS',
      'EXECUTION_ATTEMPT_STATUSES',
      'HANDOFF_CLAIM_FORMAT',
      'HANDOFF_CLAIM_SCHEMA_VERSION',
      'HANDOFF_CLAIM_STATUSES',
      'HANDOFF_DECISION_FORMAT',
      'HANDOFF_DECISION_OUTCOMES',
      'HANDOFF_DECISION_SCHEMA_VERSION',
      'HANDOFF_REQUEST_FORMAT',
      'HANDOFF_REQUEST_SCHEMA_VERSION',
      'HANDOFF_REQUEST_STATUSES',
      'HANDOFF_TRANSFER_FORMAT',
      'HANDOFF_TRANSFER_SCHEMA_VERSION',
      'MANAGED_TASK_STATUSES',
      'OBSERVATION_SOURCE_KINDS',
      'OVERRIDE_SCOPE_KINDS',
      'OVERRIDE_STATUSES',
      'OWNERSHIP_LEASE_STATUSES',
      'POLICY_DECISIONS',
      'PR_BINDING_STATUSES',
      'REVIEW_BASELINE_CATEGORIES',
      'REVIEW_FREEZE_STATUSES',
      'REVIEW_RECORD_FORMAT',
      'REVIEW_RECORD_SCHEMA_VERSION',
      'REVIEW_RECORD_STATUSES',
      'REVIEW_VERDICTS',
      'TASK_SPEC_RECORD_STATES',
      'createActionRecord',
      'createCheckpointRecord',
      'createCheckpointSnapshot',
      'createControlPlaneAuditEntry',
      'createControlPlaneSchema',
      'createControllerCursorRecord',
      'createControllerLease',
      'createControllerModeRecord',
      'createControllerRunMetricRecord',
      'createCredentialProvenanceRecord',
      'createDeliveryEventRecord',
      'createEmptyControlPlaneState',
      'createExecutionAttemptMetricRecord',
      'createHandoffClaimRecord',
      'createHandoffDecisionRecord',
      'createHandoffRequestRecord',
      'createHandoffTransferRecord',
      'createManagedTask',
      'createObservationRecord',
      'createOverrideRecord',
      'createOwnershipLease',
      'createPolicyDecisionRecord',
      'createPrBinding',
      'createRepoKnowledgeRecord',
      'createReviewRecord',
      'createRuntimePreflightRecord',
      'createTaskSpecRecord',
    ]);
  });

  it('normalizes metric count maps and optional measurement envelopes', () => {
    const controllerMetric = createControllerRunMetricRecord({
      controller_run_metric_id: 'controller-run-1',
      task_id: 'task-1',
      issue_number: 88,
      pr_number: 101,
      controller_id: 'default',
      controller_mode: 'assist',
      trigger_kind: 'ci_failed',
      lifecycle_top_status: 'warning',
      failure_class: 'ci_failure',
      started_at: NOW,
      completed_at: NOW,
      duration_ms: 0,
      observation_count: 1,
      delivery_event_count: 2,
      proposed_action_count: 3,
      executed_action_count: 1,
      blocked_action_count: 1,
      policy_decision_count: 1,
      policy_blocked_action_count: 0,
      denied_action_count: 0,
      downgraded_action_count: 0,
      action_class_counts: { 'continue-worker': 1, continue_worker: 2, hold: 1 },
      intervention_counts: { preflight_block: 1 },
      token_usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 },
      cost: { usd: 0 },
      metadata: { source: 'characterization' },
    });

    expect(controllerMetric).toMatchObject({
      schema_version: 'ao.controller-run-measurement.v1alpha3',
      format: 'ao_controller_run_measurement',
      action_class_counts: {
        continue_worker: 3,
        notify_human: 0,
        merge_pr: 0,
        hold: 1,
        human_gate: 0,
        restore_worker: 0,
        handoff_worker: 0,
        unknown: 0,
      },
      intervention_counts: {
        human_gate: 0,
        override: 0,
        explicit_resume: 0,
        successor_handoff: 0,
        policy_block: 0,
        preflight_block: 1,
      },
      token_usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 },
      cost: { usd: 0 },
      metadata: { source: 'characterization' },
    });

    const executionMetric = createExecutionAttemptMetricRecord({
      execution_attempt_metric_id: 'execution-attempt-1',
      attempt_kind: 'managed_task',
      task_id: 'task-1',
      action_class: 'notify-human',
      status: 'completed',
      retry_cause: 'explicit-resume',
      failure_class: 'review-blocked',
      started_at: NOW,
      completed_at: NOW,
      duration_ms: 12,
      intervention_counts: { successor_handoff: 2 },
    });

    expect(executionMetric).toMatchObject({
      action_class: 'notify_human',
      retry_cause: 'explicit_resume',
      failure_class: 'review_blocked',
      token_usage: { input_tokens: null, output_tokens: null, total_tokens: null },
      cost: { usd: null },
      intervention_counts: {
        human_gate: 0,
        override: 0,
        explicit_resume: 0,
        successor_handoff: 2,
        policy_block: 0,
        preflight_block: 0,
      },
    });
  });

  it('keeps checkpoint task identity exact instead of coercing mismatches', () => {
    const snapshot = createCheckpointSnapshot({
      task_ref: {
        task_id: 'task-1',
        issue_number: 88,
        title: 'Durable AO control-plane state',
        branch_name: 'feat/88',
        worktree_path: '/tmp/worker-88',
        updated_at: NOW,
        pr_binding: null,
      },
      verification_ref: { task_spec: null, runtime_preflight: null },
      execution_ref: {
        controller_id: 'default',
        controller_mode: 'observe',
        controller_mode_updated_at: NOW,
        derived_trigger: 'ci_failed',
        lifecycle_top_status: 'warning',
        observed_at: NOW,
        action_ids: ['action-1'],
      },
    });

    expect(createCheckpointRecord({
      checkpoint_id: 'checkpoint-1',
      task_id: 'task-1',
      recorded_at: NOW,
      snapshot,
    })).toMatchObject({ task_id: 'task-1', snapshot });
    expect(() => createCheckpointRecord({
      checkpoint_id: 'checkpoint-2',
      task_id: 'task-2',
      recorded_at: NOW,
      snapshot,
    })).toThrow('Checkpoint task_id must match snapshot.task_ref.task_id');
  });

  it('requires review baseline execution to remain object-shaped', () => {
    const reviewInput = {
      review_id: 'review-baseline-1',
      task_id: 'task-1',
      issue_number: 88,
      pr_number: 101,
      status: 'passed',
      trigger_kind: 'ready_for_review',
      target_branch: 'feat/88',
      target_head_sha: 'abc123',
      requested_by_session_name: 'worker-88',
      requested_by_session_id: 'session-88',
      implementation_session_name: 'worker-88',
      implementation_session_id: 'session-88',
      reviewer_session_name: 'reviewer-88',
      reviewer_session_id: 'review-session-88',
      verification_baseline: [{ category: 'workspace_sanity', commands: ['git status --short'] }],
      baseline_execution: {
        status: 'passed',
        summary: 'Focused verification passed.',
        recorded_at: NOW,
        attested_by_session_name: 'worker-88',
        attested_by_session_id: 'session-88',
        commands_run: ['npm test'],
      },
      verdict: 'pass',
      freeze_status: 'released',
      created_at: NOW,
      updated_at: NOW,
    };

    expect(createReviewRecord(reviewInput).baseline_execution).toEqual(reviewInput.baseline_execution);
    expect(() => createReviewRecord({
      ...reviewInput,
      baseline_execution: [{ status: 'passed' }],
    })).toThrow('Invalid baseline_execution');
  });
});
