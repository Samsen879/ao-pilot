import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  completionRecordId,
} from '../../scripts/ao/lib/completion-record-contracts.js';
import { createManagedTask } from '../../scripts/ao/lib/state-contracts.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';
import { writeJsonFileAtomic } from '../../scripts/ao/lib/state-storage.js';

const FIXTURE_PATH = path.resolve(
  'tests/ao/fixtures/completion-record/positive/review-passed.json',
);
const NOW = '2026-08-31T00:58:00.000Z';
const MERGE_REF = `github:snapshot/pull/79@sha256:${'4'.repeat(64)}`;
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-completion-records-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function createIdGenerator(prefix) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function recordFor(childTaskId, overrides = {}) {
  const record = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  return {
    ...record,
    record_id: completionRecordId(childTaskId),
    child_task_id: childTaskId,
    parent_task_refs: ['program-z', 'lane-a'],
    ...overrides,
  };
}

function addChild(repository, taskId) {
  repository.upsertManagedTask(createManagedTask({
    task_id: taskId,
    issue_number: null,
    title: `Completion child ${taskId}`,
    status: 'retired',
    created_at: NOW,
    updated_at: NOW,
  }));
}

function createRepository(repoRoot = createTempRepo()) {
  return createStateRepository({
    repoRoot,
    projectId: 'completion-project',
    clock: () => NOW,
    auditIdGenerator: createIdGenerator('audit'),
  });
}

function integratedEvidence() {
  return {
    providerBinding: {
      provider: 'github',
      repository_id: 1001,
      slug: 'Samsen879/ao-pilot',
      pr_number: 79,
      base_ref: 'main',
      base_sha: '1'.repeat(40),
    },
    providerMergeObservation: {
      schema_version: 'ao.github-merge-observation.v1',
      provider: 'github',
      source_ok: true,
      source_error: null,
      observed_at: '2026-08-31T00:59:00.000Z',
      repository: { repository_id: 1001, slug: 'Samsen879/ao-pilot' },
      pull_request: {
        number: 79,
        state: 'MERGED',
        base_ref: 'main',
        base_sha: '1'.repeat(40),
        head_sha: '2'.repeat(40),
        merge_commit_sha: '3'.repeat(40),
        merged_at: '2026-08-31T00:58:30.000Z',
        url: 'https://github.com/Samsen879/ao-pilot/pull/79',
      },
      evidence_refs: [MERGE_REF],
    },
  };
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('durable Completion Record repository API', () => {
  it('creates, reads, queries, and audits child-scoped records without storing artifact bodies', () => {
    const repository = createRepository();
    addChild(repository, 'child-1');
    const created = repository.createCompletionRecord(recordFor('child-1'));

    expect(created.record_id).toBe('child-completion:child-1');
    expect(created.parent_task_refs).toEqual(['lane-a', 'program-z']);
    expect(repository.getCompletionRecord(created.record_id)).toEqual(created);
    expect(repository.getCompletionRecordForChild('child-1')).toEqual(created);
    expect(repository.queryCompletionRecords({
      childTaskId: 'child-1',
      deliveryStatus: 'review_passed',
      generatorRef: created.generator_ref,
    })).toEqual([created]);
    expect(repository.queryCompletionRecords({ deliveryStatus: 'integrated' })).toEqual([]);
    expect(repository.getSnapshot().state.completion_records[0]).not.toHaveProperty('artifact_body');
    expect(repository.listAuditEntries().at(-1)).toMatchObject({
      entity_kind: 'completion_record',
      entity_id: created.record_id,
      operation: 'create',
      details: created,
    });
  });

  it('rejects duplicate child identity, unknown children, and missing update targets', () => {
    const repository = createRepository();
    addChild(repository, 'child-1');
    repository.createCompletionRecord(recordFor('child-1'));

    expect(() => repository.createCompletionRecord(recordFor('child-1', {
      parent_task_refs: ['different-parent'],
    }))).toThrow(/already exists/i);
    expect(() => repository.createCompletionRecord(recordFor('unknown-child')))
      .toThrow(/unknown managed child/i);
    addChild(repository, 'child-2');
    expect(() => repository.updateCompletionRecord(recordFor('child-2')))
      .toThrow(/does not exist/i);
  });

  it('updates the existing delivery payload and preserves the exact predecessor on regeneration', () => {
    const repository = createRepository();
    addChild(repository, 'child-1');
    const first = repository.createCompletionRecord(recordFor('child-1'));
    const integrated = repository.updateCompletionRecord({
      ...first,
      delivery_status: 'integrated',
      merge_sha: '3'.repeat(40),
      merge_observation_ref: MERGE_REF,
    }, integratedEvidence());

    expect(integrated.delivery_status).toBe('integrated');
    expect(repository.listAuditEntries().at(-1)).toMatchObject({
      entity_kind: 'completion_record',
      operation: 'update',
    });
    const regenerated = {
      ...integrated,
      generator_ref: 'ao-pilot/completion-recorder@1.0.1#fedcba9876543210',
      artifact: {
        ...integrated.artifact,
        uri: 'artifacts/completion/child-1-regenerated.md',
        content_sha256: '5'.repeat(64),
      },
      prior_artifact: integrated.artifact,
    };
    expect(repository.updateCompletionRecord(regenerated, integratedEvidence())).toEqual(regenerated);

    const backwards = { ...regenerated, delivery_status: 'review_passed' };
    delete backwards.merge_sha;
    delete backwards.merge_observation_ref;
    expect(() => repository.updateCompletionRecord(backwards)).toThrow(expect.objectContaining({
      code: 'DELIVERY_STATUS_TRANSITION_REJECTED',
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'delivery_transition_invalid' }),
      ]),
    }));

    const missingPredecessor = { ...regenerated, artifact: {
      ...regenerated.artifact,
      content_sha256: '6'.repeat(64),
    } };
    delete missingPredecessor.prior_artifact;
    expect(() => repository.updateCompletionRecord(missingPredecessor, integratedEvidence()))
      .toThrow(/requires prior_artifact matching the durable artifact/i);
  });

  it('fails closed on local-only integration evidence with structured findings', () => {
    const repository = createRepository();
    addChild(repository, 'child-1');
    const first = repository.createCompletionRecord(recordFor('child-1'));
    const localOnly = {
      ...first,
      delivery_status: 'integrated',
      merge_sha: '3'.repeat(40),
      merge_observation_ref: MERGE_REF,
    };

    expect(() => repository.updateCompletionRecord(localOnly)).toThrow(expect.objectContaining({
      code: 'DELIVERY_STATUS_TRANSITION_REJECTED',
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'delivery_provider_observation_missing' }),
      ]),
    }));
    expect(repository.getCompletionRecordForChild('child-1').delivery_status)
      .toBe('review_passed');
  });

  it('serializes and queries records deterministically across insertion order', () => {
    const first = createRepository();
    const second = createRepository();
    for (const repository of [first, second]) {
      addChild(repository, 'z-child');
      addChild(repository, 'ä-child');
    }
    first.createCompletionRecord(recordFor('ä-child'));
    first.createCompletionRecord(recordFor('z-child'));
    second.createCompletionRecord(recordFor('z-child'));
    second.createCompletionRecord(recordFor('ä-child'));

    const firstRecords = first.queryCompletionRecords();
    const secondRecords = second.queryCompletionRecords();
    expect(firstRecords.map((record) => record.child_task_id)).toEqual(['z-child', 'ä-child']);
    expect(JSON.stringify(firstRecords)).toBe(JSON.stringify(secondRecords));
  });

  it.each([
    ['missing', (record) => { delete record.schema_version; }, /missing completion record schema_version/i],
    ['unsupported', (record) => { record.schema_version = 'ao.child-completion.v2'; }, /unsupported completion record schema/i],
    ['mixed', (record, records) => {
      records.push({ ...record, record_id: 'child-completion:child-2', child_task_id: 'child-2' });
      record.schema_version = 'ao.child-completion.v2';
    }, /mixed completion record schema versions/i],
  ])('fails closed on %s durable version evidence', (_label, mutate, expected) => {
    const repository = createRepository();
    addChild(repository, 'child-1');
    const created = repository.createCompletionRecord(recordFor('child-1'));
    const paths = repository.getSnapshot().paths;
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    const records = [structuredClone(created)];
    mutate(records[0], records);
    state.completion_records = records;
    writeJsonFileAtomic(paths.statePath, state);

    expect(() => repository.getSnapshot()).toThrow(expected);
  });

  it.each([
    ['missing collection', (state) => { delete state.completion_records; }, /missing or malformed durable completion_records/i],
    ['contradictory child identity', (state) => {
      state.completion_records[0].record_id = 'child-completion:different-child';
    }, /record_id does not match child_task_id/i],
    ['unknown child', (state) => { state.managed_tasks = []; }, /unknown managed child/i],
  ])('fails closed on %s evidence in a current schema', (_label, mutate, expected) => {
    const repository = createRepository();
    addChild(repository, 'child-1');
    repository.createCompletionRecord(recordFor('child-1'));
    const paths = repository.getSnapshot().paths;
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    mutate(state);
    writeJsonFileAtomic(paths.statePath, state);

    expect(() => repository.getSnapshot()).toThrow(expected);
  });
});
