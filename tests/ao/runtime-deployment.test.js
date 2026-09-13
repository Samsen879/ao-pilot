import {test,expect,afterEach} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deploymentBinding,resolveDeploymentEnvironment} from '../../scripts/ao/lib/runtime-deployment.js';
let root;
afterEach(()=>{if(root)fs.rmSync(root,{recursive:true,force:true});root=null;});
test('deployment binding aligns default CLI and preserves explicit private runtime',()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-deploy-test-'));
  fs.mkdirSync(path.join(root,'.config/ao-pilot'),{recursive:true});
  fs.writeFileSync(path.join(root,'.config/ao-pilot/runtime-binding.json'),JSON.stringify(deploymentBinding(root)));
  expect(resolveDeploymentEnvironment({HOME:root}).AO_RUN_FILE).toBe(path.join(root,'.local/share/ao-pilot/cie-runtime/running.json'));
  expect(resolveDeploymentEnvironment({HOME:root,AO_DATA_DIR:'/explicit'})).toEqual({HOME:root,AO_DATA_DIR:'/explicit'});
  fs.writeFileSync(path.join(root,'.config/ao-pilot/runtime-binding.json'),JSON.stringify({...deploymentBinding(root),data_dir:'/foreign'}));
  expect(()=>resolveDeploymentEnvironment({HOME:root})).toThrow();
});
