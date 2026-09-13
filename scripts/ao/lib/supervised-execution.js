import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { authorityDigest, canonicalAuthorityJson, normalizeOwnerScope } from './owner-authority-ledger.js';
import { createExecutionStore, privateDirectory, readPrivate, savePrivate, syncDirectory } from './execution-store.js';
const fixedEnvironment = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC'
};
function hold(message) {
  throw new Error(`${message}; HOLD`);
}
function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    env: {
      ...fixedEnvironment,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null'
    },
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error || result.status !== 0) hold('Cannot establish Git input custody');
  return result.stdout;
}
export function describeExecutionInputs({
  cwd,
  untracked_inputs = []
}) {
  const root = fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).toString().trim());
  const head_sha = git(root, ['rev-parse', 'HEAD']).toString().trim(),
    tree_sha = git(root, ['rev-parse', 'HEAD^{tree}']).toString().trim();
  const actual = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean).sort();
  if (!Array.isArray(untracked_inputs) || new Set(untracked_inputs).size !== untracked_inputs.length || canonicalAuthorityJson([...untracked_inputs].sort()) !== canonicalAuthorityJson(actual)) hold('Undeclared untracked inputs');
  const untracked = actual.map(name => {
    const file = path.join(root, name),
      info = fs.lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) hold('Untrusted untracked input');
    return {
      path: name,
      size: info.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    };
  });
  const snapshot = {
    head_sha,
    tree_sha,
    diff_sha256: crypto.createHash('sha256').update(git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])).digest('hex'),
    cached_diff_sha256: crypto.createHash('sha256').update(git(root, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])).digest('hex'),
    untracked
  };
  return {
    root,
    ...snapshot,
    input_digest: authorityDigest(snapshot)
  };
}
export function linuxProcessIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'),
    fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return {
    pid,
    boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    start_identity: fields[19],
    state: fields[0]
  };
}
function validateManifest(manifest) {
  const expected = ['schema_version', 'invocation_id', 'scope', 'runtime_handle', 'credential_free', 'non_daemonizing', 'command', 'untracked_inputs', 'summary'];
  if (!manifest || Object.keys(manifest).sort().join('|') !== expected.sort().join('|') || manifest.schema_version !== 'ao.execution-enrollment.v1' || manifest.credential_free !== true || manifest.non_daemonizing !== true) hold('Explicit credential-free non-daemonizing enrollment required');
  normalizeOwnerScope(manifest.scope);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(manifest.invocation_id)) hold('Invalid invocation ID');
  const command = manifest.command;
  if (!command || Object.keys(command).sort().join('|') !== 'args|cwd|executable' || !path.isAbsolute(command.executable) || !path.isAbsolute(command.cwd) || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string')) hold('Invalid enrolled command');
  if (/--?(?:token|password|secret|credential|api[_-]?key)(?:=|\s|$)|(?:sk-|ghp_|github_pat_)[a-zA-Z0-9]/i.test([command.executable, ...command.args].join(' '))) hold('Credential-like argv prohibited');
  if (!manifest.runtime_handle || Object.keys(manifest.runtime_handle).sort().join('|') !== 'id|runtime_name' || ['id', 'runtime_name'].some(key => typeof manifest.runtime_handle[key] !== 'string' || !manifest.runtime_handle[key])) hold('Runtime identity required');
  const summary = manifest.summary;
  if (!summary || Object.keys(summary).sort().join('|') !== 'artifact|marker' || typeof summary.marker !== 'string' || !summary.marker.trim() || summary.marker.includes('\n') || typeof summary.artifact !== 'string' || path.isAbsolute(summary.artifact) || summary.artifact.split(/[\\/]/).includes('..')) hold('Bounded terminal summary contract required');
  return JSON.parse(canonicalAuthorityJson(manifest));
}
export function createSupervisedExecution({
  directory = path.join(os.homedir(), '.local/share/ao-pilot/executions'),
  ledger,
  processIdentity = linuxProcessIdentity,
  testOnlyEphemeralStore = false
}) {
  if(!path.isAbsolute(directory)) hold('Execution store must be absolute');
  directory = path.resolve(directory);
  const store = createExecutionStore(directory);
  if (!path.isAbsolute(directory) || directory.split(path.sep).includes('node_modules') || (directory === '/tmp' || directory.startsWith('/tmp/')) && !testOnlyEphemeralStore) hold('Persistent execution custody required');
  function processObservation(identity, currentBoot) {
    if (!identity) return 'unknown';
    if (identity.boot_id !== currentBoot) return 'absent';
    try {
      const live = processIdentity(identity.pid);
      return live.boot_id === identity.boot_id && live.start_identity === identity.start_identity && !['Z', 'X'].includes(live.state) ? 'live' : 'absent';
    } catch (error) {
      return error.code === 'ENOENT' || error.code === 'ESRCH' ? 'absent' : 'unknown';
    }
  }
  function inspectUnlocked(invocationId) {
    const record = store.read(invocationId),
      dir = store.recordDirectory(invocationId);
    const events = fs.readdirSync(dir).filter(name => /^event-[0-9]{6}\.json$/.test(name)).sort().map(name => {
      const envelope = readPrivate(path.join(dir, name));
      if (envelope.event_sha256 !== authorityDigest(envelope.event) || envelope.event.invocation_id !== invocationId) hold('Helper event identity/digest changed');
      return envelope.event;
    });
    for (let index = 0; index < events.length; index++) {
      if (events[index].sequence !== index + 1 || !['child', 'terminal'].includes(events[index].type)) hold('Helper event order/custody changed');
    }
    if ((record.applied_event_sequence || 0) > events.length) hold('Applied helper event missing');
    const observedTerminal = events.findLast(event => event.type === 'terminal');
    const currentBoot = processIdentity(process.pid).boot_id;
    const executor = processObservation(record.executor, currentBoot),
      child = processObservation(events.findLast(event => event.type === 'child')?.payload || record.child, currentBoot);
    const observation = {
      invocation_id: invocationId,
      state: 'unknown',
      evidence_status: 'missing',
      validation_pass: false,
      reason: 'Process custody uncertain',
      record,
      observed_terminal: observedTerminal?.payload || null
    };
    // Even a terminal receipt cannot override a live enrolled process.
    if (executor === 'live' || child === 'live') return {
      ...observation,
      state: 'running',
      reason: 'Enrolled process still live'
    };
    if (executor === 'unknown' || child === 'unknown' && record.phase === 'permitted' && record.executor?.boot_id === currentBoot) return observation;
    const logs = {};
    for (const name of ['stdout', 'stderr']) {
      const bytes = readPrivate(path.join(dir, name + '.log'), false);
      logs[name] = {
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      };
    }
    if (record.phase === 'completed') {
      if (authorityDigest(logs) !== authorityDigest(record.logs)) return {
        ...observation,
        reason: 'Terminal logs missing or changed'
      };
      if (record.summary?.status !== 'established') return {
        ...observation,
        state: 'completed',
        reason: 'Terminal summary missing'
      };
      const bytes = readPrivate(path.join(dir, 'summary.artifact'), false);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== record.summary.sha256) return {
        ...observation,
        state: 'completed',
        reason: 'Terminal artifact changed'
      };
      return {
        ...observation,
        state: 'completed',
        evidence_status: 'established',
        validation_pass: record.validation_pass === true,
        reason: 'Durable exit/log/summary custody'
      };
    }
    if (observedTerminal && record.phase !== 'completed' && record.phase !== 'interrupted') return {
      ...observation,
      state: 'completed',
      reason: 'Observed terminal not finalized; durable event retained'
    };
    if (record.terminal && record.phase !== 'interrupted') return {
      ...observation,
      reason: 'Terminal receipt not finalized; evidence missing'
    };
    if (record.executor && executor === 'absent' && (child === 'absent' || record.executor.boot_id !== currentBoot || record.phase === 'ready')) return {
      ...observation,
      state: 'interrupted',
      evidence_status: 'established',
      reason: record.executor.boot_id !== currentBoot ? 'host_boot_changed' : 'enrolled_process_absent'
    };
    return observation;
  }
  async function inspect(invocationId) {
    return inspectUnlocked(invocationId);
  }
  async function run(enrollment, {
    gateProofs = []
  } = {}) {
    if (typeof ledger?.consumeAndPermit !== 'function') hold('Host-verified execution authority required');
    const manifest = validateManifest(enrollment),
      inputs = describeExecutionInputs({
        cwd: manifest.command.cwd,
        untracked_inputs: manifest.untracked_inputs
      }),
      scope = manifest.scope;
    if (directory === inputs.root || directory.startsWith(inputs.root + path.sep)) hold('Execution store cannot be repository work/cache');
    if (scope.head_sha !== inputs.head_sha || scope.tree_sha !== inputs.tree_sha || scope.input_digest !== inputs.input_digest) hold('Invocation Git/input identity drift');
    const invocationId = manifest.invocation_id,
      dir = store.recordDirectory(invocationId);
    let record = {
      schema_version: 'ao.execution-record.v1',
      invocation_id: invocationId,
      custody_domain: testOnlyEphemeralStore ? 'test-only' : 'persistent',
      manifest,
      inputs,
      phase: 'intent',
      executor: null,
      child: null,
      authority_sha256: null,
      created_at: new Date().toISOString(),
      terminal: null,
      logs: null,
      summary: null
    };
    // Reserve unique evidence before helper launch. Lane mutation and effect start
    // later share the same store lock as recovery, under the ledger lock.
    await store.withLock(() => {
      if (fs.existsSync(dir)) hold('Invocation ID already enrolled; never retry');
      privateDirectory(dir, true);
      for (const name of ['stdout', 'stderr']) {
        const fd = fs.openSync(path.join(dir, name + '.log'), 'wx', 0o600);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      }
      store.save(record, true);
    });
    let helper;
    const ready = new Promise((resolve, reject) => {
      helper = spawn(process.execPath, [fileURLToPath(new URL('./execution-barrier.js', import.meta.url))], {
        cwd: manifest.command.cwd,
        env: fixedEnvironment,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      helper.once('error', reject);
      helper.once('exit', () => reject(new Error('Executor barrier exited; HOLD')));
      helper.once('message', message => message.type === 'ready' ? resolve(message.identity) : reject(new Error('Executor identity unavailable; HOLD')));
    });
    const stdout = fs.createWriteStream(path.join(dir, 'stdout.log'), {
        flags: 'a',
        mode: 0o600
      }),
      stderr = fs.createWriteStream(path.join(dir, 'stderr.log'), {
        flags: 'a',
        mode: 0o600
      });
    helper.stdout.pipe(stdout);
    helper.stderr.pipe(stderr);
    let queue = Promise.resolve(),
      writeFailure,
      eventSequence = 0;
    function enqueue(type, payload) {
      // This invocation has one helper observer. Persist exact observed child/
      // terminal custody independently of the global lane-mutation lock.
      const sequence = ++eventSequence;
      const event = {
        schema_version: 'ao.execution-observation-event.v1',
        invocation_id: invocationId,
        sequence,
        type,
        payload,
        observed_at: new Date().toISOString()
      };
      try {
        savePrivate(path.join(dir, `event-${String(sequence).padStart(6, '0')}.json`), {
          event,
          event_sha256: authorityDigest(event)
        }, true);
      } catch (error) {
        writeFailure = error;
        return;
      }
      queue = queue.then(() => store.withLock(() => {
        if (type === 'child') {
          record.child = payload;
          record.phase = 'running';
        } else record.terminal = payload;
        record.applied_event_sequence = sequence;
        store.save(record);
      }, {
        waitForCustody: true
      })).catch(error => {
        writeFailure = error;
      });
    }
    helper.on('message', message => {
      if (message.type === 'child') enqueue('child', {
        pid: message.identity.pid,
        boot_id: message.identity.boot_id,
        start_identity: message.identity.start_identity
      });
      if (message.type === 'terminal') enqueue('terminal', {
        exit_code: message.exit_code,
        signal: message.signal,
        reason: 'helper_child_exit',
        at: new Date().toISOString()
      });
    });
    const finished = new Promise(resolve => helper.once('close', (code, signal) => resolve({
      code,
      signal
    })));
    try {
      const executorIdentity = await ready;
      record.executor = {
        pid: executorIdentity.pid,
        boot_id: executorIdentity.boot_id,
        start_identity: executorIdentity.start_identity
      };
      record.phase = 'ready';
      await store.withLock(() => store.save(record));
      const action = scope.prior_invocation_id === null ? 'execution.run' : 'execution.rerun';
      await ledger.consumeAndPermit({
        scope,
        action,
        invocationId,
        gateProofs
      }, authority => store.withLock(() => {
        const fresh = describeExecutionInputs({
          cwd: manifest.command.cwd,
          untracked_inputs: manifest.untracked_inputs
        });
        if (fresh.input_digest !== inputs.input_digest) hold('Inputs changed before permit');
        const laneFile = store.laneFile(scope);
        if (fs.existsSync(laneFile)) {
          const previous = readPrivate(laneFile);
          if (previous.restored || previous.invocation_id !== scope.prior_invocation_id) hold('Lane already reserved; no inferred successor');
          const observation = inspectUnlocked(previous.invocation_id);
          if (!['completed', 'interrupted'].includes(observation.state) || observation.evidence_status !== 'established') hold('Previous invocation not safely terminal');
        } else if (scope.prior_invocation_id !== null) hold('Rerun predecessor custody missing');
        savePrivate(laneFile, {
          invocation_id: invocationId,
          restored: false
        });
        record.authority_sha256 = authority.event_sha256;
        record.phase = 'permitted';
        store.save(record);
        helper.send({
          type: 'permit',
          command: manifest.command,
          environment: {
            ...fixedEnvironment,
            AO_EXECUTION_INVOCATION_ID: invocationId,
            AO_EXECUTION_INPUT_DIGEST: inputs.input_digest
          }
        });
      }));
    } catch (error) {
      // No business child before permission. A permitted uncertainty retains custody.
      if (record.phase !== 'permitted' && record.phase !== 'running') helper.kill('SIGTERM');
      await finished;
      await queue;
      throw error;
    }
    const close = await finished;
    await queue;
    await Promise.all([stdout, stderr].map(stream => stream.closed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve))));
    if (writeFailure) throw writeFailure;
    await store.withLock(() => {
      record = store.read(invocationId);
      if (!record.terminal) hold('Executor ended without child terminal record');
      record.logs = {};
      for (const name of ['stdout', 'stderr']) {
        const file = path.join(dir, name + '.log'),
          fd = fs.openSync(file, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        const bytes = readPrivate(file, false);
        record.logs[name] = {
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        };
      }
      record.summary = {
        status: 'missing'
      };
      const output = readPrivate(path.join(dir, 'stdout.log'), false).toString('utf8').trimEnd().split('\n').at(-1);
      if (output === manifest.summary.marker) {
        const artifact = path.join(manifest.command.cwd, manifest.summary.artifact),
          real = fs.realpathSync(artifact);
        if (!real.startsWith(inputs.root + path.sep) || fs.lstatSync(artifact).isSymbolicLink()) hold('Summary artifact identity escapes inputs');
        const bytes = fs.readFileSync(artifact);
        if (bytes.length > 1024 * 1024) hold('Summary artifact size limit');
        const summary = JSON.parse(bytes.toString('utf8'));
        if (summary.schema_version !== 'ao.execution-summary.v1' || summary.invocation_id !== invocationId || summary.input_digest !== inputs.input_digest || summary.exit_code !== record.terminal.exit_code) hold('Summary belongs to another invocation or exit');
        const fd = fs.openSync(path.join(dir, 'summary.artifact'), 'wx', 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        syncDirectory(dir);
        record.summary = {
          status: 'established',
          sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        };
      }
      record.phase = 'completed';
      record.helper_close = close;
      record.validation_pass = record.terminal.exit_code === 0 && record.terminal.signal === null && record.summary.status === 'established';
      store.save(record);
    }, {
      waitForCustody: true
    });
    return inspectUnlocked(invocationId);
  }
  async function reconcileExecutionAndPermit(id, binding, scope, permit) {
    return store.withLock(async () => {
      const laneFile = store.laneFile(scope);
      if (!fs.existsSync(laneFile)) hold('Enrolled execution lane missing');
      const lane = readPrivate(laneFile);
      if (lane.invocation_id !== scope.prior_invocation_id || lane.restored) hold('Execution lane identity changed or restore already initiated');
      const observation = inspectUnlocked(lane.invocation_id),
        original = observation.record.manifest.scope;
      const bound_scope = {
        ...original,
        prior_invocation_id: scope.prior_invocation_id
      };
      if (authorityDigest(bound_scope) !== authorityDigest(scope) || id !== scope.session_id || binding.projectId !== scope.project_id) hold('Recovery execution scope drift');
      if (!['completed', 'interrupted'].includes(observation.state) || observation.evidence_status !== 'established') hold('Enrolled execution not safely terminal');
      // Retain lane custody after restore initiation. An execution rerun cannot
      // release a lane that now has an independently restored conversation writer.
      if (observation.state === 'interrupted') {
        const interrupted = {
          ...observation.record,
          phase: 'interrupted',
          validation_pass: false,
          terminal: {
            exit_code: null,
            signal: null,
            reason: observation.reason,
            at: new Date().toISOString()
          }
        };
        store.save(interrupted);
      }
      savePrivate(laneFile, {
        ...lane,
        restored: true
      });
      return permit({
        ...observation,
        bound_scope
      });
    });
  }
  return {
    run,
    inspect,
    reconcileExecutionAndPermit
  };
}
