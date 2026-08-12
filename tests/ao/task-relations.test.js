import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { createManagedTask } from '../../scripts/ao/lib/state-contracts.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';
import {
  TASK_RELATION_FORMAT,
  TASK_RELATION_SCHEMA_VERSION,
  TASK_RELATION_KINDS,
  createTaskRelation,
  createTaskRelationId,
} from '../../scripts/ao/lib/task-relations.js';

const NOW = '2026-08-10T08:00:00.000Z';
const tempDirs = [];

function createRepository() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-task-relations-'));
  tempDirs.push(repoRoot);
  let auditId = 0;
  return createStateRepository({
    repoRoot,
    projectId: 'task-relations-test',
    clock: () => NOW,
    auditIdGenerator: () => `audit-${++auditId}`,
  });
}

function managedTask(taskId, metadata = {}) {
  return createManagedTask({
    task_id: taskId,
    title: `Task ${taskId}`,
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
    metadata,
  });
}

function relation(relationKind, sourceTaskId, targetTaskId, updatedAt = NOW) {
  return {
    relation_kind: relationKind,
    source_task_id: sourceTaskId,
    target_task_id: targetTaskId,
    created_at: NOW,
    updated_at: updatedAt,
  };
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('task relation contract', () => {
  it('keeps the public JSON schema aligned with the frozen edge vocabulary', () => {
    const schema = JSON.parse(fs.readFileSync(
      new URL('../../schemas/ao.task-relation.v1alpha1.schema.json', import.meta.url),
      'utf8',
    ));

    expect(schema.$id).toBe(
      'https://schemas.ao-pilot.dev/ao.task-relation.v1alpha1.schema.json',
    );
    expect(schema.properties.schema_version.const).toBe(TASK_RELATION_SCHEMA_VERSION);
    expect(schema.properties.format.const).toBe(TASK_RELATION_FORMAT);
    expect(schema.properties.relation_kind.enum).toEqual(TASK_RELATION_KINDS);
    expect(schema.required).toEqual(expect.arrayContaining([
      'relation_id', 'relation_kind', 'source_task_id', 'target_task_id',
    ]));
    expect(schema.additionalProperties).toBe(false);
  });

  it('normalizes allowed edges with a canonical stable identity', () => {
    const input = relation('parent_of', 'parent-a', 'child-a');
    const record = createTaskRelation(input);

    expect(TASK_RELATION_KINDS).toEqual(['parent_of', 'depends_on']);
    expect(record).toEqual({
      schema_version: TASK_RELATION_SCHEMA_VERSION,
      format: TASK_RELATION_FORMAT,
      relation_id: createTaskRelationId(input),
      ...input,
    });
    expect(createTaskRelation(record)).toEqual(record);
  });

  it('fails closed on unsupported versions, types, identities, self edges, and metadata', () => {
    expect(() => createTaskRelation({
      ...relation('parent_of', 'parent-a', 'child-a'),
      schema_version: 'ao.task-relation.v2',
    })).toThrow('Unsupported task relation schema_version');
    expect(() => createTaskRelation(relation('blocks', 'parent-a', 'child-a')))
      .toThrow('Invalid relation_kind');
    expect(() => createTaskRelation({
      ...relation('depends_on', 'task-a', 'task-b'),
      relation_id: 'task-relation:forged',
    })).toThrow('canonical edge identity');
    expect(() => createTaskRelation(relation('depends_on', 'task-a', 'task-a')))
      .toThrow('same source and target');
    expect(() => createTaskRelation({
      ...relation('depends_on', 'task-a', 'task-b'),
      metadata: { parent_task_id: 'task-c' },
    })).toThrow('metadata is prohibited');
  });
});

describe('task relation repository', () => {
  it('stores a multi-parent DAG and supports deterministic CRUD/query replay', () => {
    const repository = createRepository();
    for (const taskId of ['parent-a', 'parent-b', 'child', 'prerequisite']) {
      repository.upsertManagedTask(managedTask(taskId));
    }

    const first = repository.createTaskRelation(relation('parent_of', 'parent-a', 'child'));
    const second = repository.createTaskRelation(relation('parent_of', 'parent-b', 'child'));
    const dependency = repository.createTaskRelation(
      relation('depends_on', 'child', 'prerequisite'),
    );

    expect(repository.getTaskRelation(first.relation_id)).toEqual(first);
    expect(repository.listTaskRelations({ taskId: 'child' })).toEqual(
      expect.arrayContaining([dependency, first, second]),
    );
    expect(repository.listTaskRelations({ taskId: 'child' })).toHaveLength(3);
    expect(repository.listTaskRelations({ taskId: 'child', direction: 'incoming' }))
      .toEqual(expect.arrayContaining([first, second]));
    expect(repository.listTaskRelations({ taskId: 'child', direction: 'outgoing' }))
      .toEqual([dependency]);
    expect(repository.listTaskRelations({ relationKind: 'parent_of' }))
      .toEqual(expect.arrayContaining([first, second]));

    const replayed = repository.upsertTaskRelation({ ...first, updated_at: '2026-08-10T08:01:00.000Z' });
    expect(replayed.relation_id).toBe(first.relation_id);
    expect(repository.listTaskRelations()).toHaveLength(3);
    expect(() => repository.createTaskRelation(first)).toThrow('already exists');

    expect(repository.deleteTaskRelation(second.relation_id)).toEqual(second);
    expect(repository.getTaskRelation(second.relation_id)).toBeNull();
    expect(repository.deleteTaskRelation(second.relation_id)).toBeNull();
    expect(repository.listAuditEntries().at(-1)).toMatchObject({
      entity_kind: 'task_relation',
      entity_id: second.relation_id,
      operation: 'delete',
    });
  });

  it('rejects dangling references and cycles without persisting or auditing them', () => {
    const repository = createRepository();
    for (const taskId of ['task-a', 'task-b', 'task-c']) {
      repository.upsertManagedTask(managedTask(taskId));
    }
    const auditCount = repository.listAuditEntries().length;

    expect(() => repository.createTaskRelation(
      relation('depends_on', 'task-a', 'missing-task'),
    )).toThrow('unknown managed task missing-task');
    expect(repository.listTaskRelations()).toEqual([]);
    expect(repository.listAuditEntries()).toHaveLength(auditCount);

    repository.createTaskRelation(relation('parent_of', 'task-a', 'task-b'));
    repository.createTaskRelation(relation('depends_on', 'task-b', 'task-c'));
    const beforeCycleAuditCount = repository.listAuditEntries().length;
    expect(() => repository.createTaskRelation(
      relation('parent_of', 'task-c', 'task-a'),
    )).toThrow('would create a cycle');
    expect(repository.listTaskRelations()).toHaveLength(2);
    expect(repository.listAuditEntries()).toHaveLength(beforeCycleAuditCount);
  });

  it('does not treat relation-shaped managed-task metadata as graph authority', () => {
    const repository = createRepository();
    repository.upsertManagedTask(managedTask('task-a', {
      parent_task_id: 'missing-parent',
      depends_on: ['missing-dependency'],
      task_relations: [{ relation_kind: 'parent_of' }],
    }));

    expect(repository.listTaskRelations()).toEqual([]);
  });

  it('fails closed when durable relation evidence is tampered after a valid write', () => {
    const repository = createRepository();
    repository.upsertManagedTask(managedTask('task-a'));
    repository.upsertManagedTask(managedTask('task-b'));
    repository.createTaskRelation(relation('depends_on', 'task-a', 'task-b'));
    const paths = repository.getSnapshot().paths;
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    state.task_relations[0].target_task_id = 'missing-task';
    fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    expect(() => repository.getSnapshot()).toThrow('canonical edge identity');
  });
});
