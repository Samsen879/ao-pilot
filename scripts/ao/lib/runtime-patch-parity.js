import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LEDGER_PATH = 'docs/runtime-portability/p0-r02-local-patch-parity-ledger.json';
const AUDIT_PATH = 'docs/runtime-portability/P0-R02_LOCAL_PATCH_PARITY_AUDIT.md';
const SHA40 = /^[0-9a-f]{40}$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const ALLOWED_CLASSIFICATIONS = new Set([
  'adopted',
  'equivalent',
  'obsolete',
  'still-required',
  'conflicting',
]);

const EXPECTED_COMMITS = [
  ['44d333b5000b75b5b5b89df5df6818a3fbe7f7ce', 'fe1a342d49c25c9fa7904be8c7ac97a4baa2d134', 'still-required'],
  ['718da41daa762d41c6f142cd86d3b11baf761d45', '3d1fc27fedb1391fb8e6dbde20018527c68adf81', 'adopted'],
  ['d9c64fa38e55fb32280d0dcad880e646ff7f2534', '1a6bf9581c2fb594e28546ac2fc7c6310259c7a8', 'adopted'],
  ['26e1904163f17a7de905a8a956903ebef9563c4a', '9ad495465700c67bd29e2b9cc7bdfa26cdb7505d', 'obsolete'],
  ['d7eb1aeebfdce3f40bef90ee4c1dd64a40e5fede', '92be482c0e765906ea676bb0e7b45043c3834f4c', 'adopted'],
  ['9957b8319423a5b5f6a50550c5440bcc5d40f068', '0fcc43382acdadf8d00558e7945f62ae6da4943e', 'adopted'],
  ['a862a5d0c07ccaea5b376cd68af551b33a5a77e3', 'd9bf47671ef1ece7bfdafe40f15f935f59e9f5dc', 'adopted'],
  ['5ed0947826a66932a607d8a883a7b74ad4909393', '685e3b292d869ee1e68fe30bd3ae0e7f44a5afdb', 'adopted'],
  ['e5a6ff03445dbf86bdff52dc42b02476f174bc35', '2127ccf55a6a34e845303a5ed1f912c5014004d8', 'obsolete'],
  ['859da6db0299a61feace4930bb1f4e221edf5f5a', '45d19c973b7601b7d261ef5912e8719e903ede96', 'equivalent'],
  ['1f3f32e0db9a9429380760a579858eb4ac867066', '5f9517bc784dcd47b68e4d2a14daf10029ce47cb', 'adopted'],
  ['00bea6e589b4696ea7c897ea45dd15e2de78b4e7', '69b45d50f7b5341178484827458f6c10f1f669c9', 'adopted'],
];

const EXPECTED_OFFICIAL = {
  repository: 'https://github.com/Untrivial-ai/agent-orchestrator',
  main_commit: '20dbad5f68d3bf905c4a38df12aa42716c8d360f',
  main_tree: 'ad025e3fd6e2085878fc6d2deb1fa1dc72f9ad9a',
  stable_tag: 'v0.11.2',
  stable_commit: 'c5523a6d0e51251b79555b95ddc7d2be59da0f50',
  stable_tree: '6784a292cb54c4a2031ede6cfeaee9a4bb1cd104',
  wrapper: '@aoagents/ao@0.10.3',
  wrapper_integrity: 'sha512-La3w8jv2AJV0GoekWzTEav7ZaQnw1xhnZmfwooXwLVGGuX1BV6vCT56P7xzUrfRPFJ+BuGMRuSqyftMVo6JzyQ==',
  linux: '@aoagents/ao-linux-x64@0.10.3',
  linux_integrity: 'sha512-B74xSc073V9hjIoZs860m7hbm/7rgjjuV7mkEdeVU8WaJKylBhkHit90qclaC6ol8UJw/AA1j5syLLF9RND+9A==',
};

const EXPECTED_LEDGER_SHA256 = '1930ed083525ad6e55f9a4357a73d61f85e736209a78759cc40a1b292572a82f';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readText(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(root, relativePath) {
  return JSON.parse(readText(root, relativePath));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function officialTmuxSessionMissingPredicate(output) {
  const normalized = String(output).toLowerCase();
  return normalized.includes("can't find session")
    || normalized.includes('no server running')
    || normalized.includes('error connecting')
    || normalized.includes('session not found');
}

export function validateRuntimePatchParityLedger(ledger) {
  assert(ledger?.schema_version === 'ao.runtime-patch-parity.v1', 'parity schema mismatch');
  assert(ledger?.issue === 57, 'parity issue mismatch');
  assert(ledger?.audit_scope?.mode === 'read_only', 'old checkout audit must be read-only');
  assert(ledger?.audit_scope?.patch_transfer_prohibited === true, 'bulk patch transfer prohibition missing');
  assert(ledger?.audit_scope?.unique_commit_count === 12, 'unique commit count mismatch');
  assert(ledger?.commits?.length === EXPECTED_COMMITS.length, 'parity ledger must contain 12 commits');

  for (const [index, entry] of ledger.commits.entries()) {
    const [expectedCommit, expectedPatchId, expectedClassification] = EXPECTED_COMMITS[index];
    assert(entry.ordinal === index + 1, `ordinal mismatch at ${index + 1}`);
    assert(entry.commit === expectedCommit && SHA40.test(entry.commit), `commit mismatch at ${index + 1}`);
    assert(entry.patch_id === expectedPatchId && SHA40.test(entry.patch_id), `patch id mismatch at ${index + 1}`);
    assert(ALLOWED_CLASSIFICATIONS.has(entry.classification), `invalid classification at ${index + 1}`);
    assert(entry.classification === expectedClassification, `classification mismatch at ${index + 1}`);
    assert(Array.isArray(entry.evidence) && entry.evidence.length >= 3, `insufficient evidence at ${index + 1}`);
    assert(typeof entry.migration_action === 'string' && entry.migration_action.length > 0, `missing migration action at ${index + 1}`);
  }

  const counts = Object.fromEntries([...ALLOWED_CLASSIFICATIONS].map((key) => [key, 0]));
  for (const entry of ledger.commits) counts[entry.classification] += 1;
  for (const key of ALLOWED_CLASSIFICATIONS) {
    assert(ledger.summary?.[key] === counts[key], `summary count mismatch for ${key}`);
  }
  assert(JSON.stringify(counts) === JSON.stringify({ adopted: 8, equivalent: 1, obsolete: 2, 'still-required': 1, conflicting: 0 }), 'unexpected classification distribution');

  const official = ledger.official_observation;
  assert(official?.canonical_repository === EXPECTED_OFFICIAL.repository, 'official repository mismatch');
  assert(official?.main_commit === EXPECTED_OFFICIAL.main_commit, 'official main commit mismatch');
  assert(official?.main_tree === EXPECTED_OFFICIAL.main_tree, 'official main tree mismatch');
  assert(official?.latest_stable_tag === EXPECTED_OFFICIAL.stable_tag, 'stable tag mismatch');
  assert(official?.latest_stable_commit === EXPECTED_OFFICIAL.stable_commit, 'stable commit mismatch');
  assert(official?.latest_stable_tree === EXPECTED_OFFICIAL.stable_tree, 'stable tree mismatch');
  assert(`${official?.npm_wrapper?.name}@${official?.npm_wrapper?.version}` === EXPECTED_OFFICIAL.wrapper, 'npm wrapper mismatch');
  assert(SHA512.test(official?.npm_wrapper?.integrity ?? ''), 'invalid npm wrapper integrity');
  assert(official?.npm_wrapper?.integrity === EXPECTED_OFFICIAL.wrapper_integrity, 'npm wrapper integrity mismatch');
  assert(`${official?.npm_linux_x64?.name}@${official?.npm_linux_x64?.version}` === EXPECTED_OFFICIAL.linux, 'npm linux package mismatch');
  assert(SHA512.test(official?.npm_linux_x64?.integrity ?? ''), 'invalid npm linux integrity');
  assert(official?.npm_linux_x64?.integrity === EXPECTED_OFFICIAL.linux_integrity, 'npm linux integrity mismatch');

  const remaining = ledger.commits.filter((entry) => entry.classification === 'still-required');
  assert(remaining.length === 1 && remaining[0].commit === EXPECTED_COMMITS[0][0], 'remaining delta must be the tmux permission probe fix');
  const experiment = remaining[0].minimum_experiment;
  assert(experiment?.observed_predicate_result === true, 'minimum experiment observation mismatch');
  assert(officialTmuxSessionMissingPredicate(experiment?.input) === true, 'minimum experiment is not reproducible');
  assert(experiment?.official_is_alive_result === 'false,nil', 'official liveness result mismatch');
  assert(experiment?.required_result === 'false,error', 'required liveness result mismatch');

  assert(ledger?.r03_input?.official_stable_sufficient === false, 'R02 must not approve the unchanged official stable');
  assert(ledger?.r03_input?.fork_required === true, 'R03 fork input missing');
  assert(ledger?.r03_input?.bulk_migration_allowed === false, 'bulk migration must remain prohibited');
  assert(ledger?.r03_input?.runtime_selection_deferred_to_issue === 58, 'runtime selection must remain deferred to #58');
  assert(ledger?.r03_input?.required_public_delta?.length === 1, 'R03 input must contain one minimal delta');
  assert(ledger?.limitations?.some((item) => item.includes('Go was not installed')), 'Go test limitation missing');
  assert(sha256(JSON.stringify(ledger)) === EXPECTED_LEDGER_SHA256, 'parity ledger digest drifted');

  return {
    schema_version: ledger.schema_version,
    commits: ledger.commits.length,
    classifications: counts,
    remaining_delta: remaining[0].commit,
    runtime_selection: 'deferred_to_p0_r03',
  };
}

export function verifyRuntimePatchParity(root = process.cwd()) {
  const ledger = readJson(root, LEDGER_PATH);
  const result = validateRuntimePatchParityLedger(ledger);
  const audit = readText(root, AUDIT_PATH);
  for (const fragment of [
    '12—not 11—commits',
    'Only `44d333b5000b75b5b5b89df5df6818a3fbe7f7ce` remains',
    'Do not bulk migrate',
    'No runtime is selected by this issue',
  ]) {
    assert(audit.includes(fragment), `audit document missing required text: ${fragment}`);
  }
  const r01 = readJson(root, 'docs/runtime-portability/p0-r01-incident-inventory.json');
  assert(
    r01.live_observation.old_local_runtime.unique_commits.every(
      (entry) => entry.parity_disposition === 'pending_p0_r02',
    ),
    'historical P0-R01 inventory must remain immutable',
  );
  const packageJson = readJson(root, 'package.json');
  assert(
    packageJson.scripts?.['verify:runtime-parity'] === 'node scripts/verify-runtime-patch-parity.js',
    'runtime parity verification script missing',
  );
  assert(!packageJson.scripts?.['verify:runtime-lock'], 'P0-R02 must not pre-implement P0-R04');
  assert(!packageJson.scripts?.['verify:runtime-bootstrap'], 'P0-R02 must not pre-implement P0-R05');
  return { status: 'pass', ...result, scope_guard: 'audit_only' };
}
