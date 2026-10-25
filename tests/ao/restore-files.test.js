import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {afterEach,expect,it} from '@jest/globals';
import {verifyRestoreFiles} from '../../scripts/ao/lib/restore-files.js';
import {createSystemdReleaseRunner} from '../../scripts/ao/lib/release-systemd.js';
import {configuration,fixtureRoot} from './release-fixture.js';
const roots=[];afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})});
function setup(){const root=fixtureRoot();roots.push(root);const config=configuration(root),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'file.txt'),'preserve');const manifest=path.join(root,'files.jsonl'),body=JSON.stringify({path:'file.txt',kind:'file',sha256:createHash('sha256').update('preserve').digest('hex')})+'\n';fs.writeFileSync(manifest,body,{mode:0o600});config.restoreLastFileManifests={'last-2':{path:manifest,sha256:createHash('sha256').update(body).digest('hex')}};const baseline={projects:['fixture'],identities:[{ao_session_id:'last-2',project_id:'fixture',kind:'worker',is_terminated:0,workspace_path:workspace}]};return {root,config,workspace,manifest,baseline};}
it('binds the private manifest and validates exact bytes after restoration',()=>{const {config,baseline,workspace}=setup();expect(verifyRestoreFiles(config,baseline,'last-2')).toMatchObject({status:'PASS',files_verified:1});fs.writeFileSync(path.join(workspace,'file.txt'),'changed');expect(()=>verifyRestoreFiles(config,baseline,'last-2')).toThrow('install_restore_files_changed');});
it('rejects changed manifests, absent files and non-private manifest permissions',()=>{const {config,baseline,manifest,workspace}=setup();fs.chmodSync(manifest,0o644);expect(()=>verifyRestoreFiles(config,baseline,'last-2')).toThrow('install_restore_file_manifest_invalid');fs.chmodSync(manifest,0o600);fs.unlinkSync(path.join(workspace,'file.txt'));expect(()=>verifyRestoreFiles(config,baseline,'last-2')).toThrow();fs.appendFileSync(manifest,'\n');expect(()=>verifyRestoreFiles(config,baseline,'last-2')).toThrow('install_restore_file_manifest_drift');});
it('halts immediately after a protected session loses a file; later sessions are never restored',async()=>{
 const {root,config,baseline,workspace}=setup();config.restoreProjects=['fixture'];config.restoreConcurrency=2;config.restoreLastSessionIDs=['last-2','last-4'];config.firstRestoreSessionIDs=['last-2','last-4'];baseline.identities.push({...baseline.identities[0],ao_session_id:'last-4'});const calls=[];
 const runner=createSystemdReleaseRunner(config,{run:(cmd,args)=>{if(cmd!==path.join(root,'native/ao'))return '';const ids=args.flatMap((arg,i)=>arg==='--session-id'?[args[i+1]]:[]);calls.push(ids);fs.unlinkSync(path.join(workspace,'file.txt'));return JSON.stringify({projectId:'fixture',results:ids.map(sessionId=>({sessionId,outcome:'restored',reason:'already_running'}))})},fetchImpl:async()=>({ok:true,json:async()=>({sessions:[],status:'ready',ready:true,reasons:[]})}),sleep:async()=>{}});
 await expect(runner.start({releaseRoot:root,mode:'first',baseline})).rejects.toThrow();expect(calls).toEqual([['last-2']]);
});
