import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test,expect,jest,beforeEach,afterEach} from '@jest/globals';

let root, config, raw, binding, registered;
const restore=jest.fn(), isAlive=jest.fn(), setupManagedAoLauncher=jest.fn();
const core={
 loadConfig:()=>config,
 createPluginRegistry:()=>({register:plugin=>registered.push(plugin)}),
 getSessionsDir:()=>path.join(root,'metadata'),
 readMetadata:()=>raw,
 createSessionManager:()=>({restore}),
 shellEscape:s=>s,
};
jest.unstable_mockModule('../../browser/packages/core/dist/index.js',()=>core,{virtual:true});
jest.unstable_mockModule('../../browser/packages/plugins/agent-codex/dist/index.js',()=>({default:{create:()=>({})},setupManagedAoLauncher}),{virtual:true});
for (const name of ['workspace-worktree','scm-github','tracker-github']) jest.unstable_mockModule(`../../browser/packages/plugins/${name}/dist/index.js`,()=>({default:{create:()=>({})}}),{virtual:true});
jest.unstable_mockModule('../../browser/packages/plugins/runtime-tmux/dist/index.js',()=>({default:{create:()=>({isAlive})}}),{virtual:true});
const {createRecoveryAdapter,recoverySweep}=await import('../../scripts/ao/lib/session-recovery.js');
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-adapter-identity-'));registered=[];jest.clearAllMocks();isAlive.mockResolvedValue(false);
 const transcriptPath=path.join(root,'original.jsonl'),conversationId='00000000-0000-4000-8000-000000000001';
 fs.writeFileSync(transcriptPath,JSON.stringify({type:'session_meta',payload:{id:conversationId,session_id:conversationId,cwd:root}})+'\n');
 config={configPath:path.join(root,'config.yaml'),projects:{fixture:{path:root}}};
 binding={projectId:'fixture',workspacePath:root,tmuxName:'fixture-1',createdAt:'2026-09-13T00:00:00Z',conversationId,transcriptPath,binaryPath:process.execPath};
 raw={agent:'codex',project:'fixture',worktree:root,tmuxName:'fixture-1',createdAt:binding.createdAt,status:'working',runtimeHandle:JSON.stringify({id:'fixture-1',runtimeName:'tmux'})};
});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
async function inspect({restore:shouldRestore=false}={}) {
 const manifest={sessions:{'fixture-1':binding}};
 const adapter=await createRecoveryAdapter(config.configPath,manifest);
 return recoverySweep(manifest,adapter,{restore:shouldRestore});
}
test.each(['project','worktree','tmuxName','createdAt','agent'])('actual adapter rejects %s metadata drift before restoration',async key=>{
 raw[key]='wrong';expect((await inspect({restore:true})).results[0].state).toBe('HOLD');expect(restore).not.toHaveBeenCalled();expect(isAlive).not.toHaveBeenCalled();
});
test('actual adapter rejects a missing bound project',async()=>{
 config.projects={};expect((await inspect({restore:true})).results[0].reason).toMatch('Missing bound project');expect(restore).not.toHaveBeenCalled();
});
test.each([{id:'other',runtimeName:'tmux'},{id:'fixture-1',runtimeName:'other'},null])('actual adapter rejects mismatched runtime handle %j',async handle=>{
 raw.runtimeHandle=JSON.stringify(handle);expect((await inspect({restore:true})).results[0].reason).toMatch('Runtime handle identity mismatch');expect(restore).not.toHaveBeenCalled();expect(isAlive).not.toHaveBeenCalled();
});
test.each(['merged','killed','cleanup','done'])('actual adapter treats %s original metadata as retired',async status=>{
 raw.status=status;expect((await inspect({restore:true})).results[0].state).toBe('RETIRED');expect(restore).not.toHaveBeenCalled();expect(isAlive).not.toHaveBeenCalled();
});
test('actual adapter validates transcript identity without rewriting pins',async()=>{
 const before=JSON.stringify(binding);fs.writeFileSync(binding.transcriptPath,JSON.stringify({type:'session_meta',payload:{id:'wrong',cwd:root}}));
 expect((await inspect({restore:true})).results[0].reason).toMatch('Original transcript identity mismatch');expect(restore).not.toHaveBeenCalled();expect(JSON.stringify(binding)).toBe(before);
});
test('actual adapter preserves live original worker without restore',async()=>{
 isAlive.mockResolvedValue(true);expect((await inspect({restore:true})).results[0].state).toBe('LIVE');expect(restore).not.toHaveBeenCalled();
});
test('actual adapter treats runtime permission uncertainty as HOLD rather than missing',async()=>{
 isAlive.mockRejectedValue(Error('permission denied'));expect((await inspect({restore:true})).results[0].state).toBe('HOLD');expect(restore).not.toHaveBeenCalled();
});
test('actual adapter missing runtime may restore exact original session and verifies liveness',async()=>{
 isAlive.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
 expect((await inspect({restore:true})).results[0]).toEqual({id:'fixture-1',state:'RESTORED',conversationId:binding.conversationId});expect(setupManagedAoLauncher).toHaveBeenCalledTimes(1);expect(setupManagedAoLauncher.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0]);expect(restore).toHaveBeenCalledWith('fixture-1');
});
test('launcher provisioning failure holds before pinned restore starts',async()=>{
 isAlive.mockResolvedValueOnce(false).mockResolvedValueOnce(false);setupManagedAoLauncher.mockRejectedValueOnce(Error('launcher write failed'));
 expect((await inspect({restore:true})).results[0]).toMatchObject({id:'fixture-1',state:'HOLD',reason:'launcher write failed'});expect(restore).not.toHaveBeenCalled();
});
test('pinned Codex restore injects current managed CLI compatibility guidance',async()=>{
 const manifest={sessions:{'fixture-1':binding}};
 await createRecoveryAdapter(config.configPath,manifest);
 const agent=registered[0].create();
 const command=await agent.getRestoreCommand({id:'fixture-1',workspacePath:binding.workspacePath});
 expect(command).toContain(binding.conversationId);
 expect(command).toContain('ao session claim-pr');
 expect(command).toContain('AO_SESSION_ID');
 expect(command).toContain('ao send --session');
});
test('configured project path is not directly part of the current recovery pin',async()=>{
 config.projects.fixture.path=path.join(root,'changed-configured-root');
 const adapter=await createRecoveryAdapter(config.configPath,{sessions:{'fixture-1':binding}});
 await expect(adapter.validate('fixture-1',binding)).resolves.toBeUndefined();
 // Directory resolution is deliberately stubbed: this characterizes adapter validation only.
});
