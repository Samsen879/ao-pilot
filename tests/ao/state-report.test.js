import { describe, expect, it } from '@jest/globals';

import { renderAoStateHumanSummary } from '../../scripts/ao/lib/state-report.js';

describe('ao state report', () => {
  it('renders continuity posture counts in the operator summary', () => {
    const summary = renderAoStateHumanSummary({
      bootstrapped: true,
      project_id: 'my-project',
      state_root: '/repo/.ao-control-plane/my-project',
      schema: {
        current_version: 1,
        latest_version: 1,
      },
      summary: {
        managed_task_count: 1,
        pr_binding_count: 1,
        active_ownership_lease_count: 1,
        active_controller_lease_count: 1,
        action_count: 0,
        active_override_count: 0,
        controller_modes: ['default=shadow'],
        controller_health: ['default:healthy:continuous'],
        observation_count: 2,
        controller_cursor_count: 1,
        repo_knowledge_count: 0,
        repo_knowledge_status: 'missing',
        repo_knowledge_profile_version: null,
        repo_knowledge_lint_status: null,
        checkpoint_count: 1,
        valid_checkpoint_count: 1,
        stale_checkpoint_count: 0,
        invalid_checkpoint_count: 0,
        handoff_request_count: 1,
        handoff_claim_count: 1,
        handoff_decision_count: 1,
        handoff_transfer_count: 0,
        active_handoff_count: 1,
        audit_entry_count: 2,
      },
      controllers: [
        {
          controller_id: 'default',
          health_status: 'healthy',
          configured_mode: 'shadow',
          runtime_kind: 'continuous',
          holder_id: 'ao-controller-main',
        },
      ],
      continuity: {
        summary: {
          posture_counts: {
            active_owner: 0,
            restore_ready: 1,
            handoff_pending: 0,
            handoff_granted: 1,
            orphaned: 0,
            ambiguous: 0,
            retired: 0,
          },
        },
        inspections: [
          {
            task_id: 'issue-110',
            posture: 'restore_ready',
            recommended_action: 'restore_existing_worker',
          },
          {
            task_id: 'issue-117',
            posture: 'handoff_granted',
            recommended_action: 'handoff_to_successor',
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
            task_id: 'issue-125',
            posture: 'review_pending',
            reviewer_session_name: 'worker-125-review',
            target_head_sha: 'abc123',
            freeze_status: 'active',
            blocking_reason: 'independent_review_active',
          },
        ],
      },
      tasks: {
        summary: {
          closeout_status_counts: {
            active: 0,
            hold: 1,
            ready_to_retire: 1,
            retired: 1,
          },
        },
        inspections: [
          {
            task_id: 'issue-120',
            closeout_status: 'ready_to_retire',
          },
          {
            task_id: 'issue-121',
            closeout_status: 'hold',
            review_posture: 'review_pending',
            review_freeze_status: 'active',
            review_blocking_reason: 'independent_review_active',
          },
          {
            task_id: 'issue-123',
            closeout_status: 'retired',
          },
        ],
      },
      debt: {
        summary: {
          category_counts: {
            keep_evidence: 2,
            archive_candidate: 1,
            cleanup_candidate: 3,
          },
        },
        inspections: [
          {
            item_kind: 'task_worktree',
            item_ref: '/repo/.worktrees/task-120--cleanup-ready',
            category: 'cleanup_candidate',
            recommended_action: 'remove_task_worktree',
          },
          {
            item_kind: 'managed_task',
            item_ref: 'issue-123',
            category: 'archive_candidate',
            recommended_action: 'archive_retired_task_history',
          },
        ],
      },
      actions: {
        recent: [
          {
            action_id: 'action-continue',
            action_kind: 'continue_worker',
            status: 'executed',
            model_reason: 'class_a_allowlist',
            execution_reason: 'class_a_assist_execution',
          },
          {
            action_id: 'action-legacy-ready',
            action_kind: 'notify_human_ready',
            status: 'executed',
            model_reason: 'class_a_allowlist',
            execution_reason: 'class_a_assist_execution',
          },
        ],
      },
      audit: {
        recent_entries: [],
      },
    });

    expect(summary).toContain('continuity: active_owner=0, restore_ready=1, handoff_pending=0, handoff_granted=1, orphaned=0, ambiguous=0, retired=0');
    expect(summary).toContain('continuity_tasks: issue-110=restore_ready->restore_existing_worker, issue-117=handoff_granted->handoff_to_successor');
    expect(summary).toContain('reviews: open=0, claimed=1, passed=0, changes_required=0, escalated=0, freeze_active=1');
    expect(summary).toContain('review_tasks: issue-125=review_pending@abc123 reviewer=worker-125-review freeze=active reason=independent_review_active');
    expect(summary).toContain('task_closeout: active=0, hold=1, ready_to_retire=1, retired=1');
    expect(summary).toContain('task_closeout_statuses: issue-120=ready_to_retire, issue-121=hold[review_pending], issue-123=retired');
    expect(summary).toContain('debt: keep_evidence=2, archive_candidate=1, cleanup_candidate=3');
    expect(summary).toContain('debt_items: task_worktree:/repo/.worktrees/task-120--cleanup-ready=cleanup_candidate/remove_task_worktree, managed_task:issue-123=archive_candidate/archive_retired_task_history');
    expect(summary).toContain('assist_actions: action-continue=continue_worker/executed/model:class_a_allowlist/exec:class_a_assist_execution');
    expect(summary).toContain('action-legacy-ready=release_ready(source:notify_human_ready;deprecated)/executed/model:class_a_allowlist/exec:class_a_assist_execution');
  });
});
