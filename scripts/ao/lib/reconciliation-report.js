function formatList(values) {
  if (!values?.length) return 'none';
  return values.join(', ');
}

const FINDING_SEVERITY_ORDER = new Map([
  ['blocker', 0],
  ['ambiguous', 1],
  ['warning', 2],
  ['info', 3],
]);

function sortFindings(findings) {
  return [...(findings ?? [])].sort((left, right) => {
    const leftRank = FINDING_SEVERITY_ORDER.get(left?.severity) ?? 99;
    const rightRank = FINDING_SEVERITY_ORDER.get(right?.severity) ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return String(left?.code ?? '').localeCompare(String(right?.code ?? ''));
  });
}

function summarizeOwnership(assessments) {
  if (!assessments?.length) return 'none';

  return assessments.map((assessment) => {
    const prNumber = assessment?.pr_number ?? 'unknown';
    const ownership = assessment?.ownership ?? {};

    if (ownership.status === 'clear' && ownership.owner_session) {
      return `PR #${prNumber} clear via ${ownership.owner_session}`;
    }
    if (ownership.status === 'stale' && ownership.owner_session) {
      return `PR #${prNumber} stale via ${ownership.owner_session}`;
    }
    if (ownership.status === 'ambiguous' && ownership.candidate_sessions?.length) {
      return `PR #${prNumber} ambiguous via ${ownership.candidate_sessions.join('/')}`;
    }

    return `PR #${prNumber} ${ownership.status ?? 'unknown'}`;
  }).join('; ');
}

function summarizeReleaseReadiness(assessments) {
  if (!assessments?.length) return 'none';

  return assessments.map((assessment) => (
    `PR #${assessment?.pr_number ?? 'unknown'} ${assessment?.release_readiness?.status ?? 'unknown'}`
  )).join('; ');
}

function summarizeFindings(findings) {
  const ordered = sortFindings(findings);
  if (!ordered.length) return 'none';

  return ordered
    .map((finding) => `[${finding.severity}] ${finding.code}: ${finding.summary}`)
    .join('; ');
}

function summarizeActions(actions) {
  if (!actions?.length) return 'none';
  return actions.map((action) => action.action_class).join(', ');
}

export function renderHumanSummary(report) {
  return [
    `top_status: ${report.top_status}`,
    `automation_disposition: ${report.automation_disposition}`,
    `source_health: ao=${report.source_health.ao}, github=${report.source_health.github}`,
    `selected_prs: ${report.project_summary.selected_pr_count}`,
    `selection_basis: ${formatList(report.project_summary.basis)}`,
    `ready_prs: ${formatList(report.project_summary.ready_pr_numbers)}`,
    `blocked_prs: ${formatList(report.project_summary.blocked_pr_numbers)}`,
    `ambiguous_prs: ${formatList(report.project_summary.ambiguous_pr_numbers)}`,
    `warning_prs: ${formatList(report.project_summary.warning_pr_numbers)}`,
    `not_applicable_prs: ${formatList(report.project_summary.not_applicable_pr_numbers)}`,
    `ownership_summary: ${summarizeOwnership(report.pr_assessments)}`,
    `release_readiness_summary: ${summarizeReleaseReadiness(report.pr_assessments)}`,
    `handoff_summary: inspections=${report.handoff_summary?.inspection_count ?? 0}, active=${report.handoff_summary?.active_count ?? 0}, ambiguous=${report.handoff_summary?.ambiguous_count ?? 0}, accepted=${report.handoff_summary?.accepted_count ?? 0}`,
    `key_findings: ${summarizeFindings(report.findings)}`,
    `recommended_actions: ${summarizeActions(report.recommended_actions)}`,
  ].join('\n');
}
