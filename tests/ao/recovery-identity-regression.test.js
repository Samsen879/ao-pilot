import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test,expect,jest} from '@jest/globals';
import {readBindings,writeBindings,recoverySweep} from '../../scripts/ao/lib/session-recovery.js';
function fixture(run) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-recovery-identity-'));
 try { return run(root); } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
test('same-directory config paths are distinguished by pinned manifest',()=>fixture(root=>{
 const a=path.join(root,'a.yaml'),b=path.join(root,'b.yaml'),file=path.join(root,'pins.json');
 fs.writeFileSync(a,'projects: {}');fs.writeFileSync(b,'projects: {}');writeBindings(file,readBindings(file,a));
 expect(()=>readBindings(file,b)).toThrow('manifest/config identity mismatch');
}));
test('symlink matches original pin; same-path content drift is currently not rejected',()=>fixture(root=>{
 const a=path.join(root,'a.yaml'),link=path.join(root,'alias.yaml'),file=path.join(root,'pins.json');
 fs.writeFileSync(a,'projects: {}');fs.symlinkSync(a,link);const manifest=readBindings(file,a);writeBindings(file,manifest);
 expect(readBindings(file,link)).toEqual(manifest);fs.writeFileSync(a,'projects: {changed: {}}');expect(readBindings(file,a)).toEqual(manifest);
}));
test.each(['generation drift','runtime handle drift','unknown project','config conflict'])('%s cannot reach side effects after validation holds',async reason=>{
 const adapter={validate:jest.fn().mockRejectedValue(Error(reason)),alive:jest.fn(),restore:jest.fn()};
 const result=await recoverySweep({sessions:{'same-1':{}}},adapter,{restore:true});
 expect(result.results).toEqual([{id:'same-1',state:'HOLD',reason}]);expect(adapter.alive).not.toHaveBeenCalled();expect(adapter.restore).not.toHaveBeenCalled();
});
test('retired archive is checked before liveness and cannot resurrect writer',async()=>{
 const adapter={validate:jest.fn(),retired:jest.fn().mockResolvedValue(true),alive:jest.fn(),restore:jest.fn()};
 const result=await recoverySweep({sessions:{'same-1':{}}},adapter,{restore:true});
 expect(result.results[0].state).toBe('RETIRED');expect(adapter.alive).not.toHaveBeenCalled();expect(adapter.restore).not.toHaveBeenCalled();
});
