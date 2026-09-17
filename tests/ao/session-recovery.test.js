import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test,expect,jest} from '@jest/globals';
import {verifyTranscript,recoverySweep,readBindings,writeBindings,withRecoveryLock} from '../../scripts/ao/lib/session-recovery.js';
import {runCli} from '../../bin/ao-pilot.js';
import {buildDashboardUnits} from '../../scripts/ao/lib/dashboard-service.js';
const id='01a086a5-2450-7931-9ca2-c1ba5625efdd';
test('requires exact original header ID/cwd and rejects conflicting legacy identity',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-recovery-test-'));
  try {
    const file=path.join(dir,'original.jsonl'), binding={conversationId:id,workspacePath:dir,transcriptPath:file,binaryPath:process.execPath};
    fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,session_id:id,cwd:dir}})+'\n');
    await expect(verifyTranscript(binding)).resolves.toBe(true);
    await expect(verifyTranscript({...binding,conversationId:'01a086a5-2450-7931-9ca2-c1ba5625efde'})).rejects.toThrow('identity mismatch');
    fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,session_id:'conflict',cwd:dir}})+'\n');
    await expect(verifyTranscript(binding)).rejects.toThrow();
    fs.writeFileSync(file,'');await expect(verifyTranscript(binding)).rejects.toThrow('Empty');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('live sessions are never destroyed/restored; missing sessions restore exactly once',async()=>{
  const bindings={sessions:{or:{conversationId:id}}}, adapter={validate:jest.fn(),alive:jest.fn().mockResolvedValueOnce(true),restore:jest.fn()};
  expect((await recoverySweep(bindings,adapter,{restore:true})).results[0].state).toBe('LIVE');expect(adapter.restore).not.toHaveBeenCalled();
  adapter.alive.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect((await recoverySweep(bindings,adapter,{restore:true})).results[0].state).toBe('RESTORED');expect(adapter.restore).toHaveBeenCalledTimes(1);
});
test('identity or permission failure holds without mutation; launch failure has no retry in same outage',async()=>{
  const bindings={sessions:{or:{}}}, attempts=new Set(), adapter={validate:jest.fn(),alive:jest.fn().mockResolvedValue(false),restore:jest.fn().mockRejectedValue(Error('launch failure'))};
  await recoverySweep(bindings,adapter,{restore:true,attempts});await recoverySweep(bindings,adapter,{restore:true,attempts});expect(adapter.restore).toHaveBeenCalledTimes(1);
  adapter.validate.mockRejectedValue(Error('identity mismatch'));expect((await recoverySweep(bindings,adapter,{restore:true})).results[0].state).toBe('HOLD');expect(adapter.restore).toHaveBeenCalledTimes(1);
});
test('read-only recovery inspection and retired sessions cannot launch',async()=>{
  const adapter={validate:jest.fn(),alive:jest.fn().mockResolvedValue(false),restore:jest.fn()};
  await recoverySweep({sessions:{or:{}}},adapter);expect(adapter.restore).not.toHaveBeenCalled();
  adapter.retired=async()=>true;expect((await recoverySweep({sessions:{or:{}}},adapter,{restore:true})).results[0].state).toBe('RETIRED');expect(adapter.restore).not.toHaveBeenCalled();
});
test('manifest identity is config-bound and concurrent writers fail closed',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-recovery-lock-'));
  try{const cfg=path.join(dir,'config.yaml'), file=path.join(dir,'pins.json');fs.writeFileSync(cfg,'config');
    const manifest=readBindings(file,cfg);writeBindings(file,manifest);expect(readBindings(file,cfg)).toEqual(manifest);
    const other=path.join(dir,'other.yaml');fs.writeFileSync(other,'other');expect(()=>readBindings(file,other)).toThrow();
    await withRecoveryLock(file,async()=>{await expect(withRecoveryLock(file,async()=>{})).rejects.toThrow('already active');});
    expect(fs.existsSync(file+'.lock')).toBe(false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('owned session and lifecycle help bypass unrelated ao.config.json discovery',async()=>{
  const out=[], io={writeStdout:s=>out.push(s),writeStderr:s=>out.push(s)};
  expect((await runCli(['session','--help'],io,{cwd:'/tmp'})).exitCode).toBe(0);
  expect((await runCli(['lifecycle','serve','--help'],io,{cwd:'/tmp'})).exitCode).toBe(0);
  expect(out.join('')).toContain('no fresh conversation');
});
test('recovery service is isolated from API automation and uses owned foreground command',()=>{
  const unit=buildDashboardUnits({packageRoot:'/installed/ao-pilot',nodePath:'/bin/node',home:'/user'})['ao-pilot-session-recovery.service'];
  expect(unit).toContain('/installed/ao-pilot/scripts/ao-session.js" serve');expect(unit).not.toContain('code/agent-orchestrator');
  expect(unit).toContain('Requires=ao-pilot-runtime.service');expect(unit).toContain('After=network-online.target ao-pilot-runtime.service');
});
