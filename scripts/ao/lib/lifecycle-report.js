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

function summarizeFindings(findings) {
  const ordered = sortFindings(findings);
  if (!ordered.length) return 'none';

  return ordered
    .map((finding) => `[${finding.severity}] ${finding.code}: ${finding.summary}`)
    .join('; ');
}

function summarizeActions(actions) {
  const orderedActions = [...(actions ?? [])].sort((left, right) => {
    if (left?.action_class !== right?.action_class) {
      return String(left?.action_class ?? '').localeCompare(String(right?.action_class ?? ''));
    }
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
  });
  const commands = [...new Set(orderedActions.flatMap((action) => action.commands ?? []))];
  if (!commands.length) return 'none';
  return commands.join(' | ');
}

export function renderLifecycleHumanSummary(report) {
  return [
    `top_status: ${report.top_status}`,
    `trigger: ${report.scope.trigger}`,
    `routing: ${report.routing_decision.action} owner=${report.routing_decision.owner_session ?? 'none'} authoritative=${String(report.routing_decision.authoritative)}`,
    `release: ${report.release_decision.disposition} authoritative=${String(report.release_decision.authoritative)}`,
    `source_health: reconciliation=${report.source_health.reconciliation}, doctor=${report.source_health.doctor}`,
    `key_findings: ${summarizeFindings(report.findings)}`,
    `suggested_actions: ${summarizeActions(report.actions)}`,
  ].join('\n');
}
