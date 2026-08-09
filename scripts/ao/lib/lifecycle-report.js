import { adaptLifecycleReportForObservation } from './release-judgment.js';

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
  const suggestions = [...new Set(orderedActions.flatMap((action) => {
    const commands = action.commands ?? [];
    if (commands.length) return commands;
    if (action.id) return [action.id];
    if (action.summary) return [action.summary];
    return [];
  }))];
  if (!suggestions.length) return 'none';
  return suggestions.join(' | ');
}

function formatClaimValue(claims, claim) {
  if (claims == null || !Object.hasOwn(claims, claim)) return 'missing';
  const value = claims[claim];
  if (typeof value === 'boolean') return String(value);
  const serialized = JSON.stringify(value);
  return `invalid(${serialized === undefined ? String(value) : serialized})`;
}

export function renderLifecycleHumanSummary(report) {
  const observedReport = adaptLifecycleReportForObservation(report);
  const releaseDecision = observedReport.release_decision;
  const releaseObservation = observedReport.release_decision_observation;
  return [
    `top_status: ${observedReport.top_status}`,
    `trigger: ${observedReport.scope.trigger}`,
    `routing: ${observedReport.routing_decision.action} owner=${observedReport.routing_decision.owner_session ?? 'none'} authoritative=${String(observedReport.routing_decision.authoritative)}`,
    `release: ${releaseDecision.disposition} authoritative=${String(releaseDecision.authoritative)}${releaseObservation?.disposition !== releaseDecision.disposition ? ` observed_as=${releaseObservation.disposition}` : ''}`,
    ...(releaseObservation?.authority_scope == null ? [] : [
      `release_authority: ${releaseObservation.authority_scope} claims_merge=${formatClaimValue(releaseObservation.claims, 'merge')} claims_external_effect=${formatClaimValue(releaseObservation.claims, 'external_effect')} claims_human_approval=${formatClaimValue(releaseObservation.claims, 'human_approval')}`,
    ]),
    `source_health: reconciliation=${observedReport.source_health.reconciliation}, doctor=${observedReport.source_health.doctor}`,
    `key_findings: ${summarizeFindings(observedReport.findings)}`,
    `suggested_actions: ${summarizeActions(observedReport.actions)}`,
  ].join('\n');
}
