#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync as exec} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.argv.slice(2).join(' ')!=='--deploy')throw Error('Usage: node scripts/deploy-session-recovery.js --deploy');
const root=fileURLToPath(new URL('../',import.meta.url));
const git=args=>exec('/usr/bin/git',args,{cwd:root,encoding:'utf8'}).trim();
if(git(['status','--porcelain','--untracked-files=no']))throw Error('Commit tracked changes before deployment');
const apps=path.join(os.homedir(),'.local/share/ao-pilot/apps');
const previous=exec('/usr/bin/systemctl',['--user','show','ao-pilot-dashboard.service','--property=WorkingDirectory','--value'],{encoding:'utf8'}).trim();
if(!previous.startsWith(apps+'/original-dashboard-') || fs.realpathSync(previous)!==previous)throw Error('Unexpected existing deployment; HOLD');
const prior=JSON.parse(fs.readFileSync(path.join(previous,'DEPLOYMENT.json'),'utf8'));
if(!/^[a-f0-9]{40}$/.test(prior.commit))throw Error('Invalid previous deployment SHA');
const packages=['core','plugins/agent-codex','plugins/runtime-tmux','plugins/workspace-worktree','plugins/scm-github','plugins/tracker-github'];
if(git(['diff',prior.commit,'HEAD','--',...packages.map(p=>'browser/packages/'+p),'browser/package-lock.json']))throw Error('Support source changed; rebuild rather than reusing compiled artifacts');
const commit=git(['rev-parse','HEAD']),tree=git(['rev-parse','HEAD^{tree}']);
const target=path.join(apps,'session-recovery-'+commit);
if(fs.existsSync(target))throw Error('Refusing to overwrite '+target);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ao-recovery-deploy-')), archive=path.join(temp,'source.tar');
try {
  exec('/usr/bin/git',['archive','--format=tar','-o',archive,commit],{cwd:root});
  fs.mkdirSync(target,{recursive:true,mode:0o700});exec('/usr/bin/tar',['-xf',archive,'-C',target]);
}finally{if(fs.existsSync(archive))fs.unlinkSync(archive);fs.rmdirSync(temp);}
// Reuse only compiled support from the ao-pilot-owned immutable installation;
// the exact support source and lockfile above must be unchanged.
fs.symlinkSync(path.join(previous,'node_modules'),path.join(target,'node_modules'),'dir');
fs.symlinkSync(path.join(previous,'browser/node_modules'),path.join(target,'browser/node_modules'),'dir');
for(const pkg of packages)fs.symlinkSync(path.join(previous,'browser/packages',pkg,'dist'),path.join(target,'browser/packages',pkg,'dist'),'dir');
const receipt={schema_version:'ao.session-recovery-deployment.v1',commit,tree,package_root:target,support_deployment:previous,support_commit:prior.commit,config_path:path.join(os.homedir(),'agent-orchestrator.yaml'),bindings_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(os.homedir(),'.config/ao-pilot/session-recovery.json'))).digest('hex'),fresh_conversation_fallback:false,dispatch_enabled:false};
fs.writeFileSync(path.join(target,'DEPLOYMENT.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
exec(process.execPath,[path.join(target,'scripts/install-dashboard-service.js'),'--install','--replace','--recovery-only'],{stdio:'inherit'});
exec('/usr/bin/systemctl',['--user','daemon-reload']);
exec('/usr/bin/systemctl',['--user','enable','--now','ao-pilot-session-recovery.service']);
const binDir=path.join(os.homedir(),'.local/bin'), cli=path.join(binDir,'ao-pilot');
fs.mkdirSync(binDir,{recursive:true});
if(fs.existsSync(cli) || (()=>{try{fs.lstatSync(cli);return true;}catch{return false;}})()) {
  const stat=fs.lstatSync(cli);
  if(!stat.isSymbolicLink())throw Error('Recovery deployed; refusing to replace unknown non-symlink CLI '+cli);
  const existing=fs.readlinkSync(cli), resolved=path.resolve(binDir,existing);
  if(!resolved.startsWith(apps+'/') && resolved!==path.join(root,'bin/ao-pilot.js'))throw Error('Recovery deployed; refusing unrelated CLI target '+resolved);
  fs.renameSync(cli,cli+'.backup-'+Date.now());
}
fs.symlinkSync(path.join(target,'bin/ao-pilot.js'),cli);
receipt.cli_path=cli;
fs.writeFileSync(path.join(target,'DEPLOYMENT.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(receipt,null,2));
