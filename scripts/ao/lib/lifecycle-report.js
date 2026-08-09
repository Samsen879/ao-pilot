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
  const commands = [...new Set(orderedActions.flatMap((action) => action.commands ?? []))];
  if (!commands.length) return 'none';
  return commands.join(' | ');
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
      `release_authority: ${releaseObservation.authority_scope} claims_merge=${String(releaseObservation.claims?.merge === true)} claims_external_effect=${String(releaseObservation.claims?.external_effect === true)} claims_human_approval=${String(releaseObservation.claims?.human_approval === true)}`,
    ]),
    `source_health: reconciliation=${observedReport.source_health.reconciliation}, doctor=${observedReport.source_health.doctor}`,
    `key_findings: ${summarizeFindings(observedReport.findings)}`,
    `suggested_actions: ${summarizeActions(observedReport.actions)}`,
  ].join('\n');
}
