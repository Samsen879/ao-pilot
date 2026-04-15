import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { runOverrideCommand } from '../../scripts/ao/lib/override-runner.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-override-runner-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function createIdGenerator(prefix) {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${index}`;
  };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao override runner', () => {
  it('creates, lists, and clears durable overrides', async () => {
    const repoRoot = createTempRepo();

    const created = await runOverrideCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'create',
      scopeKind: 'task',
      scopeId: 'issue-90',
      overrideKind: 'hold_autonomy',
      value: { enabled: true },
      createdBy: 'operator',
      now: '2026-03-29T07:20:00.000Z',
      overrideIdGenerator: createIdGenerator('override'),
    });

    expect(created.override).toMatchObject({
      override_id: 'override-1',
      scope_kind: 'task',
      scope_id: 'issue-90',
      override_kind: 'hold_autonomy',
      status: 'active',
      created_by: 'operator',
    });

    const listed = await runOverrideCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'list',
      status: 'active',
      scopeKind: 'task',
      scopeId: 'issue-90',
    });

    expect(listed.overrides).toEqual([
      expect.objectContaining({
        override_id: 'override-1',
        status: 'active',
      }),
    ]);

    const cleared = await runOverrideCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'clear',
      overrideId: 'override-1',
      reason: 'resume_assist_mode',
      now: '2026-03-29T07:21:00.000Z',
    });

    expect(cleared.override).toMatchObject({
      override_id: 'override-1',
      status: 'cleared',
      cleared_at: '2026-03-29T07:21:00.000Z',
      cleared_reason: 'resume_assist_mode',
    });

    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });

    expect(repository.getSnapshot().state.overrides).toEqual([
      expect.objectContaining({
        override_id: 'override-1',
        scope_kind: 'task',
        scope_id: 'issue-90',
        status: 'cleared',
        expires_at: null,
        created_by: 'operator',
      }),
    ]);
    expect(repository.listAuditEntries().filter((entry) => entry.entity_kind === 'override')).toEqual([
      expect.objectContaining({
        entity_id: 'override-1',
        operation: 'upsert',
      }),
      expect.objectContaining({
        entity_id: 'override-1',
        operation: 'created',
        actor: 'operator',
      }),
      expect.objectContaining({
        entity_id: 'override-1',
        operation: 'upsert',
      }),
      expect.objectContaining({
        entity_id: 'override-1',
        operation: 'cleared',
        actor: 'operator',
      }),
    ]);
  });

  it('preserves expiry attribution on created overrides', async () => {
    const repoRoot = createTempRepo();

    const created = await runOverrideCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'create',
      scopeKind: 'pr',
      scopeId: '109',
      overrideKind: 'block_action_kind',
      value: { action_kinds: ['notify_human_ready'] },
      expiresAt: '2026-03-29T08:00:00.000Z',
      createdBy: 'ao-operator',
      now: '2026-03-29T07:30:00.000Z',
      overrideIdGenerator: createIdGenerator('override'),
    });

    expect(created.override).toMatchObject({
      override_id: 'override-1',
      scope_kind: 'pr',
      scope_id: '109',
      override_kind: 'block_action_kind',
      expires_at: '2026-03-29T08:00:00.000Z',
      created_by: 'ao-operator',
    });
  });

  it('rejects clearing unknown overrides', async () => {
    await expect(runOverrideCommand({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      command: 'clear',
      overrideId: 'missing-override',
      reason: 'resume_assist_mode',
      now: '2026-03-29T07:21:00.000Z',
    })).rejects.toThrow(/override not found/i);
  });
});
