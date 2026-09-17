import {test,expect,afterEach,jest} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deploymentBinding,resolveDeploymentEnvironment,resolveInstalledRuntimeServiceBinding} from '../../scripts/ao/lib/runtime-deployment.js';
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

test('partial service installs inherit the exact installed runtime service binding',()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-deploy-test-'));
  const packageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ao-installed-package-'));
  const binding=deploymentBinding(root);
  fs.mkdirSync(path.join(root,'.config/systemd/user'),{recursive:true});
  fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});
  fs.writeFileSync(path.join(packageRoot,'bin/ao-pilot.js'),'#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(root,'.config/systemd/user/ao-pilot-runtime.service'),[
    '[Service]',
    `WorkingDirectory=${packageRoot}`,
    `Environment="AO_DATA_DIR=${binding.data_dir}"`,
    `Environment="AO_RUN_FILE=${binding.run_file}"`,
    '',
  ].join('\n'));
  const execute=jest.fn().mockReturnValue(JSON.stringify({
    status:'verified',
    binary_path:'/installed/runtime/bin/ao',
    binary_sha256:'b'.repeat(64),
  }));
  try {
    expect(resolveInstalledRuntimeServiceBinding({home:root,execute})).toEqual({
      package_root:packageRoot,
      binary_path:'/installed/runtime/bin/ao',
      binary_sha256:'b'.repeat(64),
      data_dir:binding.data_dir,
      run_file:binding.run_file,
    });
    expect(execute).toHaveBeenCalledWith(process.execPath,[path.join(packageRoot,'bin/ao-pilot.js'),'runtime-path','--json'],expect.objectContaining({
      cwd:packageRoot,
      env:expect.objectContaining({HOME:root,AO_DATA_DIR:binding.data_dir,AO_RUN_FILE:binding.run_file}),
    }));
  } finally {
    fs.rmSync(packageRoot,{recursive:true,force:true});
  }
});

test('partial service installs hold on installed namespace drift',()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-deploy-test-'));
  const packageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ao-installed-package-'));
  fs.mkdirSync(path.join(root,'.config/systemd/user'),{recursive:true});
  fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});
  fs.writeFileSync(path.join(packageRoot,'bin/ao-pilot.js'),'#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(root,'.config/systemd/user/ao-pilot-runtime.service'),[
    '[Service]',
    `WorkingDirectory=${packageRoot}`,
    'Environment="AO_DATA_DIR=/foreign/data"',
    `Environment="AO_RUN_FILE=${deploymentBinding(root).run_file}"`,
    '',
  ].join('\n'));
  try {
    expect(()=>resolveInstalledRuntimeServiceBinding({home:root,execute:jest.fn()})).toThrow('binding drifted');
  } finally {
    fs.rmSync(packageRoot,{recursive:true,force:true});
  }
});
