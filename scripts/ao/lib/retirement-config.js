import path from 'node:path';
import yaml from 'js-yaml';

// Keep the config's real path and every non-retired project unchanged:
// live session namespaces and .origin receipts bind that path.
export function retireLegacyProject(source, pilotPath) {
  if (!path.isAbsolute(pilotPath) || path.basename(pilotPath) !== 'ao-pilot') throw new Error('Expected absolute ao-pilot checkout');
  const config = yaml.safeLoad(source);
  if (!config?.projects?.['ciecopilot-home']) throw new Error('Missing live CIE project; HOLD');
  const retired = config.projects['agent-orchestrator'];
  if (retired && path.basename(retired.path || '') !== 'agent-orchestrator') throw new Error('Unexpected retired project path; HOLD');
  if (config.projects['ao-pilot'] && config.projects['ao-pilot'].path !== pilotPath) throw new Error('Existing ao-pilot project binding differs; HOLD');
  delete config.projects['agent-orchestrator'];
  config.projects['ao-pilot'] ??= {
    name: 'ao-pilot', repo: 'Samsen879/ao-pilot', path: pilotPath,
    defaultBranch: 'main', sessionPrefix: 'ap', symlinks: [],
    agentRules: 'Preserve unrelated changes. Use ao-pilot owned source and deployment only. Keep the original Dashboard layout and localhost-only listeners. Do not import desktop code or launch the retired agent-orchestrator checkout. Do not merge or delete remote refs without explicit Owner authorization.',
  };
  return {config, text: yaml.safeDump(config, {lineWidth: -1, noRefs: true}), retiredPath: retired?.path ?? null};
}
