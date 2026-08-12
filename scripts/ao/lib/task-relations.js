import { createHash } from 'node:crypto';

export const TASK_RELATION_SCHEMA_VERSION = 'ao.task-relation.v1alpha1';
export const TASK_RELATION_FORMAT = 'ao_task_relation';
export const TASK_RELATION_KINDS = Object.freeze(['parent_of', 'depends_on']);
const RFC3339_DATE_TIME = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}`);
  }
  return value.trim();
}

function normalizeIsoTimestamp(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName);
  const dateParts = RFC3339_DATE_TIME.test(normalized)
    ? /^(\d{4})-(\d{2})-(\d{2})/.exec(normalized)
    : null;
  const calendarDate = dateParts == null
    ? null
    : new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3])));
  if (
    dateParts == null
    || calendarDate.getUTCFullYear() !== Number(dateParts[1])
    || calendarDate.getUTCMonth() !== Number(dateParts[2]) - 1
    || calendarDate.getUTCDate() !== Number(dateParts[3])
    || Number.isNaN(new Date(normalized).getTime())
  ) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return normalized;
}

export function createTaskRelationId({
  relation_kind,
  source_task_id,
  target_task_id,
} = {}) {
  const relationKind = normalizeRequiredString(relation_kind, 'relation_kind');
  if (!TASK_RELATION_KINDS.includes(relationKind)) {
    throw new Error('Invalid relation_kind');
  }
  const sourceTaskId = normalizeRequiredString(source_task_id, 'source_task_id');
  const targetTaskId = normalizeRequiredString(target_task_id, 'target_task_id');
  const digest = createHash('sha256')
    .update(JSON.stringify([TASK_RELATION_SCHEMA_VERSION, relationKind, sourceTaskId, targetTaskId]))
    .digest('hex');
  return `task-relation:${digest}`;
}

export function createTaskRelation(input = {}) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid task relation record');
  }
  if (Object.hasOwn(input, 'metadata')) {
    throw new Error('Task relation metadata is prohibited; use a first-class relation record');
  }
  const allowedKeys = new Set([
    'schema_version',
    'format',
    'relation_id',
    'relation_kind',
    'source_task_id',
    'target_task_id',
    'created_at',
    'updated_at',
  ]);
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(`Invalid task relation field ${unknownKey}`);
  }
  const {
    schema_version = TASK_RELATION_SCHEMA_VERSION,
    format = TASK_RELATION_FORMAT,
    relation_id = null,
    relation_kind,
    source_task_id,
    target_task_id,
    created_at,
    updated_at,
  } = input;
  if (schema_version !== TASK_RELATION_SCHEMA_VERSION) {
    throw new Error('Unsupported task relation schema_version');
  }
  if (format !== TASK_RELATION_FORMAT) {
    throw new Error('Invalid task relation format');
  }
  const relationKind = normalizeRequiredString(relation_kind, 'relation_kind');
  if (!TASK_RELATION_KINDS.includes(relationKind)) {
    throw new Error('Invalid relation_kind');
  }
  const sourceTaskId = normalizeRequiredString(source_task_id, 'source_task_id');
  const targetTaskId = normalizeRequiredString(target_task_id, 'target_task_id');
  if (sourceTaskId === targetTaskId) {
    throw new Error('Task relation cannot reference the same source and target task');
  }

  const expectedRelationId = createTaskRelationId({
    relation_kind: relationKind,
    source_task_id: sourceTaskId,
    target_task_id: targetTaskId,
  });
  if (relation_id != null && normalizeRequiredString(relation_id, 'relation_id') !== expectedRelationId) {
    throw new Error('Task relation_id does not match its canonical edge identity');
  }

  return {
    schema_version: TASK_RELATION_SCHEMA_VERSION,
    format: TASK_RELATION_FORMAT,
    relation_id: expectedRelationId,
    relation_kind: relationKind,
    source_task_id: sourceTaskId,
    target_task_id: targetTaskId,
    created_at: normalizeIsoTimestamp(created_at, 'created_at'),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
  };
}

export function assertTaskRelationGraphWrite({
  relation,
  taskIds,
  existingRelations = [],
} = {}) {
  const normalizedRelation = createTaskRelation(relation);
  const knownTaskIds = taskIds instanceof Set ? taskIds : new Set(taskIds ?? []);
  for (const taskId of [normalizedRelation.source_task_id, normalizedRelation.target_task_id]) {
    if (!knownTaskIds.has(taskId)) {
      throw new Error(`Task relation references unknown managed task ${taskId}`);
    }
  }

  const outgoing = new Map();
  for (const candidate of [...existingRelations, normalizedRelation]) {
    if (candidate?.relation_id === normalizedRelation.relation_id && candidate !== normalizedRelation) {
      continue;
    }
    const edge = createTaskRelation(candidate);
    const targets = outgoing.get(edge.source_task_id) ?? new Set();
    targets.add(edge.target_task_id);
    outgoing.set(edge.source_task_id, targets);
  }

  const pending = [normalizedRelation.target_task_id];
  const visited = new Set();
  while (pending.length) {
    const taskId = pending.pop();
    if (taskId === normalizedRelation.source_task_id) {
      throw new Error('Task relation would create a cycle');
    }
    if (visited.has(taskId)) continue;
    visited.add(taskId);
    pending.push(...(outgoing.get(taskId) ?? []));
  }

  return normalizedRelation;
}
