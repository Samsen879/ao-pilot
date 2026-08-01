import fs from 'node:fs';
import path from 'node:path';

import {
  artifactDigest,
  canonicalJson,
  readJson,
  sha256Bytes,
  writeCanonicalJson,
} from './canonical.js';
import {
  classifyCategory,
  classifyFirstDetectableStage,
  classifyReviewMaterial,
  classifySeverity,
  extractBlockingFindings,
  isAutomatedActor,
  isAutomatedInlineSuggestion,
  parseIndependentReviewProtocol,
  REVIEW_PROTOCOL_VERSION,
} from './protocol.js';
import {
  FIRST_DETECTABLE_STAGES,
  validateArtifacts,
  validateSnapshotManifest,
} from './schemas.js';
import { SNAPSHOT_MANIFEST_FILENAME } from './harvester.js';

export const INVENTORY_FILENAME = 'ao.independent-review-block-inventory.v1alpha1.json';
export const BASELINE_FILENAME = 'ao.review-round-baseline.v1alpha1.json';
export const NORMALIZER_VERSION = 'ao.review-normalizer@0.1.0';

const SECRET_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/i,
];

function reviewId(review) {
  return String(review?.id ?? 'unknown');
}

function numericTime(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function sortByTimeAndId(items, timeField = 'submitted_at') {
  return [...items].sort((left, right) => {
    const delta = numericTime(left?.[timeField]) - numericTime(right?.[timeField]);
    if (delta !== 0) return delta;
    return reviewId(left).localeCompare(reviewId(right));
  });
}

function distribution(values) {
  const counts = {};
  for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1;
  return Object.keys(counts)
    .sort((left, right) => Number(left) - Number(right))
    .reduce((result, key) => {
      result[key] = counts[key];
      return result;
    }, {});
}

function ratio(numerator, denominator) {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : Number((numerator / denominator).toFixed(6)),
  };
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return null;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

function durationSummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, min_seconds: null, median_seconds: null, p95_seconds: null, max_seconds: null };
  return {
    count: sorted.length,
    min_seconds: sorted[0],
    median_seconds: percentile(sorted, 50),
    p95_seconds: percentile(sorted, 95),
    max_seconds: sorted.at(-1),
  };
}

function loadAndVerifyPage(manifestDir, record) {
  const rawPath = path.resolve(manifestDir, record.raw_path);
  if (!fs.existsSync(rawPath)) throw new Error(`Missing snapshot page: ${record.raw_path}`);
  const bytes = fs.readFileSync(rawPath);
  if (sha256Bytes(bytes) !== record.body_sha256) throw new Error(`Snapshot hash mismatch: ${record.raw_path}`);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(bytes.toString('utf8'))) throw new Error(`Secret-like value found in snapshot: ${record.raw_path}`);
  }
  if (Object.keys(record.response_headers ?? {}).some((key) => /authorization|cookie|token/i.test(key))) {
    throw new Error(`Unsafe response header persisted for ${record.request_id}`);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid snapshot JSON ${record.raw_path}: ${error.message}`);
  }
}

function assertPageSequence(records, label) {
  if (!records.length) throw new Error(`Missing required snapshot source: ${label}`);
  const pages = records.map((record) => record.page).sort((left, right) => left - right);
  pages.forEach((page, index) => {
    if (page !== index + 1) throw new Error(`Missing snapshot page for ${label}: expected ${index + 1}, found ${page}`);
  });
  records.forEach((record, index) => {
    const expectedNext = index < records.length - 1;
    if (Boolean(record.pagination?.has_next) !== expectedNext) {
      throw new Error(`Pagination evidence mismatch for ${label} page ${record.page}`);
    }
  });
}

export function loadSnapshotCorpus(manifestPath) {
  const manifest = readJson(manifestPath);
  validateSnapshotManifest(manifest);
  const manifestDir = path.dirname(manifestPath);
  const pageById = new Map();
  for (const record of manifest.endpoint_pages) {
    if (pageById.has(record.request_id)) throw new Error(`Duplicate snapshot request id: ${record.request_id}`);
    pageById.set(record.request_id, { record, parsed: loadAndVerifyPage(manifestDir, record) });
  }

  function requiredPages(ids, label) {
    if (!Array.isArray(ids) || ids.length === 0) throw new Error(`Missing page references: ${label}`);
    const entries = ids.map((id) => {
      const entry = pageById.get(id);
      if (!entry) throw new Error(`Manifest references missing page ${id}`);
      return entry;
    }).sort((left, right) => left.record.page - right.record.page);
    assertPageSequence(entries.map((entry) => entry.record), label);
    return entries.flatMap((entry) => {
      if (!Array.isArray(entry.parsed)) throw new Error(`Expected array response for ${label}`);
      return entry.parsed;
    });
  }

  const prs = manifest.pull_requests.map((prRef) => {
    const metadataEntry = pageById.get(prRef.metadata_request_id);
    if (!metadataEntry || Array.isArray(metadataEntry.parsed)) throw new Error(`Missing PR metadata for #${prRef.pr_number}`);
    const endpoints = prRef.endpoint_request_ids ?? {};
    const commits = requiredPages(endpoints.commits, `PR #${prRef.pr_number} commits`);
    if (Number.isInteger(metadataEntry.parsed.commits) && commits.length !== metadataEntry.parsed.commits) {
      throw new Error(`Incomplete commit snapshot for PR #${prRef.pr_number}: expected ${metadataEntry.parsed.commits}, found ${commits.length}`);
    }
    return {
      ref: prRef,
      metadata: metadataEntry.parsed,
      commits,
      reviews: requiredPages(endpoints.reviews, `PR #${prRef.pr_number} reviews`),
      reviewComments: requiredPages(endpoints.review_comments, `PR #${prRef.pr_number} review comments`),
      issueComments: requiredPages(endpoints.issue_comments, `PR #${prRef.pr_number} issue comments`),
    };
  });
  if (prs.length !== manifest.enumerated_pr_count) throw new Error('PR corpus coverage does not match enumerated count');
  return { manifest, manifestPath, pageById, prs };
}

function fallbackFinding(review) {
  const body = String(review?.body ?? '');
  const heading = body.match(/^\s*\d+\.\s+\*\*([^*\n]+)/m)?.[1]
    ?? body.split(/\n\s*\n/).slice(1).find((value) => value.trim())
    ?? 'Explicit independent BLOCKED verdict';
  const summary = heading.replace(/[*#]/g, '').trim().slice(0, 500);
  return {
    ordinal: 1,
    summary,
    detail: body,
    category: classifyCategory(body),
    severity: classifySeverity(body),
    first_detectable_stage: classifyFirstDetectableStage(body),
    finding_fingerprint: sha256Bytes(Buffer.from(body.replace(/\s+/g, ' ').trim().toLowerCase(), 'utf8')),
  };
}

function commentFinding(comment, ordinal) {
  const body = String(comment?.body ?? '').replace(/\\n/g, '\n').trim();
  const firstLine = body.split('\n').find((line) => line.trim()) ?? 'Inline blocking finding';
  const summary = firstLine
    .replace(/<[^>]+>/g, '')
    .replace(/^#+\s*/, '')
    .replace(/^\*+|\*+$/g, '')
    .trim()
    .slice(0, 500);
  return {
    ordinal,
    summary: summary || 'Inline blocking finding',
    detail: body,
    category: classifyCategory(body),
    severity: classifySeverity(body),
    first_detectable_stage: classifyFirstDetectableStage(body),
    finding_fingerprint: sha256Bytes(Buffer.from(body.replace(/\s+/g, ' ').toLowerCase(), 'utf8')),
  };
}

function normalizePr(repository, source) {
  const prNumber = Number(source.metadata.number);
  const reviewCommentsByReview = new Map();
  let automatedSuggestionCount = 0;
  const automatedSuggestions = [];
  let automatedReviewSubmissionCount = 0;
  for (const comment of source.reviewComments) {
    if (isAutomatedInlineSuggestion(comment)) {
      automatedSuggestionCount += 1;
      const body = String(comment.body ?? '').replace(/\\n/g, '\n').trim();
      automatedSuggestions.push({
        record_type: 'automated_inline_suggestion',
        repository,
        pr_number: prNumber,
        comment_ref: `github-review-comment:${comment.id}`,
        review_ref: comment.pull_request_review_id == null
          ? null
          : `github-review:${comment.pull_request_review_id}`,
        github_actor_login: comment?.user?.login ?? null,
        commit_id: comment.commit_id ?? null,
        original_commit_id: comment.original_commit_id ?? null,
        path: comment.path ?? null,
        line: comment.line ?? null,
        classification: 'non_blocking',
        primary_blocker_inclusion: false,
        exclusion_basis: 'automated_suggestion_without_explicit_independent_BLOCKED_reference',
        summary: body.split('\n').find((line) => line.trim())?.slice(0, 500) ?? '',
        body_sha256: sha256Bytes(Buffer.from(body, 'utf8')),
      });
    }
    const key = String(comment.pull_request_review_id ?? 'unbound');
    if (!reviewCommentsByReview.has(key)) reviewCommentsByReview.set(key, []);
    reviewCommentsByReview.get(key).push(comment);
  }

  const sortedReviews = sortByTimeAndId(source.reviews);
  let unknownCount = 0;
  let protocolMarkerCount = 0;
  let exactHeadMarkerCount = 0;
  let sourceBlockingNotIndependentCount = 0;
  const rounds = [];
  for (const review of sortedReviews) {
    if (isAutomatedActor(review)) {
      automatedReviewSubmissionCount += 1;
      continue;
    }
    const material = classifyReviewMaterial(review);
    if (material.protocol.role_marker) protocolMarkerCount += 1;
    if (material.protocol.role_marker && material.protocol.head_binding === 'exact') exactHeadMarkerCount += 1;
    if (!material.protocol.independent_role) {
      if (String(review.body ?? '').trim() || String(review.state ?? '').toUpperCase() === 'CHANGES_REQUESTED') {
        unknownCount += 1;
      }
      if (material.classification === 'blocking') sourceBlockingNotIndependentCount += 1;
      continue;
    }
    const comments = sortByTimeAndId(
      reviewCommentsByReview.get(reviewId(review)) ?? [],
      'created_at',
    );
    const humanInlineComments = comments.filter((comment) => !isAutomatedActor(comment));
    const bodyFindings = extractBlockingFindings(review);
    const findings = material.protocol.verdict === 'BLOCKED'
      ? (humanInlineComments.length
        ? humanInlineComments.map((comment, index) => commentFinding(comment, index + 1))
        : (bodyFindings.length ? bodyFindings : [fallbackFinding(review)]))
      : [];
    rounds.push({
      review,
      comments,
      protocol: material.protocol,
      classification: material.classification,
      blocking_basis: material.basis,
      findings,
    });
  }

  const blockers = [];
  const roundRecords = rounds.map((round) => {
    const id = `review-round:${repository}:pr-${prNumber}:review-${reviewId(round.review)}`;
    return {
      review_round_id: id,
      review_ref: `github-review:${reviewId(round.review)}`,
      submitted_at: round.review.submitted_at ?? null,
      github_actor_login: round.review?.user?.login ?? null,
      github_review_state: String(round.review.state ?? '').toUpperCase() || null,
      protocol_version: round.protocol.protocol_version,
      verdict: round.protocol.verdict,
      classification: round.classification,
      reviewed_head_sha: round.protocol.commit_id,
      head_binding: round.protocol.head_binding,
      comment_refs: round.comments.map((comment) => `github-review-comment:${comment.id}`),
      finding_count: round.findings.length,
    };
  });

  rounds.forEach((round, roundIndex) => {
    if (round.protocol.verdict !== 'BLOCKED' || round.classification !== 'blocking') return;
    const laterPass = rounds.slice(roundIndex + 1).find((candidate) => (
      candidate.protocol.verdict === 'PASS'
      && candidate.protocol.head_binding === 'exact'
      && candidate.protocol.commit_id !== round.protocol.commit_id
    ));
    for (const finding of round.findings) {
      const roundId = roundRecords[roundIndex].review_round_id;
      blockers.push({
        schema_version: 'ao.independent-review-block.v1alpha1',
        block_id: `block:${repository}:pr-${prNumber}:review-${reviewId(round.review)}:finding-${finding.ordinal}`,
        repository,
        pr_number: prNumber,
        reviewer_actor_ref: `independent-reviewer:${REVIEW_PROTOCOL_VERSION}`,
        github_actor_login: round.review?.user?.login ?? null,
        review_role_basis: REVIEW_PROTOCOL_VERSION,
        review_session_ref: null,
        review_ref: `github-review:${reviewId(round.review)}`,
        comment_refs: round.comments.map((comment) => `github-review-comment:${comment.id}`),
        review_round_id: roundId,
        reviewed_head_sha: round.protocol.commit_id,
        classification: 'blocking',
        blocking_basis: 'explicit_BLOCKED_independent_exact_head_body_protocol',
        severity: finding.severity,
        category: finding.category,
        summary: finding.summary,
        observed_stage: 'independent_review',
        first_detectable_stage: finding.first_detectable_stage,
        finding_fingerprint: finding.finding_fingerprint,
        correction_head_sha: laterPass?.protocol?.commit_id ?? null,
        resolution_review_ref: laterPass ? `github-review:${reviewId(laterPass.review)}` : null,
        resolution_verdict: laterPass ? 'PASS' : null,
        status: laterPass ? 'resolved' : 'unresolved',
        evidence_refs: [
          `github-review:${reviewId(round.review)}`,
          ...round.comments.map((comment) => `github-review-comment:${comment.id}`),
        ],
      });
    }
  });

  const correctionRoundCount = rounds.filter((round, index) => (
    round.protocol.verdict === 'BLOCKED'
    && rounds.slice(index + 1).some((candidate) => candidate.protocol.commit_id !== round.protocol.commit_id)
  )).length;
  const mergeMs = Date.parse(source.metadata.merged_at ?? '');
  const firstReviewMs = rounds.length ? Date.parse(rounds[0].review.submitted_at ?? '') : NaN;
  const firstReviewToMergeSeconds = Number.isFinite(mergeMs) && Number.isFinite(firstReviewMs)
    ? Math.max(0, Math.round((mergeMs - firstReviewMs) / 1000))
    : null;

  return {
    blockers,
    rounds: roundRecords,
    unknownCount,
    protocolMarkerCount,
    exactHeadMarkerCount,
    automatedSuggestionCount,
    automatedSuggestions,
    automatedReviewSubmissionCount,
    sourceBlockingNotIndependentCount,
    correctionRoundCount,
    firstReviewToMergeSeconds,
    prBaseline: {
      pr_number: prNumber,
      merged_at: source.metadata.merged_at ?? null,
      merge_commit_sha: source.metadata.merge_commit_sha ?? null,
      review_round_count: rounds.length,
      blocking_round_count: rounds.filter((round) => round.protocol.verdict === 'BLOCKED').length,
      correction_round_count: correctionRoundCount,
      blocker_count: blockers.length,
      first_pass_independent_review: rounds.length ? rounds[0].protocol.verdict === 'PASS' : null,
      first_review_to_merge_seconds: firstReviewToMergeSeconds,
      rounds: roundRecords,
    },
  };
}

export function normalizeSnapshotCorpus(corpus) {
  const { manifest, manifestPath, prs } = corpus;
  const repository = manifest.target_repository_identity.full_name;
  const manifestBytes = fs.readFileSync(manifestPath);
  const sourceRef = {
    path: SNAPSHOT_MANIFEST_FILENAME,
    sha256: sha256Bytes(manifestBytes),
  };
  const normalizedPrs = prs.map((source) => normalizePr(repository, source));
  const blockers = normalizedPrs.flatMap((pr) => pr.blockers)
    .sort((left, right) => left.block_id.localeCompare(right.block_id));
  const prBaselines = normalizedPrs.map((pr) => pr.prBaseline)
    .sort((left, right) => left.pr_number - right.pr_number);

  const stageCounts = Object.fromEntries(FIRST_DETECTABLE_STAGES.map((stage) => [stage, 0]));
  blockers.forEach((blocker) => { stageCounts[blocker.first_detectable_stage] += 1; });
  const categories = new Map();
  for (const blocker of blockers) {
    if (blocker.category === 'not_established') continue;
    if (!categories.has(blocker.category)) categories.set(blocker.category, { blockers: [], prs: new Set() });
    categories.get(blocker.category).blockers.push(blocker.block_id);
    categories.get(blocker.category).prs.add(blocker.pr_number);
  }
  const recurringPatterns = [...categories.entries()]
    .filter(([, evidence]) => evidence.prs.size >= 3)
    .map(([category, evidence]) => ({
      pattern_id: `review-pattern:${category}`,
      category,
      blocker_count: evidence.blockers.length,
      episode_count: evidence.prs.size,
      episode_pr_numbers: [...evidence.prs].sort((left, right) => left - right),
      pattern_fingerprint: sha256Bytes(Buffer.from(`${category}\n${[...evidence.prs].sort((a, b) => a - b).join(',')}`, 'utf8')),
    }))
    .sort((left, right) => left.pattern_id.localeCompare(right.pattern_id));

  const episodeCount = new Set(blockers.map((blocker) => blocker.pr_number)).size;
  const unknownCount = normalizedPrs.reduce((sum, pr) => sum + pr.unknownCount, 0);
  const protocolMarkers = normalizedPrs.reduce((sum, pr) => sum + pr.protocolMarkerCount, 0);
  const exactMarkers = normalizedPrs.reduce((sum, pr) => sum + pr.exactHeadMarkerCount, 0);
  const automatedSuggestionCount = normalizedPrs.reduce((sum, pr) => sum + pr.automatedSuggestionCount, 0);
  const automatedSuggestions = normalizedPrs
    .flatMap((pr) => pr.automatedSuggestions)
    .sort((left, right) => {
      if (left.pr_number !== right.pr_number) return left.pr_number - right.pr_number;
      return left.comment_ref.localeCompare(right.comment_ref);
    });
  const automatedReviewSubmissionCount = normalizedPrs.reduce((sum, pr) => sum + pr.automatedReviewSubmissionCount, 0);
  const sourceBlockingNotIndependentCount = normalizedPrs.reduce((sum, pr) => sum + pr.sourceBlockingNotIndependentCount, 0);
  const knowledgeChecks = {
    normalized_independent_review_blockers_gte_50: blockers.length >= 50,
    independent_episodes_gte_10: episodeCount >= 10,
    recurring_patterns_gte_3: recurringPatterns.length >= 3,
    each_recurring_pattern_in_gte_3_episodes: recurringPatterns.length > 0 && recurringPatterns.every((pattern) => pattern.episode_count >= 3),
    first_detectable_stage_baseline_exists: Object.values(stageCounts).reduce((sum, value) => sum + value, 0) === blockers.length,
  };

  const inventory = {
    schema_version: 'ao.independent-review-block-inventory.v1alpha1',
    source_snapshot_manifest_ref: sourceRef,
    generated_at: manifest.run_receipt.finished_at,
    harvester_version: manifest.harvester_version,
    normalizer_version: NORMALIZER_VERSION,
    review_protocol_version: REVIEW_PROTOCOL_VERSION,
    blocker_count: blockers.length,
    unknown_classification_count: unknownCount,
    episode_count: episodeCount,
    recurring_pattern_count: recurringPatterns.length,
    first_detectable_stage_counts: stageCounts,
    source_coverage: {
      enumerated_pr_count: manifest.enumerated_pr_count,
      normalized_pr_count: prs.length,
      pr_metadata: ratio(prs.length, manifest.enumerated_pr_count),
      commits: ratio(prs.length, manifest.enumerated_pr_count),
      reviews: ratio(prs.length, manifest.enumerated_pr_count),
      review_comments: ratio(prs.length, manifest.enumerated_pr_count),
      issue_comments: ratio(prs.length, manifest.enumerated_pr_count),
      full_source_coverage: prs.length === manifest.enumerated_pr_count,
    },
    protocol_marker_coverage: ratio(protocolMarkers, protocolMarkers + unknownCount),
    head_binding_coverage: ratio(exactMarkers, protocolMarkers),
    automated_inline_suggestion_count: automatedSuggestionCount,
    automated_inline_suggestions: automatedSuggestions,
    automated_review_submission_count: automatedReviewSubmissionCount,
    source_blocking_without_independent_role_count: sourceBlockingNotIndependentCount,
    recurring_patterns: recurringPatterns,
    blockers,
    deterministic_fingerprint: artifactDigest({
      source_manifest_sha256: sourceRef.sha256,
      blocker_fingerprints: blockers.map((blocker) => blocker.finding_fingerprint),
      recurring_pattern_fingerprints: recurringPatterns.map((pattern) => pattern.pattern_fingerprint),
    }),
    knowledge_gate: {
      checks: knowledgeChecks,
      passed: Object.values(knowledgeChecks).every(Boolean),
      conclusion: Object.values(knowledgeChecks).every(Boolean)
        ? 'Knowledge Track proposal may start'
        : 'Knowledge Track proposal gate not met',
    },
  };

  const reviewCounts = prBaselines.map((pr) => pr.review_round_count);
  const blockingCounts = prBaselines.map((pr) => pr.blocking_round_count);
  const correctionCounts = prBaselines.map((pr) => pr.correction_round_count);
  const blockersPerBlockingRound = prBaselines.flatMap((pr) => pr.rounds
    .filter((round) => round.verdict === 'BLOCKED')
    .map((round) => round.finding_count));
  const reviewedPrs = prBaselines.filter((pr) => pr.review_round_count > 0);
  const firstPassCount = reviewedPrs.filter((pr) => pr.first_pass_independent_review).length;
  const durations = reviewedPrs.map((pr) => pr.first_review_to_merge_seconds).filter(Number.isFinite);
  const baseline = {
    schema_version: 'ao.review-round-baseline.v1alpha1',
    source_snapshot_manifest_ref: sourceRef,
    generated_at: manifest.run_receipt.finished_at,
    harvester_version: manifest.harvester_version,
    normalizer_version: NORMALIZER_VERSION,
    review_protocol_version: REVIEW_PROTOCOL_VERSION,
    per_pr_rounds: prBaselines,
    review_round_distribution: {
      histogram: distribution(reviewCounts),
      total_rounds: reviewCounts.reduce((sum, value) => sum + value, 0),
    },
    blocking_round_distribution: {
      histogram: distribution(blockingCounts),
      total_rounds: blockingCounts.reduce((sum, value) => sum + value, 0),
    },
    correction_round_distribution: {
      histogram: distribution(correctionCounts),
      total_rounds: correctionCounts.reduce((sum, value) => sum + value, 0),
    },
    blockers_per_blocking_round: {
      histogram: distribution(blockersPerBlockingRound),
      total_blocking_rounds: blockersPerBlockingRound.length,
      total_blockers: blockersPerBlockingRound.reduce((sum, value) => sum + value, 0),
    },
    first_pass_independent_review_rate: ratio(firstPassCount, reviewedPrs.length),
    first_review_to_merge_duration: durationSummary(durations),
    head_binding_coverage: ratio(exactMarkers, protocolMarkers),
    deterministic_fingerprint: artifactDigest({
      source_manifest_sha256: sourceRef.sha256,
      pr_rounds: prBaselines.map((pr) => ({
        pr_number: pr.pr_number,
        rounds: pr.rounds.map((round) => [round.review_ref, round.reviewed_head_sha, round.verdict]),
      })),
    }),
  };
  validateArtifacts({ manifest, inventory, baseline });
  return { manifest, inventory, baseline };
}

export function replayReviewHarvest({ manifestPath, outputDir }) {
  const corpus = loadSnapshotCorpus(manifestPath);
  const artifacts = normalizeSnapshotCorpus(corpus);
  fs.mkdirSync(outputDir, { recursive: true });
  writeCanonicalJson(path.join(outputDir, SNAPSHOT_MANIFEST_FILENAME), artifacts.manifest);
  writeCanonicalJson(path.join(outputDir, INVENTORY_FILENAME), artifacts.inventory);
  writeCanonicalJson(path.join(outputDir, BASELINE_FILENAME), artifacts.baseline);
  return {
    artifacts,
    digests: {
      snapshot_manifest: sha256Bytes(Buffer.from(canonicalJson(artifacts.manifest), 'utf8')),
      blocker_inventory: sha256Bytes(Buffer.from(canonicalJson(artifacts.inventory), 'utf8')),
      review_round_baseline: sha256Bytes(Buffer.from(canonicalJson(artifacts.baseline), 'utf8')),
      output_set: artifactDigest([
        sha256Bytes(Buffer.from(canonicalJson(artifacts.manifest), 'utf8')),
        sha256Bytes(Buffer.from(canonicalJson(artifacts.inventory), 'utf8')),
        sha256Bytes(Buffer.from(canonicalJson(artifacts.baseline), 'utf8')),
      ]),
    },
  };
}
