import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { buildDoctorReport } from '../../scripts/ao/lib/doctor-engine.js';
import { createDoctorLocalState, createDoctorProjectScope } from '../../scripts/ao/lib/doctor-contracts.js';
import { createManagedTask } from '../../scripts/ao/lib/state-contracts.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';
import { loadAoStateReport } from '../../scripts/ao/lib/state-runner.js';
import {
  TASK_GRAPH_RESULT_FORMAT,
  TASK_GRAPH_RESULT_SCHEMA_VERSION,
  inspectTaskGraph,
  terminalEvidenceFromManagedTasks,
} from '../../scripts/ao/lib/task-graph.js';

const NOW = '2026-08-30T16:00:00.000Z';
const tempDirs = [];

function task(taskId, status = 'active') {
  return createManagedTask({
    task_id: taskId,
    title: `Task ${taskId}`,
    status,
    created_at: NOW,
    updated_at: NOW,
  });
}

function relation(relationKind, sourceTaskId, targetTaskId, overrides = {}) {
  return {
    relation_kind: relationKind,
    source_task_id: sourceTaskId,
    target_task_id: targetTaskId,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function evidence(taskId, terminal) {
  return { task_id: taskId, terminal, source: 'explicit' };
}

function codes(result) {
  return result.findings.map((finding) => finding.code);
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('task graph engine', () => {
  it('traverses a multi-parent DAG and projects readiness and all-child terminality', () => {
    const tasks = ['parent-a', 'parent-b', 'child', 'dependency', 'leaf'];
    const result = inspectTaskGraph({
      tasks,
      relations: [
        relation('parent_of', 'parent-a', 'child'),
        relation('parent_of', 'parent-b', 'child'),
        relation('parent_of', 'parent-a', 'leaf'),
        relation('depends_on', 'child', 'dependency'),
      ],
      terminalEvidence: [
        evidence('parent-a', false),
        evidence('parent-b', false),
        evidence('child', true),
        evidence('dependency', true),
        evidence('leaf', false),
      ],
    });

    expect(result).toMatchObject({
      schema_version: TASK_GRAPH_RESULT_SCHEMA_VERSION,
      format: TASK_GRAPH_RESULT_FORMAT,
      healthy: true,
      structurally_healthy: true,
      relation_kind_counts: { parent_of: 3, depends_on: 1 },
    });
    expect(result.ordered_task_ids).toEqual([
      'parent-a', 'leaf', 'parent-b', 'child', 'dependency',
    ]);
    expect(result.tasks.find((entry) => entry.task_id === 'child')).toMatchObject({
      terminal: true,
      dependency_task_ids: ['dependency'],
      dependency_ready: true,
    });
    expect(result.tasks.find((entry) => entry.task_id === 'parent-a')).toMatchObject({
      child_task_ids: ['child', 'leaf'],
      all_children_terminal: false,
      nonterminal_child_task_ids: ['leaf'],
    });
    expect(result.result_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed on cycles and suppresses ordered traversal', () => {
    const result = inspectTaskGraph({
      tasks: ['a', 'b', 'c', 'tail'],
      relations: [
        relation('parent_of', 'a', 'b'),
        relation('depends_on', 'b', 'c'),
        relation('parent_of', 'c', 'a'),
        relation('parent_of', 'c', 'tail'),
      ],
      terminalEvidence: [
        evidence('a', false), evidence('b', false), evidence('c', false), evidence('tail', false),
      ],
    });

    expect(result.structurally_healthy).toBe(false);
    expect(result.ordered_task_ids).toEqual([]);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'task_graph_cycle',
      task_ids: ['a', 'b', 'c'],
    }));
    expect(result.tasks.every((entry) => entry.dependency_ready === false)).toBe(true);
    expect(result.tasks.every((entry) => entry.all_children_terminal === null)).toBe(true);
  });

  it('returns blocking findings for missing nodes', () => {
    const result = inspectTaskGraph({
      tasks: ['a'],
      relations: [relation('depends_on', 'a', 'missing')],
      terminalEvidence: [evidence('a', false)],
    });

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'task_graph_missing_node',
      task_ids: ['missing'],
    }));
    expect(result.relation_count).toBe(0);
  });

  it('classifies malformed, unsupported, and mixed-version relations', () => {
    const result = inspectTaskGraph({
      tasks: ['a', 'b'],
      relations: [
        relation('parent_of', 'a', 'b'),
        relation('parent_of', 'b', 'a', { schema_version: 'ao.task-relation.v2' }),
        relation('blocks', 'a', 'b'),
        { relation_kind: 'parent_of', source_task_id: 'a', target_task_id: 'b' },
      ],
      terminalEvidence: [evidence('a', false), evidence('b', false)],
    });

    expect(codes(result)).toEqual(expect.arrayContaining([
      'task_graph_relation_mixed_version',
      'task_graph_relation_unsupported_version',
      'task_graph_relation_unsupported_kind',
      'task_graph_relation_malformed',
    ]));
    expect(result.structurally_healthy).toBe(false);
  });

  it('fails closed on missing, contradictory, unknown, and label-derived terminal evidence', () => {
    const result = inspectTaskGraph({
      tasks: ['parent', 'child'],
      relations: [relation('parent_of', 'parent', 'child')],
      terminalEvidence: [
        evidence('child', true),
        evidence('child', false),
        evidence('child', true),
        evidence('missing', true),
        { task_id: 'parent', terminal: true, source: 'github_label' },
      ],
    });

    expect(codes(result)).toEqual(expect.arrayContaining([
      'task_graph_terminal_evidence_contradictory',
      'task_graph_terminal_evidence_unknown_task',
      'task_graph_terminal_evidence_unsupported_source',
      'task_graph_terminal_evidence_missing',
    ]));
    expect(result.tasks.find((entry) => entry.task_id === 'parent')).toMatchObject({
      terminal: null,
      all_children_terminal: null,
    });
  });

  it('keeps traversal, findings, projections, and fingerprint stable across record order', () => {
    const tasks = ['parent-a', 'parent-b', 'child', 'dependency'];
    const relations = [
      relation('parent_of', 'parent-a', 'child'),
      relation('parent_of', 'parent-b', 'child'),
      relation('depends_on', 'child', 'dependency'),
    ];
    const terminalEvidence = tasks.map((taskId) => evidence(taskId, taskId === 'dependency'));
    const first = inspectTaskGraph({ tasks, relations, terminalEvidence });
    const replay = inspectTaskGraph({
      tasks: [...tasks].reverse(),
      relations: [...relations].reverse(),
      terminalEvidence: [...terminalEvidence].reverse(),
    });

    expect(replay).toEqual(first);
  });

  it('keeps malformed findings and fingerprint stable across record order', () => {
    const first = inspectTaskGraph({
      tasks: ['a', 'b'],
      relations: [
        relation('blocks', 'a', 'b'),
        { relation_kind: 'depends_on', source_task_id: 'a', target_task_id: 'b' },
      ],
      terminalEvidence: [
        { task_id: 'a', terminal: 'yes' },
        evidence('b', false),
      ],
    });
    const replay = inspectTaskGraph({
      tasks: ['b', 'a'],
      relations: [
        { relation_kind: 'depends_on', source_task_id: 'a', target_task_id: 'b' },
        relation('blocks', 'a', 'b'),
      ],
      terminalEvidence: [
        evidence('b', false),
        { task_id: 'a', terminal: 'yes' },
      ],
    });

    expect(replay).toEqual(first);
  });
});

describe('task graph control-plane integration', () => {
  it('adds deterministic graph health and projections to ao state', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-task-graph-state-'));
    tempDirs.push(repoRoot);
    const repository = createStateRepository({
      repoRoot,
      projectId: 'task-graph-state',
      clock: () => NOW,
      auditIdGenerator: (() => {
        let id = 0;
        return () => `audit-${++id}`;
      })(),
    });
    repository.upsertManagedTask(task('parent'));
    repository.upsertManagedTask(task('child', 'retired'));
    repository.createTaskRelation(relation('parent_of', 'parent', 'child'));

    const report = await loadAoStateReport({
      repoRoot,
      projectId: 'task-graph-state',
      now: NOW,
    });

    expect(report.summary).toMatchObject({
      task_graph_healthy: true,
      task_graph_finding_count: 0,
    });
    expect(report.task_graph.tasks.find((entry) => entry.task_id === 'parent'))
      .toMatchObject({ all_children_terminal: true });
  });

  it('maps structured graph-health findings into doctor blockers', () => {
    const managedTasks = [task('parent'), task('child')];
    const report = buildDoctorReport({
      scope: createDoctorProjectScope({ projectId: 'task-graph-doctor' }),
      reconciliationReport: {
        project_id: 'task-graph-doctor',
        observed_at: NOW,
        top_status: 'healthy',
        automation_disposition: 'proceed',
        scope: { selected_pr_numbers: [] },
        source_health: {},
        findings: [],
      },
      localState: createDoctorLocalState({ cwd: '/repo', git_observable: false }),
      controlPlaneSnapshot: {
        bootstrapped: true,
        schema: { current_version: 12 },
        state: {
          managed_tasks: managedTasks,
          task_relations: [relation('parent_of', 'parent', 'missing')],
          task_specs: [],
          runtime_preflights: [],
          handoff_requests: [],
          handoff_claims: [],
          handoff_decisions: [],
          handoff_transfers: [],
        },
      },
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'task_graph_missing_node',
      severity: 'blocker',
      source_area: 'task_graph',
    }));
  });

  it('derives explicit non-label terminal evidence only from managed task status', () => {
    expect(terminalEvidenceFromManagedTasks([
      task('active'),
      task('paused', 'paused'),
      task('retired', 'retired'),
      { task_id: 'malformed', status: 'completed' },
    ])).toEqual([
      { task_id: 'active', terminal: false, source: 'managed_task_status' },
      { task_id: 'paused', terminal: false, source: 'managed_task_status' },
      { task_id: 'retired', terminal: true, source: 'managed_task_status' },
    ]);
  });
});
