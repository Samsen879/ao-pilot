import { createHash } from 'node:crypto';

import {
  TASK_RELATION_KINDS,
  TASK_RELATION_SCHEMA_VERSION,
  createTaskRelation,
} from './task-relations.js';

export const TASK_GRAPH_RESULT_SCHEMA_VERSION = 'ao.task-graph-result.v1alpha1';
export const TASK_GRAPH_RESULT_FORMAT = 'ao_task_graph_result';
export const TASK_GRAPH_TERMINAL_EVIDENCE_SOURCES = Object.freeze([
  'explicit',
  'managed_task_status',
  'completion_record',
  'provider_outcome',
]);

const STRUCTURAL_FINDING_CODES = new Set([
  'task_graph_task_malformed',
  'task_graph_task_duplicate',
  'task_graph_relation_malformed',
  'task_graph_relation_unsupported_kind',
  'task_graph_relation_unsupported_version',
  'task_graph_relation_mixed_version',
  'task_graph_relation_duplicate',
  'task_graph_missing_node',
  'task_graph_cycle',
]);

function compareStrings(left, right) {
  return String(left).localeCompare(String(right));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareStrings).map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function finding(code, { taskIds = [], relationIds = [], details = [] } = {}) {
  return {
    code,
    severity: 'blocker',
    task_ids: [...new Set(taskIds)].sort(compareStrings),
    relation_ids: [...new Set(relationIds)].sort(compareStrings),
    details: [...new Set(details.map(String))].sort(compareStrings),
  };
}

function normalizeTasks(tasks, findings) {
  if (!Array.isArray(tasks)) {
    findings.push(finding('task_graph_task_malformed', {
      details: ['tasks must be an array'],
    }));
    return [];
  }

  const taskIds = [];
  const seen = new Set();
  for (const task of tasks) {
    const candidate = typeof task === 'string' ? task : task?.task_id;
    const taskId = typeof candidate === 'string' ? candidate.trim() : '';
    if (!taskId) {
      findings.push(finding('task_graph_task_malformed', {
        details: ['task record is missing task_id'],
      }));
      continue;
    }
    if (seen.has(taskId)) {
      findings.push(finding('task_graph_task_duplicate', { taskIds: [taskId] }));
      continue;
    }
    seen.add(taskId);
    taskIds.push(taskId);
  }
  return taskIds.sort(compareStrings);
}

function classifyRelationError(error) {
  const message = String(error?.message ?? error);
  if (message.includes('Unsupported task relation schema_version')) {
    return 'task_graph_relation_unsupported_version';
  }
  if (message.includes('Invalid relation_kind')) {
    return 'task_graph_relation_unsupported_kind';
  }
  return 'task_graph_relation_malformed';
}

function normalizeRelations(relations, knownTaskIds, findings) {
  if (!Array.isArray(relations)) {
    findings.push(finding('task_graph_relation_malformed', {
      details: ['relations must be an array'],
    }));
    return [];
  }

  const observedVersions = [...new Set(relations.map((relation) => (
    typeof relation?.schema_version === 'string'
      ? relation.schema_version
      : TASK_RELATION_SCHEMA_VERSION
  )))].sort(compareStrings);
  if (observedVersions.length > 1) {
    findings.push(finding('task_graph_relation_mixed_version', {
      details: observedVersions.map((version) => `schema_version=${version}`),
    }));
  }

  const normalized = [];
  const relationIds = new Set();
  for (const relation of relations) {
    let edge;
    try {
      edge = createTaskRelation(relation);
    } catch (error) {
      findings.push(finding(classifyRelationError(error), {
        relationIds: typeof relation?.relation_id === 'string' ? [relation.relation_id] : [],
        details: [String(error?.message ?? error)],
      }));
      continue;
    }
    if (relationIds.has(edge.relation_id)) {
      findings.push(finding('task_graph_relation_duplicate', {
        relationIds: [edge.relation_id],
      }));
      continue;
    }
    relationIds.add(edge.relation_id);
    const missingTaskIds = [edge.source_task_id, edge.target_task_id]
      .filter((taskId) => !knownTaskIds.has(taskId));
    if (missingTaskIds.length) {
      findings.push(finding('task_graph_missing_node', {
        taskIds: missingTaskIds,
        relationIds: [edge.relation_id],
      }));
      continue;
    }
    normalized.push(edge);
  }

  return normalized.sort((left, right) => compareStrings(left.relation_id, right.relation_id));
}

function buildTopology(taskIds, relations, findings) {
  const outgoing = new Map(taskIds.map((taskId) => [taskId, new Set()]));
  const indegree = new Map(taskIds.map((taskId) => [taskId, 0]));
  for (const relation of relations) {
    const targets = outgoing.get(relation.source_task_id);
    if (targets.has(relation.target_task_id)) continue;
    targets.add(relation.target_task_id);
    indegree.set(relation.target_task_id, indegree.get(relation.target_task_id) + 1);
  }

  const ready = taskIds.filter((taskId) => indegree.get(taskId) === 0).sort(compareStrings);
  const orderedTaskIds = [];
  while (ready.length) {
    const taskId = ready.shift();
    orderedTaskIds.push(taskId);
    for (const targetTaskId of [...outgoing.get(taskId)].sort(compareStrings)) {
      indegree.set(targetTaskId, indegree.get(targetTaskId) - 1);
      if (indegree.get(targetTaskId) === 0) {
        ready.push(targetTaskId);
        ready.sort(compareStrings);
      }
    }
  }

  if (orderedTaskIds.length !== taskIds.length) {
    const cycleTaskIds = findCycleTaskIds(taskIds, outgoing);
    const cycleTaskIdSet = new Set(cycleTaskIds);
    findings.push(finding('task_graph_cycle', {
      taskIds: cycleTaskIds,
      relationIds: relations.filter((relation) => (
        cycleTaskIdSet.has(relation.source_task_id)
        && cycleTaskIdSet.has(relation.target_task_id)
      )).map((relation) => relation.relation_id),
    }));
    return [];
  }
  return orderedTaskIds;
}

function findCycleTaskIds(taskIds, outgoing) {
  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycleTaskIds = new Set();

  function visit(taskId) {
    indexes.set(taskId, nextIndex);
    lowLinks.set(taskId, nextIndex);
    nextIndex += 1;
    stack.push(taskId);
    onStack.add(taskId);

    for (const targetTaskId of [...outgoing.get(taskId)].sort(compareStrings)) {
      if (!indexes.has(targetTaskId)) {
        visit(targetTaskId);
        lowLinks.set(taskId, Math.min(lowLinks.get(taskId), lowLinks.get(targetTaskId)));
      } else if (onStack.has(targetTaskId)) {
        lowLinks.set(taskId, Math.min(lowLinks.get(taskId), indexes.get(targetTaskId)));
      }
    }

    if (lowLinks.get(taskId) !== indexes.get(taskId)) return;
    const component = [];
    while (stack.length) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === taskId) break;
    }
    if (component.length > 1) component.forEach((member) => cycleTaskIds.add(member));
  }

  for (const taskId of taskIds) {
    if (!indexes.has(taskId)) visit(taskId);
  }
  return [...cycleTaskIds].sort(compareStrings);
}

function normalizeTerminalEvidence(terminalEvidence, knownTaskIds, findings) {
  if (!Array.isArray(terminalEvidence)) {
    findings.push(finding('task_graph_terminal_evidence_malformed', {
      details: ['terminalEvidence must be an array'],
    }));
    return new Map();
  }

  const evidenceByTaskId = new Map();
  const contradictoryTaskIds = new Set();
  for (const evidence of terminalEvidence) {
    const taskId = typeof evidence?.task_id === 'string' ? evidence.task_id.trim() : '';
    const source = evidence?.source ?? 'explicit';
    if (!taskId || typeof evidence?.terminal !== 'boolean') {
      findings.push(finding('task_graph_terminal_evidence_malformed', {
        taskIds: taskId ? [taskId] : [],
        details: ['terminal evidence must contain task_id and boolean terminal'],
      }));
      continue;
    }
    if (!knownTaskIds.has(taskId)) {
      findings.push(finding('task_graph_terminal_evidence_unknown_task', { taskIds: [taskId] }));
      continue;
    }
    if (!TASK_GRAPH_TERMINAL_EVIDENCE_SOURCES.includes(source)) {
      findings.push(finding('task_graph_terminal_evidence_unsupported_source', {
        taskIds: [taskId],
        details: [`source=${source}`],
      }));
      continue;
    }
    if (contradictoryTaskIds.has(taskId)) continue;
    const current = evidenceByTaskId.get(taskId);
    if (current != null && current !== evidence.terminal) {
      findings.push(finding('task_graph_terminal_evidence_contradictory', { taskIds: [taskId] }));
      evidenceByTaskId.delete(taskId);
      contradictoryTaskIds.add(taskId);
      continue;
    }
    evidenceByTaskId.set(taskId, evidence.terminal);
  }

  for (const taskId of knownTaskIds) {
    if (!evidenceByTaskId.has(taskId)) {
      findings.push(finding('task_graph_terminal_evidence_missing', { taskIds: [taskId] }));
    }
  }
  return evidenceByTaskId;
}

function sortFindings(findings) {
  return findings.sort((left, right) => (
    compareStrings(left.code, right.code)
    || compareStrings(left.task_ids.join(','), right.task_ids.join(','))
    || compareStrings(left.relation_ids.join(','), right.relation_ids.join(','))
    || compareStrings(left.details.join(','), right.details.join(','))
  ));
}

export function terminalEvidenceFromManagedTasks(tasks = []) {
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((task) => {
    if (typeof task?.task_id !== 'string') return [];
    if (!['active', 'paused', 'retired'].includes(task.status)) return [];
    return [{
      task_id: task.task_id,
      terminal: task.status === 'retired',
      source: 'managed_task_status',
    }];
  });
}

export function inspectTaskGraph({
  tasks = [],
  relations = [],
  terminalEvidence = [],
} = {}) {
  const findings = [];
  const taskIds = normalizeTasks(tasks, findings);
  const knownTaskIds = new Set(taskIds);
  const normalizedRelations = normalizeRelations(relations, knownTaskIds, findings);
  const orderedTaskIds = buildTopology(taskIds, normalizedRelations, findings);
  const terminalByTaskId = normalizeTerminalEvidence(terminalEvidence, knownTaskIds, findings);
  const sortedFindings = sortFindings(findings);
  const structurallyHealthy = !sortedFindings.some((item) => STRUCTURAL_FINDING_CODES.has(item.code));

  const taskResults = taskIds.map((taskId) => {
    const dependencyTaskIds = normalizedRelations
      .filter((relation) => relation.relation_kind === 'depends_on' && relation.source_task_id === taskId)
      .map((relation) => relation.target_task_id)
      .sort(compareStrings);
    const childTaskIds = normalizedRelations
      .filter((relation) => relation.relation_kind === 'parent_of' && relation.source_task_id === taskId)
      .map((relation) => relation.target_task_id)
      .sort(compareStrings);
    const missingDependencyEvidence = dependencyTaskIds.filter((id) => !terminalByTaskId.has(id));
    const nonterminalDependencyTaskIds = dependencyTaskIds.filter(
      (id) => terminalByTaskId.get(id) === false,
    );
    const childrenWithMissingEvidence = childTaskIds.filter((id) => !terminalByTaskId.has(id));
    const nonterminalChildTaskIds = childTaskIds.filter((id) => terminalByTaskId.get(id) === false);
    return {
      task_id: taskId,
      terminal: terminalByTaskId.has(taskId) ? terminalByTaskId.get(taskId) : null,
      dependency_task_ids: dependencyTaskIds,
      dependency_ready: structurallyHealthy
        && missingDependencyEvidence.length === 0
        && nonterminalDependencyTaskIds.length === 0,
      missing_dependency_evidence_task_ids: missingDependencyEvidence,
      nonterminal_dependency_task_ids: nonterminalDependencyTaskIds,
      child_task_ids: childTaskIds,
      all_children_terminal: structurallyHealthy && childrenWithMissingEvidence.length === 0
        ? nonterminalChildTaskIds.length === 0
        : null,
      missing_child_evidence_task_ids: childrenWithMissingEvidence,
      nonterminal_child_task_ids: nonterminalChildTaskIds,
    };
  });

  const result = {
    schema_version: TASK_GRAPH_RESULT_SCHEMA_VERSION,
    format: TASK_GRAPH_RESULT_FORMAT,
    healthy: sortedFindings.length === 0,
    structurally_healthy: structurallyHealthy,
    task_count: taskIds.length,
    relation_count: normalizedRelations.length,
    relation_kind_counts: Object.fromEntries(TASK_RELATION_KINDS.map((kind) => [
      kind,
      normalizedRelations.filter((relation) => relation.relation_kind === kind).length,
    ])),
    ordered_task_ids: structurallyHealthy ? orderedTaskIds : [],
    findings: sortedFindings,
    tasks: taskResults,
  };
  return {
    ...result,
    result_fingerprint: fingerprint(result),
  };
}
