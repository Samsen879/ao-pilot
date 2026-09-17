import {test,expect,afterEach,jest} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {deploymentBinding,resolveDeploymentEnvironment,resolveInstalledRuntimeServiceBinding} from '../../scripts/ao/lib/runtime-deployment.js';
let root;
afterEach(()=>{if(root)fs.rmSync(root,{recursive:true,force:true});root=null;});
function activeService(packageRoot,binding,{binary='/installed/runtime/bin/ao',digest='b'.repeat(64),environment={}}={}) {
  return {
    activeState:'active',mainPid:'123',packageRoot,
    argv:['/usr/bin/node',path.join(packageRoot,'scripts/ao-runtime-foreground.js')],
    environment:{AO_DATA_DIR:binding.data_dir,AO_RUN_FILE:binding.run_file,...environment},
    daemonPid:'124',daemonArgv:[binary,'daemon'],
    daemonEnvironment:{AO_DATA_DIR:binding.data_dir,AO_RUN_FILE:binding.run_file,...environment},
    daemonExecutable:binary,daemonSha256:digest,
  };
}
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
  fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});
  fs.mkdirSync(path.join(packageRoot,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(packageRoot,'bin/ao-pilot.js'),'#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(packageRoot,'scripts/ao-runtime-foreground.js'),'#!/usr/bin/env node\n');
  const service=activeService(packageRoot,binding,{environment:{AO_PILOT_RUNTIME_STORE:'/custom/runtime-store'}});
  const inspectService=jest.fn().mockReturnValue(service);
  const execute=jest.fn().mockReturnValue(JSON.stringify({
    status:'verified',
    binary_path:'/installed/runtime/bin/ao',
    binary_sha256:'b'.repeat(64),
  }));
  try {
    expect(resolveInstalledRuntimeServiceBinding({home:root,execute,inspectService})).toEqual({
      package_root:packageRoot,
      binary_path:'/installed/runtime/bin/ao',
      binary_sha256:'b'.repeat(64),
      store_root:'/custom/runtime-store',
      data_dir:binding.data_dir,
      run_file:binding.run_file,
    });
    expect(execute).toHaveBeenCalledWith('/usr/bin/node',[path.join(packageRoot,'bin/ao-pilot.js'),'runtime-path','--json'],expect.objectContaining({
      cwd:packageRoot,
      env:expect.objectContaining({HOME:root,AO_DATA_DIR:binding.data_dir,AO_RUN_FILE:binding.run_file,AO_PILOT_RUNTIME_STORE:'/custom/runtime-store'}),
    }));
    expect(inspectService).toHaveBeenCalledTimes(2);
  } finally {
    fs.rmSync(packageRoot,{recursive:true,force:true});
  }
});

test('partial service installs hold on installed namespace drift',()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-deploy-test-'));
  const packageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ao-installed-package-'));
  fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});
  fs.mkdirSync(path.join(packageRoot,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(packageRoot,'bin/ao-pilot.js'),'#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(packageRoot,'scripts/ao-runtime-foreground.js'),'#!/usr/bin/env node\n');
  const inspectService=jest.fn().mockReturnValue(activeService(packageRoot,deploymentBinding(root),{
    environment:{AO_DATA_DIR:'/foreign/data'},
  }));
  try {
    expect(()=>resolveInstalledRuntimeServiceBinding({home:root,execute:jest.fn(),inspectService})).toThrow('binding drifted');
  } finally {
    fs.rmSync(packageRoot,{recursive:true,force:true});
  }
});

test('partial service installs hold when the active service changes during inspection',()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-deploy-test-'));
  const packageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ao-installed-package-'));
  const binding=deploymentBinding(root);
  fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});
  fs.mkdirSync(path.join(packageRoot,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(packageRoot,'bin/ao-pilot.js'),'#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(packageRoot,'scripts/ao-runtime-foreground.js'),'#!/usr/bin/env node\n');
  const service=activeService(packageRoot,binding,{binary:'/runtime/ao'});
  const inspectService=jest.fn().mockReturnValueOnce(service).mockReturnValueOnce({...service,mainPid:'456'});
  const execute=jest.fn().mockReturnValue(JSON.stringify({status:'verified',binary_path:'/runtime/ao',binary_sha256:'b'.repeat(64)}));
  try {
    expect(()=>resolveInstalledRuntimeServiceBinding({home:root,execute,inspectService})).toThrow('changed during inspection');
  } finally {
    fs.rmSync(packageRoot,{recursive:true,force:true});
  }
});

test('partial service installs hold when the active daemon child does not match verified provenance',()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-deploy-test-'));
  const packageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ao-installed-package-'));
  const binding=deploymentBinding(root);
  fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});
  fs.mkdirSync(path.join(packageRoot,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(packageRoot,'bin/ao-pilot.js'),'#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(packageRoot,'scripts/ao-runtime-foreground.js'),'#!/usr/bin/env node\n');
  const inspectService=jest.fn().mockReturnValue(activeService(packageRoot,binding,{
    binary:'/runtime/ao',digest:'a'.repeat(64),
  }));
  const execute=jest.fn().mockReturnValue(JSON.stringify({
    status:'verified',binary_path:'/runtime/ao',binary_sha256:'b'.repeat(64),
  }));
  try {
    expect(()=>resolveInstalledRuntimeServiceBinding({home:root,execute,inspectService})).toThrow('daemon child');
  } finally {
    fs.rmSync(packageRoot,{recursive:true,force:true});
  }
});

test('default inspection derives identity from systemd MainPID and proc state',()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-deploy-test-'));
  const packageRoot='/installed/package';
  const binding=deploymentBinding(root);
  const awaitedDigest=crypto.createHash('sha256').update('active-daemon-bytes').digest('hex');
  const execute=jest.fn((command,args)=>{
    if(command==='systemctl')return args.includes('--property=ActiveState')?'active\n':'123\n';
    return JSON.stringify({status:'verified',binary_path:'/runtime/ao',binary_sha256:awaitedDigest});
  });
  const readFile=jest.fn(file=>{
    if(file==='/proc/123/cmdline')return Buffer.from(`/usr/bin/node\0${packageRoot}/scripts/ao-runtime-foreground.js\0`);
    if(file==='/proc/123/environ')return Buffer.from(`PATH=/usr/bin\0AO_DATA_DIR=${binding.data_dir}\0AO_RUN_FILE=${binding.run_file}\0`);
    if(file==='/proc/123/task/123/children')return '124\n';
    if(file==='/proc/124/cmdline')return Buffer.from('/runtime/ao\0daemon\0');
    if(file==='/proc/124/environ')return Buffer.from(`AO_DATA_DIR=${binding.data_dir}\0AO_RUN_FILE=${binding.run_file}\0`);
    if(file==='/proc/124/exe')return Buffer.from('active-daemon-bytes');
    throw new Error(`unexpected read ${file}`);
  });
  const realpath=jest.fn(value=>value==='/proc/123/cwd'?packageRoot:value==='/proc/124/exe'?'/runtime/ao':value);
  const lstat=jest.fn(()=>({isFile:()=>true,isSymbolicLink:()=>false}));
  expect(resolveInstalledRuntimeServiceBinding({home:root,execute,readFile,realpath,lstat})).toMatchObject({
    package_root:packageRoot,binary_path:'/runtime/ao',store_root:path.join(root,'.local/share/ao-pilot/runtimes'),data_dir:binding.data_dir,run_file:binding.run_file,
  });
  expect(execute).toHaveBeenCalledWith('systemctl',expect.arrayContaining(['--property=ActiveState']),expect.any(Object));
  expect(execute).toHaveBeenCalledWith('systemctl',expect.arrayContaining(['--property=MainPID']),expect.any(Object));
  expect(readFile).toHaveBeenCalledWith('/proc/123/cmdline');
  expect(readFile).toHaveBeenCalledWith('/proc/123/environ');
});
