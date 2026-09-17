import { describe, expect, it, jest } from '@jest/globals';

import {
  buildRuntimeContract,
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

describe('installed runtime CLI contract', () => {
  it('publishes distinct global status and project readback commands', () => {
    const report = buildRuntimeContract(runtime, successfulProbes());
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
    expect(buildRuntimeContract(runtime, probes)).toMatchObject({
      status: 'hold',
      checks: {
        status_project_flag_absent: false,
        spawn_attempt_custody_supported: false,
      },
    });
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
    }, { resolveRuntime: () => runtime, executeRuntime });

    expect(result.exitCode).toBe(0);
    expect(executeRuntime.mock.calls.map(([, args]) => args)).toEqual([
      ['--version'],
      ['status', '--help'],
      ['project', 'get', '--help'],
      ['spawn', '--help'],
    ]);
    expect(JSON.parse(output.join('')).status).toBe('passed');
  });

  it('rejects unsupported options before resolving the runtime', () => {
    expect(() => parseRuntimeContractArgs(['--project', 'x'])).toThrow('Unknown argument');
  });
});
