import { describe, expect, it } from '@jest/globals';

import {
  createManagedTask,
  createOwnershipLease,
} from '../../scripts/ao/lib/state-contracts.js';
import {
  transitionManagedTask,
  transitionOwnershipLease,
} from '../../scripts/ao/lib/transition-engine.js';

const NOW = '2026-03-29T06:10:00.000Z';

describe('ao transition engine', () => {
  it('enrolls a managed task into active state with an issue-derived id', () => {
    expect(transitionManagedTask({
      intent: 'enroll',
      existingTask: null,
      now: NOW,
      issueNumber: 89,
      title: 'Managed-task enrollment and shadow controller loop',
      branchName: 'feat/89',
      worktreePath: '/tmp/worker-50',
    })).toMatchObject({
      task_id: 'issue-89',
      issue_number: 89,
      status: 'active',
      branch_name: 'feat/89',
      worktree_path: '/tmp/worker-50',
      updated_at: NOW,
    });
  });

  it('pauses active tasks and rejects unmanage on retired tasks', () => {
    const activeTask = createManagedTask({
      task_id: 'issue-89',
      issue_number: 89,
      title: 'Managed-task enrollment and shadow controller loop',
      branch_name: 'feat/89',
      worktree_path: '/tmp/worker-50',
      status: 'active',
      created_at: '2026-03-29T06:00:00.000Z',
      updated_at: '2026-03-29T06:00:00.000Z',
    });

    expect(transitionManagedTask({
      intent: 'unmanage',
      existingTask: activeTask,
      now: NOW,
    })).toMatchObject({
      task_id: 'issue-89',
      status: 'paused',
      updated_at: NOW,
    });

    expect(() => transitionManagedTask({
      intent: 'unmanage',
      existingTask: {
        ...activeTask,
        status: 'retired',
      },
      now: NOW,
    })).toThrow(/illegal managed-task transition/i);
  });

  it('reactivates paused tasks through adopt but rejects retired reactivation', () => {
    const pausedTask = createManagedTask({
      task_id: 'issue-89',
      issue_number: 89,
      title: 'Managed-task enrollment and shadow controller loop',
      branch_name: 'feat/issue-89',
      worktree_path: '/tmp/worker-50',
      status: 'paused',
      created_at: '2026-03-29T06:00:00.000Z',
      updated_at: '2026-03-29T06:05:00.000Z',
    });

    expect(transitionManagedTask({
      intent: 'adopt',
      existingTask: pausedTask,
      now: NOW,
      branchName: 'feat/89',
      worktreePath: '/tmp/worker-50b',
    })).toMatchObject({
      task_id: 'issue-89',
      status: 'active',
      branch_name: 'feat/89',
      worktree_path: '/tmp/worker-50b',
      updated_at: NOW,
    });

    expect(() => transitionManagedTask({
      intent: 'adopt',
      existingTask: {
        ...pausedTask,
        status: 'retired',
      },
      now: NOW,
    })).toThrow(/illegal managed-task transition/i);
  });

  it('releases active ownership leases and rejects terminal lease transitions', () => {
    const activeLease = createOwnershipLease({
      lease_id: 'ownership-issue-89-worker-50',
      task_id: 'issue-89',
      owner_session_name: 'worker-50',
      owner_session_id: 'worker-50',
      status: 'active',
      acquired_at: '2026-03-29T06:00:00.000Z',
      expires_at: '2026-03-29T06:30:00.000Z',
    });

    expect(transitionOwnershipLease({
      intent: 'release',
      existingLease: activeLease,
      now: NOW,
      reason: 'task_unmanaged',
    })).toMatchObject({
      lease_id: 'ownership-issue-89-worker-50',
      status: 'released',
      released_at: NOW,
      release_reason: 'task_unmanaged',
    });

    expect(() => transitionOwnershipLease({
      intent: 'release',
      existingLease: {
        ...activeLease,
        status: 'released',
        released_at: '2026-03-29T06:05:00.000Z',
      },
      now: NOW,
      reason: 'task_unmanaged',
    })).toThrow(/illegal ownership lease transition/i);
  });
});
