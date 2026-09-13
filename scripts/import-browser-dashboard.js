#!/usr/bin/env node
// Bulk mechanical source transplant. Application TSX/CSS bytes are not rewritten.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const source = process.argv[2];
if (!source || !path.isAbsolute(source)) throw new Error('Absolute legacy source checkout required');
const target = path.resolve('browser');
if (fs.existsSync(target)) throw new Error('Refusing to overwrite browser source');
const roots = ['packages/web','packages/core',...['agent-claude-code','agent-codex','agent-opencode','runtime-tmux','workspace-worktree','scm-github','tracker-github','tracker-linear'].map(name=>`packages/plugins/${name}`)];
const files = execFileSync('/usr/bin/git',['-C',source,'ls-files','-z','--',...roots,'tsconfig.base.json','LICENSE'],{encoding:'utf8'}).split('\0').filter(Boolean);
if (execFileSync('/usr/bin/git',['-C',source,'status','--porcelain','--',...roots,'tsconfig.base.json','LICENSE'],{encoding:'utf8'}).trim()) throw new Error('Source import scope is dirty; refusing ambiguous provenance');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const receipt = {schema_version:'ao.browser-source-import.v1',source_commit:execFileSync('/usr/bin/git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),files:[]};
for (const relative of files) {
  if (/(^|\/)(node_modules|\.next|dist|dist-server)(\/|$)/.test(relative) || /\.tsbuildinfo$/.test(relative)) continue;
  const from = path.join(source,relative), to = path.join(target,relative);
  if (!fs.statSync(from).isFile()) throw new Error(`Unexpected non-file ${relative}`);
  const bytes = fs.readFileSync(from);
  fs.mkdirSync(path.dirname(to),{recursive:true});
  fs.copyFileSync(from,to);
  receipt.files.push({path:relative,sha256:sha256(bytes)});
}
// npm workspaces replace only package-manager syntax, never page/component code.
for (const root of roots) {
  const file=path.join(target,root,'package.json');
  const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const deps of ['dependencies','optionalDependencies','devDependencies']) for(const [name,version] of Object.entries(manifest[deps]||{})) {
    if(version.startsWith('workspace:'))manifest[deps][name]='*';
    else { const installed=path.join(source,root,'node_modules',name,'package.json'); if(fs.existsSync(installed))manifest[deps][name]=JSON.parse(fs.readFileSync(installed,'utf8')).version; }
  }
  fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
}
const buildDeps = roots.filter(root=>root!=='packages/web').map(root=>`npm run build --workspace ./${root}`).join(' && ');
fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'ao-pilot-browser',private:true,type:'module',workspaces:['packages/core','packages/web','packages/plugins/*'],scripts:{'build:deps':buildDeps,'dev':'npm run dev --workspace @composio/ao-web','build':'npm run build --workspace @composio/ao-web'},devDependencies:{typescript:'5.9.3','@types/node':'22.19.15'}},null,2)+'\n');
fs.writeFileSync(path.join(target,'SOURCE_IMPORT.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({source_commit:receipt.source_commit,imported_files:receipt.files.length,target}));
