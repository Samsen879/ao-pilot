import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import yaml from 'js-yaml';
export function planCieCutover({ configPath, sessionsDir }) {
  const bytes = fs.readFileSync(configPath);
  const legacy = yaml.safeLoad(bytes.toString());
  const project = legacy.projects?.['ciecopilot-home'];
  if (!project || !path.isAbsolute(project.path)) throw new Error('Missing/invalid CIE project');
  const config = { defaultBranch: project.defaultBranch || 'main', sessionPrefix: project.sessionPrefix || 'cie',
    symlinks: project.symlinks || [], agentRules: typeof project.agentRules === 'string' ? project.agentRules : '',
    worker: {agent:'codex'}, orchestrator:{agent:'codex'}, reviewers:[{harness:'codex'}] };
  const supported = new Set(['name','repo','path','defaultBranch','sessionPrefix','symlinks','agentRules']);
  config.agentRules = config.agentRules
    .replace('Use the host-level multi-project AO; this repository does not own or embed an AO runtime.', 'Use the ao-pilot managed headless runtime and localhost Dashboard; CIE does not embed runtime source.')
    .replace('Before acting on stale state, verify `ao status --project ciecopilot-home --json` and the live GitHub PR/check state.', 'Before acting on stale state, verify native session state against the active AO_DATA_DIR/AO_RUN_FILE and live GitHub PR/check state.')
    .replace('Confirm command syntax with `ao <command> --help`; never use retired `ao-pilot` package commands or the removed single-project configuration.', 'Resolve the exact managed binary through ao-pilot runtime-path. Confirm native subcommand syntax with that binary; never use a PATH-shadowed ao or load the retired repository.');
  const unsupported = Object.keys(project).filter(key => !supported.has(key));
  const sessions = ['cie-111','cie-orchestrator'].map(id => {
    const source = path.join(sessionsDir,id), bytes = fs.readFileSync(source);
    const fields = Object.fromEntries(bytes.toString().split('\n').filter(line=>line.includes('=')).map(line=>{ const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)]; }));
    return {id,source,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),workspace:fields.worktree,branch:fields.branch,pr:fields.pr||null,
      disposition:'HOLD_LEGACY_SESSION_NOT_IMPORTED',reason:'p0.4 project importer does not register existing legacy session/workspace/transcript identity'};
  });
  return { schema_version:'ao.cie-cutover-plan.v1', source_config:configPath, source_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
    project:{id:'ciecopilot-home',path:project.path,name:project.name||'CIE Copilot Home',config},unsupported_fields:unsupported,sessions };
}
