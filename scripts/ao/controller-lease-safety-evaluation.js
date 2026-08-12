import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createControllerLeaseAuthority,
  digestControllerLeaseAuthorityEvidence,
} from './lib/controller-lease-authority.js';
import { createControllerLease } from './lib/state-contracts.js';
import { bootstrapControlPlaneState, resolveControlPlanePaths } from './lib/state-migrations.js';
import { createStateRepository } from './lib/state-repository.js';
import { writeJsonFileAtomic } from './lib/state-storage.js';

export const CONTROLLER_LEASE_SAFETY_FIXTURE_SCHEMA_VERSION = 'ao.controller-lease-safety-fixtures.v1';
export const CONTROLLER_LEASE_SAFETY_RECEIPT_SCHEMA_VERSION = 'ao.controller-lease-safety-replay-receipt.v1';
export const CONTROLLER_LEASE_RECOVERY_EVIDENCE_SCHEMA_VERSION = 'ao.controller-lease-recovery-evidence.v1';

const PROJECT_ID = 'controller-lease-safety';
const INCIDENT_ID = 'lease-authority-loss-2026-08-09';
const FIXED_NOW = '2026-08-09T12:00:00.000Z';

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

export function digestControllerLeaseSafetyEvidence(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableJson(value))).digest('hex');
}

function lease(kind) {
  const definitions = {
    latest: {
      lease_id: 'latest-lease', holder_id: 'latest-holder', incarnation_id: 'latest-incarnation',
      acquired_at: '2026-08-09T10:00:00.000Z', heartbeat_at: '2026-08-09T10:02:00.000Z',
      expires_at: '2026-08-09T10:07:00.000Z', status: 'active',
    },
    stale: {
      lease_id: 'stale-lease', holder_id: 'stale-holder', incarnation_id: 'stale-incarnation',
      acquired_at: '2026-08-09T09:00:00.000Z', heartbeat_at: '2026-08-09T09:01:00.000Z',
      expires_at: '2026-08-09T09:06:00.000Z', status: 'active',
    },
    legacy: {
      lease_id: 'expired-legacy-lease', holder_id: 'legacy-holder', incarnation_id: null,
      acquired_at: '2026-08-09T08:00:00.000Z', heartbeat_at: null,
      expires_at: '2026-08-09T08:05:00.000Z', status: 'expired',
    },
    heartbeat: {
      lease_id: 'heartbeat-lease', holder_id: 'heartbeat-holder', incarnation_id: 'heartbeat-incarnation',
      acquired_at: '2026-08-09T10:00:00.000Z', heartbeat_at: '2026-08-09T10:01:00.000Z',
      expires_at: '2026-08-09T10:06:00.000Z', status: 'active',
    },
    recovered: {
      lease_id: 'recovered-expired-lease', holder_id: 'recovered-holder', incarnation_id: 'recovered-incarnation',
      acquired_at: '2026-08-09T08:00:00.000Z', heartbeat_at: '2026-08-09T08:01:00.000Z',
      expires_at: '2026-08-09T08:06:00.000Z', status: 'expired',
    },
  };
  const value = definitions[kind];
  return createControllerLease({
    ...value,
    controller_id: 'default',
    holder_type: 'session',
    lease_timeout_ms: value.incarnation_id == null ? null : 300000,
    runtime_kind: value.incarnation_id == null ? null : 'continuous',
  });
}

function recoveryEvidence(kind) {
  const authority = createControllerLeaseAuthority([lease('recovered')]);
  const quiescenceEvidence = {
    schema_version: 'ao.controller-lease-quiescence-evidence.v1',
    observer_id: 'operator-18',
    observed_at: '2026-08-09T10:55:00.000Z',
    running_controller_ids: [],
  };
  const evidence = {
    schema_version: CONTROLLER_LEASE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    project_id: PROJECT_ID,
    incident_id: INCIDENT_ID,
    operator: { id: 'operator-18', role: 'repository_owner' },
    operator_intent: 'restore_verified_canonical_backup',
    reason: 'Canonical authority was lost; restore the separately verified backup while controllers remain stopped.',
    approved_at: '2026-08-09T11:00:00.000Z',
    source_evidence: {
      kind: 'offline_verified_backup',
      digest: digestControllerLeaseAuthorityEvidence(authority),
      active_controller_count: 0,
      quiescence_evidence: {
        ...quiescenceEvidence,
        integrity_digest: digestControllerLeaseAuthorityEvidence(quiescenceEvidence),
      },
    },
    resulting_authority: {
      digest: digestControllerLeaseAuthorityEvidence(authority),
      records: authority.records,
      active_controller_count: 0,
      observed_at: '2026-08-09T11:05:00.000Z',
    },
  };
  if (kind === 'missing-intent') delete evidence.operator_intent;
  if (kind === 'result-digest-mismatch') evidence.resulting_authority.digest = 'sha256:'.concat('0'.repeat(64));
  if (kind === 'non-text-operator') evidence.operator = { id: 7, role: true };
  if (kind === 'target-mismatch') evidence.project_id = 'different-project';
  if (kind === 'missing-quiescence') delete evidence.source_evidence.quiescence_evidence;
  if (kind === 'forged-quiescence') {
    evidence.source_evidence.quiescence_evidence.integrity_digest = `sha256:${'0'.repeat(64)}`;
  }
  if (kind === 'invalid-order') evidence.resulting_authority.observed_at = '2026-08-09T10:50:00.000Z';
  return evidence;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) && new Date(timestampMs).toISOString() === value;
}

function isNonEmptyText(value) {
  return typeof value === 'string' && value.trim() === value && value !== '';
}

export function snapshotControllerLeasePersistentArtifacts(stateRoot) {
  const artifacts = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const artifactPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(artifactPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.lock') || /\.tmp-\d+-\d+$/.test(entry.name)) continue;
        artifacts.push({
          path: path.relative(stateRoot, artifactPath).split(path.sep).join('/'),
          sha256: crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex'),
        });
      } else {
        throw new Error(`Unsupported persistent controller lease artifact: ${entry.name}`);
      }
    }
  }
  visit(stateRoot);
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

export function classifyControllerLeaseSafetyError(error) {
  const message = String(error?.message ?? '');
  if (error instanceof SyntaxError) return 'canonical_authority_invalid_json';
  if (message.includes('Missing canonical controller lease authority')) return 'canonical_authority_missing';
  if (message.includes('Incomplete control-plane state evidence')) return 'control_plane_evidence_incomplete';
  if (message.includes('expected a versioned JSON object')) return 'canonical_authority_unversioned';
  if (message.includes('explicit operator intent')) return 'recovery_operator_intent_missing';
  if (message.includes('textual operator identity')) return 'recovery_operator_identity_invalid';
  if (message.includes('expected project and incident')) return 'recovery_target_mismatch';
  if (message.includes('quiescence evidence')) return 'recovery_quiescence_evidence_invalid';
  if (message.includes('timestamps are invalid or out of order')) return 'recovery_timestamp_order_invalid';
  if (message.includes('resulting authority digest mismatch')) return 'recovery_result_digest_mismatch';
  return 'unexpected_error';
}

export function verifyControllerLeaseRecoveryEvidence(evidence, { projectId, incidentId } = {}) {
  if (!evidence || evidence.schema_version !== CONTROLLER_LEASE_RECOVERY_EVIDENCE_SCHEMA_VERSION) {
    throw new Error('Unsupported controller lease recovery evidence');
  }
  if (!isNonEmptyText(evidence.operator?.id) || !isNonEmptyText(evidence.operator?.role)) {
    throw new Error('Controller lease recovery requires textual operator identity fields');
  }
  if (!evidence.operator_intent) {
    throw new Error('Controller lease recovery requires explicit operator intent and identity');
  }
  if (evidence.operator_intent !== 'restore_verified_canonical_backup') {
    throw new Error('Unsupported controller lease recovery intent');
  }
  if (
    !isNonEmptyText(projectId)
    || !isNonEmptyText(incidentId)
    || !isNonEmptyText(evidence.project_id)
    || !isNonEmptyText(evidence.incident_id)
    || evidence.project_id !== projectId
    || evidence.incident_id !== incidentId
  ) {
    throw new Error('Controller lease recovery evidence does not match the expected project and incident');
  }
  if (!evidence.reason || evidence.source_evidence?.kind !== 'offline_verified_backup') {
    throw new Error('Controller lease recovery source evidence is incomplete');
  }
  const quiescence = evidence.source_evidence.quiescence_evidence;
  const { integrity_digest: quiescenceDigest, ...quiescenceBody } = quiescence ?? {};
  if (
    quiescence?.schema_version !== 'ao.controller-lease-quiescence-evidence.v1'
    || quiescence.observer_id !== evidence.operator.id
    || !isCanonicalTimestamp(quiescence.observed_at)
    || !Array.isArray(quiescence.running_controller_ids)
    || quiescence.running_controller_ids.length !== 0
    || quiescenceDigest !== digestControllerLeaseAuthorityEvidence(quiescenceBody)
  ) {
    throw new Error('Controller lease recovery requires valid integrity-bound controller quiescence evidence');
  }
  if (
    !isCanonicalTimestamp(evidence.approved_at)
    || !isCanonicalTimestamp(evidence.resulting_authority?.observed_at)
    || Date.parse(quiescence.observed_at) > Date.parse(evidence.approved_at)
    || Date.parse(evidence.approved_at) > Date.parse(evidence.resulting_authority.observed_at)
  ) {
    throw new Error('Controller lease recovery evidence timestamps are invalid or out of order');
  }
  if (evidence.source_evidence.active_controller_count !== 0 || evidence.resulting_authority?.active_controller_count !== 0) {
    throw new Error('Controller lease recovery requires quiesced controller evidence');
  }
  const authority = createControllerLeaseAuthority(evidence.resulting_authority?.records);
  const activeControllerCount = authority.records.filter((record) => record.status === 'active').length;
  if (evidence.resulting_authority?.active_controller_count !== activeControllerCount || activeControllerCount !== 0) {
    throw new Error('Controller lease recovery resulting authority must contain no active leases');
  }
  const resultingDigest = digestControllerLeaseAuthorityEvidence(authority);
  if (evidence.resulting_authority?.digest !== resultingDigest) {
    throw new Error('Controller lease recovery resulting authority digest mismatch');
  }
  if (evidence.source_evidence.digest !== resultingDigest) {
    throw new Error('Controller lease recovery source and resulting authority digests differ');
  }
  return {
    evidence_digest: digestControllerLeaseAuthorityEvidence(evidence),
    operator_id: evidence.operator.id,
    operator_intent: evidence.operator_intent,
    resulting_authority_digest: resultingDigest,
    lease_ids: authority.records.map((record) => record.lease_id),
  };
}

function materialize(entry, tempRoots) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-controller-lease-safety-'));
  tempRoots.push(repoRoot);
  bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW });
  const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
  const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  if (entry.setup.shadow === 'stale') state.controller_leases = [lease('stale')];
  else delete state.controller_leases;
  writeJsonFileAtomic(paths.statePath, state);

  if (entry.setup.schema_version === 10) {
    delete state.task_relations;
    writeJsonFileAtomic(paths.statePath, state);
    const schema = JSON.parse(fs.readFileSync(paths.schemaPath, 'utf8'));
    schema.current_version = 10;
    schema.applied_migrations = schema.applied_migrations.filter((migration) => migration.version <= 10);
    writeJsonFileAtomic(paths.schemaPath, schema);
    const auditEntries = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line))
      .filter((entryValue) => Number(entryValue?.details?.migration_version) <= 10);
    fs.writeFileSync(paths.auditPath, `${auditEntries.map((entryValue) => JSON.stringify(entryValue)).join('\n')}\n`, 'utf8');
    fs.rmSync(paths.controllerLeaseMigrationReceiptPath, { force: true });
    fs.rmSync(paths.controllerLeaseMigrationAuditCheckpointPath, { force: true });
  }
  if (entry.setup.canonical === 'latest') {
    writeJsonFileAtomic(paths.controllerLeasesPath, createControllerLeaseAuthority([lease('latest')]));
  } else if (entry.setup.canonical === 'heartbeat-initial') {
    writeJsonFileAtomic(paths.controllerLeasesPath, createControllerLeaseAuthority([lease('heartbeat')]));
  } else if (entry.setup.canonical === 'legacy-array') {
    writeJsonFileAtomic(paths.controllerLeasesPath, [lease('legacy')]);
  } else if (entry.setup.canonical === 'invalid-json') {
    fs.writeFileSync(paths.controllerLeasesPath, '{ invalid json\n', 'utf8');
  } else if (entry.setup.canonical === 'missing') {
    fs.rmSync(paths.controllerLeasesPath, { force: true });
  }
  if (entry.setup.schema === 'missing') fs.rmSync(paths.schemaPath, { force: true });
  if (entry.setup.state === 'missing') fs.rmSync(paths.statePath, { force: true });
  return { paths, repoRoot };
}

function acceptedSnapshot(entry, paths, repository) {
  const beforeArtifacts = snapshotControllerLeasePersistentArtifacts(paths.stateRoot);
  let snapshot = repository.getSnapshot();
  if (entry.operation === 'restart-cold-read') {
    snapshot = createStateRepository({ repoRoot: paths.repoRoot, projectId: PROJECT_ID, clock: FIXED_NOW }).getSnapshot();
  }
  const migrationReceipt = fs.existsSync(paths.controllerLeaseMigrationReceiptPath)
    ? JSON.parse(fs.readFileSync(paths.controllerLeaseMigrationReceiptPath, 'utf8'))
    : null;
  const result = {
    disposition: 'accepted',
    bootstrapped: snapshot.bootstrapped,
    schema_version: snapshot.bootstrapped
      ? migrationReceipt?.destination_schema_version ?? snapshot.schema.current_version
      : snapshot.schema.current_version,
    lease_ids: snapshot.state.controller_leases.map((record) => record.lease_id),
    authority_digest: digestControllerLeaseAuthorityEvidence(
      createControllerLeaseAuthority(snapshot.state.controller_leases),
    ),
  };
  if (entry.operation === 'restart-cold-read') {
    result.persistent_bytes_unchanged = digestControllerLeaseSafetyEvidence(
      snapshotControllerLeasePersistentArtifacts(paths.stateRoot),
    ) === digestControllerLeaseSafetyEvidence(beforeArtifacts);
  }
  if (entry.expected.migration_receipt) {
    const beforeReceipt = fs.readFileSync(paths.controllerLeaseMigrationReceiptPath);
    const beforeAuthority = fs.readFileSync(paths.controllerLeasesPath);
    result.migration_receipt_digest = digestControllerLeaseSafetyEvidence(
      JSON.parse(beforeReceipt.toString('utf8')),
    );
    createStateRepository({ repoRoot: paths.repoRoot, projectId: PROJECT_ID, clock: FIXED_NOW }).getSnapshot();
    result.migration_replay_stable = fs.readFileSync(paths.controllerLeaseMigrationReceiptPath).equals(beforeReceipt)
      && fs.readFileSync(paths.controllerLeasesPath).equals(beforeAuthority);
  }
  return result;
}

async function runConcurrentHeartbeat(paths, repoRoot) {
  const repositoryA = createStateRepository({ repoRoot, projectId: PROJECT_ID, clock: FIXED_NOW });
  const repositoryB = createStateRepository({ repoRoot, projectId: PROJECT_ID, clock: FIXED_NOW });
  let releaseFirst;
  const firstPaused = new Promise((resolve) => { releaseFirst = resolve; });
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  const renew = (repository, heartbeatAt, wait = null) => repository.mutateControllerLeasesAtomically({
    entityId: 'heartbeat-lease',
    summary: `Heartbeat ${heartbeatAt}`,
    mutate: async ({ findControllerLeaseById, upsertControllerLease }) => {
      const current = findControllerLeaseById('heartbeat-lease');
      const next = upsertControllerLease({
        ...current,
        heartbeat_at: heartbeatAt,
        expires_at: new Date(new Date(heartbeatAt).getTime() + 300000).toISOString(),
      });
      if (wait) {
        enteredFirst();
        await wait;
      }
      return { value: next, entityId: next.lease_id, summary: `Accepted heartbeat ${heartbeatAt}`, details: next };
    },
  });
  const first = renew(repositoryA, '2026-08-09T10:02:00.000Z', firstPaused);
  await firstEntered;
  const second = renew(repositoryB, '2026-08-09T10:03:00.000Z');
  releaseFirst();
  await Promise.all([first, second]);
  const snapshot = createStateRepository({ repoRoot, projectId: PROJECT_ID, clock: FIXED_NOW }).getSnapshot();
  const record = snapshot.state.controller_leases[0];
  return {
    disposition: 'accepted',
    lease_ids: [record.lease_id],
    heartbeat_at: record.heartbeat_at,
    authority_digest: digestControllerLeaseAuthorityEvidence(
      JSON.parse(fs.readFileSync(paths.controllerLeasesPath, 'utf8')),
    ),
  };
}

async function executeCase(entry, tempRoots) {
  if (entry.operation === 'verify-recovery-evidence') {
    try {
      return {
        disposition: 'accepted',
        ...verifyControllerLeaseRecoveryEvidence(recoveryEvidence(entry.setup.recovery_evidence), {
          projectId: PROJECT_ID,
          incidentId: INCIDENT_ID,
        }),
      };
    } catch (error) {
      return { disposition: 'rejected', error_code: classifyControllerLeaseSafetyError(error) };
    }
  }
  const { paths, repoRoot } = materialize(entry, tempRoots);
  try {
    if (entry.operation === 'concurrent-heartbeat') return await runConcurrentHeartbeat(paths, repoRoot);
    if (entry.operation === 'persistent-artifact-mutation') {
      const before = snapshotControllerLeasePersistentArtifacts(paths.stateRoot);
      fs.appendFileSync(paths.auditPath, '{"fixture":"persistent-mutation"}\n');
      const after = snapshotControllerLeasePersistentArtifacts(paths.stateRoot);
      return {
        disposition: 'accepted',
        artifact_path: 'audit-log.jsonl',
        mutation_detected: digestControllerLeaseSafetyEvidence(before) !== digestControllerLeaseSafetyEvidence(after),
      };
    }
    return acceptedSnapshot(entry, { ...paths, repoRoot }, createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: FIXED_NOW,
    }));
  } catch (error) {
    return { disposition: 'rejected', error_code: classifyControllerLeaseSafetyError(error) };
  }
}

function assertExpected(entry, result) {
  for (const [key, expected] of Object.entries(entry.expected)) {
    if (key === 'migration_receipt') {
      if (expected && !result.migration_receipt_digest) throw new Error(`${entry.id}: missing migration receipt`);
    } else if (JSON.stringify(result[key]) !== JSON.stringify(expected)) {
      throw new Error(`${entry.id}: expected ${key}=${JSON.stringify(expected)}, received ${JSON.stringify(result)}`);
    }
  }
}

export function loadControllerLeaseSafetyFixturePack(fixturePath) {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

export async function replayControllerLeaseSafetyFixturePack(pack, { replayCount = pack?.required_replays } = {}) {
  if (pack?.schema_version !== CONTROLLER_LEASE_SAFETY_FIXTURE_SCHEMA_VERSION || !Array.isArray(pack.cases)) {
    throw new Error('Unsupported controller lease safety fixture pack');
  }
  if (!Number.isInteger(replayCount) || replayCount < 2) throw new Error('Controller lease safety requires at least two replays');
  const fixtureIds = pack.cases.map((entry) => entry.id);
  if (new Set(fixtureIds).size !== fixtureIds.length) throw new Error('Controller lease safety fixture ids must be unique');
  const runs = [];
  const tempRoots = [];
  try {
    for (let replay = 1; replay <= replayCount; replay += 1) {
      const cases = [];
      for (const entry of pack.cases) {
        const result = await executeCase(entry, tempRoots);
        assertExpected(entry, result);
        cases.push({ id: entry.id, class: entry.class, result });
      }
      runs.push({ replay, cases, digest: digestControllerLeaseSafetyEvidence(cases) });
    }
  } finally {
    for (const tempRoot of tempRoots) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  const stableDigest = runs[0].digest;
  if (runs.some((run) => run.digest !== stableDigest)) throw new Error('Controller lease safety replay digest drifted');
  const receipt = {
    schema_version: CONTROLLER_LEASE_SAFETY_RECEIPT_SCHEMA_VERSION,
    fixture_pack_digest: digestControllerLeaseSafetyEvidence(pack),
    fixture_count: pack.cases.length,
    replay_count: replayCount,
    case_execution_count: pack.cases.length * replayCount,
    stable_run_digest: stableDigest,
    run_digests: runs.map((run) => run.digest),
    class_counts: Object.fromEntries([...new Set(pack.cases.map((entry) => entry.class))].sort().map((name) => [
      name, pack.cases.filter((entry) => entry.class === name).length,
    ])),
    status: 'passed',
  };
  return { receipt: { ...receipt, receipt_digest: digestControllerLeaseSafetyEvidence(receipt) }, runs };
}
