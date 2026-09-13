import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect, jest } from '@jest/globals';
import { createSupervisedExecution, describeExecutionInputs, linuxProcessIdentity } from '../../scripts/ao/lib/supervised-execution.js';
import { createExecutionStore } from '../../scripts/ao/lib/execution-store.js';
import { authorityDigest, createOwnerAuthorityLedger } from '../../scripts/ao/lib/owner-authority-ledger.js';
import { createOwnerRecoveryPolicy } from '../../scripts/ao/lib/owner-recovery-policy.js';
import { recoverySweep } from '../../scripts/ao/lib/session-recovery.js';
async function fixture(run, code = "const fs=require('fs');fs.writeFileSync('summary.json',JSON.stringify({schema_version:'ao.execution-summary.v1',invocation_id:process.env.AO_EXECUTION_INVOCATION_ID,input_digest:process.env.AO_EXECUTION_INPUT_DIGEST,exit_code:0}));console.log('TERMINAL SUMMARY');") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-execution-')),
    cwd = path.join(root, 'repo'),
    directory = path.join(root, 'store');
  fs.mkdirSync(cwd);
  for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.test'], ['config', 'user.name', 'Fixture']]) {
    const r = spawnSync('git', args, {
      cwd
    });
    if (r.status !== 0) throw r.error || Error('git fixture');
  }
  fs.writeFileSync(path.join(cwd, 'command.cjs'), code);
  spawnSync('git', ['add', 'command.cjs'], {
    cwd
  });
  spawnSync('git', ['commit', '-qm', 'fixture'], {
    cwd
  });
  const inputs = describeExecutionInputs({
      cwd
    }),
    scope = {
      repository: 'Samsen879/ao-pilot',
      project_id: 'ap',
      task_id: '109',
      pr_number: 124,
      worker_ref: 'worker',
      session_id: 'ap-1',
      generation: 'birth',
      head_sha: inputs.head_sha,
      tree_sha: inputs.tree_sha,
      input_digest: inputs.input_digest,
      prior_invocation_id: null
    };
  const ledger = createOwnerAuthorityLedger({
    directory: path.join(root, 'authority'),
    ownerRef: 'Owner',
    verifySource: async ({
      sourceProof
    }) => sourceProof.fixture === true ? {
      owner_ref: 'Owner',
      source_ref: 'unit-source'
    } : null
  });
  const grant = async (event_id, scope, actions = ['execution.run'], supersedes = []) => ledger.ingest({
    schema_version: 'ao.owner-authority-event.v1',
    event_id,
    kind: 'grant',
    owner_ref: 'Owner',
    source_ref: 'unit-source',
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    scope,
    allowed_actions: actions,
    prohibited_actions: [],
    supersedes,
    revokes: [],
    dependency_gates: []
  }, {
    fixture: true
  });
  const manifest = {
    schema_version: 'ao.execution-enrollment.v1',
    invocation_id: 'inv-1',
    scope,
    runtime_handle: {
      runtime_name: 'tmux',
      id: 'original'
    },
    credential_free: true,
    non_daemonizing: true,
    command: {
      executable: process.execPath,
      args: ['command.cjs'],
      cwd
    },
    untracked_inputs: [],
    summary: {
      marker: 'TERMINAL SUMMARY',
      artifact: 'summary.json'
    }
  };
  const execution = createSupervisedExecution({
    directory,
    ledger,
    testOnlyEphemeralStore: true
  });
  try {
    return await run({
      root,
      cwd,
      directory,
      scope,
      ledger,
      grant,
      manifest,
      execution
    });
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true
    });
  }
}
async function until(fn) {
  for (let i = 0; i < 400; i++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await new Promise(r => setTimeout(r, 10));
  }
  throw Error('fixture timeout');
}
test('real child has durable executor/authority/log/exit/summary custody', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  directory
}) => {
  await grant('run', scope);
  const result = await execution.run(manifest);
  expect(result.state).toBe('completed');
  expect(result.evidence_status).toBe('established');
  expect(result.record.validation_pass).toBe(true);
  expect(result.record.executor.pid).toBeGreaterThan(0);
  expect(result.record.child.pid).toBeGreaterThan(0);
  expect(result.record.terminal.exit_code).toBe(0);
  expect(result.record.authority_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(fs.readFileSync(path.join(directory, 'invocations/inv-1/stdout.log'), 'utf8')).toContain('TERMINAL SUMMARY');
}));
test('missing verifier, wrong input or credential enrollment never launches business child', () => fixture(async ({
  execution,
  manifest,
  cwd,
  directory,
  grant,
  scope
}) => {
  await expect(createSupervisedExecution({
    directory,
    testOnlyEphemeralStore: true
  }).run(manifest)).rejects.toThrow('authority');
  await grant('run', scope);
  await expect(execution.run({
    ...manifest,
    credential_free: false
  })).rejects.toThrow('credential-free');
  await expect(execution.run({
    ...manifest,
    command: {
      ...manifest.command,
      args: ['--token=credential']
    }
  })).rejects.toThrow('Credential-like');
  fs.appendFileSync(path.join(cwd, 'command.cjs'), '\n// changed');
  await expect(execution.run(manifest)).rejects.toThrow('drift');
  expect(fs.existsSync(path.join(cwd, 'summary.json'))).toBe(false);
}));
test('helper barrier cannot execute before source grant permits', () => fixture(async ({
  manifest,
  directory,
  cwd
}) => {
  let reject;
  const blocked = {
    consumeAndPermit: () => new Promise((_resolve, r) => reject = r)
  };
  const execution = createSupervisedExecution({
    directory,
    ledger: blocked,
    testOnlyEphemeralStore: true
  });
  const pending = execution.run(manifest);
  await until(() => reject);
  const record = createExecutionStore(directory).read('inv-1');
  expect(record.phase).toBe('ready');
  expect(record.executor.start_identity).toBeTruthy();
  expect(record.child).toBeNull();
  expect(fs.existsSync(path.join(cwd, 'summary.json'))).toBe(false);
  reject(Error('grant refused'));
  await expect(pending).rejects.toThrow('grant refused');
  expect(fs.existsSync(path.join(cwd, 'summary.json'))).toBe(false);
}));
test('undeclared untracked inputs hold; named bytes alter fingerprint', () => fixture(async ({
  cwd
}) => {
  const clean = describeExecutionInputs({
    cwd
  });
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'one');
  expect(() => describeExecutionInputs({
    cwd
  })).toThrow('Undeclared');
  const one = describeExecutionInputs({
    cwd,
    untracked_inputs: ['input.txt']
  });
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'two');
  const two = describeExecutionInputs({
    cwd,
    untracked_inputs: ['input.txt']
  });
  expect(one.input_digest).not.toBe(clean.input_digest);
  expect(two.input_digest).not.toBe(one.input_digest);
}));
test('zero exit with partial TAP cannot become PASS or established summary', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest
}) => {
  await grant('run', scope);
  const result = await execution.run(manifest);
  expect(result.state).toBe('completed');
  expect(result.evidence_status).toBe('missing');
  expect(result.record.validation_pass).toBe(false);
}, "console.log('ok 1 - partial TAP');"));
test('nonzero exit with summary has terminal evidence but FAIL', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest
}) => {
  await grant('run', scope);
  const result = await execution.run(manifest);
  expect(result.evidence_status).toBe('established');
  expect(result.record.validation_pass).toBe(false);
  expect(result.record.terminal.exit_code).toBe(7);
}, "require('fs').writeFileSync('summary.json',JSON.stringify({schema_version:'ao.execution-summary.v1',invocation_id:process.env.AO_EXECUTION_INVOCATION_ID,input_digest:process.env.AO_EXECUTION_INPUT_DIGEST,exit_code:7}));console.log('TERMINAL SUMMARY');process.exit(7);"));
test('terminal logs/artifact/record truncation and substituted identity hold', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  directory
}) => {
  await grant('run', scope);
  await execution.run(manifest);
  const dir = path.join(directory, 'invocations/inv-1');
  const log = fs.readFileSync(path.join(dir, 'stdout.log'));
  fs.appendFileSync(path.join(dir, 'stdout.log'), 'tamper');
  expect((await execution.inspect('inv-1')).evidence_status).toBe('missing');
  fs.writeFileSync(path.join(dir, 'stdout.log'), log);
  fs.writeFileSync(path.join(dir, 'summary.artifact'), 'tamper');
  expect((await execution.inspect('inv-1')).evidence_status).toBe('missing');
  fs.writeFileSync(path.join(dir, 'record.json'), '{');
  await expect(execution.inspect('inv-1')).rejects.toThrow();
}));
test('completed session cannot automatically launch another invocation without explicit rerun', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  cwd
}) => {
  await grant('run', scope);
  await execution.run(manifest);
  const inputs = describeExecutionInputs({
      cwd,
      untracked_inputs: ['summary.json']
    }),
    fresh = {
      ...scope,
      input_digest: inputs.input_digest
    };
  await grant('run2', fresh);
  await expect(execution.run({
    ...manifest,
    invocation_id: 'inv-2',
    scope: fresh,
    untracked_inputs: ['summary.json']
  })).rejects.toThrow('Lane already reserved');
}));
test('authorized rerun rotates lane atomically and never inherits old PASS', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  cwd
}) => {
  await grant('run', scope);
  await execution.run(manifest);
  fs.writeFileSync(path.join(cwd, 'command.cjs'), "console.log('partial TAP');");
  const inputs = describeExecutionInputs({
      cwd,
      untracked_inputs: ['summary.json']
    }),
    next = {
      ...scope,
      input_digest: inputs.input_digest,
      prior_invocation_id: 'inv-1'
    };
  await grant('rerun', next, ['execution.rerun']);
  const result = await execution.run({
    ...manifest,
    invocation_id: 'inv-2',
    scope: next,
    untracked_inputs: ['summary.json']
  });
  expect(result.record.validation_pass).toBe(false);
  expect(result.evidence_status).toBe('missing');
  expect(result.record.manifest.scope.prior_invocation_id).toBe('inv-1');
}));
test('actual running lane blocks concurrent execution and enrolled recovery', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  directory
}) => {
  await grant('run', scope);
  const pending = execution.run(manifest);
  await until(async () => {
    const r = createExecutionStore(directory).read('inv-1');
    return r.phase === 'running' && r;
  });
  const restoreScope = {
    ...scope,
    prior_invocation_id: 'inv-1'
  };
  await grant('restore', restoreScope, ['conversation.restore']);
  const adapter = {
    validate: async () => {},
    alive: async () => false,
    restore: jest.fn()
  };
  const binding = {
    projectId: 'ap',
    authorityEnrollment: {
      schema_version: 'ao.owner-recovery-enrollment.v1',
      scope: restoreScope,
      invocation_id: 'restore-1',
      gate_proofs: []
    }
  };
  const policy = createOwnerRecoveryPolicy({
    ledger: {
      consumeAndPermit: async (_options, permit) => permit({})
    },
    reconcileExecutionAndPermit: execution.reconcileExecutionAndPermit
  });
  const result = await recoverySweep({
    sessions: {
      'ap-1': binding
    }
  }, adapter, {
    restore: true,
    authorityPolicy: policy
  });
  expect(result.results[0].state).toBe('HOLD');
  expect(adapter.restore).not.toHaveBeenCalled();
  expect((await execution.inspect('inv-1')).state).toBe('running');
  const r = await pending;
  expect(r.record.validation_pass).toBe(true);
}, "setTimeout(()=>{require('fs').writeFileSync('summary.json',JSON.stringify({schema_version:'ao.execution-summary.v1',invocation_id:process.env.AO_EXECUTION_INVOCATION_ID,input_digest:process.env.AO_EXECUTION_INPUT_DIGEST,exit_code:0}));console.log('TERMINAL SUMMARY');},500);"));
test('actual terminal recovery holds execution custody until restore starts and keeps lane reserved', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  cwd,
  ledger,
  directory
}) => {
  await grant('run', scope);
  await execution.run(manifest);
  const s = {
    ...scope,
    prior_invocation_id: 'inv-1'
  };
  await grant('restore', s, ['conversation.restore']);
  const policy = createOwnerRecoveryPolicy({
    ledger,
    reconcileExecutionAndPermit: execution.reconcileExecutionAndPermit
  });
  const binding = {
    projectId: 'ap',
    authorityEnrollment: {
      schema_version: 'ao.owner-recovery-enrollment.v1',
      scope: s,
      invocation_id: 'restore-1',
      gate_proofs: []
    }
  };
  let release, entered;
  const wait = new Promise(r => release = r),
    signal = new Promise(r => entered = r);
  const restore = jest.fn(async () => {
    entered();
    await wait;
  });
  const pending = policy.restore('ap-1', binding, restore);
  await signal;
  await expect(createExecutionStore(directory).withLock(() => true)).rejects.toThrow('mutation');
  release();
  await pending;
  expect(restore).toHaveBeenCalledTimes(1);
  const inputs = describeExecutionInputs({
      cwd,
      untracked_inputs: ['summary.json']
    }),
    next = {
      ...s,
      input_digest: inputs.input_digest
    };
  await grant('rerun', next, ['execution.rerun']);
  await expect(execution.run({
    ...manifest,
    invocation_id: 'inv-2',
    scope: next,
    untracked_inputs: ['summary.json']
  })).rejects.toThrow('Lane already reserved');
}));
test('host boot change, PID reuse and lost executor are conservative interrupted/unknown observations', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  directory
}) => {
  await grant('run', scope);
  await execution.run(manifest);
  const store = createExecutionStore(directory),
    record = store.read('inv-1');
  record.phase = 'running';
  record.terminal = null;
  record.validation_pass = false;
  record.applied_event_sequence = 1;
  fs.unlinkSync(path.join(directory, 'invocations/inv-1/event-000002.json'));
  store.save(record);
  const bootChanged = createSupervisedExecution({
    directory,
    testOnlyEphemeralStore: true,
    processIdentity: pid => ({
      ...linuxProcessIdentity(process.pid),
      pid,
      boot_id: 'next-boot'
    })
  });
  expect((await bootChanged.inspect('inv-1')).state).toBe('interrupted');
  expect((await bootChanged.inspect('inv-1')).validation_pass).toBe(false);
  const reused = createSupervisedExecution({
    directory,
    testOnlyEphemeralStore: true,
    processIdentity: pid => ({
      ...linuxProcessIdentity(process.pid),
      pid,
      start_identity: 'reused',
      state: 'S'
    })
  });
  expect((await reused.inspect('inv-1')).state).toBe('interrupted');
  const unknown = createSupervisedExecution({
    directory,
    testOnlyEphemeralStore: true,
    processIdentity: pid => {
      if (pid === process.pid) return linuxProcessIdentity(pid);
      throw Object.assign(Error('denied'), {
        code: 'EPERM'
      });
    }
  });
  expect((await unknown.inspect('inv-1')).state).toBe('unknown');
}));
test('symlink/private custody and temporary production storage reject', () => fixture(async ({
  directory,
  root
}) => {
  expect(() => createSupervisedExecution({
    directory
  })).toThrow('Persistent');
  fs.mkdirSync(directory, {
    mode: 0o700
  });
  fs.symlinkSync(directory, path.join(root, 'alias'));
  const execution = createSupervisedExecution({
    directory: path.join(root, 'alias'),
    testOnlyEphemeralStore: true
  });
  await expect(execution.inspect('x')).rejects.toThrow('symlink');
}));
test('business child alive after helper kill blocks recovery; group kill becomes interrupted', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  directory
}) => {
  await grant('run', scope);
  const pending = execution.run(manifest),
    settled = pending.then(value => ({
      value
    }), error => ({
      error
    }));
  const running = await until(() => {
    const r = createExecutionStore(directory).read('inv-1');
    return r.phase === 'running' && r;
  });
  process.kill(running.executor.pid, 'SIGKILL');
  await until(async () => {
    try {
      linuxProcessIdentity(running.executor.pid);
      return false;
    } catch {
      return true;
    }
  });
  expect((await execution.inspect('inv-1')).state).toBe('running');
  process.kill(-running.executor.pid, 'SIGKILL');
  const result = await settled;
  expect(result.error.message).toContain('terminal record');
  const observation = await execution.inspect('inv-1');
  expect(observation.state).toBe('interrupted');
  expect(observation.validation_pass).toBe(false);
}, "setTimeout(()=>console.log('partial TAP'),10000);"));
test('old summary artifact cannot authorize a new invocation with a fresh marker', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  cwd
}) => {
  await grant('run', scope);
  await execution.run(manifest);
  fs.writeFileSync(path.join(cwd, 'command.cjs'), "console.log('TERMINAL SUMMARY');");
  const inputs = describeExecutionInputs({
      cwd,
      untracked_inputs: ['summary.json']
    }),
    next = {
      ...scope,
      input_digest: inputs.input_digest,
      prior_invocation_id: 'inv-1'
    };
  await grant('rerun', next, ['execution.rerun']);
  await expect(execution.run({
    ...manifest,
    invocation_id: 'inv-2',
    scope: next,
    untracked_inputs: ['summary.json']
  })).rejects.toThrow('another invocation');
  expect((await execution.inspect('inv-2')).evidence_status).toBe('missing');
}));
test('ready evidence write failure never permits business command', () => fixture(async ({
  manifest,
  directory,
  cwd
}) => {
  const fakeLedger = {
    consumeAndPermit: jest.fn(async (_options, permit) => permit({
      event_sha256: 'a'.repeat(64)
    }))
  };
  const execution = createSupervisedExecution({
    directory,
    ledger: fakeLedger,
    testOnlyEphemeralStore: true
  });
  // An interrupted global store mutation is a hard stop before helper creation.
  fs.mkdirSync(directory, {
    mode: 0o700
  });
  fs.mkdirSync(path.join(directory, '.mutation-lock'), {
    mode: 0o700
  });
  await expect(execution.run(manifest)).rejects.toThrow('mutation');
  expect(fakeLedger.consumeAndPermit).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(cwd, 'summary.json'))).toBe(false);
}));
test('top-level execution help/unsigned launch do not require config or launch a child', async () => {
  const {
    runCli
  } = await import('../../bin/ao-pilot.js');
  const io = {
    writeStdout: jest.fn(),
    writeStderr: jest.fn()
  };
  expect((await runCli(['execution', '--help'], io, {
    cwd: '/tmp'
  })).exitCode).toBe(0);
  expect((await runCli(['execution', 'run'], io, {
    cwd: '/tmp'
  })).exitCode).toBe(2);
  expect(io.writeStderr).toHaveBeenCalledWith('Execution custody cannot be established; HOLD\n');
});
test('normalized .. and root /tmp production custody reject before creation', () => {
  expect(() => createSupervisedExecution({
    directory: '/home/samsen/../../tmp/ao-normalized-custody'
  })).toThrow('Persistent');
  expect(() => createSupervisedExecution({
    directory: '/tmp'
  })).toThrow('Persistent');
  expect(() => createSupervisedExecution({
    directory: '/home/samsen/x/../node_modules/store'
  })).toThrow('Persistent');
});
test('same-process disjoint lane restore cannot lose a naturally exiting child receipt', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  directory
}) => {
  await grant('run', scope);
  const pending = execution.run(manifest);
  const running = await until(() => {
    const r = createExecutionStore(directory).read('inv-1');
    return r.phase === 'running' && r;
  });
  const store = createExecutionStore(directory);
  let release, entered;
  const barrier = new Promise(r => release = r),
    signal = new Promise(r => entered = r);
  const foreignRestore = store.withLock(async () => {
    entered();
    await barrier;
  });
  await signal;
  await until(() => fs.readdirSync(path.join(directory, 'invocations/inv-1')).some(name => name === 'event-000002.json'));
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'invocations/inv-1/event-000002.json')));
  expect(receipt.event.type).toBe('terminal');
  expect(receipt.event.payload.exit_code).toBe(0);
  release();
  await foreignRestore;
  const result = await pending;
  expect(result.evidence_status).toBe('established');
  expect(result.validation_pass).toBe(true);
}, "setTimeout(()=>{require('fs').writeFileSync('summary.json',JSON.stringify({schema_version:'ao.execution-summary.v1',invocation_id:process.env.AO_EXECUTION_INVOCATION_ID,input_digest:process.env.AO_EXECUTION_INPUT_DIGEST,exit_code:0}));console.log('TERMINAL SUMMARY');},300);"));
test('cross-process legitimate restore lock retains terminal event until finalization', () => fixture(async ({
  execution,
  grant,
  scope,
  manifest,
  directory
}) => {
  const {
    spawn
  } = await import('node:child_process');
  await grant('run', scope);
  const pending = execution.run(manifest);
  await until(() => createExecutionStore(directory).read('inv-1').phase === 'running');
  const module = new URL('../../scripts/ao/lib/execution-store.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createExecutionStore} from ${JSON.stringify(module)};await createExecutionStore(process.argv[1]).withLock(async()=>{process.stdout.write('locked\\n');await new Promise(r=>setTimeout(r,400));});`, directory], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error('foreign fixture failed')));
  });
  await new Promise(resolve => child.stdout.once('data', resolve));
  await until(() => fs.existsSync(path.join(directory, 'invocations/inv-1/event-000002.json')));
  expect((await execution.inspect('inv-1')).observed_terminal.exit_code).toBe(0);
  await finished;
  const result = await pending;
  expect(result.evidence_status).toBe('established');
  expect(result.validation_pass).toBe(true);
}, "setTimeout(()=>{require('fs').writeFileSync('summary.json',JSON.stringify({schema_version:'ao.execution-summary.v1',invocation_id:process.env.AO_EXECUTION_INVOCATION_ID,input_digest:process.env.AO_EXECUTION_INPUT_DIGEST,exit_code:0}));console.log('TERMINAL SUMMARY');},300);"));
