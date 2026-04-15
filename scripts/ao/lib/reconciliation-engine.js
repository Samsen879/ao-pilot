import {
  REPORT_FORMAT,
  SCHEMA_VERSION,
  createFinding,
  createProjectSummary,
} from './reconciliation-contracts.js';
import {
  collectGateBlockerCodes,
  createGate,
  createGateSnapshot,
} from './gate-model.js';

function deriveSourceHealth(observation) {
  if (!observation?.source_ok) return 'failed';
  if ((observation?.raw_summary?.orchestrator_count ?? 0) > 1) return 'degraded';
  if (observation?.source_error) return 'degraded';
  return 'ok';
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).filter(Boolean).map((value) => String(value)))];
}

function createNotApplicableGate(name, reasonCode) {
  return createGate({
    name,
    state: 'not_applicable',
    reason_codes: [reasonCode],
  });
}

function deriveOwnershipGate(ownership) {
  switch (ownership?.status) {
    case 'clear':
      return createGate({
        name: 'ownership',
        state: 'open',
      });
    case 'stale':
      return createGate({
        name: 'ownership',
        state: 'pending',
        reason_codes: ['ownership_stale'],
      });
    case 'orphaned':
      return createGate({
        name: 'ownership',
        state: 'blocked',
        blocker_codes: ['orphan_open_pr'],
        reason_codes: ['ownership_orphaned'],
      });
    case 'ambiguous':
      return createGate({
        name: 'ownership',
        state: 'ambiguous',
        reason_codes: [ownership.reason === 'branch_mismatch_with_github' ? 'branch_mismatch_with_github' : 'ownership_ambiguous'],
      });
    case 'unknown':
    default:
      return createGate({
        name: 'ownership',
        state: 'ambiguous',
        reason_codes: ['ownership_unknown'],
      });
  }
}

function deriveReviewGate(pr) {
  if (pr.review_status === 'changes_requested') {
    return createGate({
      name: 'review',
      state: 'blocked',
      blocker_codes: ['review_blocked'],
    });
  }

  if (pr.review_status === 'approved') {
    return createGate({
      name: 'review',
      state: 'open',
    });
  }

  if (pr.review_status === 'pending') {
    return createGate({
      name: 'review',
      state: 'pending',
      reason_codes: ['review_pending'],
    });
  }

  return createGate({
    name: 'review',
    state: 'ambiguous',
    reason_codes: ['review_unknown'],
  });
}

function deriveCiGate(pr) {
  if (pr.ci_status === 'failing') {
    return createGate({
      name: 'ci',
      state: 'blocked',
      blocker_codes: ['ci_blocked'],
    });
  }

  if (pr.ci_status === 'passing') {
    return createGate({
      name: 'ci',
      state: 'open',
    });
  }

  if (pr.ci_status === 'pending') {
    return createGate({
      name: 'ci',
      state: 'pending',
      reason_codes: ['ci_pending'],
    });
  }

  return createGate({
    name: 'ci',
    state: 'ambiguous',
    reason_codes: ['ci_unknown'],
  });
}

function deriveMergeabilityGate(pr) {
  if (pr.mergeability === 'conflicting') {
    return createGate({
      name: 'mergeability',
      state: 'blocked',
      blocker_codes: ['merge_conflict_blocked'],
    });
  }

  if (pr.mergeability === 'mergeable') {
    return createGate({
      name: 'mergeability',
      state: 'open',
    });
  }

  return createGate({
    name: 'mergeability',
    state: 'ambiguous',
    reason_codes: ['mergeability_unknown'],
  });
}

function buildReleaseReadinessGates(pr, ownership) {
  if (!pr || pr.state !== 'OPEN') {
    return createGateSnapshot({
      ownership: createNotApplicableGate('ownership', 'pr_not_open'),
      review: createNotApplicableGate('review', 'pr_not_open'),
      ci: createNotApplicableGate('ci', 'pr_not_open'),
      mergeability: createNotApplicableGate('mergeability', 'pr_not_open'),
      release: createNotApplicableGate('release', 'pr_not_open'),
    });
  }

  if (pr.is_draft === true) {
    return createGateSnapshot({
      ownership: createNotApplicableGate('ownership', 'draft_pr'),
      review: createNotApplicableGate('review', 'draft_pr'),
      ci: createNotApplicableGate('ci', 'draft_pr'),
      mergeability: createNotApplicableGate('mergeability', 'draft_pr'),
      release: createNotApplicableGate('release', 'draft_pr'),
    });
  }

  const ownershipGate = deriveOwnershipGate(ownership);
  const reviewGate = deriveReviewGate(pr);
  const ciGate = deriveCiGate(pr);
  const mergeabilityGate = deriveMergeabilityGate(pr);
  const prereleaseGates = createGateSnapshot({
    ownership: ownershipGate,
    review: reviewGate,
    ci: ciGate,
    mergeability: mergeabilityGate,
  });
  const blockerCodes = collectGateBlockerCodes(prereleaseGates);
  const pendingReasonCodes = uniqueStrings(
    Object.values(prereleaseGates)
      .filter((gate) => gate.state === 'pending')
      .flatMap((gate) => gate.reason_codes ?? []),
  );
  const ambiguousReasonCodes = uniqueStrings(
    Object.values(prereleaseGates)
      .filter((gate) => gate.state === 'ambiguous')
      .flatMap((gate) => gate.reason_codes ?? []),
  );

  let releaseGate;
  if (blockerCodes.length) {
    releaseGate = createGate({
      name: 'release',
      state: 'blocked',
      blocker_codes: blockerCodes,
      reason_codes: ownershipGate.state === 'blocked' ? ['ownership_orphaned'] : [],
    });
  } else if (pendingReasonCodes.length) {
    releaseGate = createGate({
      name: 'release',
      state: 'pending',
      reason_codes: pendingReasonCodes,
    });
  } else if (ambiguousReasonCodes.length) {
    releaseGate = createGate({
      name: 'release',
      state: 'ambiguous',
      reason_codes: ambiguousReasonCodes,
    });
  } else {
    releaseGate = createGate({
      name: 'release',
      state: 'open',
      reason_codes: ['all_release_signals_clear'],
    });
  }

  return createGateSnapshot({
    ...prereleaseGates,
    release: releaseGate,
  });
}

function resolveOwnership(pr, workers) {
  const directMatches = (workers ?? []).filter((worker) => worker.pr_number === pr.pr_number);
  const branchMatches = directMatches.length
    ? []
    : (workers ?? []).filter((worker) => worker.branch_name && pr.head_branch && worker.branch_name === pr.head_branch);
  const winningMatches = directMatches.length ? directMatches : branchMatches;

  if (!winningMatches.length) {
    return {
      status: 'orphaned',
      pr_number: pr.pr_number,
      branch_name: pr.head_branch ?? null,
      owner_session: null,
      candidate_sessions: [],
      candidate_linkage_basis: [],
      reason: 'no_matching_worker',
    };
  }

  if (winningMatches.length > 1) {
    return {
      status: 'ambiguous',
      pr_number: pr.pr_number,
      branch_name: pr.head_branch ?? null,
      owner_session: null,
      candidate_sessions: winningMatches.map((worker) => worker.session_name),
      candidate_linkage_basis: uniqueStrings(winningMatches.flatMap((worker) => worker.linkage_basis ?? [])),
      reason: 'multiple_candidate_workers',
    };
  }

  const [worker] = winningMatches;
  if (
    directMatches.length === 1
    && worker.branch_name
    && pr.head_branch
    && worker.branch_name !== pr.head_branch
  ) {
    return {
      status: 'ambiguous',
      pr_number: pr.pr_number,
      branch_name: pr.head_branch ?? null,
      owner_session: worker.session_name,
      owner_branch_name: worker.branch_name ?? null,
      candidate_sessions: [worker.session_name],
      candidate_linkage_basis: uniqueStrings(worker.linkage_basis ?? []),
      reason: 'branch_mismatch_with_github',
    };
  }

  if (worker.freshness?.status === 'stale') {
    return {
      status: 'stale',
      pr_number: pr.pr_number,
      branch_name: pr.head_branch ?? null,
      owner_session: worker.session_name,
      owner_branch_name: worker.branch_name ?? null,
      candidate_sessions: [worker.session_name],
      candidate_linkage_basis: uniqueStrings(worker.linkage_basis ?? []),
      reason: 'stale_worker_session',
    };
  }

  if (worker.freshness?.status === 'unknown') {
    return {
      status: 'unknown',
      pr_number: pr.pr_number,
      branch_name: pr.head_branch ?? null,
      owner_session: worker.session_name,
      owner_branch_name: worker.branch_name ?? null,
      candidate_sessions: [worker.session_name],
      candidate_linkage_basis: uniqueStrings(worker.linkage_basis ?? []),
      reason: 'unknown_worker_freshness',
    };
  }

  return {
    status: 'clear',
    pr_number: pr.pr_number,
    branch_name: pr.head_branch ?? null,
    owner_session: worker.session_name,
    owner_branch_name: worker.branch_name ?? null,
    candidate_sessions: [worker.session_name],
    candidate_linkage_basis: uniqueStrings(worker.linkage_basis ?? []),
    reason: null,
  };
}

function deriveReleaseReadiness(pr, ownership) {
  const warnings = [];
  const gates = buildReleaseReadinessGates(pr, ownership);
  const blockerCodes = collectGateBlockerCodes(gates);
  const releaseGate = gates.release;

  if (!pr || pr.state !== 'OPEN') {
    return {
      status: 'not_applicable',
      blockers: blockerCodes,
      blocker_codes: blockerCodes,
      warnings,
      basis: ['pr_not_open'],
      gates,
    };
  }

  if (pr.is_draft === true) {
    warnings.push('draft_pr_not_releasable');
    return {
      status: 'not_applicable',
      blockers: blockerCodes,
      blocker_codes: blockerCodes,
      warnings,
      basis: ['draft_pr'],
      gates,
    };
  }

  if (ownership.status === 'stale') warnings.push('stale_worker_session');

  if (releaseGate?.state === 'blocked') {
    return {
      status: 'blocked',
      blockers: blockerCodes,
      blocker_codes: blockerCodes,
      warnings,
      basis: blockerCodes.includes('orphan_open_pr') ? ['ownership_orphaned'] : [...blockerCodes],
      gates,
    };
  }

  if (releaseGate?.state === 'pending' || releaseGate?.state === 'ambiguous') {
    return {
      status: 'ambiguous',
      blockers: blockerCodes,
      blocker_codes: blockerCodes,
      warnings,
      basis: releaseGate.reason_codes?.length ? [...releaseGate.reason_codes] : ['fallback_ambiguous'],
      gates,
    };
  }

  if (releaseGate?.state === 'open') {
    return {
      status: 'ready',
      blockers: blockerCodes,
      blocker_codes: blockerCodes,
      warnings,
      basis: ['all_release_signals_clear'],
      gates,
    };
  }

  return {
    status: 'ambiguous',
    blockers: blockerCodes,
    blocker_codes: blockerCodes,
    warnings,
    basis: ['fallback_ambiguous'],
    gates,
  };
}

function buildPrFindings(pr, ownership, releaseReadiness) {
  const findings = [];

  if (ownership.status === 'orphaned') {
    findings.push(createFinding({
      code: 'orphan_open_pr',
      severity: 'blocker',
      subject_type: 'pr',
      subject_id: pr.pr_number,
      summary: `Open PR #${pr.pr_number} has no healthy AO owner`,
      details: ['No worker matched the PR number or head branch.'],
      evidence_refs: [{ source: 'github', kind: 'pr', id: pr.pr_number, summary: 'PR is OPEN' }],
    }));
  }

  if (ownership.status === 'ambiguous' && (ownership.candidate_sessions?.length ?? 0) > 1) {
    findings.push(createFinding({
      code: 'multiple_candidate_workers',
      severity: 'ambiguous',
      subject_type: 'ownership',
      subject_id: pr.pr_number,
      summary: `PR #${pr.pr_number} has multiple candidate workers`,
      details: ownership.candidate_sessions,
      evidence_refs: ownership.candidate_sessions.map((sessionName) => ({
        source: 'ao',
        kind: 'session',
        id: sessionName,
        summary: 'Matched winning ownership tier',
      })),
    }));
  }

  if (ownership.reason === 'branch_mismatch_with_github') {
    findings.push(createFinding({
      code: 'ao_github_branch_disagreement',
      severity: 'ambiguous',
      subject_type: 'ownership',
      subject_id: pr.pr_number,
      summary: `PR #${pr.pr_number} AO ownership branch disagrees with GitHub`,
      details: [
        `ao_branch: ${ownership.owner_branch_name ?? 'unknown'}`,
        `github_branch: ${pr.head_branch ?? 'unknown'}`,
      ],
      evidence_refs: [
        {
          source: 'ao',
          kind: 'session',
          id: ownership.owner_session,
          summary: 'Matched worker branch differs from GitHub head branch',
        },
        {
          source: 'github',
          kind: 'pr',
          id: pr.pr_number,
          summary: 'GitHub head branch is canonical for PR truth',
        },
      ].filter((ref) => ref.id != null),
    }));
  }

  if (ownership.status === 'stale') {
    findings.push(createFinding({
      code: 'stale_worker_session',
      severity: 'warning',
      subject_type: 'session',
      subject_id: ownership.owner_session,
      summary: `PR #${pr.pr_number} is linked to a stale worker`,
      details: [ownership.owner_session ?? 'unknown-session'],
      evidence_refs: ownership.owner_session ? [{
        source: 'ao',
        kind: 'session',
        id: ownership.owner_session,
        summary: 'Worker freshness is stale',
      }] : [],
    }));
  }

  if (pr.review_status === 'changes_requested') {
    findings.push(createFinding({
      code: 'review_blocked',
      severity: 'blocker',
      subject_type: 'pr',
      subject_id: pr.pr_number,
      summary: `PR #${pr.pr_number} is blocked by review`,
      details: ['GitHub review decision is changes requested.'],
      evidence_refs: [{ source: 'github', kind: 'review', id: pr.pr_number, summary: 'Review decision is CHANGES_REQUESTED' }],
    }));
  }

  if (pr.ci_status === 'failing') {
    findings.push(createFinding({
      code: 'ci_blocked',
      severity: 'blocker',
      subject_type: 'pr',
      subject_id: pr.pr_number,
      summary: `PR #${pr.pr_number} is blocked by CI`,
      details: ['At least one required check is failing.'],
      evidence_refs: [{ source: 'github', kind: 'check', id: pr.pr_number, summary: 'CI status is failing' }],
    }));
  }

  if (pr.mergeability === 'conflicting') {
    findings.push(createFinding({
      code: 'merge_conflict_blocked',
      severity: 'blocker',
      subject_type: 'pr',
      subject_id: pr.pr_number,
      summary: `PR #${pr.pr_number} has merge conflicts`,
      details: ['GitHub mergeability is conflicting.'],
      evidence_refs: [{ source: 'github', kind: 'mergeability', id: pr.pr_number, summary: 'Mergeability is conflicting' }],
    }));
  }

  if (pr.mergeability === 'unknown') {
    findings.push(createFinding({
      code: 'mergeability_unknown',
      severity: 'ambiguous',
      subject_type: 'pr',
      subject_id: pr.pr_number,
      summary: `PR #${pr.pr_number} has unknown mergeability`,
      details: ['GitHub mergeability is unknown.'],
      evidence_refs: [{ source: 'github', kind: 'mergeability', id: pr.pr_number, summary: 'Mergeability is unknown' }],
    }));
  }

  if (pr.is_draft === true) {
    findings.push(createFinding({
      code: 'draft_pr_not_releasable',
      severity: 'warning',
      subject_type: 'pr',
      subject_id: pr.pr_number,
      summary: `PR #${pr.pr_number} is draft and not releasable`,
      details: ['Draft PRs are not release-ready in phase 1.'],
      evidence_refs: [{ source: 'github', kind: 'pr', id: pr.pr_number, summary: 'PR is draft' }],
    }));
  }

  if (releaseReadiness.status === 'ambiguous') {
    findings.push(createFinding({
      code: 'release_readiness_ambiguous',
      severity: 'ambiguous',
      subject_type: 'release_readiness',
      subject_id: pr.pr_number,
      summary: `PR #${pr.pr_number} is not clearly releasable`,
      details: releaseReadiness.basis,
      evidence_refs: [{ source: 'repo_local', kind: 'assessment', id: pr.pr_number, summary: 'Release readiness is ambiguous' }],
    }));
  }

  return findings;
}

function deriveTopStatus(sourceHealth, prAssessments, findings) {
  if (sourceHealth.ao === 'failed' || sourceHealth.github === 'failed') return 'source_failure';
  if (prAssessments.some((assessment) => assessment.release_readiness.status === 'blocked') || findings.some((finding) => finding.severity === 'blocker')) {
    return 'blocked';
  }
  if (prAssessments.some((assessment) => assessment.release_readiness.status === 'ambiguous') || findings.some((finding) => finding.severity === 'ambiguous')) {
    return 'ambiguous';
  }
  if (findings.some((finding) => finding.severity === 'warning')) {
    return 'warning';
  }
  return 'healthy';
}

function deriveAutomationDisposition(sourceHealth, prAssessments, findings) {
  if (sourceHealth.ao === 'failed' || sourceHealth.github === 'failed') return 'source_failure';
  if (prAssessments.some((assessment) => assessment.release_readiness.status === 'ambiguous') || findings.some((finding) => finding.severity === 'ambiguous')) {
    return 'human_gate';
  }
  if (prAssessments.some((assessment) => assessment.release_readiness.status === 'blocked') || findings.some((finding) => finding.severity === 'blocker')) {
    return 'pause';
  }
  return 'continue';
}

function deriveRecommendedActions(automationDisposition) {
  if (automationDisposition === 'source_failure') {
    return [{ action_class: 'refresh_ao_runtime', summary: 'Refresh AO or GitHub observation sources before acting.' }];
  }
  if (automationDisposition === 'human_gate') {
    return [{ action_class: 'require_human_review', summary: 'A human or orchestrator inspection is required before proceeding.' }];
  }
  if (automationDisposition === 'pause') {
    return [{ action_class: 'pause_autonomy', summary: 'Do not continue autonomous delivery until blockers are resolved.' }];
  }
  return [{ action_class: 'continue_observe', summary: 'Continue observing the PR under the current owner.' }];
}

function buildSourceFindings({ projectId, aoObservation, githubObservation }) {
  const findings = [];

  if (!aoObservation?.source_ok) {
    findings.push(createFinding({
      code: 'ao_source_failed',
      severity: 'ambiguous',
      subject_type: 'project',
      subject_id: projectId,
      summary: 'AO runtime could not be observed reliably.',
      details: [aoObservation?.source_error ?? 'AO observation failed.'],
      evidence_refs: [],
    }));
    findings.push(createFinding({
      code: 'ao_project_not_observable',
      severity: 'ambiguous',
      subject_type: 'project',
      subject_id: projectId,
      summary: 'The AO project is not currently observable.',
      details: [aoObservation?.source_error ?? 'AO project status could not be read.'],
      evidence_refs: [],
    }));
  }

  if (!githubObservation?.source_ok) {
    findings.push(createFinding({
      code: 'github_source_failed',
      severity: 'ambiguous',
      subject_type: 'project',
      subject_id: projectId,
      summary: 'GitHub PR state could not be observed reliably.',
      details: [githubObservation?.source_error ?? 'GitHub observation failed.'],
      evidence_refs: [],
    }));
  }

  return findings;
}

function buildAoRuntimeFindings({ projectId, aoObservation }) {
  const findings = [];
  if (!aoObservation?.source_ok) return findings;

  const orchestrator = aoObservation?.orchestrator ?? null;
  const orchestratorCount = Number(aoObservation?.raw_summary?.orchestrator_count ?? (orchestrator ? 1 : 0));
  const orchestratorSessionNames = Array.isArray(aoObservation?.raw_summary?.orchestrator_session_names)
    ? aoObservation.raw_summary.orchestrator_session_names
    : [];

  if (orchestratorCount === 0) {
    findings.push(createFinding({
      code: 'no_orchestrator_session',
      severity: 'warning',
      subject_type: 'project',
      subject_id: projectId,
      summary: 'No orchestrator session is currently visible in AO runtime.',
      details: ['AO observation returned no orchestrator session.'],
      evidence_refs: [],
    }));
  }

  if (orchestratorCount > 1) {
    findings.push(createFinding({
      code: 'multiple_orchestrator_sessions',
      severity: 'ambiguous',
      subject_type: 'project',
      subject_id: projectId,
      summary: 'More than one orchestrator session is currently visible in AO runtime.',
      details: orchestratorSessionNames.length ? orchestratorSessionNames : ['Multiple orchestrator candidates were observed.'],
      evidence_refs: orchestratorSessionNames.map((sessionName) => ({
        source: 'ao',
        kind: 'session',
        id: sessionName,
        summary: 'Visible orchestrator candidate',
      })),
    }));
    findings.push(createFinding({
      code: 'ao_runtime_ambiguous',
      severity: 'ambiguous',
      subject_type: 'project',
      subject_id: projectId,
      summary: 'AO runtime evidence is internally ambiguous.',
      details: ['Multiple orchestrator sessions are visible at the same time.'],
      evidence_refs: orchestratorSessionNames.map((sessionName) => ({
        source: 'ao',
        kind: 'session',
        id: sessionName,
        summary: 'Visible orchestrator candidate',
      })),
    }));
  }

  if (orchestrator?.freshness?.status === 'stale') {
    findings.push(createFinding({
      code: 'stale_orchestrator_session',
      severity: 'warning',
      subject_type: 'session',
      subject_id: orchestrator.session_name,
      summary: 'The visible orchestrator session is stale.',
      details: [orchestrator.session_name],
      evidence_refs: [{
        source: 'ao',
        kind: 'session',
        id: orchestrator.session_name,
        summary: 'Orchestrator freshness is stale',
      }],
    }));
  }

  return findings;
}

export function reconcileObservations({
  scope,
  aoObservation,
  githubObservation,
}) {
  const projectId = aoObservation?.project_id ?? 'unknown-project';
  const observedAt = githubObservation?.observed_at ?? aoObservation?.observed_at ?? new Date().toISOString();
  const sourceHealth = {
    ao: deriveSourceHealth(aoObservation),
    github: deriveSourceHealth(githubObservation),
  };

  const findings = [
    ...buildSourceFindings({ projectId, aoObservation, githubObservation }),
    ...buildAoRuntimeFindings({ projectId, aoObservation }),
  ];

  const workers = aoObservation?.workers ?? [];
  const prAssessments = (githubObservation?.prs ?? []).map((pr) => {
    const ownership = resolveOwnership(pr, workers);
    const releaseReadiness = deriveReleaseReadiness(pr, ownership);
    const prFindings = buildPrFindings(pr, ownership, releaseReadiness);
    findings.push(...prFindings);

    return {
      pr_number: pr.pr_number,
      branch_name: pr.head_branch ?? null,
      github: pr,
      ownership,
      release_readiness: releaseReadiness,
      findings: prFindings,
    };
  });

  const projectSummary = createProjectSummary({
    selected_pr_count: prAssessments.length,
    basis: scope?.selection_basis ?? [],
  });

  for (const assessment of prAssessments) {
    const { pr_number: prNumber } = assessment;
    if (assessment.release_readiness.status === 'ready') {
      projectSummary.ready_pr_numbers.push(prNumber);
    } else if (assessment.release_readiness.status === 'blocked') {
      projectSummary.blocked_pr_numbers.push(prNumber);
    } else if (assessment.release_readiness.status === 'ambiguous') {
      projectSummary.ambiguous_pr_numbers.push(prNumber);
    } else if (assessment.release_readiness.status === 'not_applicable') {
      projectSummary.not_applicable_pr_numbers.push(prNumber);
    }

    if (
      assessment.findings.some((finding) => finding.severity === 'warning') &&
      !projectSummary.warning_pr_numbers.includes(prNumber)
    ) {
      projectSummary.warning_pr_numbers.push(prNumber);
    }
  }

  const topStatus = deriveTopStatus(sourceHealth, prAssessments, findings);
  const automationDisposition = deriveAutomationDisposition(sourceHealth, prAssessments, findings);

  return {
    schema_version: SCHEMA_VERSION,
    report_format: REPORT_FORMAT,
    engine_version: 'phase1-foundation',
    project_id: projectId,
    observed_at: observedAt,
    scope,
    top_status: topStatus,
    automation_disposition: automationDisposition,
    source_health: sourceHealth,
    pr_assessments: prAssessments,
    project_summary: projectSummary,
    findings,
    recommended_actions: deriveRecommendedActions(automationDisposition),
  };
}
