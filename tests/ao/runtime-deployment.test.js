import {test,expect,afterEach,jest} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {deploymentBinding,resolveDeploymentEnvironment,resolveInstalledRuntimeServiceBinding} from '../../scripts/ao/lib/runtime-deployment.js';
let root;
afterEach(()=>{if(root)fs.rmSync(root,{recursive:true,force:true});root=null;});
function activeService(packageRoot,binding,{binary='/installed/runtime/bin/ao',digest='b'.repeat(64),environment={}}={}) {
  const mergedEnvironment={AO_DATA_DIR:binding.data_dir,AO_RUN_FILE:binding.run_file,XDG_DATA_HOME:path.join(path.dirname(path.dirname(path.dirname(binding.data_dir))), 'xdg-data'),...environment};
  const unitEnvironment=Object.entries(mergedEnvironment).map(([name,value])=>`Environment="${name}=${value}"`).join('\n');
  return {
    activeState:'active',mainPid:'123',packageRoot,
    argv:['/usr/bin/node',path.join(packageRoot,'scripts/ao-runtime-foreground.js')],
    environment:mergedEnvironment,
    daemonPid:'124',daemonArgv:[binary,'daemon'],
    daemonEnvironment:mergedEnvironment,
    daemonExecutable:binary,daemonSha256:digest,
    fragmentPath:'/unit/ao-pilot-runtime.service',dropInPaths:'',
    unitText:`[Service]\nWorkingDirectory=${packageRoot}\n${unitEnvironment}\nExecStart="/usr/bin/node" "${path.join(packageRoot,'scripts/ao-runtime-foreground.js')}"\n`,
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

test('partial service installs preserve XDG_DATA_HOME when the runtime store is implicit',()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-deploy-test-'));
  const packageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ao-installed-package-'));
  const binding=deploymentBinding(root);
  fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});fs.mkdirSync(path.join(packageRoot,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(packageRoot,'bin/ao-pilot.js'),'#!/usr/bin/env node\n');fs.writeFileSync(path.join(packageRoot,'scripts/ao-runtime-foreground.js'),'#!/usr/bin/env node\n');
  const service=activeService(packageRoot,binding,{environment:{XDG_DATA_HOME:'/xdg/data'}});
  const execute=jest.fn().mockReturnValue(JSON.stringify({status:'verified',binary_path:'/installed/runtime/bin/ao',binary_sha256:'b'.repeat(64)}));
  try {
    expect(resolveInstalledRuntimeServiceBinding({home:root,execute,inspectService:()=>service}).store_root).toBe('/xdg/data/ao-pilot/runtimes');
    expect(execute).toHaveBeenCalledWith('/usr/bin/node',expect.any(Array),expect.objectContaining({env:expect.objectContaining({AO_PILOT_RUNTIME_STORE:'/xdg/data/ao-pilot/runtimes'})}));
  } finally {fs.rmSync(packageRoot,{recursive:true,force:true});}
});

test('partial service installs reject on-disk or effective restart binding drift',()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-deploy-test-'));
  const packageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ao-installed-package-'));
  const binding=deploymentBinding(root);
  fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});fs.mkdirSync(path.join(packageRoot,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(packageRoot,'bin/ao-pilot.js'),'#!/usr/bin/env node\n');fs.writeFileSync(path.join(packageRoot,'scripts/ao-runtime-foreground.js'),'#!/usr/bin/env node\n');
  const execute=jest.fn().mockReturnValue(JSON.stringify({status:'verified',binary_path:'/installed/runtime/bin/ao',binary_sha256:'b'.repeat(64)}));
  try {
    const service=activeService(packageRoot,binding);
    expect(()=>resolveInstalledRuntimeServiceBinding({home:root,execute,inspectService:()=>({...service,unitText:service.unitText.replace(packageRoot,'/next/release')})})).toThrow('binding drifted');
    expect(()=>resolveInstalledRuntimeServiceBinding({home:root,execute,inspectService:()=>({...service,dropInPaths:'/override.conf'})})).toThrow('binding drifted');
    expect(()=>resolveInstalledRuntimeServiceBinding({home:root,execute,inspectService:()=>({...service,unitText:`${service.unitText}Environment="AO_DATA_DIR=/next/data"\n`})})).toThrow('binding drifted');
    expect(()=>resolveInstalledRuntimeServiceBinding({home:root,execute,inspectService:()=>({...service,unitText:`${service.unitText}Environment = 'AO_RUN_FILE=/next/run'\n`})})).toThrow('binding drifted');
    expect(()=>resolveInstalledRuntimeServiceBinding({home:root,execute,inspectService:()=>({...service,unitText:`${service.unitText}EnvironmentFile = /tmp/runtime.env\n`})})).toThrow('binding drifted');
  } finally {fs.rmSync(packageRoot,{recursive:true,force:true});}
});

test('partial service installs require implicit XDG store selection to be pinned in the unit',()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-deploy-test-'));
  const packageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ao-installed-package-'));
  const binding=deploymentBinding(root);
  fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});fs.mkdirSync(path.join(packageRoot,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(packageRoot,'bin/ao-pilot.js'),'#!/usr/bin/env node\n');fs.writeFileSync(path.join(packageRoot,'scripts/ao-runtime-foreground.js'),'#!/usr/bin/env node\n');
  const service=activeService(packageRoot,binding,{environment:{XDG_DATA_HOME:'/manager/xdg'}});
  const execute=jest.fn().mockReturnValue(JSON.stringify({status:'verified',binary_path:'/installed/runtime/bin/ao',binary_sha256:'b'.repeat(64)}));
  try {
    const withoutPinnedXdg={...service,unitText:service.unitText.replace('Environment="XDG_DATA_HOME=/manager/xdg"\n','')};
    expect(()=>resolveInstalledRuntimeServiceBinding({home:root,execute,inspectService:()=>withoutPinnedXdg})).toThrow('binding drifted');
  } finally {fs.rmSync(packageRoot,{recursive:true,force:true});}
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
    if(command==='systemctl') {
      if(args.includes('--property=ActiveState'))return 'active\n';
      if(args.includes('--property=MainPID'))return '123\n';
      if(args.includes('--property=FragmentPath'))return '/unit/ao-pilot-runtime.service\n';
      if(args.includes('--property=DropInPaths'))return '\n';
    }
    return JSON.stringify({status:'verified',binary_path:'/runtime/ao',binary_sha256:awaitedDigest});
  });
  const readFile=jest.fn(file=>{
    if(file==='/proc/123/cmdline')return Buffer.from(`/usr/bin/node\0${packageRoot}/scripts/ao-runtime-foreground.js\0`);
    if(file==='/proc/123/environ')return Buffer.from(`PATH=/usr/bin\0AO_DATA_DIR=${binding.data_dir}\0AO_RUN_FILE=${binding.run_file}\0XDG_DATA_HOME=${root}/.local/share\0`);
    if(file==='/proc/123/task/123/children')return '124\n';
    if(file==='/proc/124/cmdline')return Buffer.from('/runtime/ao\0daemon\0');
    if(file==='/proc/124/environ')return Buffer.from(`AO_DATA_DIR=${binding.data_dir}\0AO_RUN_FILE=${binding.run_file}\0`);
    if(file==='/proc/124/exe')return Buffer.from('active-daemon-bytes');
    if(file==='/unit/ao-pilot-runtime.service')return `[Service]\nWorkingDirectory=${packageRoot}\nEnvironment="AO_DATA_DIR=${binding.data_dir}"\nEnvironment="AO_RUN_FILE=${binding.run_file}"\nEnvironment="XDG_DATA_HOME=${root}/.local/share"\nExecStart="/usr/bin/node" "${packageRoot}/scripts/ao-runtime-foreground.js"\n`;
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
