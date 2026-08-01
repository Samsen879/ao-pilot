import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  canonicalJson,
  contentAddressedPath,
  sha256Bytes,
  writeCanonicalJson,
} from '../../scripts/ao/lib/review-harvest/canonical.js';
import {
  createRateLimitGuard,
  hasNextPage,
  parseGhApiResponse,
} from '../../scripts/ao/lib/review-harvest/github-client.js';
import {
  ExpectedCountMismatchError,
  harvestGitHubReviewSnapshots,
  isMergedInExactWindow,
  SNAPSHOT_MANIFEST_FILENAME,
} from '../../scripts/ao/lib/review-harvest/harvester.js';
import {
  BASELINE_FILENAME,
  INVENTORY_FILENAME,
  replayReviewHarvest,
} from '../../scripts/ao/lib/review-harvest/normalize.js';
import {
  classifyFirstDetectableStage,
  classifyReviewMaterial,
  extractBlockingFindings,
  isAutomatedInlineSuggestion,
  parseIndependentReviewProtocol,
} from '../../scripts/ao/lib/review-harvest/protocol.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'e'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ao-review-harvest-test-'));
}

function response(body, { status = 200, headers = {}, processStatus = 0 } = {}) {
  return {
    status,
    headers,
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    process_status: processStatus,
    stderr: processStatus === 0 ? '' : 'request failed',
  };
}

function rateResponse(overrides = {}) {
  return response({
    resources: {
      core: { limit: 5000, remaining: 4900, reset: 2_000_000_000 },
      graphql: { limit: 5000, remaining: 4900, reset: 2_000_000_000 },
      search: { limit: 30, remaining: 29, reset: 2_000_000_000 },
      ...overrides,
    },
  });
}

function prMetadata(number, head = HEAD_B) {
  return {
    number,
    merged_at: '2026-07-15T12:00:00Z',
    merge_commit_sha: MERGE_SHA,
    commits: 2,
    head: { sha: head, repo: { id: 999357095 } },
    base: { repo: { id: 999357095 } },
  };
}

function blockedReview({ id = 10, commitId = HEAD_A, login = 'Samsen879', findings = 2 } = {}) {
  const findingText = Array.from({ length: findings }, (_, index) => (
    `${index + 1}. **${index === 0 ? 'Fail-open semantic authority' : 'Metrics count is stale'}.** `
    + `${index === 0 ? 'The implementation invents a canonical route instead of rejecting missing authority.' : 'The metric count does not reconcile.'}`
  )).join('\n\n');
  return {
    id,
    state: 'COMMENTED',
    commit_id: commitId,
    submitted_at: '2026-07-15T10:00:00Z',
    user: { login },
    body: `BLOCKED — independent exact-head code review\n\nReviewed head: \`${commitId}\`\n\n## Blocking findings\n\n${findingText}\n\n## Evidence\n\nDeterministic checks ran.`,
  };
}

function passReview({ id = 11, commitId = HEAD_B, login = 'Samsen879' } = {}) {
  return {
    id,
    state: 'COMMENTED',
    commit_id: commitId,
    submitted_at: '2026-07-15T11:00:00Z',
    user: { login },
    body: `PASS — fresh independent exact-head review\n\nReviewed head \`${commitId}\` / tree \`${'d'.repeat(40)}\`.`,
  };
}

function createMockProvider({
  prNumbers = [1],
  searchPages = null,
  reviewsByPr = {},
  reviewCommentsByPr = {},
  issueCommentsByPr = {},
  failOnceEndpoint = null,
  failAlwaysEndpoint = null,
} = {}) {
  const calls = [];
  let failed = false;
  return {
    calls,
    async get(endpoint, parameters = {}) {
      calls.push({ endpoint, parameters });
      if (endpoint === '/rate_limit') return rateResponse();
      if (endpoint === '/repos/o/r') return response({ id: 999357095, full_name: 'o/r' });
      if (endpoint === failAlwaysEndpoint) {
        return response({ message: 'fixture failure' }, { status: 500, processStatus: 1 });
      }
      if (endpoint === failOnceEndpoint && !failed) {
        failed = true;
        return response({ message: 'fixture failure' }, { status: 500, processStatus: 1 });
      }
      if (endpoint === '/search/issues') {
        const page = Number(parameters.page);
        const pages = searchPages ?? [prNumbers];
        return response({
          total_count: pages.flat().length,
          items: (pages[page - 1] ?? []).map((number) => ({ number })),
        }, {
          headers: page < pages.length ? { link: `<https://api.github.test/search?page=${page + 1}>; rel="next"` } : {},
        });
      }
      const match = endpoint.match(/^\/repos\/o\/r\/pulls\/(\d+)(?:\/(commits|reviews|comments))?$/);
      if (match) {
        const pr = Number(match[1]);
        const resource = match[2] ?? 'metadata';
        if (resource === 'metadata') return response(prMetadata(pr));
        if (resource === 'commits') return response([{ sha: HEAD_A }, { sha: HEAD_B }]);
        if (resource === 'reviews') return response(reviewsByPr[pr] ?? []);
        return response(reviewCommentsByPr[pr] ?? []);
      }
      const issueMatch = endpoint.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/);
      if (issueMatch) return response(issueCommentsByPr[Number(issueMatch[1])] ?? []);
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
  };
}

async function networkFixture({ provider, outputDir, expectedPrCount = 1 }) {
  return harvestGitHubReviewSnapshots({
    repository: 'o/r',
    mergedAtStart: '2026-07-01T00:00:00Z',
    mergedAtEndExclusive: '2026-08-01T00:00:00Z',
    expectedPrCount,
    outputDir,
    concurrency: 2,
    provider,
    now: () => new Date('2026-08-01T00:00:00Z'),
    sleep: async () => {},
  });
}

describe('P0-A review harvester', () => {
  it('uses an exact inclusive-start/exclusive-end GitHub UTC merged window', () => {
    expect(isMergedInExactWindow({ merged_at: '2026-07-01T00:00:00Z' }, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z')).toBe(true);
    expect(isMergedInExactWindow({ merged_at: '2026-07-31T23:59:59Z' }, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z')).toBe(true);
    expect(isMergedInExactWindow({ merged_at: '2026-08-01T00:00:00Z' }, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z')).toBe(false);
  });

  it('follows complete pagination in a fixed page order', async () => {
    const outputDir = tempDir();
    const provider = createMockProvider({ prNumbers: [1, 2], searchPages: [[2], [1]] });
    const manifest = await networkFixture({ provider, outputDir, expectedPrCount: 2 });
    expect(manifest.exact_pr_numbers).toEqual([1, 2]);
    expect(manifest.enumeration.search_page_request_ids).toEqual(['scope-search-page-0001', 'scope-search-page-0002']);
    expect(hasNextPage({ link: '<x>; rel="next"' })).toBe(true);
  });

  it('preserves independently fetched repository identity for an empty exact window', async () => {
    const outputDir = tempDir();
    const manifest = await networkFixture({
      provider: createMockProvider({ prNumbers: [] }),
      outputDir,
      expectedPrCount: 0,
    });
    expect(manifest.enumerated_pr_count).toBe(0);
    expect(manifest.target_repository_identity).toEqual({ full_name: 'o/r', repository_id: 999357095 });
    expect(manifest.enumeration.repository_metadata_request_id).toBe('repository-metadata-page-0001');
  });

  it('persists enumeration evidence and stops before finalization on expected-count mismatch', async () => {
    const outputDir = tempDir();
    await expect(networkFixture({
      provider: createMockProvider({ prNumbers: [1] }),
      outputDir,
      expectedPrCount: 2,
    })).rejects.toBeInstanceOf(ExpectedCountMismatchError);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'scope', 'COUNT_MISMATCH.json'))).actual_pr_count).toBe(1);
    expect(fs.existsSync(path.join(outputDir, SNAPSHOT_MANIFEST_FILENAME))).toBe(false);
  });

  it('hashes raw response bytes deterministically and resumes after a crash without refetching successful pages', async () => {
    const outputDir = tempDir();
    const first = createMockProvider({
      prNumbers: [1],
      failAlwaysEndpoint: '/repos/o/r/pulls/1/reviews',
    });
    await expect(networkFixture({ provider: first, outputDir })).rejects.toThrow('recovery exhausted');
    const rawBefore = fs.readdirSync(path.join(outputDir, 'raw', 'sha256'), { recursive: true }).sort();
    const second = createMockProvider({ prNumbers: [1] });
    const manifest = await networkFixture({ provider: second, outputDir });
    expect(second.calls.some((call) => call.endpoint === '/search/issues')).toBe(false);
    expect(second.calls.some((call) => call.endpoint === '/repos/o/r')).toBe(false);
    expect(second.calls.some((call) => call.endpoint === '/repos/o/r/pulls/1')).toBe(false);
    expect(second.calls.some((call) => call.endpoint === '/repos/o/r/pulls/1/commits')).toBe(false);
    expect(manifest.raw_snapshot.corpus_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(rawBefore.every((entry) => fs.readdirSync(path.join(outputDir, 'raw', 'sha256'), { recursive: true }).includes(entry))).toBe(true);
  });

  it('pauses below reserve and resumes only after reset evidence', async () => {
    let nowMs = 1_000_000;
    let queryCount = 0;
    const waits = [];
    const guard = createRateLimitGuard({
      provider: {
        async get() {
          queryCount += 1;
          return rateResponse(queryCount === 1 ? {
            core: { limit: 5000, remaining: 1499, reset: Math.ceil((nowMs + 2000) / 1000) },
          } : {});
        },
      },
      now: () => nowMs,
      sleep: async (milliseconds) => { waits.push(milliseconds); nowMs += milliseconds; },
    });
    await guard.check('core');
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
    expect(queryCount).toBe(2);
  });

  it.each([
    [403, { 'retry-after': '2' }],
    [429, { 'retry-after': '3' }],
  ])('honors Retry-After and retries %s rate responses', async (status, headers) => {
    let attempts = 0;
    const waits = [];
    const guard = createRateLimitGuard({
      provider: {
        async get() {
          attempts += 1;
          return attempts === 1
            ? response({ message: 'secondary rate limit' }, { status, headers, processStatus: 1 })
            : response({ ok: true });
        },
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    });
    await expect(guard.get('/fixture')).resolves.toMatchObject({ status: 200 });
    expect(waits).toEqual([Number(headers['retry-after']) * 1000]);
  });

  it('retries transient transport failures with bounded exponential backoff', async () => {
    let attempts = 0;
    const waits = [];
    const guard = createRateLimitGuard({
      provider: {
        async get() {
          attempts += 1;
          return attempts === 1
            ? { status: null, headers: {}, body: Buffer.alloc(0), process_status: 1, stderr: 'TLS handshake timeout' }
            : response({ ok: true });
        },
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    });
    await expect(guard.get('/fixture')).resolves.toMatchObject({ status: 200 });
    expect(waits).toEqual([1000]);
  });

  it('distinguishes same-login protocol role and COMMENTED BLOCKED/PASS verdicts', () => {
    const blocked = blockedReview();
    const pass = passReview();
    expect(parseIndependentReviewProtocol(blocked)).toMatchObject({ independent_role: true, verdict: 'BLOCKED', head_binding: 'exact' });
    expect(parseIndependentReviewProtocol(pass)).toMatchObject({ independent_role: true, verdict: 'PASS', head_binding: 'exact' });
    expect(parseIndependentReviewProtocol({ user: { login: 'Samsen879' }, body: 'Fixed in a new commit.' }).independent_role).toBe(false);
  });

  it('recognizes versioned deterministic protocol variants but rejects headless role markers', () => {
    const variant = {
      state: 'COMMENTED',
      commit_id: HEAD_A,
      body: `CHANGES REQUIRED — fresh independent exact-head review bound to commit \`${HEAD_A}\`.`,
    };
    expect(parseIndependentReviewProtocol(variant)).toMatchObject({
      independent_role: true,
      verdict: 'BLOCKED',
      declared_head_sha: HEAD_A,
      head_binding: 'exact',
    });
    expect(parseIndependentReviewProtocol({
      state: 'COMMENTED',
      commit_id: HEAD_A,
      body: 'Independent exact-head review: PASS',
    })).toMatchObject({ independent_role: false, verdict: 'PASS', head_binding: 'not_established' });
  });

  it('classifies body HEAD and commit_id mismatch as unknown', () => {
    const review = blockedReview();
    review.commit_id = HEAD_B;
    expect(classifyReviewMaterial(review)).toMatchObject({ classification: 'unknown', basis: 'protocol_head_binding_not_exact' });
  });

  it('keeps connector bot suggestions outside the primary blocker protocol', () => {
    const comment = {
      user: { login: 'chatgpt-codex-connector[bot]' },
      body: 'P1 Badge: automated review suggestion',
    };
    expect(isAutomatedInlineSuggestion(comment)).toBe(true);
    expect(parseIndependentReviewProtocol(comment).independent_role).toBe(false);
  });

  it('persists connector bot comments as separate non-primary suggestion records', async () => {
    const outputDir = tempDir();
    await networkFixture({
      provider: createMockProvider({
        reviewsByPr: { 1: [blockedReview(), passReview()] },
        reviewCommentsByPr: {
          1: [{
            id: 99,
            pull_request_review_id: 999,
            user: { login: 'chatgpt-codex-connector[bot]' },
            body: 'P1 Badge: automated review suggestion',
            commit_id: HEAD_A,
            original_commit_id: HEAD_A,
            path: 'src/a.js',
            line: 4,
          }],
        },
      }),
      outputDir,
    });
    const replay = replayReviewHarvest({
      manifestPath: path.join(outputDir, SNAPSHOT_MANIFEST_FILENAME),
      outputDir,
    });
    expect(replay.artifacts.inventory.automated_inline_suggestion_count).toBe(1);
    expect(replay.artifacts.inventory.automated_inline_suggestions[0]).toMatchObject({
      record_type: 'automated_inline_suggestion',
      primary_blocker_inclusion: false,
      classification: 'non_blocking',
    });
  });

  it('uses only blocking, non_blocking, and unknown source classifications', () => {
    expect(classifyReviewMaterial(blockedReview()).classification).toBe('blocking');
    expect(classifyReviewMaterial(passReview()).classification).toBe('non_blocking');
    expect(classifyReviewMaterial({ state: 'COMMENTED', body: 'Please consider this.' }).classification).toBe('unknown');
  });

  it('extracts multiple deterministic findings and fails closed on first-detectable stage', () => {
    expect(extractBlockingFindings(blockedReview())).toHaveLength(2);
    expect(classifyFirstDetectableStage('A serious implementation defect.')).toBe('not_established');
    expect(classifyFirstDetectableStage('This preflight validator should reject it.')).toBe('worker_preflight');
  });

  it('reconciles body findings with referenced inline findings without dropping either source', async () => {
    const outputDir = tempDir();
    const review = blockedReview({ findings: 1 });
    review.body = `BLOCKED — independent exact-head code review\n\nReviewed head: \`${HEAD_A}\`\n\n## Blocking findings\n\n1. **First body finding.** Preserve this finding.\n\n2. **Second body finding.** Preserve this finding too.\n\n3. **New inline finding below.** The detailed evidence is attached inline.\n\n## Evidence\n\nDeterministic checks ran.`;
    await networkFixture({
      provider: createMockProvider({
        reviewsByPr: { 1: [review] },
        reviewCommentsByPr: {
          1: [{
            id: 88,
            pull_request_review_id: review.id,
            user: { login: 'Samsen879' },
            body: '**[P2] Third inline finding**\n\nDetailed inline evidence.',
            commit_id: HEAD_A,
            created_at: review.submitted_at,
          }],
        },
      }),
      outputDir,
    });
    const replay = replayReviewHarvest({
      manifestPath: path.join(outputDir, SNAPSHOT_MANIFEST_FILENAME),
      outputDir,
    });
    expect(replay.artifacts.inventory.blockers).toHaveLength(3);
    expect(replay.artifacts.baseline.per_pr_rounds[0].rounds[0].finding_count).toBe(3);
    expect(replay.artifacts.inventory.blockers.map((finding) => finding.summary)).toEqual([
      'First body finding',
      'Second body finding',
      '[P2] Third inline finding',
    ]);
  });

  it('requires correction HEAD plus fresh PASS for resolution and never infers resolution from merge', async () => {
    const resolvedDir = tempDir();
    await networkFixture({
      provider: createMockProvider({ reviewsByPr: { 1: [blockedReview(), passReview()] } }),
      outputDir: resolvedDir,
    });
    const resolved = replayReviewHarvest({
      manifestPath: path.join(resolvedDir, SNAPSHOT_MANIFEST_FILENAME),
      outputDir: resolvedDir,
    });
    expect(resolved.artifacts.inventory.blockers).toHaveLength(2);
    expect(resolved.artifacts.inventory.blockers.every((blocker) => blocker.status === 'resolved' && blocker.correction_head_sha === HEAD_B)).toBe(true);
    expect(resolved.artifacts.baseline.correction_round_distribution.total_rounds).toBe(1);

    const unresolvedDir = tempDir();
    await networkFixture({
      provider: createMockProvider({ reviewsByPr: { 1: [blockedReview()] } }),
      outputDir: unresolvedDir,
    });
    const unresolved = replayReviewHarvest({
      manifestPath: path.join(unresolvedDir, SNAPSHOT_MANIFEST_FILENAME),
      outputDir: unresolvedDir,
    });
    expect(unresolved.artifacts.inventory.blockers.every((blocker) => blocker.status === 'unresolved')).toBe(true);
  });

  it('does not resolve a blocked successor head from a stale or unrelated PASS head', async () => {
    for (const staleHead of [HEAD_A, HEAD_C]) {
      const outputDir = tempDir();
      await networkFixture({
        provider: createMockProvider({
          reviewsByPr: { 1: [blockedReview({ commitId: HEAD_B }), passReview({ commitId: staleHead })] },
        }),
        outputDir,
      });
      const replay = replayReviewHarvest({
        manifestPath: path.join(outputDir, SNAPSHOT_MANIFEST_FILENAME),
        outputDir,
      });
      expect(replay.artifacts.inventory.blockers.every((blocker) => blocker.status === 'unresolved')).toBe(true);
      expect(replay.artifacts.baseline.correction_round_distribution.total_rounds).toBe(0);
    }
  });

  it('retains exact-head conversation verdicts as unknown unbound evidence, not review rounds', async () => {
    const outputDir = tempDir();
    await networkFixture({
      provider: createMockProvider({
        issueCommentsByPr: {
          1: [{
            id: 55,
            user: { login: 'Samsen879' },
            created_at: '2026-07-15T10:00:00Z',
            body: `## BLOCKING exact-head review — CHANGES REQUIRED\n\nGitHub cannot bind this conversation verdict to a review submission.\n\n- PR head: \`${HEAD_A}\``,
          }],
        },
      }),
      outputDir,
    });
    const replay = replayReviewHarvest({
      manifestPath: path.join(outputDir, SNAPSHOT_MANIFEST_FILENAME),
      outputDir,
    });
    expect(replay.artifacts.inventory.unbound_conversation_review_evidence_count).toBe(1);
    expect(replay.artifacts.inventory.unbound_conversation_review_evidence[0]).toMatchObject({
      verdict: 'BLOCKED',
      declared_head_sha: HEAD_A,
      github_commit_id: null,
      head_binding: 'not_established',
      classification: 'unknown',
    });
    expect(replay.artifacts.inventory.unknown_classification_count).toBe(1);
    expect(replay.artifacts.baseline.review_round_distribution.total_rounds).toBe(0);
  });

  it('fails closed when a PR metadata page is bound to the wrong PR reference', async () => {
    const outputDir = tempDir();
    await networkFixture({
      provider: createMockProvider({ prNumbers: [1, 2] }),
      outputDir,
      expectedPrCount: 2,
    });
    const manifestPath = path.join(outputDir, SNAPSHOT_MANIFEST_FILENAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    [manifest.pull_requests[0].metadata_request_id, manifest.pull_requests[1].metadata_request_id]
      = [manifest.pull_requests[1].metadata_request_id, manifest.pull_requests[0].metadata_request_id];
    writeCanonicalJson(manifestPath, manifest);
    expect(() => replayReviewHarvest({ manifestPath, outputDir: tempDir() }))
      .toThrow('PR metadata endpoint binding mismatch');
  });

  it('replays offline twice with identical output digests and fixed ordering', async () => {
    const sourceDir = tempDir();
    await networkFixture({
      provider: createMockProvider({ reviewsByPr: { 1: [blockedReview(), passReview()] } }),
      outputDir: sourceDir,
    });
    const firstDir = tempDir();
    const secondDir = tempDir();
    const first = replayReviewHarvest({ manifestPath: path.join(sourceDir, SNAPSHOT_MANIFEST_FILENAME), outputDir: firstDir });
    const second = replayReviewHarvest({ manifestPath: path.join(sourceDir, SNAPSHOT_MANIFEST_FILENAME), outputDir: secondDir });
    expect(first.digests).toEqual(second.digests);
    expect(fs.readFileSync(path.join(firstDir, INVENTORY_FILENAME))).toEqual(fs.readFileSync(path.join(secondDir, INVENTORY_FILENAME)));
    expect(fs.readFileSync(path.join(firstDir, BASELINE_FILENAME))).toEqual(fs.readFileSync(path.join(secondDir, BASELINE_FILENAME)));
    fs.rmSync(sourceDir, { recursive: true, force: true });
    const third = replayReviewHarvest({
      manifestPath: path.join(firstDir, SNAPSHOT_MANIFEST_FILENAME),
      outputDir: tempDir(),
    });
    expect(third.digests).toEqual(first.digests);
  });

  it('fails closed when a referenced snapshot page is missing', async () => {
    const outputDir = tempDir();
    const manifest = await networkFixture({ provider: createMockProvider(), outputDir });
    const firstPage = manifest.endpoint_pages[0];
    fs.unlinkSync(path.join(outputDir, firstPage.raw_path));
    expect(() => replayReviewHarvest({
      manifestPath: path.join(outputDir, SNAPSHOT_MANIFEST_FILENAME),
      outputDir: tempDir(),
    })).toThrow('Missing snapshot page');
  });

  it('redacts unsafe headers and rejects secret-like raw bytes', () => {
    const parsed = parseGhApiResponse(Buffer.from([
      'HTTP/2.0 200 OK',
      'Authorization: Bearer secret',
      'ETag: "safe"',
      'X-RateLimit-Remaining: 4900',
      '',
      '{"ok":true}',
    ].join('\r\n')));
    expect(parsed.headers).toEqual({ etag: '"safe"', 'x-ratelimit-remaining': '4900' });
  });

  it('keeps repository-specific raw artifacts outside the npm package allowlist', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    expect(packageJson.files).not.toContain('artifacts');
    expect(packageJson.files.every((entry) => !String(entry).startsWith('artifacts/'))).toBe(true);
  });
});
