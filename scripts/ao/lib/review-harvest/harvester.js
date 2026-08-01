import fs from 'node:fs';
import path from 'node:path';

import {
  artifactDigest,
  canonicalJson,
  contentAddressedPath,
  readJson,
  sha256Bytes,
  writeCanonicalJson,
  writeFileExclusive,
} from './canonical.js';
import {
  createGhApiProvider,
  createRateLimitGuard,
  hasNextPage,
  parseJsonBody,
} from './github-client.js';
import { validateSnapshotManifest } from './schemas.js';

export const HARVESTER_VERSION = 'ao.review-harvester@0.1.1';
export const SNAPSHOT_MANIFEST_FILENAME = 'ao.github-review-snapshot-manifest.v1alpha1.json';
const CHECKPOINT_VERSION = 'ao.github-review-harvest-checkpoint.v1alpha1';

export class ExpectedCountMismatchError extends Error {
  constructor(expected, actual, evidencePath) {
    super(`Expected ${expected} PRs in exact merged_at window, found ${actual}; evidence: ${evidencePath}`);
    this.name = 'ExpectedCountMismatchError';
    this.expected = expected;
    this.actual = actual;
    this.evidencePath = evidencePath;
  }
}
function iso(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid clock value: ${value}`);
  return date.toISOString();
}

function repositoryParts(repository) {
  const match = String(repository ?? '').match(/^([^/]+)\/([^/]+)$/);
  if (!match) throw new Error(`Invalid repository identity: ${repository}`);
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

function assertWindow(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error('Invalid merged_at window');
  }
  return { startMs, endMs };
}

export function isMergedInExactWindow(pr, start, end) {
  const mergedMs = Date.parse(pr?.merged_at ?? '');
  const { startMs, endMs } = assertWindow(start, end);
  return Number.isFinite(mergedMs) && mergedMs >= startMs && mergedMs < endMs;
}

function pageMetadataPath(outputDir, requestId) {
  return path.join(outputDir, 'scope', 'pages', `${requestId}.json`);
}

function loadCheckpoint(outputDir, initial) {
  const checkpointPath = path.join(outputDir, 'scope', 'checkpoint.json');
  if (!fs.existsSync(checkpointPath)) return { ...initial, checkpointPath };
  const checkpoint = readJson(checkpointPath);
  if (checkpoint.schema_version !== CHECKPOINT_VERSION) throw new Error('Unsupported harvest checkpoint version');
  if (checkpoint.repository !== initial.repository || checkpoint.selector !== initial.selector) {
    throw new Error('Checkpoint scope does not match requested harvest');
  }
  return { ...checkpoint, checkpointPath };
}

function persistCheckpoint(state) {
  writeCanonicalJson(state.checkpointPath, {
    schema_version: CHECKPOINT_VERSION,
    repository: state.repository,
    selector: state.selector,
    started_at: state.started_at,
    network_request_count: state.network_request_count,
    completed_request_ids: [...new Set(state.completed_request_ids)].sort(),
    rate_limit_events: state.rate_limit_events,
  });
}

function existingPage(outputDir, requestId) {
  const metadataPath = pageMetadataPath(outputDir, requestId);
  if (!fs.existsSync(metadataPath)) return null;
  const record = readJson(metadataPath);
  const rawPath = path.resolve(outputDir, record.raw_path);
  if (!fs.existsSync(rawPath)) throw new Error(`Missing raw snapshot page: ${record.raw_path}`);
  const body = fs.readFileSync(rawPath);
  const digest = sha256Bytes(body);
  if (digest !== record.body_sha256) throw new Error(`Raw snapshot digest mismatch: ${record.raw_path}`);
  return { record, body };
}

function buildRequestId(prefix, page) {
  return `${prefix}-page-${String(page).padStart(4, '0')}`;
}

async function mapLimited(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function sortPageRecords(records) {
  return [...records].sort((left, right) => left.request_id.localeCompare(right.request_id));
}

function renderReceipt({ state, manifest, finishedAt, status, error = null }) {
  const events = state.rate_limit_events.map((event) => `- ${canonicalJson(event).trim().replace(/\n/g, ' ')}`);
  return [
    '# AO P0-A GitHub Review Harvest Run Receipt',
    '',
    `- Status: ${status}`,
    `- Repository: ${state.repository}`,
    `- Selector: ${state.selector}`,
    `- Started at: ${state.started_at}`,
    `- Finished at: ${finishedAt}`,
    `- Harvester: ${HARVESTER_VERSION}`,
    `- Network request count: ${state.network_request_count}`,
    `- Snapshot page count: ${manifest?.endpoint_pages?.length ?? state.completed_request_ids.length}`,
    `- Enumerated PR count: ${manifest?.enumerated_pr_count ?? 'not finalized'}`,
    `- Raw byte count: ${manifest?.raw_snapshot?.total_uncompressed_bytes ?? 'not finalized'}`,
    ...(error ? [`- Error: ${error}`] : []),
    '',
    '## Rate-limit events',
    '',
    ...(events.length ? events : ['- None recorded.']),
    '',
    'All GitHub operations in this run used the allowlisted GET provider. No Authorization header or token is persisted.',
    '',
  ].join('\n');
}

function writeReceipt(outputDir, contents) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'RUN_RECEIPT.md'), contents, 'utf8');
}

export async function harvestGitHubReviewSnapshots({
  repository,
  mergedAtStart,
  mergedAtEndExclusive,
  expectedPrCount,
  outputDir,
  concurrency = 2,
  provider = createGhApiProvider(),
  now = () => new Date(),
  sleep,
  thresholds,
} = {}) {
  const identity = repositoryParts(repository);
  assertWindow(mergedAtStart, mergedAtEndExclusive);
  if (!Number.isInteger(expectedPrCount) || expectedPrCount < 0) throw new Error('expectedPrCount must be a non-negative integer');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('concurrency must be 1 or 2');
  if (!outputDir) throw new Error('outputDir is required');

  const selector = `merged_at >= ${mergedAtStart} && merged_at < ${mergedAtEndExclusive}`;
  const state = loadCheckpoint(outputDir, {
    schema_version: CHECKPOINT_VERSION,
    repository: identity.fullName,
    selector,
    started_at: iso(now),
    network_request_count: 0,
    completed_request_ids: [],
    rate_limit_events: [],
  });
  fs.mkdirSync(path.join(outputDir, 'scope', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'raw'), { recursive: true });

  const countingProvider = {
    async get(endpoint, parameters) {
      state.network_request_count += 1;
      persistCheckpoint(state);
      return provider.get(endpoint, parameters);
    },
  };
  const guard = createRateLimitGuard({
    provider: countingProvider,
    ...(sleep ? { sleep } : {}),
    ...(thresholds ? { thresholds } : {}),
    now: () => {
      const value = typeof now === 'function' ? now() : now;
      return value instanceof Date ? value.getTime() : new Date(value).getTime();
    },
    onEvent(event) {
      state.rate_limit_events.push({ observed_at: iso(now), ...event });
      persistCheckpoint(state);
    },
  });

  async function fetchPage({ requestId, endpoint, parameters, resource, page }) {
    const cached = existingPage(outputDir, requestId);
    if (cached) return { ...cached, parsed: JSON.parse(cached.body.toString('utf8')) };
    const response = await guard.get(endpoint, parameters, { resource });
    const digest = sha256Bytes(response.body);
    const rawPath = contentAddressedPath(path.join(outputDir, 'raw'), digest);
    writeFileExclusive(rawPath, response.body);
    const record = {
      request_id: requestId,
      resource,
      endpoint,
      parameters,
      page,
      pagination: {
        has_next: hasNextPage(response.headers),
        link: response.headers.link ?? null,
      },
      response_status: response.status,
      response_headers: response.headers,
      etag: response.headers.etag ?? null,
      fetched_at: iso(now),
      body_sha256: digest,
      uncompressed_byte_length: response.body.length,
      raw_path: path.relative(outputDir, rawPath),
    };
    writeCanonicalJson(pageMetadataPath(outputDir, requestId), record, { exclusive: true });
    state.completed_request_ids.push(requestId);
    persistCheckpoint(state);
    return { record, body: response.body, parsed: parseJsonBody(response, requestId) };
  }

  async function fetchPagination({ prefix, endpoint, parameters = {}, resource = 'core' }) {
    const results = [];
    for (let page = 1; ; page += 1) {
      const result = await fetchPage({
        requestId: buildRequestId(prefix, page),
        endpoint,
        parameters: { ...parameters, page, per_page: 100 },
        resource,
        page,
      });
      results.push(result);
      if (!result.record.pagination.has_next) break;
    }
    return results;
  }

  let manifest = null;
  try {
    await guard.check('core');
    const repositoryPage = await fetchPage({
      requestId: buildRequestId('repository-metadata', 1),
      endpoint: `/repos/${identity.owner}/${identity.repo}`,
      parameters: {},
      resource: 'core',
      page: 1,
    });
    if (Array.isArray(repositoryPage.parsed)
      || !Number.isInteger(repositoryPage.parsed?.id)
      || repositoryPage.parsed.id <= 0
      || String(repositoryPage.parsed?.full_name ?? '').toLowerCase() !== identity.fullName.toLowerCase()) {
      throw new Error(`Invalid repository identity response for ${identity.fullName}`);
    }
    await guard.check('search');
    const query = `repo:${identity.fullName} is:pr is:merged merged:${mergedAtStart.slice(0, 10)}..${new Date(Date.parse(mergedAtEndExclusive) - 1).toISOString().slice(0, 10)}`;
    const searchPages = await fetchPagination({
      prefix: 'scope-search',
      endpoint: '/search/issues',
      parameters: { q: query, sort: 'created', order: 'asc' },
      resource: 'search',
    });
    const candidateNumbers = searchPages
      .flatMap((page) => page.parsed?.items ?? [])
      .map((item) => Number(item.number));
    if (candidateNumbers.some((number) => !Number.isInteger(number))) throw new Error('Search response contained invalid PR number');
    const uniqueCandidates = [...new Set(candidateNumbers)].sort((left, right) => left - right);
    if (uniqueCandidates.length !== candidateNumbers.length) throw new Error('Search pagination returned duplicate PR numbers');

    const metadata = [];
    for (let offset = 0; offset < uniqueCandidates.length; offset += 50) {
      await guard.check('core');
      const batch = uniqueCandidates.slice(offset, offset + 50);
      const batchResults = await mapLimited(batch, concurrency, async (prNumber) => {
        const pages = await fetchPagination({
          prefix: `pr-${String(prNumber).padStart(6, '0')}-metadata`,
          endpoint: `/repos/${identity.owner}/${identity.repo}/pulls/${prNumber}`,
        });
        if (pages.length !== 1 || Array.isArray(pages[0].parsed)) throw new Error(`Invalid PR metadata response for #${prNumber}`);
        return pages[0].parsed;
      });
      metadata.push(...batchResults);
    }

    const exactPrs = metadata
      .filter((pr) => isMergedInExactWindow(pr, mergedAtStart, mergedAtEndExclusive))
      .sort((left, right) => Number(left.number) - Number(right.number));
    const exactPrNumbers = exactPrs.map((pr) => Number(pr.number));
    const scopeEvidence = {
      schema_version: 'ao.github-review-harvest-scope.v1alpha1',
      repository: identity.fullName,
      selector: { merged_at_gte: mergedAtStart, merged_at_lt: mergedAtEndExclusive },
      search: {
        query,
        order: 'asc',
        sort: 'created',
        total_count: searchPages[0]?.parsed?.total_count ?? null,
        candidate_pr_numbers: uniqueCandidates,
        page_request_ids: searchPages.map((page) => page.record.request_id),
      },
      exact_pr_numbers: exactPrNumbers,
      expected_pr_count: expectedPrCount,
      actual_pr_count: exactPrNumbers.length,
      filtered_out_candidate_pr_numbers: metadata
        .filter((pr) => !isMergedInExactWindow(pr, mergedAtStart, mergedAtEndExclusive))
        .map((pr) => Number(pr.number))
        .sort((left, right) => left - right),
    };
    const scopeEvidencePath = path.join(outputDir, 'scope', 'exact-scope.json');
    writeCanonicalJson(scopeEvidencePath, scopeEvidence);
    if (exactPrNumbers.length !== expectedPrCount) {
      writeCanonicalJson(path.join(outputDir, 'scope', 'COUNT_MISMATCH.json'), scopeEvidence);
      throw new ExpectedCountMismatchError(expectedPrCount, exactPrNumbers.length, scopeEvidencePath);
    }

    const prRefs = [];
    for (let offset = 0; offset < exactPrs.length; offset += 25) {
      await guard.check('core');
      const batch = exactPrs.slice(offset, offset + 25);
      const batchRefs = await mapLimited(batch, concurrency, async (pr) => {
        const prNumber = Number(pr.number);
        const endpointSpecs = [
          ['commits', `/repos/${identity.owner}/${identity.repo}/pulls/${prNumber}/commits`],
          ['reviews', `/repos/${identity.owner}/${identity.repo}/pulls/${prNumber}/reviews`],
          ['review-comments', `/repos/${identity.owner}/${identity.repo}/pulls/${prNumber}/comments`],
          ['issue-comments', `/repos/${identity.owner}/${identity.repo}/issues/${prNumber}/comments`],
        ];
        const endpointRequestIds = {};
        for (const [name, endpoint] of endpointSpecs) {
          const pages = await fetchPagination({
            prefix: `pr-${String(prNumber).padStart(6, '0')}-${name}`,
            endpoint,
          });
          endpointRequestIds[name.replace(/-/g, '_')] = pages.map((page) => page.record.request_id);
        }
        return {
          pr_number: prNumber,
          merged_at: pr.merged_at,
          head_sha: pr?.head?.sha ?? null,
          merge_commit_sha: pr.merge_commit_sha ?? null,
          metadata_request_id: buildRequestId(`pr-${String(prNumber).padStart(6, '0')}-metadata`, 1),
          endpoint_request_ids: endpointRequestIds,
        };
      });
      prRefs.push(...batchRefs);
    }

    const finalRates = await guard.check('core');
    const pageRecords = fs.readdirSync(path.join(outputDir, 'scope', 'pages'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(outputDir, 'scope', 'pages', name)));
    const sortedPages = sortPageRecords(pageRecords);
    const rawDigests = [...new Set(sortedPages.map((page) => page.body_sha256))].sort();
    const rawBytes = rawDigests.reduce((sum, digest) => {
      const rawPath = contentAddressedPath(path.join(outputDir, 'raw'), digest);
      if (!fs.existsSync(rawPath)) throw new Error(`Missing content-addressed raw body: ${digest}`);
      return sum + fs.statSync(rawPath).size;
    }, 0);
    const finishedAt = iso(now);
    manifest = {
      schema_version: 'ao.github-review-snapshot-manifest.v1alpha1',
      target_repository_identity: {
        full_name: identity.fullName,
        repository_id: repositoryPage.parsed.id,
      },
      selector: {
        merged_at_gte: mergedAtStart,
        merged_at_lt: mergedAtEndExclusive,
        exact_filter_field: 'pull_request.merged_at',
        timezone: 'GitHub UTC',
      },
      enumeration: {
        endpoint: '/search/issues',
        query,
        sort: 'created',
        order: 'asc',
        search_total_count: searchPages[0]?.parsed?.total_count ?? null,
        search_page_request_ids: searchPages.map((page) => page.record.request_id),
        repository_metadata_request_id: repositoryPage.record.request_id,
        exact_filter_metadata_request_ids: exactPrs.map((pr) => buildRequestId(`pr-${String(pr.number).padStart(6, '0')}-metadata`, 1)),
      },
      exact_pr_numbers: exactPrNumbers,
      enumerated_pr_count: exactPrNumbers.length,
      expected_pr_count: expectedPrCount,
      endpoint_pages: sortedPages,
      pull_requests: prRefs.sort((left, right) => left.pr_number - right.pr_number),
      raw_snapshot: {
        content_addressed_by: 'sha256_uncompressed_response_body',
        unique_body_count: rawDigests.length,
        total_uncompressed_bytes: rawBytes,
        corpus_digest: artifactDigest(rawDigests),
      },
      harvester_version: HARVESTER_VERSION,
      run_receipt: {
        started_at: state.started_at,
        finished_at: finishedAt,
        network_request_count: state.network_request_count,
        bounded_concurrency: concurrency,
        rate_limit_thresholds: thresholds ?? { core: 1500, graphql: 1500, search: 10 },
        rate_limit_events: state.rate_limit_events,
        final_rate_limit_snapshot: finalRates,
        github_operation: 'GET only',
      },
    };
    validateSnapshotManifest(manifest);
    writeCanonicalJson(path.join(outputDir, SNAPSHOT_MANIFEST_FILENAME), manifest);
    writeReceipt(outputDir, renderReceipt({ state, manifest, finishedAt, status: 'complete' }));
    return manifest;
  } catch (error) {
    const finishedAt = iso(now);
    writeReceipt(outputDir, renderReceipt({
      state,
      manifest,
      finishedAt,
      status: error instanceof ExpectedCountMismatchError ? 'stopped_expected_count_mismatch' : 'failed_closed',
      error: error.message,
    }));
    throw error;
  }
}
