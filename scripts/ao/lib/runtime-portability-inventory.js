import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const INCIDENT_SCHEMA_VERSION = 'ao.runtime-portability-incident.v1';
export const MIGRATION_SCHEMA_VERSION = 'ao-pilot.issue-migration-receipt.v1';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const EXPECTED_AO_PILOT_MAIN_SHA = 'e51bef40ccd124939b2781b14af3297e856c6f17';
const EXPECTED_AO_PILOT_TREE_SHA = '67aa09d8b11a6532876353f500df7fb529e4d9b5';
const EXPECTED_MIGRATION_BODY_LEDGER_SHA256 =
  '37bebf141ece71ced8f02d029e5242e00fc828882e7b5cd3a07a4cbe7fc4d0e4';

const EXPECTED_OFFICIAL_RUNTIME = Object.freeze({
  canonical_repository: 'https://github.com/Untrivial-ai/agent-orchestrator',
  main_sha: '4a907abda23db81865e594f2e00b3c0cef4cc3ee',
  main_tree_sha: '8b9f57b938a7f0e9f5ef29a7663e748f8c1ec47a',
  stable_tag: 'v0.11.2',
  stable_commit: 'c5523a6d0e51251b79555b95ddc7d2be59da0f50',
  stable_tree: '6784a292cb54c4a2031ede6cfeaee9a4bb1cd104',
  wrapper_name: '@aoagents/ao',
  wrapper_version: '0.10.3',
  wrapper_bin: Object.freeze({ ao: 'bin/ao.js' }),
  wrapper_integrity:
    'sha512-La3w8jv2AJV0GoekWzTEav7ZaQnw1xhnZmfwooXwLVGGuX1BV6vCT56P7xzUrfRPFJ+BuGMRuSqyftMVo6JzyQ==',
  wrapper_shasum: 'aded3adbbb5e6a18cbf19865c17a287b45e5e549',
  linux_name: '@aoagents/ao-linux-x64',
  linux_version: '0.10.3',
  linux_integrity:
    'sha512-B74xSc073V9hjIoZs860m7hbm/7rgjjuV7mkEdeVU8WaJKylBhkHit90qclaC6ol8UJw/AA1j5syLLF9RND+9A==',
  linux_shasum: '929632edfb263e42f8cfc65bd9fd533c358d7176',
});

const EXPECTED_LOCAL_RUNTIME_COMMITS = Object.freeze([
  '44d333b5000b75b5b5b89df5df6818a3fbe7f7ce',
  '718da41daa762d41c6f142cd86d3b11baf761d45',
  'd9c64fa38e55fb32280d0dcad880e646ff7f2534',
  '26e1904163f17a7de905a8a956903ebef9563c4a',
  'd7eb1aeebfdce3f40bef90ee4c1dd64a40e5fede',
  '9957b8319423a5b5f6a50550c5440bcc5d40f068',
  'a862a5d0c07ccaea5b376cd68af551b33a5a77e3',
  '5ed0947826a66932a607d8a883a7b74ad4909393',
  'e5a6ff03445dbf86bdff52dc42b02476f174bc35',
  '859da6db0299a61feace4930bb1f4e221edf5f5a',
  '1f3f32e0db9a9429380760a579858eb4ac867066',
  '00bea6e589b4696ea7c897ea45dd15e2de78b4e7',
]);

const EXPECTED_MIGRATED_ISSUES = Object.freeze([
  7,
  8,
  ...Array.from({ length: 43 }, (_, index) => index + 12),
]);

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
  assert(frozen.ao_pilot_main_sha === EXPECTED_AO_PILOT_MAIN_SHA, 'frozen main SHA drifted');
  assert(frozen.ao_pilot_tree_sha === EXPECTED_AO_PILOT_TREE_SHA, 'frozen tree SHA drifted');
  assert(live?.ao_pilot?.main_sha === frozen.ao_pilot_main_sha, 'live/frozen main mismatch');
  assert(live?.ao_pilot?.main_tree_sha === frozen.ao_pilot_tree_sha, 'live/frozen tree mismatch');
  assert(frozen?.estimated_local_runtime_unique_commits === 11, 'frozen estimate must be preserved');

  const local = live?.old_local_runtime;
  assert(local?.audit_mode === 'read_only', 'old runtime audit must be read-only');
  assert(local?.unique_commit_count === 12, 'live unique commit count must be 12');
  assert(local?.unique_commits?.length === local.unique_commit_count, 'unique commit ledger incomplete');
  assert(new Set(local.unique_commits.map((entry) => entry.commit)).size === 12, 'duplicate local commit');
  assert(
    JSON.stringify(local.unique_commits.map((entry) => entry.commit))
      === JSON.stringify(EXPECTED_LOCAL_RUNTIME_COMMITS),
    'local runtime commit ledger drifted',
  );
  for (const [index, entry] of local.unique_commits.entries()) {
    assert(entry.ordinal === index + 1, `local commit ordinal mismatch at ${index + 1}`);
    assert(SHA40.test(entry.commit ?? ''), `invalid local commit SHA at ${index + 1}`);
    assert(entry.parity_disposition === 'pending_p0_r02', `premature parity verdict at ${index + 1}`);
  }

  const official = live?.official_runtime;
  const observedOfficialRuntime = {
    canonical_repository: official?.canonical_repository,
    main_sha: official?.main_sha,
    main_tree_sha: official?.main_tree_sha,
    stable_tag: official?.latest_stable_release?.tag,
    stable_commit: official?.latest_stable_release?.commit,
    stable_tree: official?.latest_stable_release?.tree,
    wrapper_name: official?.npm_wrapper?.name,
    wrapper_version: official?.npm_wrapper?.version,
    wrapper_bin: official?.npm_wrapper?.bin,
    wrapper_integrity: official?.npm_wrapper?.integrity,
    wrapper_shasum: official?.npm_wrapper?.shasum,
    linux_name: official?.npm_linux_x64?.name,
    linux_version: official?.npm_linux_x64?.version,
    linux_integrity: official?.npm_linux_x64?.integrity,
    linux_shasum: official?.npm_linux_x64?.shasum,
  };
  assert(
    JSON.stringify(observedOfficialRuntime) === JSON.stringify(EXPECTED_OFFICIAL_RUNTIME),
    'official runtime artifact identity drifted',
  );
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
  assert(
    JSON.stringify(receipt.issues.map((entry) => entry.issue_number))
      === JSON.stringify(EXPECTED_MIGRATED_ISSUES),
    'migration issue sequence mismatch',
  );
  const migrationBodyLedger = receipt.issues.map((entry) => ({
    issue_number: entry.issue_number,
    old_body_sha256: entry.old_body_sha256,
    body_sha256: entry.body_sha256,
  }));
  assert(
    crypto.createHash('sha256').update(JSON.stringify(migrationBodyLedger)).digest('hex')
      === EXPECTED_MIGRATION_BODY_LEDGER_SHA256,
    'migration body digest ledger drifted',
  );

  for (const entry of receipt.issues) {
    assert(SHA64.test(entry.old_body_sha256 ?? ''), `invalid old body digest for #${entry.issue_number}`);
    assert(SHA64.test(entry.body_sha256 ?? ''), `invalid live body digest for #${entry.issue_number}`);
    assert(entry.update_result === 'verified_live', `unverified migration result for #${entry.issue_number}`);
  }
  const issue7 = receipt.issues.find((entry) => entry.issue_number === 7);
  const issue8 = receipt.issues.find((entry) => entry.issue_number === 8);
  assert(
    issue7.old_predecessor === null
      && issue7.new_predecessor === '#55 P0 Bootstrap Lane before #8; #63 terminal before #12',
    '#7 predecessor migration mismatch',
  );
  assert(
    issue8.old_predecessor === 'none'
      && issue8.new_predecessor === '#63 P0-R08 terminal closeout',
    '#8 predecessor migration mismatch',
  );
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
    ['docs/runtime-portability/P0-R01_INCIDENT_BASELINE.md', ['P0-R01 Runtime Portability Incident Baseline', 'Issue #12 is therefore not admitted']],
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
