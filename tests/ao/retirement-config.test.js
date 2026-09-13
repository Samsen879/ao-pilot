import {test, expect} from '@jest/globals';
import yaml from 'js-yaml';
import {retireLegacyProject} from '../../scripts/ao/lib/retirement-config.js';
const original = {port:3000, defaults:{agent:'codex'}, projects:{'agent-orchestrator':{path:'/repo/agent-orchestrator'}, 'ciecopilot-home':{path:'/repo/ciecopilot-home',sessionPrefix:'cie',agentRules:'retain',agentConfig:{model:'original'}}, other:{path:'/repo/other'}}};
test('retires only the old project while preserving CIE and unrelated configuration',()=>{
  const source=yaml.safeDump(original), result=retireLegacyProject(source,'/repo/ao-pilot');
  expect(result.config.projects['agent-orchestrator']).toBeUndefined();
  expect(result.config.projects['ciecopilot-home']).toEqual(original.projects['ciecopilot-home']);
  expect(result.config.projects.other).toEqual(original.projects.other);
  expect(result.config.defaults).toEqual(original.defaults);
  expect(result.config.projects['ao-pilot'].repo).toBe('Samsen879/ao-pilot');
  expect(retireLegacyProject(result.text,'/repo/ao-pilot').config).toEqual(result.config);
});
test('fails closed for missing CIE or conflicting pilot identity',()=>{
  expect(()=>retireLegacyProject('projects: {}','/repo/ao-pilot')).toThrow();
  const config=structuredClone(original);config.projects['ao-pilot']={path:'/wrong/ao-pilot'};
  expect(()=>retireLegacyProject(yaml.safeDump(config),'/repo/ao-pilot')).toThrow();
  expect(()=>retireLegacyProject(yaml.safeDump(original),'relative')).toThrow();
});
