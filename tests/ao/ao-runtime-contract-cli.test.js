import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildRuntimeContract,
  inspectWorkerLauncher,
  parseRuntimeContractArgs,
  runCli,
} from '../../scripts/ao-runtime-contract.js';

const runtime = {
  runtime_ref: 'runtime.test.v1',
  lock_digest: 'sha256:lock',
  binary_path: '/managed/runtime/bin/ao',
  binary_sha256: 'a'.repeat(64),
  source: { commit_sha: '1'.repeat(40), tree_sha: '2'.repeat(40) },
};

function successfulProbes() {
  return {
    version: { exit_code: 0, stdout: 'ao version 1.2.3\n', stderr: '', error_code: null },
    status_help: { exit_code: 0, stdout: 'Usage: ao status [flags]\n --json', stderr: '', error_code: null },
    project_get_help: { exit_code: 0, stdout: 'Usage: ao project get <id> [flags]\n --json', stderr: '', error_code: null },
    spawn_help: { exit_code: 0, stdout: 'Usage: ao spawn [flags]\n --attempt-id string', stderr: '', error_code: null },
  };
}

function successfulLauncher() {
  return {
    path: '/home/test/.ao/bin/ao',
    available: true,
    authenticated: true,
    version_probe: { exit_code: 0, stdout: 'ao version 1.2.3\n' },
    binary_binding_matches: true,
    binary_digest_binding_matches: true,
    data_binding_matches: true,
    run_file_binding_matches: true,
  };
}

function successfulInstalledBinding() {
  return {
    binary_path: runtime.binary_path,
    binary_sha256: runtime.binary_sha256,
    data_dir: '/home/test/.local/share/ao-pilot/cie-runtime/data',
    run_file: '/home/test/.local/share/ao-pilot/cie-runtime/running.json',
  };
}

describe('installed runtime CLI contract', () => {
  it('publishes distinct global status and project readback commands', () => {
    const report = buildRuntimeContract(runtime, successfulProbes(), successfulLauncher());
    expect(report).toMatchObject({
      status: 'passed',
      launcher: { worker_command: 'ao', resolved_binary_path: runtime.binary_path },
      commands: {
        global_status: ['ao', 'status', '--json'],
        project_readback: ['ao', 'project', 'get', '<project-id>', '--json'],
      },
    });
  });

  it('holds when status advertises a project flag or spawn custody is unavailable', () => {
    const probes = successfulProbes();
    probes.status_help.stdout += '\n --project string';
    probes.spawn_help.stdout = 'Usage: ao spawn';
    expect(buildRuntimeContract(runtime, probes, successfulLauncher())).toMatchObject({
      status: 'hold',
      checks: {
        status_project_flag_absent: false,
        spawn_attempt_custody_supported: false,
      },
    });
  });

  it('holds when the worker launcher or managed namespace bindings are unavailable', () => {
    expect(buildRuntimeContract(runtime, successfulProbes(), {
      ...successfulLauncher(),
      available: false,
      run_file_binding_matches: false,
    })).toMatchObject({
      status: 'hold',
      checks: {
        worker_launcher_available: false,
        worker_run_file_binding_matches: false,
      },
    });
  });

  it('accepts only an executable regular launcher with exact managed bindings', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-runtime-contract-'));
    const bin = path.join(home, '.ao', 'bin');
    const launcher = path.join(bin, 'ao');
    try {
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(launcher, `#!/bin/sh
if [ "$AO_MANAGED_RUNTIME_BINARY_SHA256" != "${runtime.binary_sha256}" ]; then
  echo "ao-wrapper: managed AO launcher digest mismatch" >&2
  exit 126
fi
echo "ao version 1.2.3"
`, { mode: 0o755 });
      expect(inspectWorkerLauncher(runtime, {
        HOME: home,
        AO_MANAGED_RUNTIME_BINARY: runtime.binary_path,
        AO_MANAGED_RUNTIME_BINARY_SHA256: runtime.binary_sha256,
        AO_MANAGED_RUNTIME_DATA_DIR: path.join(home, '.local/share/ao-pilot/cie-runtime/data'),
        AO_MANAGED_RUNTIME_RUN_FILE: path.join(home, '.local/share/ao-pilot/cie-runtime/running.json'),
      })).toEqual({
        ...successfulLauncher(),
        path: launcher,
      });

      fs.writeFileSync(launcher, '#!/bin/sh\necho "ao version 1.2.3"\n', { mode: 0o755 });
      expect(inspectWorkerLauncher(runtime, {
        HOME: home,
        AO_MANAGED_RUNTIME_BINARY: runtime.binary_path,
        AO_MANAGED_RUNTIME_BINARY_SHA256: runtime.binary_sha256,
        AO_MANAGED_RUNTIME_DATA_DIR: path.join(home, '.local/share/ao-pilot/cie-runtime/data'),
        AO_MANAGED_RUNTIME_RUN_FILE: path.join(home, '.local/share/ao-pilot/cie-runtime/running.json'),
      }).authenticated).toBe(false);

      fs.rmSync(launcher);
      fs.symlinkSync('/bin/true', launcher);
      expect(inspectWorkerLauncher(runtime, {
        HOME: home,
        AO_MANAGED_RUNTIME_BINARY: runtime.binary_path,
        AO_MANAGED_RUNTIME_BINARY_SHA256: runtime.binary_sha256,
        AO_MANAGED_RUNTIME_DATA_DIR: path.join(home, '.local/share/ao-pilot/cie-runtime/data'),
        AO_MANAGED_RUNTIME_RUN_FILE: path.join(home, '.local/share/ao-pilot/cie-runtime/running.json'),
      }).available).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('bounds launcher authentication probes and treats timeouts as unauthenticated', () => {
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'ao-runtime-contract-'));
    const bin=path.join(home,'.ao','bin');
    const launcher=path.join(bin,'ao');
    const execute=jest.fn().mockReturnValue({status:null,stdout:'',stderr:'',error:{code:'ETIMEDOUT'}});
    try {
      fs.mkdirSync(bin,{recursive:true});
      fs.writeFileSync(launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
      expect(inspectWorkerLauncher(runtime,{
        HOME:home,AO_MANAGED_RUNTIME_BINARY:runtime.binary_path,
        AO_MANAGED_RUNTIME_BINARY_SHA256:runtime.binary_sha256,
        AO_MANAGED_RUNTIME_DATA_DIR:path.join(home,'.local/share/ao-pilot/cie-runtime/data'),
        AO_MANAGED_RUNTIME_RUN_FILE:path.join(home,'.local/share/ao-pilot/cie-runtime/running.json'),
      },execute).authenticated).toBe(false);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[0][2]).toMatchObject({timeout:5_000});
      expect(execute.mock.calls[1][2]).toMatchObject({timeout:5_000});
    } finally {
      fs.rmSync(home,{recursive:true,force:true});
    }
  });

  it('probes only read-only help/version surfaces on the exact resolved binary', async () => {
    const output = [];
    const executeRuntime = jest.fn((resolved, args) => ({
      runtime: resolved,
      result: {
        status: 0,
        stdout: args[0] === '--version'
          ? 'ao version 1.2.3\n'
          : args[0] === 'status'
            ? 'Usage: ao status [flags]\n --json'
            : args[0] === 'project'
              ? 'Usage: ao project get <id> [flags]\n --json'
              : 'Usage: ao spawn [flags]\n --attempt-id string',
        stderr: '',
        error_code: null,
      },
    }));
    const result = await runCli(['--json'], {
      writeStdout: (text) => output.push(text),
      writeStderr: (text) => output.push(text),
    }, {
      resolveRuntime: () => runtime,
      resolveInstalledBinding: () => successfulInstalledBinding(),
      executeRuntime,
      inspectLauncher: () => successfulLauncher(),
      env: {HOME:'/home/test'},
    });

    expect(result.exitCode).toBe(0);
    expect(executeRuntime.mock.calls.map(([, args]) => args)).toEqual([
      ['--version'],
      ['status', '--help'],
      ['project', 'get', '--help'],
      ['spawn', '--help'],
    ]);
    expect(JSON.parse(output.join('')).status).toBe('passed');
  });

  it('converts probe exceptions into a structured hold', async () => {
    const output = [];
    const error = Object.assign(new Error('deployment binding changed'), {
      code: 'runtime_binding_changed',
    });
    const result = await runCli(['--json'], {
      writeStdout: (text) => output.push(text),
      writeStderr: (text) => output.push(text),
    }, {
      resolveRuntime: () => runtime,
      resolveInstalledBinding: () => successfulInstalledBinding(),
      executeRuntime: () => { throw error; },
      env: {HOME:'/home/test'},
    });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(output.join(''))).toMatchObject({
      status: 'hold',
      code: 'runtime_binding_changed',
      runtime: { binary_path: runtime.binary_path },
    });
  });

  it('derives missing worker bindings from the active installed service', async () => {
    const output=[];
    const inspectLauncher=jest.fn(() => successfulLauncher());
    const result=await runCli(['--json'],{
      writeStdout:text=>output.push(text),writeStderr:text=>output.push(text),
    },{
      env:{HOME:'/home/test'},
      resolveRuntime:()=>runtime,
      resolveInstalledBinding:()=>successfulInstalledBinding(),
      executeRuntime:(resolved,args)=>({runtime:resolved,result:{status:0,stdout:args[0]==='--version'?'ao version 1.2.3\n':args[0]==='status'?'Usage: ao status [flags]\n --json':args[0]==='project'?'Usage: ao project get <id> [flags]\n --json':'Usage: ao spawn [flags]\n --attempt-id string',stderr:'',error_code:null}}),
      inspectLauncher,
    });
    expect(result.exitCode).toBe(0);
    expect(inspectLauncher).toHaveBeenCalledWith(runtime,expect.objectContaining({
      AO_MANAGED_RUNTIME_BINARY:runtime.binary_path,
      AO_MANAGED_RUNTIME_BINARY_SHA256:runtime.binary_sha256,
      AO_MANAGED_RUNTIME_DATA_DIR:successfulInstalledBinding().data_dir,
      AO_MANAGED_RUNTIME_RUN_FILE:successfulInstalledBinding().run_file,
    }));
  });

  it('rejects unsupported options before resolving the runtime', () => {
    expect(() => parseRuntimeContractArgs(['--project', 'x'])).toThrow('Unknown argument');
  });
});
