const FINDING_SEVERITY_ORDER = new Map([
  ['blocker', 0],
  ['ambiguous', 1],
  ['warning', 2],
  ['info', 3],
]);

function formatList(values) {
  if (!values?.length) return 'none';
  return values.join(', ');
}

function sortFindings(findings) {
  return [...(findings ?? [])].sort((left, right) => {
    const leftRank = FINDING_SEVERITY_ORDER.get(left?.severity) ?? 99;
    const rightRank = FINDING_SEVERITY_ORDER.get(right?.severity) ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return String(left?.code ?? '').localeCompare(String(right?.code ?? ''));
  });
}

function summarizeFindings(findings) {
  const ordered = sortFindings(findings);
  if (!ordered.length) return 'none';

  return ordered
    .map((finding) => `[${finding.severity}] ${finding.code}: ${finding.summary}`)
    .join('; ');
}

function summarizeSuggestedCommands(suggestions) {
  const commands = [...new Set((suggestions ?? []).flatMap((suggestion) => suggestion.commands ?? []))];
  if (!commands.length) return 'none';
  return commands.join(' | ');
}

export function renderDoctorHumanSummary(report) {
  const runtime = report.runtime ?? {};
  const githubAuth = report.authentication?.github ?? {};
  const codexAuth = report.authentication?.codex ?? {};
  return [
    `top_status: ${report.top_status}`,
    `source_health: reconciliation=${report.source_health.reconciliation}, ao=${report.source_health.ao}, github=${report.source_health.github}, git=${report.source_health.git}, worktree=${report.source_health.worktree}, runtime=${report.source_health.runtime ?? 'not_checked'}`,
    `runtime_status: ${runtime.status ?? 'not_checked'}`,
    `runtime_ref: ${runtime.runtime_ref ?? 'none'}`,
    `runtime_repository: ${runtime.source?.repository ?? 'none'}`,
    `runtime_version: ${runtime.source?.version ?? 'none'}`,
    `runtime_commit_sha: ${runtime.source?.commit_sha ?? 'none'}`,
    `runtime_tree_sha: ${runtime.source?.tree_sha ?? 'none'}`,
    `runtime_integrity: ${runtime.source?.integrity == null ? 'none' : `${runtime.source.integrity.algorithm}:${runtime.source.integrity.digest}`}`,
    `runtime_binary_path: ${runtime.binary_path ?? 'none'}`,
    `runtime_binary_sha256: ${runtime.binary_sha256 ?? 'none'}`,
    `runtime_compatibility: ao-pilot>=${runtime.compatibility?.ao_pilot?.minimum_version ?? 'none'}, ao-pilot<${runtime.compatibility?.ao_pilot?.maximum_exclusive_version ?? 'none'}`,
    `runtime_path_candidate: ${runtime.path_candidate ?? 'none'}`,
    `auth_github: available=${String(githubAuth.available ?? false)}, authenticated=${String(githubAuth.authenticated ?? false)}`,
    `auth_codex: available=${String(codexAuth.available ?? false)}, authenticated=${String(codexAuth.authenticated ?? false)}`,
    `reconciliation_top_status: ${report.reconciliation_summary.top_status ?? 'none'}`,
    `reconciliation_targets: ${formatList(report.reconciliation_summary.selected_pr_numbers)}`,
    `current_branch: ${report.local_state.current_branch ?? 'none'}`,
    `upstream_branch: ${report.local_state.upstream_branch ?? 'none'}`,
    `worktree_dirty: ${String(report.local_state.worktree_dirty)}`,
    `ao_artifacts: ${formatList(report.local_state.ao_artifact_paths)}`,
    `key_findings: ${summarizeFindings(report.findings)}`,
    `suggested_commands: ${summarizeSuggestedCommands(report.suggestions)}`,
  ].join('\n');
}
