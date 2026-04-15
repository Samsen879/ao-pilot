import { describe, expect, it } from '@jest/globals';

import {
  createControllerCursorRecord,
  createDeliveryEventRecord,
  createEmptyControlPlaneState,
  createObservationRecord,
  OBSERVATION_SOURCE_KINDS,
} from '../../scripts/ao/lib/state-contracts.js';

const NOW = '2026-03-29T06:00:00.000Z';

describe('ao controller state contracts', () => {
  it('exports frozen poll-observation source kinds', () => {
    expect(OBSERVATION_SOURCE_KINDS).toEqual(['ao_poll', 'github_poll']);
  });

  it('creates durable observation and controller cursor records', () => {
    expect(createObservationRecord({
      observation_id: 'obs-1',
      task_id: 'issue-89',
      source_kind: 'ao_poll',
      cursor: 'cursor-1',
      observed_at: NOW,
      recorded_at: NOW,
      summary: 'Observed AO worker state for issue-89.',
      payload: {
        workers: [{ session_name: 'worker-50' }],
      },
    })).toEqual({
      observation_id: 'obs-1',
      task_id: 'issue-89',
      source_kind: 'ao_poll',
      cursor: 'cursor-1',
      observed_at: NOW,
      recorded_at: NOW,
      summary: 'Observed AO worker state for issue-89.',
      payload: {
        workers: [{ session_name: 'worker-50' }],
      },
    });

    expect(createControllerCursorRecord({
      cursor_id: 'default:issue-89:ao_poll',
      controller_id: 'default',
      task_id: 'issue-89',
      source_kind: 'ao_poll',
      last_cursor: 'cursor-1',
      observed_at: NOW,
      updated_at: NOW,
    })).toEqual({
      cursor_id: 'default:issue-89:ao_poll',
      controller_id: 'default',
      task_id: 'issue-89',
      source_kind: 'ao_poll',
      last_cursor: 'cursor-1',
      observed_at: NOW,
      updated_at: NOW,
    });

    expect(createDeliveryEventRecord({
      event_id: 'delivery-1',
      task_id: 'issue-89',
      pr_number: 109,
      source_kind: 'github_poll',
      event_family: 'check',
      event_type: 'check_state',
      dedupe_key: 'github_poll:check:109:abc123:failing',
      lifecycle_trigger: 'ci_failed',
      controller_action_hint: 'hold_ci',
      observed_at: NOW,
      recorded_at: NOW,
      lineage: {
        source_observation_id: 'issue-89:github_poll:cursor-1',
        source_cursor: 'cursor-1',
      },
      payload: {
        head_sha: 'abc123',
        ci_status: 'failing',
      },
    })).toEqual(expect.objectContaining({
      event_id: 'delivery-1',
      task_id: 'issue-89',
      event_family: 'check',
      lifecycle_trigger: 'ci_failed',
      controller_action_hint: 'hold_ci',
    }));
  });

  it('extends empty control-plane state with observation, delivery-event, and cursor collections', () => {
    expect(createEmptyControlPlaneState({
      project_id: 'my-project',
      created_at: NOW,
      updated_at: NOW,
    })).toMatchObject({
      project_id: 'my-project',
      observations: [],
      delivery_events: [],
      controller_cursors: [],
      runtime_preflights: [],
      checkpoints: [],
    });
  });
});
