import fs from 'node:fs';
import path from 'node:path';

export const INCIDENT_SCHEMA_VERSION = 'ao.runtime-portability-incident.v1';
export const MIGRATION_SCHEMA_VERSION = 'ao-pilot.issue-migration-receipt.v1';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readText(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

export function validateIncidentInventory(inventory) {
  assert(inventory?.schema_version === INCIDENT_SCHEMA_VERSION, 'incident schema mismatch');
  assert(inventory?.severity === 'P0_RELEASE_BLOCKER', 'incident must remain a P0 release blocker');
  assert(
    inventory?.current_claim
      === 'ao-pilot has package-level portability and does not yet have operational runtime portability.',
    'current portability claim drifted',
  );
  assert(inventory?.admission?.p0_parent_issue === 55, 'P0 parent mismatch');
  assert(inventory?.admission?.admitted_issue === 56, 'only P0-R01 may be admitted');
  assert(
    JSON.stringify(inventory?.admission?.blocked_successors) === JSON.stringify([
      57, 58, 59, 60, 61, 62, 63, 12,
    ]),
    'blocked successor set drifted',
  );
  assert(
    inventory?.admission?.p0_r08_runtime_ref === 'runtime.bootstrap_recovery.unresolved_fail_closed_v1',
    'P0-R08 must retain a fail-closed unresolved runtime ref until selection',
  );

  const frozen = inventory?.frozen_observation;
  const live = inventory?.live_observation;
  assert(SHA40.test(frozen?.ao_pilot_main_sha ?? ''), 'frozen main SHA invalid');
  assert(SHA40.test(frozen?.ao_pilot_tree_sha ?? ''), 'frozen tree SHA invalid');
  assert(live?.ao_pilot?.main_sha === frozen.ao_pilot_main_sha, 'live/frozen main mismatch');
  assert(live?.ao_pilot?.main_tree_sha === frozen.ao_pilot_tree_sha, 'live/frozen tree mismatch');
  assert(frozen?.estimated_local_runtime_unique_commits === 11, 'frozen estimate must be preserved');

  const local = live?.old_local_runtime;
  assert(local?.audit_mode === 'read_only', 'old runtime audit must be read-only');
  assert(local?.unique_commit_count === 12, 'live unique commit count must be 12');
  assert(local?.unique_commits?.length === local.unique_commit_count, 'unique commit ledger incomplete');
  assert(new Set(local.unique_commits.map((entry) => entry.commit)).size === 12, 'duplicate local commit');
  for (const [index, entry] of local.unique_commits.entries()) {
    assert(entry.ordinal === index + 1, `local commit ordinal mismatch at ${index + 1}`);
    assert(SHA40.test(entry.commit ?? ''), `invalid local commit SHA at ${index + 1}`);
    assert(entry.parity_disposition === 'pending_p0_r02', `premature parity verdict at ${index + 1}`);
  }

  const official = live?.official_runtime;
  assert(official?.canonical_repository === 'https://github.com/Untrivial-ai/agent-orchestrator', 'canonical upstream drifted');
  assert(SHA40.test(official?.main_sha ?? ''), 'official main SHA invalid');
  assert(official?.latest_stable_release?.tag === 'v0.11.2', 'stable release observation drifted');
  assert(SHA40.test(official?.latest_stable_release?.commit ?? ''), 'stable commit invalid');
  assert(official?.npm_wrapper?.name === '@aoagents/ao', 'official npm wrapper name mismatch');
  assert(official?.npm_wrapper?.version === '0.10.3', 'official npm wrapper version mismatch');
  assert(official?.npm_wrapper?.integrity?.startsWith('sha512-'), 'npm wrapper integrity missing');
  assert(official?.npm_linux_x64?.integrity?.startsWith('sha512-'), 'Linux package integrity missing');
  assert(official?.selection_status === 'NOT_ESTABLISHED', 'P0-R01 must not select the runtime');
  assert(official?.selection_owner_issue === 58, 'runtime selection must remain owned by P0-R03');

  const claims = new Map(inventory.release_claim_ledger.map((entry) => [entry.claim, entry.disposition]));
  assert(claims.get('verify:package proves runtime portability') === 'WITHDRAWN', 'verify:package claim not withdrawn');
  assert(
    claims.get('ao-pilot is operationally migratable or can admit issue #12') === 'WITHDRAWN_UNTIL_P0_R08',
    'operational portability claim not blocked',
  );
  assert(inventory.fail_closed_boundaries.length >= 6, 'fail-closed boundary ledger incomplete');

  return {
    schema_version: inventory.schema_version,
    severity: inventory.severity,
    unique_local_commits: local.unique_commit_count,
    runtime_selection: official.selection_status,
    admitted_issue: inventory.admission.admitted_issue,
  };
}

export function validateIssueMigrationReceipt(receipt) {
  assert(receipt?.schema_version === MIGRATION_SCHEMA_VERSION, 'migration receipt schema mismatch');
  assert(receipt?.validation?.result === 'PASS', 'migration receipt is not PASS');
  assert(receipt?.validation?.targeted_updates === 45, 'migration target count mismatch');
  assert(receipt?.validation?.live_exact_matches === 45, 'migration live match count mismatch');
  assert(receipt?.p0_parent === 55, 'migration parent mismatch');
  assert(
    JSON.stringify(receipt.p0_children.map((entry) => entry.issue_number))
      === JSON.stringify([56, 57, 58, 59, 60, 61, 62, 63]),
    'P0 child sequence mismatch',
  );
  assert(receipt?.issues?.length === 45, 'migration issue ledger length mismatch');
  assert(new Set(receipt.issues.map((entry) => entry.issue_number)).size === 45, 'duplicate migrated issue');

  for (const entry of receipt.issues) {
    assert(SHA64.test(entry.old_body_sha256 ?? ''), `invalid old body digest for #${entry.issue_number}`);
    assert(SHA64.test(entry.body_sha256 ?? ''), `invalid live body digest for #${entry.issue_number}`);
    assert(entry.update_result === 'verified_live', `unverified migration result for #${entry.issue_number}`);
  }
  for (let issueNumber = 12; issueNumber <= 54; issueNumber += 1) {
    const entry = receipt.issues.find((candidate) => candidate.issue_number === issueNumber);
    assert(entry, `missing migration entry for #${issueNumber}`);
    assert(entry.new_position === `${issueNumber - 3}/51`, `new position mismatch for #${issueNumber}`);
    if (issueNumber === 12) {
      assert(entry.old_position === '1/43', '#12 old position mismatch');
      assert(entry.new_predecessor === '#63 — P0-R08 terminal closeout', '#12 predecessor mismatch');
    } else {
      assert(entry.new_predecessor === `#${issueNumber - 1}`, `predecessor changed for #${issueNumber}`);
    }
  }
  return {
    schema_version: receipt.schema_version,
    updated_issues: receipt.issues.length,
    intake_issues_checked: receipt.validation.intake_issues_checked,
    result: receipt.validation.result,
  };
}

export function verifyRuntimePortabilityInventory(root = process.cwd()) {
  const incident = readJson(root, 'docs/runtime-portability/p0-r01-incident-inventory.json');
  const migration = readJson(root, 'docs/runtime-portability/p0-r01-issue-migration-receipt.json');
  const incidentResult = validateIncidentInventory(incident);
  const migrationResult = validateIssueMigrationReceipt(migration);

  const requiredText = new Map([
    ['README.md', ['P0 Runtime Portability Incident', 'package-level portability']],
    ['docs/AO_ARCHITECTURE.md', ['P0 Operational Portability Boundary', 'public immutable Agent Orchestrator runtime']],
    ['docs/AO_DEVELOPMENT.md', ['package-level portability only']],
    ['docs/AO_RELEASE.md', ['P0 Release Blocker', 'Package-only Second-machine Verification']],
    ['docs/AO_CONFIGURATION.md', ['logical control-plane selection']],
    ['docs/AO_MIGRATION_HISTORY.md', ['P0 runtime portability correction']],
    ['docs/AO_SYSTEM_ARCHITECTURE_AND_UPGRADE_GUIDE.md', ['2026-08-02 P0 superseding notice']],
    ['docs/consolidation/cie-embedded-ao/FINAL_CONSOLIDATION_REPORT.md', ['07-runtime-portability-erratum.md']],
    ['docs/consolidation/cie-embedded-ao/07-runtime-portability-erratum.md', ['package installation and public API verification remain accepted']],
  ]);
  for (const [relativePath, fragments] of requiredText) {
    const text = readText(root, relativePath);
    for (const fragment of fragments) {
      assert(text.includes(fragment), `${relativePath} is missing required incident text: ${fragment}`);
    }
  }

  const packageJson = readJson(root, 'package.json');
  assert(Object.keys(packageJson.bin).length === 1, 'P0-R01 must preserve the package binary surface');
  assert(packageJson.bin['ao-pilot'] === './bin/ao-pilot.js', 'ao-pilot binary changed unexpectedly');
  assert(packageJson.scripts['verify:runtime-inventory'] === 'node scripts/verify-runtime-portability-inventory.js', 'inventory gate missing');
  assert(!packageJson.scripts['verify:runtime-lock'], 'P0-R01 must not pre-implement P0-R04');
  assert(!packageJson.scripts['verify:runtime-bootstrap'], 'P0-R01 must not pre-implement P0-R05');
  assert(!packageJson.scripts['verify:fresh-clone'], 'P0-R01 must not pre-implement P0-R07');
  assert(!packageJson.scripts['verify:self-hosting'], 'P0-R01 must not pre-implement P0-R08');

  return {
    status: 'pass',
    incident: incidentResult,
    issue_migration: migrationResult,
    documentation_files: requiredText.size,
    scope_guard: 'inventory_only',
  };
}
