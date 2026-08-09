import {
  readAoFixture,
  sanitizeFixtureToken,
} from './fixture-support.js';
import { LOCAL_COMMAND_RUNNER } from './providers/command-runner.js';

const PR_JSON_FIELDS = 'number,state,headRefName,headRefOid,reviewDecision,mergeStateStatus,isDraft,statusCheckRollup,url,reviews';
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() === value && value !== '';
}

function isGitSha(value) {
  return typeof value === 'string' && GIT_SHA_PATTERN.test(value);
}

function isExactPullRequestUrl(value, repositorySlug, prNumber) {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'github.com'
      && parsed.pathname === `/${repositorySlug}/pull/${prNumber}`
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

function parseJsonLinesOutput(result, fallbackLabel) {
  try {
    return String(result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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

function fetchPrObservationByNumber(prNumber, now, commandRunner) {
  const fixture = readAoFixture(
    ['github', `pr-${prNumber}.json`],
    `github-pr-${prNumber}.json`,
  );
  if (fixture) {
    const parsed = JSON.parse(fixture.text || 'null');
    return normalizePrObservation(parsed ?? {}, now);
  }

  const result = commandRunner.run('gh', [
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

function fetchPrObservationsByBranch(branchName, now, commandRunner) {
  const fixture = readAoFixture(
    ['github', `branch-${sanitizeFixtureToken(branchName)}.json`],
    `github-branch-${sanitizeFixtureToken(branchName)}.json`,
  );
  if (fixture) {
    const parsed = JSON.parse(fixture.text || '[]');
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((item) => normalizePrObservation(item, now));
  }

  const result = commandRunner.run('gh', [
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
  commandRunner = LOCAL_COMMAND_RUNNER,
} = {}) {
  const selectedPrNumbers = Array.isArray(scope?.selected_pr_numbers)
    ? scope.selected_pr_numbers
    : [];
  const branchHints = extractBranchHints(scope);

  const observationMap = new Map();
  try {
    for (const prNumber of selectedPrNumbers) {
      const observation = fetchPrObservationByNumber(prNumber, now, commandRunner);
      observationMap.set(observation.pr_number, observation);
    }

    for (const branchName of branchHints) {
      const observations = fetchPrObservationsByBranch(branchName, now, commandRunner);
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

export async function loadGitHubMergeObservation({
  repository,
  prNumber,
  now = new Date().toISOString(),
  commandRunner = LOCAL_COMMAND_RUNNER,
} = {}) {
  const observedAt = toIsoString(now) ?? new Date().toISOString();
  const empty = (sourceError) => ({
    schema_version: 'ao.github-merge-observation.v1',
    provider: 'github',
    source_ok: false,
    source_error: String(sourceError),
    observed_at: observedAt,
    repository: {
      repository_id: Number.isSafeInteger(repository?.repository_id)
        && repository.repository_id > 0 ? repository.repository_id : null,
      slug: typeof repository?.slug === 'string' && repository.slug.trim() === repository.slug
        && repository.slug !== '' ? repository.slug : null,
    },
    pull_request: {
      number: Number.isSafeInteger(prNumber) && prNumber > 0 ? prNumber : null,
      state: 'UNKNOWN',
      base_ref: null,
      base_sha: null,
      head_sha: null,
      merge_commit_sha: null,
      merged_at: null,
      url: null,
    },
    evidence_refs: [],
  });
  if (!Number.isSafeInteger(repository?.repository_id) || repository.repository_id <= 0
    || typeof repository?.slug !== 'string' || repository.slug.trim() !== repository.slug
    || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return empty('invalid_exact_merge_observation_scope');
  }

  let repositoryResult;
  try {
    repositoryResult = await commandRunner.run('gh', [
      'api', '--hostname', 'github.com', `repos/${repository.slug}`,
    ], { encoding: 'utf8' });
  } catch (error) {
    return empty(error?.message ?? 'github_repository_observation_failed');
  }
  if (repositoryResult?.status !== 0) {
    return empty((repositoryResult?.stderr || repositoryResult?.stdout
      || 'gh api repository view failed').trim());
  }
  let repositoryRaw;
  try {
    repositoryRaw = parseJsonOutput(repositoryResult, 'gh repository observation');
  } catch (error) {
    return empty(error.message);
  }
  if (!Number.isSafeInteger(repositoryRaw?.id)
    || repositoryRaw.id !== repository.repository_id
    || repositoryRaw?.full_name !== repository.slug) {
    return empty('github_repository_identity_mismatch');
  }
  const expectedRepositoryApiUrl = `https://api.github.com/repos/${repository.slug}`;
  if (repositoryRaw?.url !== expectedRepositoryApiUrl) {
    return empty('github_repository_evidence_missing');
  }

  let result;
  try {
    result = await commandRunner.run('gh', [
      'api', '--hostname', 'github.com', `repos/${repository.slug}/pulls/${prNumber}`,
    ], { encoding: 'utf8' });
  } catch (error) {
    return empty(error?.message ?? 'github_merge_observation_failed');
  }
  if (result?.status !== 0) {
    return empty((result?.stderr || result?.stdout || 'gh pr view failed').trim());
  }

  let raw;
  try {
    raw = parseJsonOutput(result, 'gh merge observation');
  } catch (error) {
    return empty(error.message);
  }

  const rawState = normalizeState(raw?.state);
  const merged = raw?.merged;
  if (!Number.isSafeInteger(raw?.number) || raw.number !== prNumber
    || !Number.isSafeInteger(raw?.base?.repo?.id)
    || raw.base.repo.id !== repository.repository_id
    || raw?.base?.repo?.full_name !== repository.slug) {
    return empty('github_pull_request_identity_mismatch');
  }
  if (!['OPEN', 'CLOSED'].includes(rawState)
    || typeof merged !== 'boolean'
    || (merged && rawState !== 'CLOSED')
    || (!merged && rawState === 'MERGED')
    || (!merged && raw?.merged_at != null)) {
    return empty('github_merge_state_ambiguous');
  }

  const state = merged ? 'MERGED' : rawState;
  const baseRef = raw?.base?.ref;
  const baseSha = raw?.base?.sha;
  const headSha = raw?.head?.sha;
  const mergeCommitSha = raw?.merge_commit_sha;
  const mergedAt = toIsoString(raw?.merged_at);
  const apiUrl = raw?.url;
  const htmlUrl = raw?.html_url;
  if (!isNonEmptyString(baseRef) || !isGitSha(baseSha) || !isGitSha(headSha)
    || apiUrl !== `${expectedRepositoryApiUrl}/pulls/${prNumber}`
    || !isExactPullRequestUrl(htmlUrl, repositoryRaw.full_name, raw.number)) {
    return empty('github_merge_evidence_missing');
  }
  if (merged && (!isGitSha(mergeCommitSha)
    || !isNonEmptyString(raw?.merged_at) || mergedAt == null)) {
    return empty('github_merged_evidence_missing');
  }

  let mergedEvent = null;
  if (merged) {
    let eventResult;
    try {
      eventResult = await commandRunner.run('gh', [
        'api', '--hostname', 'github.com', '--paginate',
        `repos/${repository.slug}/issues/${prNumber}/events?per_page=100`,
        '--jq', '.[] | select(.event == "merged") | {id,url,event,commit_id,created_at}',
      ], { encoding: 'utf8' });
    } catch (error) {
      return empty(error?.message ?? 'github_merge_event_observation_failed');
    }
    if (eventResult?.status !== 0) {
      return empty((eventResult?.stderr || eventResult?.stdout
        || 'gh api merge event observation failed').trim());
    }
    let mergedEvents;
    try {
      mergedEvents = parseJsonLinesOutput(eventResult, 'gh merge event observation');
    } catch (error) {
      return empty(error.message);
    }
    if (mergedEvents.length !== 1) {
      return empty('github_merge_event_ambiguous');
    }
    [mergedEvent] = mergedEvents;
    const expectedEventUrl = Number.isSafeInteger(mergedEvent?.id)
      ? `${expectedRepositoryApiUrl}/issues/events/${mergedEvent.id}` : null;
    if (mergedEvent?.event !== 'merged'
      || mergedEvent?.commit_id !== mergeCommitSha
      || toIsoString(mergedEvent?.created_at) !== mergedAt
      || mergedEvent?.url !== expectedEventUrl) {
      return empty('github_merge_event_mismatch');
    }
  }

  return {
    schema_version: 'ao.github-merge-observation.v1',
    provider: 'github',
    source_ok: true,
    source_error: null,
    observed_at: observedAt,
    repository: {
      repository_id: Number(repositoryRaw.id),
      slug: String(repositoryRaw.full_name),
    },
    pull_request: {
      number: Number(raw.number),
      state,
      base_ref: String(baseRef),
      base_sha: String(baseSha),
      head_sha: String(headSha),
      merge_commit_sha: merged ? String(mergeCommitSha) : null,
      merged_at: merged ? mergedAt : null,
      url: String(htmlUrl),
    },
    evidence_refs: [
      `${String(repositoryRaw.url)}#repository-id:${Number(repositoryRaw.id)}`,
      ...(mergedEvent == null ? [`${String(apiUrl)}#provider-readback:${observedAt}`]
        : [String(mergedEvent.url)]),
    ],
  };
}
