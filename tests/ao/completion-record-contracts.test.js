import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import {
  COMPLETION_DELIVERY_STATUSES,
  COMPLETION_INPUT_MANIFEST_SCHEMA_VERSION,
  COMPLETION_RECORD_SCHEMA_VERSION,
  canonicalCompletionInputManifest,
  canonicalCompletionRecord,
  completionInputManifestDigest,
  completionRecordId,
  generationInputsDigest,
  normalizeCompletionInputManifest,
  normalizeCompletionRecord,
  verifyCompletionRecordReplay,
} from '../../scripts/ao/lib/completion-record-contracts.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(repositoryRoot, 'tests/ao/fixtures/completion-record');
const artifactBytes = Buffer.from('deterministic child artifact\n');

function fixture(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, relativePath), 'utf8'));
}

describe('child Completion Record v1alpha1 contracts', () => {
  it('keeps the JSON schemas and all terminal outcomes explicit', () => {
    const recordSchema = JSON.parse(fs.readFileSync(path.join(
      repositoryRoot, 'schemas/ao.child-completion.v1alpha1.schema.json',
    ), 'utf8'));
    const manifestSchema = JSON.parse(fs.readFileSync(path.join(
      repositoryRoot, 'schemas/ao.child-completion-input-manifest.v1alpha1.schema.json',
    ), 'utf8'));

    expect(recordSchema.properties.schema_version.const).toBe(COMPLETION_RECORD_SCHEMA_VERSION);
    expect(recordSchema.properties.delivery_status.enum).toEqual(COMPLETION_DELIVERY_STATUSES);
    expect(recordSchema.required).toEqual(expect.arrayContaining([
      'child_task_id', 'generator_ref', 'generation_inputs_digest', 'artifact',
    ]));
    expect(recordSchema.additionalProperties).toBe(false);
    expect(manifestSchema.properties.schema_version.const)
      .toBe(COMPLETION_INPUT_MANIFEST_SCHEMA_VERSION);
    expect(manifestSchema.additionalProperties).toBe(false);
  });

  it.each([
    ['review_passed', 'positive/review-passed.json'],
    ['integrated', 'positive/integrated.json'],
    ['abandoned', 'positive/abandoned.json'],
  ])('accepts the positive %s schema fixture without collapsing outcomes', (status, name) => {
    expect(normalizeCompletionRecord(fixture(name)).delivery_status).toBe(status);
  });

  it('derives child identity independently from ordered multi-parent relations', () => {
    const record = fixture('positive/review-passed.json');
    const withoutParents = structuredClone(record);
    delete withoutParents.parent_task_refs;
    const withDifferentParents = structuredClone(record);
    withDifferentParents.parent_task_refs = ['program-z', 'lane-a', 'program-7'];

    expect(normalizeCompletionRecord(record).parent_task_refs).toEqual(['lane-8', 'program-7']);
    expect(normalizeCompletionRecord(withDifferentParents).record_id)
      .toBe(normalizeCompletionRecord(withoutParents).record_id);
    expect(completionRecordId(record.child_task_id)).toBe(record.record_id);
  });

  it('canonicalizes manifest inputs and record keys to stable bytes', () => {
    const manifest = fixture('input-manifest.v1alpha1.json');
    const reversed = { ...manifest, inputs: [...manifest.inputs].reverse() };
    const reorderedRecord = Object.fromEntries(
      Object.entries(fixture('positive/review-passed.json')).reverse(),
    );

    expect(canonicalCompletionInputManifest(reversed))
      .toBe(canonicalCompletionInputManifest(manifest));
    expect(completionInputManifestDigest(reversed)).toBe(completionInputManifestDigest(manifest));
    expect(generationInputsDigest(reversed)).toBe(generationInputsDigest(manifest));
    expect(canonicalCompletionRecord(reorderedRecord))
      .toBe(canonicalCompletionRecord(fixture('positive/review-passed.json')));
    expect(canonicalCompletionInputManifest(manifest))
      .toBe(fs.readFileSync(path.join(fixtureRoot, 'input-manifest.v1alpha1.json'), 'utf8'));
  });

  it.each([
    ['negative/integrated-missing-evidence.json', /requires merge_sha and merge_observation_ref/i],
    ['negative/mixed-version.json', /unsupported completion record input manifest schema/i],
  ])('rejects negative Completion Record fixture %s', (name, expected) => {
    expect(() => normalizeCompletionRecord(fixture(name))).toThrow(expected);
  });

  it('rejects missing canonical generation inputs and mixed manifest versions', () => {
    expect(() => normalizeCompletionInputManifest(fixture('negative/missing-inputs.json')))
      .toThrow(/at least one input/i);
    const mixed = fixture('input-manifest.v1alpha1.json');
    mixed.schema_version = 'ao.child-completion-input-manifest.v1alpha0';
    expect(() => normalizeCompletionInputManifest(mixed)).toThrow(/unsupported input manifest schema/i);
  });

  it('fails closed when terminal evidence or artifact custody is missing', () => {
    const reviewPassed = fixture('positive/review-passed.json');
    delete reviewPassed.review_refs;
    expect(() => normalizeCompletionRecord(reviewPassed)).toThrow(/review_passed requires review_refs/i);

    const abandoned = fixture('positive/abandoned.json');
    abandoned.unresolved_items[0].evidence_refs = [];
    expect(() => normalizeCompletionRecord(abandoned)).toThrow(/requires evidence/i);

    expect(() => verifyCompletionRecordReplay(fixture('positive/review-passed.json'), {
      inputManifest: fixture('input-manifest.v1alpha1.json'),
    })).toThrow(/artifact bytes are required/i);
  });

  it('replays identical normalized inputs and generator identity to identical bytes', () => {
    const record = fixture('positive/review-passed.json');
    const manifest = fixture('input-manifest.v1alpha1.json');
    const replayRecord = structuredClone(record);
    replayRecord.parent_task_refs = ['another-parent', 'lane-8'];
    const result = verifyCompletionRecordReplay(replayRecord, {
      inputManifest: { ...manifest, inputs: [...manifest.inputs].reverse() },
      artifactBytes,
      replayOf: record,
    });

    expect(result.manifest_sha256).toBe(record.generation_inputs.manifest_sha256);
    expect(result.generation_inputs_digest).toBe(record.generation_inputs_digest);
    expect(result.artifact_content_sha256).toBe(record.artifact.content_sha256);
    expect(result.record.record_id).toBe(record.record_id);
  });

  it('rejects replay when generator, normalized inputs, or output bytes differ', () => {
    const record = fixture('positive/review-passed.json');
    const manifest = fixture('input-manifest.v1alpha1.json');
    const changedGenerator = structuredClone(record);
    changedGenerator.generator_ref = 'ao-pilot/completion-recorder@2.0.0#abcdef';
    expect(() => verifyCompletionRecordReplay(changedGenerator, {
      inputManifest: manifest,
      artifactBytes,
      replayOf: record,
    })).toThrow(/generator_ref mismatch/i);

    const changedInputs = structuredClone(manifest);
    changedInputs.inputs[0].content_sha256 = '9'.repeat(64);
    expect(() => verifyCompletionRecordReplay(record, {
      inputManifest: changedInputs,
      artifactBytes,
      replayOf: record,
    })).toThrow(/input manifest content digest mismatch/i);

    expect(() => verifyCompletionRecordReplay(record, {
      inputManifest: manifest,
      artifactBytes: Buffer.from('different bytes\n'),
      replayOf: record,
    })).toThrow(/artifact byte length mismatch|artifact content_sha256 mismatch/i);
  });
});
