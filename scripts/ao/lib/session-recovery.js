import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import crypto from 'node:crypto';

export const defaultBindingsPath = () => path.join(os.homedir(), '.config/ao-pilot/session-recovery.json');
export async function verifyTranscript(binding) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.conversationId)) throw new Error('Invalid original conversation ID; HOLD');
  for (const key of ['workspacePath','transcriptPath','binaryPath']) if (!path.isAbsolute(binding[key] || '')) throw new Error(`Invalid ${key}; HOLD`);
  const stream = fs.createReadStream(binding.transcriptPath);
  const lines = readline.createInterface({input:stream});
  try {
    for await (const line of lines) {
      const entry = JSON.parse(line), meta = entry.payload;
      if (entry.type !== 'session_meta' || !meta) throw new Error('Missing original transcript header; HOLD');
      const ids = [meta.id, meta.session_id].filter(Boolean);
      if (!ids.length || ids.some(id => id !== binding.conversationId) || fs.realpathSync(meta.cwd) !== fs.realpathSync(binding.workspacePath)) throw new Error('Original transcript identity mismatch; HOLD');
      fs.accessSync(binding.binaryPath, fs.constants.X_OK);
      return true;
    }
    throw new Error('Empty original transcript; HOLD');
  } finally { lines.close(); stream.destroy(); }
}
export function readBindings(file, configPath) {
  if (!fs.existsSync(file)) return {schema_version:'ao.session-recovery.v1',configPath:fs.realpathSync(configPath),sessions:{}};
  const manifest = JSON.parse(fs.readFileSync(file,'utf8'));
  if (manifest.schema_version !== 'ao.session-recovery.v1' || manifest.configPath !== fs.realpathSync(configPath) || !manifest.sessions || Array.isArray(manifest.sessions)) throw new Error('Recovery manifest/config identity mismatch; HOLD');
  return manifest;
}
export function writeBindings(file, manifest) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+crypto.randomUUID();
  fs.writeFileSync(temp,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.renameSync(temp,file);
}
export async function withRecoveryLock(file, action) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const lock=file+'.lock', boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  const owner=JSON.stringify({pid:process.pid,boot,token:crypto.randomUUID()});
  try {fs.writeFileSync(lock,owner,{flag:'wx',mode:0o600});}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    const previous=fs.readFileSync(lock,'utf8'), data=JSON.parse(previous);
    let live=data.boot===boot;
    if(live){try{process.kill(data.pid,0);}catch(e){if(e.code==='ESRCH')live=false;else throw e;}}
    if(live)throw new Error('Recovery writer already active; HOLD');
    if(fs.readFileSync(lock,'utf8')!==previous)throw new Error('Recovery lock changed; HOLD');
    fs.unlinkSync(lock);fs.writeFileSync(lock,owner,{flag:'wx',mode:0o600});
  }
  try{return await action();}
  finally{if(fs.readFileSync(lock,'utf8')===owner)fs.unlinkSync(lock);}
}
export async function recoverySweep(bindings, adapter, {restore=false, attempts=new Set(), authorityPolicy}={}) {
  const results=[];
  for (const [id,binding] of Object.entries(bindings.sessions)) {
    try {
      await adapter.validate(id,binding);
      if(adapter.retired && await adapter.retired(id,binding)) {results.push({id,state:'RETIRED',action:'none'});continue;}
      if (await adapter.alive(id,binding)) { attempts.delete(id); results.push({id,state:'LIVE',action:'none'}); continue; }
      if (!restore) {results.push({id,state:'MISSING',action:'none'});continue;}
      if(attempts.has(id)) {results.push({id,state:'HOLD',reason:'Recovery already attempted in this outage; no automatic retry'});continue;}
      attempts.add(id);
      if(binding.authorityEnrollment !== undefined) {
        if(!authorityPolicy || typeof authorityPolicy.restore !== 'function') throw new Error('Enrolled recovery requires trusted authority/execution policy; HOLD');
        await authorityPolicy.restore(id,binding,()=>adapter.restore(id,binding));
      } else { await adapter.restore(id,binding); }
      if(!await adapter.alive(id,binding)) throw new Error('Restored runtime not alive; HOLD');
      results.push({id,state:'RESTORED',conversationId:binding.conversationId});
    } catch(error) {results.push({id,state:'HOLD',reason:error.message});}
  }
  return {schema_version:'ao.session-recovery-report.v1',automation_dispatch:false,fresh_conversation_fallback:false,results};
}

export async function createRecoveryAdapter(configPath, manifest) {
  // Every import is ao-pilot-owned; no sibling checkout or PATH-shadowed ao.
  const core=await import('../../../browser/packages/core/dist/index.js');
  const [{default:codex},{default:tmux},{default:workspace},{default:scm},{default:tracker}]=await Promise.all([
    import('../../../browser/packages/plugins/agent-codex/dist/index.js'),
    import('../../../browser/packages/plugins/runtime-tmux/dist/index.js'),
    import('../../../browser/packages/plugins/workspace-worktree/dist/index.js'),
    import('../../../browser/packages/plugins/scm-github/dist/index.js'),
    import('../../../browser/packages/plugins/tracker-github/dist/index.js'),
  ]);
  const config=core.loadConfig(configPath), registry=core.createPluginRegistry();
  const metadata = (id,binding) => {
    const project=config.projects[binding.projectId];
    if(!project) throw new Error('Missing bound project; HOLD');
    const dir=core.getSessionsDir(config.configPath,project.path), raw=core.readMetadata(dir,id);
    if(!raw || raw.agent!=='codex' || raw.project!==binding.projectId || raw.worktree!==binding.workspacePath || raw.tmuxName!==binding.tmuxName || raw.createdAt!==binding.createdAt) throw new Error('Session metadata identity drift; HOLD');
    return {dir,raw};
  };
  const validate=async(id,binding)=>{metadata(id,binding);await verifyTranscript(binding);};
  registry.register({...codex,create(options){const agent=codex.create(options);return {...agent,postLaunchSetup:undefined,async getRestoreCommand(session){
    const binding=manifest.sessions[session.id];
    if(!binding || session.workspacePath!==binding.workspacePath) throw new Error('Unpinned restore forbidden; HOLD');
    await validate(session.id,binding);
    return [core.shellEscape(binding.binaryPath),'resume','--sandbox','workspace-write','--ask-for-approval','on-request','--cd',core.shellEscape(binding.workspacePath),'-c','check_for_update_on_startup=false',core.shellEscape(binding.conversationId)].join(' ');
  }}}});
  for(const plugin of [tmux,workspace,scm,tracker]) registry.register(plugin);
  const manager=core.createSessionManager({config,registry});
  const runtime=tmux.create();
  return {core,config,manager,metadata,validate,
    async retired(id,binding){return ['merged','killed','cleanup','done'].includes(metadata(id,binding).raw.status);},
    async alive(id,binding){const {raw}=metadata(id,binding);const handle=JSON.parse(raw.runtimeHandle || 'null');if(!handle || handle.id!==binding.tmuxName || handle.runtimeName!=='tmux') throw new Error('Runtime handle identity mismatch; HOLD');return runtime.isAlive(handle);},
    async restore(id,binding){await validate(id,binding);if(await this.alive(id,binding)) return;await manager.restore(id);},
  };
}
