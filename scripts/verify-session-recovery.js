#!/usr/bin/env node
// Real tmux + migrated core, but an offline Codex double. Never touch live CIE.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync as run} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import yaml from 'js-yaml';
import * as core from '../browser/packages/core/dist/index.js';
import {createRecoveryAdapter,recoverySweep,writeBindings} from './ao/lib/session-recovery.js';
process.env.PATH=path.dirname(process.execPath)+':/usr/local/bin:/usr/bin:/bin';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-recovery-canary-'));
// A private, initially nonexistent tmux socket reproduces cold boot without
// killing or attaching to the user's tmux server.
process.env.TMUX_TMPDIR=root;
const workspace=path.join(root,'ao-recovery-canary');fs.mkdirSync(workspace);
run('/usr/bin/git',['init','--quiet',workspace]);
const configPath=path.join(root,'config.yaml'), id='canary-1', conversationId='00000000-0000-4000-8000-000000000001';
fs.writeFileSync(configPath,yaml.safeDump({defaults:{runtime:'tmux',agent:'codex',workspace:'worktree',notifiers:[]},projects:{'ao-recovery-canary':{path:workspace,repo:'fixture/offline',defaultBranch:'main',sessionPrefix:'canary'}}}));
const transcriptPath=path.join(root,'original.jsonl');fs.writeFileSync(transcriptPath,JSON.stringify({type:'session_meta',payload:{id:conversationId,cwd:workspace}})+'\n');
const binaryPath=fileURLToPath(new URL('../tests/ao/fixtures/recovery-codex.cjs',import.meta.url));fs.chmodSync(binaryPath,0o755);
const tmuxName=core.generateTmuxName(configPath,'canary',1), dir=core.getSessionsDir(configPath,workspace), createdAt=new Date().toISOString();
core.writeMetadata(dir,id,{worktree:workspace,branch:'fixture',status:'working',project:'ao-recovery-canary',agent:'codex',createdAt,tmuxName,runtimeHandle:JSON.stringify({id:tmuxName,runtimeName:'tmux',data:{workspacePath:workspace}})});
const manifest={schema_version:'ao.session-recovery.v1',configPath,sessions:{[id]:{projectId:'ao-recovery-canary',workspacePath:workspace,tmuxName,createdAt,conversationId,transcriptPath,binaryPath}}};
const manifestPath=path.join(root,'pins.json');writeBindings(manifestPath,manifest);
const adapter=await createRecoveryAdapter(configPath,manifest);
try {
  const first=await recoverySweep(manifest,adapter,{restore:true});
  if(first.results[0].state!=='RESTORED')throw Error(JSON.stringify(first));
  await new Promise(resolve=>setTimeout(resolve,1200));
  const capture=()=>run('tmux',['capture-pane','-pt',tmuxName],{encoding:'utf8'});
  if(!capture().includes(conversationId))throw Error('Original resume identity absent from terminal');
  const pane=()=>run('tmux',['list-panes','-t',tmuxName,'-F','#{pane_pid}'],{encoding:'utf8'}).trim();
  const initial=pane();
  // Restart the recovery foreground process, not a real Codex conversation.
  const unit='ao-pilot-recovery-canary-'+path.basename(root);
  const start=()=>run('systemd-run',['--user','--unit',unit,'--property=Type=simple','--setenv=PATH='+process.env.PATH,'--setenv=TMUX_TMPDIR='+root,process.execPath,fileURLToPath(new URL('./ao-session.js',import.meta.url)),'serve','--config',configPath,'--bindings',manifestPath]);
  start();
  try {
    await new Promise(resolve=>setTimeout(resolve,1200));
    if(pane()!==initial)throw Error('Live canary restarted unexpectedly');
    run('systemctl',['--user','stop',unit]);
    run('tmux',['kill-session','-t',tmuxName]);
    start();
    await new Promise(resolve=>setTimeout(resolve,2000));
    if(!capture().includes(conversationId))throw Error('Service startup did not restore original canary identity');
    console.log(JSON.stringify({status:'PASS',real_tmux:true,cold_boot_private_socket:true,service_restart_missing_session_restored:true,original_conversation_preserved:true,live_session_skipped:true,provider_calls:0,live_CIE_touched:false,canary_root:root}));
  }finally{try{run('systemctl',['--user','stop',unit]);}catch{}}
}finally {
  try{run('tmux',['kill-session','-t',tmuxName]);}catch{}
  core.updateMetadata(dir,id,{status:'killed'});
  // Preserve exact generated canary evidence for inspection; never clean broad roots.
}
