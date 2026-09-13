#!/usr/bin/env node
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {defaultBindingsPath,readBindings,writeBindings,verifyTranscript,createRecoveryAdapter,recoverySweep,withRecoveryLock} from './ao/lib/session-recovery.js';

export async function runCli(args,io={writeStdout:s=>process.stdout.write(s),writeStderr:s=>process.stderr.write(s)}) {
  try {
    if(args.includes('--help') || args.includes('-h')) {io.writeStdout('Usage: ao-pilot session <list|bind|restore|send> [session] [message] --config <existing.yaml> [--bindings <manifest>]\nBind requires --conversation <original-id> --transcript <absolute-jsonl> --binary <absolute-codex>.\nao-pilot lifecycle <status|recover|serve> --config <existing.yaml> [--bindings <manifest>]\nRecovery is pinned, no fresh conversation, no dispatch or successor spawning.\n');return {exitCode:0};}
    const options={}, positional=[];
    const allowed=new Set(['--config','--bindings','--conversation','--transcript','--binary']);
    for(let i=0;i<args.length;i++){if(args[i]==='--json')continue;if(args[i].startsWith('--')){if(!allowed.has(args[i]) || !args[i+1] || args[i+1].startsWith('--'))throw new Error('Invalid option '+args[i]);options[args[i].slice(2)]=args[++i];}else positional.push(args[i]);}
    const [command,id,message]=positional;
    if(!['list','bind','restore','send','status','recover','serve'].includes(command))throw new Error('Unknown session/recovery command');
    if(['bind','restore','send'].includes(command) ? !id || positional.length!==(command==='send'?3:2) : positional.length!==1)throw new Error('Invalid command arguments');
    const configPath=options.config || process.env.AO_CONFIG_PATH;
    if(!configPath)throw new Error('Explicit --config or AO_CONFIG_PATH required');
    const file=options.bindings || defaultBindingsPath(), manifest=readBindings(file,configPath);
    const adapter=await createRecoveryAdapter(configPath,manifest);
    const print=result=>io.writeStdout(JSON.stringify(result,null,2)+'\n');
    if(command==='list') {
      const sessions=[];
      for(const [projectId,project] of Object.entries(adapter.config.projects)) {
        const dir=adapter.core.getSessionsDir(adapter.config.configPath,project.path);
        for(const name of adapter.core.listMetadata(dir)) {
          const raw=adapter.core.readMetadata(dir,name);
          if(!raw.agent || raw.project!==projectId)continue;
          sessions.push({id:name,projectId,status:raw.status,workspacePath:raw.worktree,recoveryPinned:Boolean(manifest.sessions[name])});
        }
      }
      print({sessions});return {exitCode:0};
    }
    if(command==='bind'){
      const projectId=Object.keys(adapter.config.projects).find(project=>id.startsWith(adapter.config.projects[project].sessionPrefix+'-'));
      if(!projectId)throw new Error('Unknown session project; HOLD');
      const dir=adapter.core.getSessionsDir(adapter.config.configPath,adapter.config.projects[projectId].path), raw=adapter.core.readMetadata(dir,id);
      if(!raw || raw.agent!=='codex' || !raw.worktree || !raw.tmuxName || !raw.createdAt)throw new Error('Missing original session metadata; HOLD');
      const binding={projectId,workspacePath:raw.worktree,tmuxName:raw.tmuxName,createdAt:raw.createdAt,conversationId:options.conversation,transcriptPath:options.transcript,binaryPath:options.binary};
      await verifyTranscript(binding);
      if(manifest.sessions[id] && JSON.stringify(manifest.sessions[id])!==JSON.stringify(binding))throw new Error('Existing recovery pin differs; HOLD');
      await adapter.validate(id,binding);
      await withRecoveryLock(file,async()=>{const latest=readBindings(file,configPath);if(latest.sessions[id] && JSON.stringify(latest.sessions[id])!==JSON.stringify(binding))throw new Error('Recovery pin changed concurrently; HOLD');latest.sessions[id]=binding;writeBindings(file,latest);});
      print({id,binding,state:'BOUND',session_unchanged:true});return {exitCode:0};
    }
    if(command==='send') {const binding=manifest.sessions[id];if(!binding)throw new Error('Unpinned session; HOLD');await adapter.validate(id,binding);if(!await adapter.alive(id,binding))throw new Error('Session not alive; HOLD');await adapter.manager.send(id,message);print({id,delivered:true});return {exitCode:0};}
    if(command==='restore' && !manifest.sessions[id])throw new Error('Unpinned session; HOLD');
    const scope=command==='restore'?{...manifest,sessions:{[id]:manifest.sessions[id]}}:manifest;
    const attempts=new Set();
    let stopped=false;
    const stop=()=>{stopped=true;};
    if(command==='serve'){process.on('SIGTERM',stop);process.on('SIGINT',stop);}
    try {
      do {
        const sweep=()=>recoverySweep(scope,adapter,{restore:['restore','recover','serve'].includes(command),attempts});
        const report=await (['restore','recover','serve'].includes(command)?withRecoveryLock(file,sweep):sweep());
        print(report);
        if(command!=='serve')return {exitCode:report.results.some(r=>r.state==='HOLD')?3:0,report};
        await new Promise(resolve=>{const timer=setTimeout(done,30000);function done(){clearTimeout(timer);process.off('SIGTERM',done);process.off('SIGINT',done);resolve();}process.once('SIGTERM',done);process.once('SIGINT',done);if(stopped)done();});
      }while(!stopped);
    }finally{if(command==='serve'){process.off('SIGTERM',stop);process.off('SIGINT',stop);}}
    return {exitCode:0};
  }catch(error){io.writeStderr(error.message+'\n');return {exitCode:3};}
}
if(process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href===import.meta.url){const result=await runCli(process.argv.slice(2));process.exitCode=result.exitCode;}
