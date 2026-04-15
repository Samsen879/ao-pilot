import { randomUUID } from 'node:crypto';

import { createOverrideRecord } from './state-contracts.js';
import { createStateRepository } from './state-repository.js';

export const DEFAULT_PROJECT_ID = 'my-project';

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function isExpiredOverride(override, timestamp) {
  if (override?.status !== 'active' || !override?.expires_at) return false;
  const expiresAt = new Date(override.expires_at);
  const now = new Date(timestamp);
  if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(now.getTime())) return false;
  return expiresAt.getTime() <= now.getTime();
}

function matchesOverrideFilters(override, {
  status = null,
  scopeKind = null,
  scopeId = null,
  overrideKind = null,
  now,
} = {}) {
  if (status === 'active') {
    if (override.status !== 'active') return false;
    if (isExpiredOverride(override, now)) return false;
  } else if (status != null && override.status !== status) {
    return false;
  }

  if (scopeKind != null && override.scope_kind !== scopeKind) return false;
  if (scopeId != null && override.scope_id !== scopeId) return false;
  if (overrideKind != null && override.override_kind !== overrideKind) return false;
  return true;
}

export async function runOverrideCommand({
  repoRoot,
  cwd = repoRoot,
  projectId = DEFAULT_PROJECT_ID,
  command,
  overrideId = null,
  scopeKind = null,
  scopeId = null,
  overrideKind = null,
  value = {},
  status = null,
  expiresAt = null,
  createdBy = 'operator',
  reason = null,
  now = new Date().toISOString(),
  overrideIdGenerator = randomUUID,
} = {}) {
  const timestamp = resolveNow(now);
  const repository = createStateRepository({
    repoRoot,
    projectId,
  });

  switch (command) {
    case 'create': {
      const override = createOverrideRecord({
        override_id: overrideId ?? overrideIdGenerator(),
        scope_kind: scopeKind,
        scope_id: scopeId,
        override_kind: overrideKind,
        value,
        status: 'active',
        created_at: timestamp,
        expires_at: expiresAt,
        cleared_at: null,
        cleared_reason: null,
        created_by: createdBy,
      });
      repository.upsertOverride(override);
      repository.appendAuditEntry({
        entityKind: 'override',
        entityId: override.override_id,
        operation: 'created',
        actor: createdBy ?? 'operator',
        summary: `Created override ${override.override_id}.`,
        details: override,
        recordedAt: timestamp,
      });
      return {
        project_id: projectId,
        cwd,
        command,
        override,
        overrides: [override],
      };
    }
    case 'list': {
      const overrides = repository.getSnapshot().state.overrides.filter((override) => matchesOverrideFilters(override, {
        status,
        scopeKind,
        scopeId,
        overrideKind,
        now: timestamp,
      }));
      return {
        project_id: projectId,
        cwd,
        command,
        override: null,
        overrides,
      };
    }
    case 'clear': {
      const existingOverride = repository.getSnapshot().state.overrides.find((override) => override.override_id === overrideId) ?? null;
      if (!existingOverride) {
        throw new Error(`Override not found: ${overrideId}`);
      }

      const override = existingOverride.status === 'active'
        ? createOverrideRecord({
            ...existingOverride,
            status: 'cleared',
            cleared_at: timestamp,
            cleared_reason: reason ?? 'operator_cleared',
          })
        : existingOverride;

      if (override !== existingOverride) {
        repository.upsertOverride(override);
        repository.appendAuditEntry({
          entityKind: 'override',
          entityId: override.override_id,
          operation: 'cleared',
          actor: createdBy ?? 'operator',
          summary: `Cleared override ${override.override_id}.`,
          details: override,
          recordedAt: timestamp,
        });
      }

      return {
        project_id: projectId,
        cwd,
        command,
        override,
        overrides: [override],
      };
    }
    default:
      throw new Error(`Unsupported override command: ${command}`);
  }
}
