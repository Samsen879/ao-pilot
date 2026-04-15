import { spawnSync } from 'node:child_process';
import {
  readAoFixture,
  sanitizeFixtureToken,
} from './fixture-support.js';

const PR_JSON_FIELDS = 'number,state,headRefName,headRefOid,reviewDecision,mergeStateStatus,isDraft,statusCheckRollup,url,reviews';

function toIsoString(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeReviewStatus(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'APPROVED') return 'approved';
  if (normalized === 'CHANGES_REQUESTED') return 'changes_requested';
  if (normalized === 'REVIEW_REQUIRED') return 'pending';
  return 'unknown';
}

function normalizeCiStatus(statusCheckRollup) {
  const entries = Array.isArray(statusCheckRollup) ? statusCheckRollup.filter(Boolean) : [];
  if (!entries.length) return 'unknown';

  let sawPending = false;
  let sawPassing = false;

  for (const entry of entries) {
    const status = String(entry.status ?? '').trim().toUpperCase();
    const conclusion = String(entry.conclusion ?? '').trim().toUpperCase();

    if (['QUEUED', 'IN_PROGRESS', 'PENDING', 'EXPECTED', 'REQUESTED', 'WAITING'].includes(status)) {
      sawPending = true;
      continue;
    }

    if (status === 'COMPLETED') {
      if (['FAILURE', 'FAILED', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE'].includes(conclusion)) {
        return 'failing';
      }
      if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) {
        sawPassing = true;
        continue;
      }
      if (!conclusion || conclusion === 'PENDING') {
        sawPending = true;
      }
    }
  }

  if (sawPending) return 'pending';
  if (sawPassing) return 'passing';
  return 'unknown';
}

function normalizeMergeability(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(normalized)) return 'mergeable';
  if (['DIRTY', 'CONFLICTING', 'BEHIND'].includes(normalized)) return 'conflicting';
  return 'unknown';
}

function normalizeState(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (['OPEN', 'CLOSED', 'MERGED'].includes(normalized)) return normalized;
  return 'UNKNOWN';
}

function normalizeReviewState(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'APPROVED') return 'approved';
  if (normalized === 'CHANGES_REQUESTED') return 'changes_requested';
  if (normalized === 'COMMENTED') return 'commented';
  return 'unknown';
}

function normalizeReviews(value) {
  const reviews = Array.isArray(value) ? value : [];

  return reviews
    .map((review) => ({
      review_id: review?.id != null ? String(review.id) : null,
      state: normalizeReviewState(review?.state),
      author_login: review?.author?.login != null ? String(review.author.login) : null,
      submitted_at: toIsoString(review?.submittedAt),
      commit_oid: review?.commit?.oid != null ? String(review.commit.oid) : null,
    }))
    .filter((review) => review.review_id || review.submitted_at || review.commit_oid)
    .sort((left, right) => {
      if ((left.submitted_at ?? '') !== (right.submitted_at ?? '')) {
        return String(left.submitted_at ?? '').localeCompare(String(right.submitted_at ?? ''));
      }
      return String(left.review_id ?? '').localeCompare(String(right.review_id ?? ''));
    });
}

function buildEmptyObservationSet(scope, now, sourceError = null) {
  return {
    scope,
    observed_at: toIsoString(now) ?? new Date().toISOString(),
    source_ok: sourceError == null,
    source_error: sourceError,
    prs: [],
  };
}

function normalizePrObservation(raw, now) {
  return {
    pr_number: Number(raw.number),
    observed_at: toIsoString(now) ?? new Date().toISOString(),
    source_ok: true,
    source_error: null,
    state: normalizeState(raw.state),
    head_branch: raw.headRefName != null ? String(raw.headRefName) : null,
    head_sha: raw.headRefOid != null ? String(raw.headRefOid) : null,
    review_status: normalizeReviewStatus(raw.reviewDecision),
    ci_status: normalizeCiStatus(raw.statusCheckRollup),
    mergeability: normalizeMergeability(raw.mergeStateStatus),
    is_draft: typeof raw.isDraft === 'boolean' ? raw.isDraft : null,
    url: raw.url != null ? String(raw.url) : null,
    reviews: normalizeReviews(raw.reviews),
  };
}

function parseJsonOutput(result, fallbackLabel) {
  try {
    return JSON.parse(result.stdout || 'null');
  } catch (error) {
    throw new Error(`invalid ${fallbackLabel} json: ${error.message}`);
  }
}

function extractBranchHints(scope) {
  const branchHints = (scope?.selection_notes ?? [])
    .map((value) => String(value))
    .filter((value) => value.startsWith('branch:'))
    .map((value) => value.slice('branch:'.length).trim())
    .filter(Boolean);

  return [...new Set(branchHints)].sort((left, right) => left.localeCompare(right));
}

function fetchPrObservationByNumber(prNumber, now) {
  const fixture = readAoFixture(
    ['github', `pr-${prNumber}.json`],
    `github-pr-${prNumber}.json`,
  );
  if (fixture) {
    const parsed = JSON.parse(fixture.text || 'null');
    return normalizePrObservation(parsed ?? {}, now);
  }

  const result = spawnSync('gh', [
    'pr',
    'view',
    String(prNumber),
    '--json',
    PR_JSON_FIELDS,
  ], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const errorMessage = (result.stderr || result.stdout || 'gh pr view failed').trim();
    throw new Error(errorMessage);
  }

  const parsed = parseJsonOutput(result, 'gh pr view');
  return normalizePrObservation(parsed ?? {}, now);
}

function fetchPrObservationsByBranch(branchName, now) {
  const fixture = readAoFixture(
    ['github', `branch-${sanitizeFixtureToken(branchName)}.json`],
    `github-branch-${sanitizeFixtureToken(branchName)}.json`,
  );
  if (fixture) {
    const parsed = JSON.parse(fixture.text || '[]');
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((item) => normalizePrObservation(item, now));
  }

  const result = spawnSync('gh', [
    'pr',
    'list',
    '--state',
    'open',
    '--head',
    String(branchName),
    '--json',
    PR_JSON_FIELDS,
  ], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const errorMessage = (result.stderr || result.stdout || 'gh pr list failed').trim();
    throw new Error(errorMessage);
  }

  const parsed = parseJsonOutput(result, 'gh pr list');
  const items = Array.isArray(parsed) ? parsed : [];
  return items.map((item) => normalizePrObservation(item, now));
}

export async function loadGitHubObservationSet({
  scope,
  now = new Date().toISOString(),
} = {}) {
  const selectedPrNumbers = Array.isArray(scope?.selected_pr_numbers)
    ? scope.selected_pr_numbers
    : [];
  const branchHints = extractBranchHints(scope);

  const observationMap = new Map();
  try {
    for (const prNumber of selectedPrNumbers) {
      const observation = fetchPrObservationByNumber(prNumber, now);
      observationMap.set(observation.pr_number, observation);
    }

    for (const branchName of branchHints) {
      const observations = fetchPrObservationsByBranch(branchName, now);
      for (const observation of observations) {
        observationMap.set(observation.pr_number, observation);
      }
    }
  } catch (error) {
    return buildEmptyObservationSet(scope, now, error.message);
  }

  return {
    scope,
    observed_at: toIsoString(now) ?? new Date().toISOString(),
    source_ok: true,
    source_error: null,
    prs: [...observationMap.values()].sort((left, right) => left.pr_number - right.pr_number),
  };
}
