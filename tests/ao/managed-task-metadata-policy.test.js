import { describe, expect, it } from '@jest/globals';

import {
  RESERVED_MANAGED_TASK_METADATA_REGISTRY_VERSION,
  lintManagedTaskMetadata,
  scanManagedTaskMetadata,
} from '../../scripts/ao/lib/managed-task-metadata-policy.js';

describe('reserved managed-task metadata policy', () => {
  const sourceArtifact = '.ao/state/project/state.json';

  it('reports actionable destinations for available and explicitly unsupported contracts', () => {
    const findings = lintManagedTaskMetadata({
      task: {
        task_id: 'issue-28',
        issue_number: 28,
        metadata: {
          workstream_id: 'data-governance',
          parent_task_id: 'issue-9',
          depends_on: ['issue-24'],
          completion_record: { status: 'passed' },
          path_claims: ['scripts/ao/**'],
          unrelated_note: 'preserved',
        },
      },
      sourceArtifact,
    });

    expect(findings.map((finding) => finding.offending_key)).toEqual([
      'completion_record', 'depends_on', 'parent_task_id', 'path_claims', 'workstream_id',
    ]);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task_id: 'issue-28',
        offending_key: 'parent_task_id',
        disposition: 'invalid',
        source: expect.objectContaining({
          artifact: sourceArtifact,
          selector: 'task_id=issue-28.metadata.parent_task_id',
        }),
        target: expect.objectContaining({
          contract: 'ao.task-relation.v1alpha1',
          migration_destination: 'state.task_relations (relation_kind=parent_of)',
          support: 'available',
        }),
      }),
      expect.objectContaining({
        offending_key: 'depends_on',
        disposition: 'invalid',
        target: expect.objectContaining({
          contract: 'ao.task-relation.v1alpha1',
          migration_destination: 'state.task_relations (relation_kind=depends_on)',
          support: 'available',
        }),
      }),
      expect.objectContaining({
        offending_key: 'workstream_id',
        disposition: 'unsupported',
        target: expect.objectContaining({ support: 'unsupported' }),
      }),
    ]));
  });

  it('keeps unrelated metadata compatible and produces a passing scan', () => {
    expect(scanManagedTaskMetadata({
      managedTasks: [{
        task_id: 'issue-29',
        issue_number: 29,
        metadata: { task_risk: 'low', note: 'compatible' },
      }],
      sourceArtifact,
    })).toMatchObject({
      status: 'pass', scanned_task_count: 1, finding_count: 0, findings: [],
    });
  });

  it('fails closed on missing evidence and unknown registry versions', () => {
    expect(() => scanManagedTaskMetadata({
      managedTasks: [{ metadata: {} }], sourceArtifact,
    })).toThrow('Missing managed-task identity evidence');
    expect(() => scanManagedTaskMetadata({
      managedTasks: [], sourceArtifact: '',
    })).toThrow('Missing managed-task metadata source artifact evidence');
    expect(() => scanManagedTaskMetadata({
      managedTasks: [],
      sourceArtifact,
      registryVersion: `${RESERVED_MANAGED_TASK_METADATA_REGISTRY_VERSION}.future`,
    })).toThrow('Unsupported reserved managed-task metadata registry version');
  });

  it('replays deterministically without mutating historical metadata', () => {
    const managedTasks = [{
      task_id: 'legacy-task',
      issue_number: null,
      metadata: { parent_task_id: 'legacy-parent', note: 'keep me' },
    }];
    const before = JSON.stringify(managedTasks);
    const first = scanManagedTaskMetadata({ managedTasks, sourceArtifact });
    const second = scanManagedTaskMetadata({ managedTasks, sourceArtifact });

    expect(second).toEqual(first);
    expect(JSON.stringify(managedTasks)).toBe(before);
    expect(first).toMatchObject({ status: 'blocked', finding_count: 1 });
  });
});
