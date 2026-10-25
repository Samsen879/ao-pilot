import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertRelease,fileSha256} from './release-manifest.js';

export function verifyRestoreFiles(config, baseline, sessionId) {
 const input=config.restoreLastFileManifests?.[sessionId];
 assertRelease(input&&path.isAbsolute(input.path??'')&&/^[a-f0-9]{64}$/.test(input.sha256??''),'install_restore_file_manifest_required');
 const fd=fs.openSync(input.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let raw;
 try {const st=fs.fstatSync(fd);assertRelease(st.isFile()&&st.uid===process.getuid()&&st.nlink===1&&(st.mode&0o077)===0,'install_restore_file_manifest_invalid');raw=fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd)}
 assertRelease(createHash('sha256').update(raw).digest('hex')===input.sha256,'install_restore_file_manifest_drift');
 const row=baseline.identities.find(row=>row.ao_session_id===sessionId),root=row?.workspace_path;
 assertRelease(path.isAbsolute(root??'')&&fs.realpathSync(root)===root,'install_restore_file_manifest_invalid');
 const entries=raw.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),seen=new Set();
 assertRelease(entries.length>0,'install_restore_file_manifest_invalid');
 for(const entry of entries){
  const rel=entry.path;assertRelease(typeof rel==='string'&&rel!==''&&!path.isAbsolute(rel)&&!rel.split('/').some(p=>p==='..'||p==='.'||p==='.git')&&!seen.has(rel)&&['file','symlink'].includes(entry.kind)&&/^[a-f0-9]{64}$/.test(entry.sha256),'install_restore_file_manifest_invalid');seen.add(rel);
  const target=path.join(root,rel);let dir=path.dirname(target);while(dir!==root){assertRelease(!fs.lstatSync(dir).isSymbolicLink(),'install_restore_file_manifest_invalid');dir=path.dirname(dir)}
  const stat=fs.lstatSync(target);const digest=entry.kind==='symlink'?(assertRelease(stat.isSymbolicLink(),'install_restore_files_changed'),createHash('sha256').update(fs.readlinkSync(target)).digest('hex')):(assertRelease(stat.isFile()&&!stat.isSymbolicLink(),'install_restore_files_changed'),fileSha256(target));
  assertRelease(digest===entry.sha256,'install_restore_files_changed');
 }
 return {session_id:sessionId,status:'PASS',manifest_sha256:input.sha256,files_verified:entries.length};
}
