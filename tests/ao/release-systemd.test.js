import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { configuration, fixtureRoot, createBundle } from './release-fixture.js';
import { createSystemdReleaseRunner, validateInstallConfiguration, probeExclusiveLock, assertLoadedProcess, assertFirstRestoreConfiguration, firstRestorePlan } from '../../scripts/ao/lib/release-systemd.js';
import { prepareStaging, assertStagingIsolation } from '../../scripts/verify-install-staging.js';
import { runCli } from '../../scripts/ao-upgrade.js';
import { validateEnvironmentOverride } from '../../scripts/ao/lib/release-units.js';
import { inspectInstall } from '../../scripts/ao/lib/install-doctor.js';
const roots = [];
afterEach(() => { roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });
function fixture() { const root = fixtureRoot(); roots.push(root); return { root, config: configuration(root) }; }
it.each([
  [0, 'PASS', 'ok', false],
  [1, 'FAIL', 'violation', false],
  [2, 'FAIL', 'violation', true],
  [1, null, null, true],
  [1, 'invalid-json', null, true],
])('preserves doctor status %i evidence without converting FAIL to PASS or accepting unknown output', async (exitCode, level, status, unknown) => {
  const { root, config } = fixture(); const toolDirectory = path.join(root, 'tools'); fs.mkdirSync(toolDirectory);
  fs.writeFileSync(path.join(toolDirectory, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const report = level ? { checks: [{ name: 'tmux_cgroup', level, details: { status, server_pid: process.pid, server_start_token: 'fixture-token' } }] } : { checks: [] };
  const stdout = level === 'invalid-json' ? 'invalid-json' : JSON.stringify(report);
  const bundle = createBundle(root, { native: `#!/bin/sh\nprintf '%s\\n' '${stdout}'\nexit ${exitCode}\n` });
  const priorPath = process.env.PATH; process.env.PATH = toolDirectory;
  try {
    const runner = createSystemdReleaseRunner(config, { fetchImpl: async () => ({ ok: true, json: async () => ({ sessions: [] }) }) });
    const observation = await runner.observe({ releaseRoot: bundle.payload });
    if (unknown) expect(observation.tmux).toBeNull();
    else expect(observation.tmux).toMatchObject({ level, status, server_pid: process.pid, server_start_token: 'fixture-token' });
    expect(inspectInstall({ releaseRoot: bundle.payload, observation }).checks.tmux_cgroup).toBe(unknown ? 'UNKNOWN' : level);
    // The diagnostic exception must never admit a nonzero service command.
    await expect(runner.stop()).rejects.toMatchObject({ code: 'install_observation_failed' });
  } finally { process.env.PATH = priorPath; }
});
it('allows only the generated private HOME with explicit staging context, never a generic HOME override', () => {
  const { config } = fixture(); const home = path.join(config.stateRoot, 'home');
  const text = `[Service]\nEnvironment="HOME=${home}"\n`;
  expect(() => validateEnvironmentOverride(text)).toThrow('unsafe_unit_override');
  expect(validateEnvironmentOverride(text, { stagingRoot: config.stateRoot })).toEqual({ HOME: home });
  expect(() => validateEnvironmentOverride('[Service]\nEnvironment="HOME=/host-profile"\n', { stagingRoot: config.stateRoot })).toThrow('unsafe_unit_override');
});
it('default runner issues only explicitly namespaced service commands and waits for strict readiness', async () => {
  const { config } = fixture(); const commands = []; let requests = 0; const sleeps = [];
  const runner = createSystemdReleaseRunner(config, { run: (command, args) => { commands.push([command, args]); return ''; }, fetchImpl: async () => ({ ok: true, json: async () => ++requests === 1 ? { status: 'degraded', ready: false, reasons: [{ code: 'boot' }] } : { status: 'ready', ready: true, reasons: [] } }), sleep: async (ms) => { sleeps.push(ms); } });
  await runner.start();
  expect(commands).toHaveLength(5); expect(commands[0]).toEqual(['systemctl', ['--user', 'start', 'ao-pilot-staging-fixture-tmux.service']]);
  expect(commands[4][1]).toContain('ao-pilot-staging-fixture-dashboard-adapter.service'); expect(sleeps).toEqual([250]);
});
it('default runner fails closed when only health=ok or degraded is observed', async () => {
  const { config } = fixture();
  const runner = createSystemdReleaseRunner(config, { run: () => '', fetchImpl: async () => ({ ok: true, json: async () => ({ health: 'ok' }) }), sleep: async () => {}, startupAttempts: 2 });
  await expect(runner.start()).rejects.toMatchObject({ code: 'install_startup_not_ready' });
});
it('rejects partial namespace configuration and symlinked ancestors before executing commands', () => {
  const { root, config } = fixture(); const incomplete = { ...config }; delete incomplete.tmuxTmpdir;
  expect(() => validateInstallConfiguration(incomplete)).toThrow();
  const linked = path.join(root, 'alias'); fs.symlinkSync(config.stateRoot, linked);
  expect(() => validateInstallConfiguration({ ...config, dataDir: path.join(linked, 'data') })).toThrow();
});
it('prepares isolated staging files and never starts services; overlapping production paths fail before writing', () => {
  const { root, config } = fixture(); const staging = path.join(root, 'new-staging');
  const plan = prepareStaging({ root: staging, id: 'unit-test', production: config, ports: [44001, 44000, 44002, 44003, 44004] });
  expect(assertStagingIsolation(plan, config)).toBe(true); expect(fs.existsSync(path.join(staging, 'LOCAL-VALIDATION.md'))).toBe(true);
  expect(fs.statSync(path.join(staging, 'install.json')).mode & 0o777).toBe(0o600);
  const collision = path.join(config.stateRoot, 'unsafe');
  expect(() => prepareStaging({ root: collision, id: 'collision', production: config })).toThrow(); expect(fs.existsSync(collision)).toBe(false);
});
it('upgrade CLI connects registered envelope input to real apply API and emits only its public receipt', async () => {
  const { root, config } = fixture(); const id = `1.0.0+${'a'.repeat(40)}`; config.releaseCatalog = { [id]: { bundle: path.join(root, 'bundle'), envelope_sha256: 'a'.repeat(64) } };
  let supplied; const output = []; const result = await runCli(['apply', '--release', id, '--install-config', path.join(root, 'private.json')], { writeStdout: (text) => output.push(text), writeStderr: (text) => output.push(text) }, { configLoader: () => config, apply: async (options) => { supplied = options; return { result: 'passed' }; } });
  expect(result.exitCode).toBe(0); expect(supplied).toMatchObject({ bundle: path.join(root, 'bundle'), expectedEnvelopeSha256: 'a'.repeat(64), resume: false }); expect(output).toEqual(['{\n  "result": "passed"\n}\n']);
});
it('a missing ownership lock is unknown rather than proof of daemon exit', () => {
  const { root } = fixture(); expect(probeExclusiveLock(path.join(root, 'missing'), { expectHeld: false })).toBeNull();
});
it('keeps the existing strict environment check for every non-adoption stop', async () => {
  const { config } = fixture(); const commands = [];
  const runner = createSystemdReleaseRunner(config, { run: (command, args) => { commands.push([command, args]); return String(process.pid); } });
  await expect(runner.stop()).rejects.toMatchObject({ code: 'install_service_namespace_mismatch' });
  expect(commands.some(([, args]) => args.includes('stop'))).toBe(false);
});
it('rejects unsafe/missing terminal credentials before observations or any service effects', async () => {
  const { config } = fixture(); let calls = 0;
  const runner = createSystemdReleaseRunner(config, { toolResolver: () => process.execPath, run: () => { calls += 1; throw Error('unexpected command'); } });
  fs.chmodSync(config.terminalTokenFile, 0o644);
  await expect(runner.preflight({ mode: 'daily' })).rejects.toMatchObject({ code: 'install_terminal_auth_input_invalid' });
  fs.rmSync(config.terminalTokenFile);
  await expect(runner.preflight({ mode: 'daily' })).rejects.toMatchObject({ code: 'install_terminal_auth_input_invalid' });
  expect(calls).toBe(0);
  expect(() => validateEnvironmentOverride('[Service]\nEnvironment="AO_TERMINAL_TOKEN_FILE=/redirect"\n')).toThrow('unsafe_unit_override');
});
it('requires the explicit CLI adoption option and forwards it only to apply', async () => {
  const { root, config } = fixture(); const id = `1.0.0+${'a'.repeat(40)}`;
  config.releaseCatalog = { [id]: { bundle: path.join(root, 'bundle'), envelope_sha256: 'a'.repeat(64) } };
  let supplied; const io = { writeStdout() {}, writeStderr() {} };
  const options = { configLoader: () => config, apply: async (args) => { supplied = args; return { result: 'passed' }; } };
  expect((await runCli(['apply', '--release', id, '--adopt-legacy'], io, options)).exitCode).toBe(0);
  expect(supplied.adoptLegacy).toBe(true);
  expect((await runCli(['apply', '--release', id, '--adopt-legacy-offline'], io, options)).exitCode).toBe(0);
  expect(supplied).toMatchObject({ adoptLegacy: true, adoptLegacyOffline: true });
  expect((await runCli(['apply', '--release', id, '--adopt-legacy', '--adopt-legacy-offline'], io, options)).exitCode).toBe(2);
  expect((await runCli(['apply', '--release', id, '--adopt-legacy-offline', '--adopt-legacy'], io, options)).exitCode).toBe(2);
  expect((await runCli(['inspect', '--adopt-legacy-offline'], io, options)).exitCode).toBe(2);
  expect((await runCli(['inspect', '--adopt-legacy'], io, options)).exitCode).toBe(2);
});

it('uses the real readyz DTO and never accepts CLI state or contradictory readiness', async () => {
  const { config } = fixture();
  for (const ready of [{ state: 'ready', ready: true, reasons: [] }, { status: 'ready', ready: false, reasons: [] }, { status: 'ready', state: 'degraded', ready: true, reasons: [] }]) {
    const runner = createSystemdReleaseRunner(config, { run: () => '', fetchImpl: async () => ({ ok: true, json: async () => ready }), sleep: async () => {}, startupAttempts: 1 });
    await expect(runner.start()).rejects.toThrow('install_startup_not_ready');
  }
});
it('checks real native cwd=DataDir while release provenance comes from immutable exe/argv and managed bindings', () => {
  const { root, config } = fixture(); const bundle = createBundle(root); fs.mkdirSync(config.dataDir, { recursive: true });
  const manifest = bundle.manifest; const binary = path.join(bundle.payload, 'native/ao'); const sha = manifest.components.daemon.files[0].sha256;
  const proc = { executable: binary, argv: [binary, 'daemon'], cwd: config.dataDir, executable_sha256: sha,
    environment: { HOME: path.join(config.stateRoot, 'home'), XDG_CONFIG_HOME: path.join(config.stateRoot, 'home/.config'), XDG_DATA_HOME: path.join(config.stateRoot, 'home/.local/share'),
      AO_TMUX_SOCKET: config.tmuxSocket, AO_TMUX_UNIT: `${config.namespace}-tmux.service`, AO_TMUX_TMPDIR: config.tmuxTmpdir, TMUX_TMPDIR: config.tmuxTmpdir,
      AO_DASHBOARD_ADAPTER_CONFIG: path.join(config.stateRoot, 'dashboard-adapter.json'),
      AO_RELEASE_ID: manifest.release_id, AO_RELEASE_ROOT: bundle.payload, AO_DATA_DIR: config.dataDir, AO_RUN_FILE: path.join(config.discoveryDir, 'running.json'),
      AO_MANAGED_RUNTIME_BINARY: binary, AO_MANAGED_RUNTIME_BINARY_SHA256: sha, AO_MANAGED_RUNTIME_DATA_DIR: config.dataDir, AO_MANAGED_RUNTIME_RUN_FILE: path.join(config.discoveryDir, 'running.json') } };
  const evidence = { proc, root: bundle.payload, manifest, component: 'daemon', config };
  expect(() => assertLoadedProcess(evidence)).not.toThrow();
  for (const changed of [{ ...proc, cwd: bundle.payload }, { ...proc, executable_sha256: '0'.repeat(64) }, { ...proc, environment: { ...proc.environment, AO_MANAGED_RUNTIME_BINARY_SHA256: undefined } },
    ...['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'AO_TMUX_SOCKET', 'AO_TMUX_UNIT', 'AO_TMUX_TMPDIR', 'TMUX_TMPDIR', 'AO_DASHBOARD_ADAPTER_CONFIG'].map((key) => ({ ...proc, environment: { ...proc.environment, [key]: '/host-profile' } }))]) {
    expect(() => assertLoadedProcess({ ...evidence, proc: changed })).toThrow('install_loaded_release_drift');
  }
  const node = fs.realpathSync(manifest.toolchain.node_executable);
  const recovery = { ...proc, executable: node, executable_sha256: manifest.toolchain.node_sha256, cwd: bundle.payload,
    argv: [node, path.join(bundle.payload, 'scripts/ao-session.js'), 'serve', '--bindings', path.join(config.dataDir, 'session-recovery.json')] };
  expect(() => assertLoadedProcess({ ...evidence, component: 'session-recovery', proc: recovery })).not.toThrow();
  for (const argv of [recovery.argv.slice(0, 3), [...recovery.argv.slice(0, 4), '/other-install/session-recovery.json']]) {
    expect(() => assertLoadedProcess({ ...evidence, component: 'session-recovery', proc: { ...recovery, argv } })).toThrow('install_loaded_release_drift');
  }
});
it('requires explicit first restore inputs before effects and never restores in daily mode', async () => {
  const { config } = fixture(); let calls = 0;
  expect(() => assertFirstRestoreConfiguration(config, 'first')).toThrow('install_first_restore_input_required');
  const runner = createSystemdReleaseRunner(config, { run: () => { calls += 1; return ''; }, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ready', ready: true, reasons: [] }) }), sleep: async () => {} });
  await expect(runner.start({ mode: 'first' })).rejects.toThrow('install_first_restore_input_required'); expect(calls).toBe(0);
  await runner.start({ mode: 'daily' }); expect(calls).toBe(5);
});
it('restores first-only explicit projects after boot REST while degraded, preserves native skipped_hold, then requires strict ready', async () => {
  const { root, config } = fixture(); Object.assign(config, { restoreProjects: ['fixture'], restoreConcurrency: 2 }); const events = [];
  const result = { projectId: 'fixture', results: [{ sessionId: 'original', outcome: 'restored', reason: 'restored', restoreMode: 'native' }, { sessionId: 'held', outcome: 'skipped_hold', reason: 'spawn_hold_or_pending' }] };
  const runner = createSystemdReleaseRunner(config, { run: (command, args, options) => { events.push([command, args, options]); return JSON.stringify(result); }, fetchImpl: async (url) => {
    events.push(['fetch', url.pathname]); return { ok: true, json: async () => url.pathname.includes('sessions') ? { sessions: [] } : { status: 'ready', ready: true, reasons: [] } };
  }, sleep: async () => {} });
  expect(await runner.start({ releaseRoot: root, mode: 'first', baseline: { projects: ['fixture'], identities: [{ ao_session_id: 'original', project_id: 'fixture', kind: 'worker', is_terminated: 0 }, { ao_session_id: 'held', project_id: 'fixture', kind: 'worker', is_terminated: 0 }, { ao_session_id: 'historical-1', project_id: 'fixture', kind: 'worker', is_terminated: 1 }, { ao_session_id: 'historical-2', project_id: 'fixture', kind: 'worker', is_terminated: 1 }] } })).toEqual({ restore_results: [result] });
  const restore = events.findIndex(([command]) => command === path.join(root, 'native/ao'));
  expect(events[restore][1]).toEqual(['session', 'restore', '--project', 'fixture', '--all', '--include-terminated', '--session-id', 'held', '--session-id', 'original', '--concurrency', '2', '--json']);
  expect(events[restore][2]).toMatchObject({ timeout: 15 * 60 * 1000 + 10000, env: { AO_TMUX_SOCKET: config.tmuxSocket } });
  expect(events.findIndex(([command, arg]) => command === 'fetch' && arg === '/api/v1/sessions')).toBeLessThan(restore);
  expect(events.findIndex(([command, arg]) => command === 'fetch' && arg === '/readyz')).toBeGreaterThan(restore);
  result.results[0].restoreMode = 'fresh';
  await expect(runner.start({ releaseRoot: root, mode: 'first', baseline: { projects: ['fixture'], identities: [{ ao_session_id: 'original', project_id: 'fixture', kind: 'worker', is_terminated: 0 }, { ao_session_id: 'held', project_id: 'fixture', kind: 'worker', is_terminated: 0 }, { ao_session_id: 'historical-1', project_id: 'fixture', kind: 'worker', is_terminated: 1 }, { ao_session_id: 'historical-2', project_id: 'fixture', kind: 'worker', is_terminated: 1 }] } })).rejects.toThrow('install_first_restore_failed');
  result.results[0].outcome = 'failed';
  await expect(runner.start({ releaseRoot: root, mode: 'first', baseline: { projects: ['fixture'], identities: [{ ao_session_id: 'original', project_id: 'fixture', kind: 'worker', is_terminated: 0 }, { ao_session_id: 'held', project_id: 'fixture', kind: 'worker', is_terminated: 0 }, { ao_session_id: 'historical-1', project_id: 'fixture', kind: 'worker', is_terminated: 1 }, { ao_session_id: 'historical-2', project_id: 'fixture', kind: 'worker', is_terminated: 1 }] } })).rejects.toThrow('install_first_restore_failed');
});

it('first restore scope mismatch fails before any start and invalid outcomes cannot pass', async () => {
  const { root, config } = fixture(); Object.assign(config, { restoreProjects: ['explicit'], restoreConcurrency: 2 }); const calls = [];
  const runner = createSystemdReleaseRunner(config, { run: (command) => { calls.push(command); return ''; }, fetchImpl: async () => ({ ok: true, json: async () => ({ sessions: [] }) }), sleep: async () => {} });
  await expect(runner.start({ mode: 'first', releaseRoot: root, baseline: { projects: ['other'], identities: [] } })).rejects.toThrow('install_first_restore_scope_incomplete');
  await expect(runner.start({ mode: 'first', releaseRoot: root, baseline: { projects: ['explicit', 'other'], identities: [{ project_id: 'other', ao_session_id: 'kept' }] } })).rejects.toThrow('install_first_restore_scope_incomplete');
  expect(calls).toHaveLength(0);
});

it('never invokes an unscoped restore for an empty pre-stop live set and rejects an unknown live baseline', async () => {
 const {root,config}=fixture();Object.assign(config,{restoreProjects:['fixture'],restoreConcurrency:2});const calls=[];
 const runner=createSystemdReleaseRunner(config,{run:(...args)=>{calls.push(args);return '';},fetchImpl:async(url)=>({ok:true,json:async()=>url.pathname.includes('sessions')?{sessions:[]}:{status:'ready',ready:true,reasons:[]}}),sleep:async()=>{}});
 const baseline={projects:['fixture'],identities:[{project_id:'fixture',ao_session_id:'historical',kind:'worker',is_terminated:1}]};
 expect(await runner.start({releaseRoot:root,mode:'first',baseline})).toEqual({restore_results:[{projectId:'fixture',results:[]}]});
 expect(calls.some(([command])=>command===path.join(root,'native/ao'))).toBe(false);
 calls.length=0;delete baseline.identities[0].is_terminated;
 await expect(runner.start({releaseRoot:root,mode:'first',baseline})).rejects.toThrow('install_first_restore_scope_incomplete');expect(calls).toHaveLength(0);
});
it.each(['extra_history','missing_live','duplicate_live'])('rejects native restore set mismatch %s', async (mutation) => {
 const {root,config}=fixture();Object.assign(config,{restoreProjects:['fixture'],restoreConcurrency:2});
 const item={sessionId:'live',outcome:'restored',reason:'already_running'};
 const results=mutation==='extra_history'?[item,{...item,sessionId:'historical'}]:mutation==='missing_live'?[]:[item,item];
 const runner=createSystemdReleaseRunner(config,{run:()=>JSON.stringify({projectId:'fixture',results}),fetchImpl:async()=>({ok:true,json:async()=>({sessions:[]})}),sleep:async()=>{}});
 await expect(runner.start({releaseRoot:root,mode:'first',baseline:{projects:['fixture'],identities:[{project_id:'fixture',ao_session_id:'live',kind:'worker',is_terminated:0},{project_id:'fixture',ao_session_id:'historical',kind:'worker',is_terminated:1}]}})).rejects.toThrow('install_first_restore_failed');
});

it('bounds large live requests without increasing the 4096-byte API limit and finishes global orchestrators first', async () => {
 const {root,config}=fixture();Object.assign(config,{restoreProjects:['one','two'],restoreConcurrency:2});
 const identities=Array.from({length:600},(_,i)=>({ao_session_id:`fixture-${i}`,project_id:i%2?'one':'two',kind:i%199===0?'orchestrator':'worker',is_terminated:0}));
 const baseline={projects:['one','two'],identities};const plan=firstRestorePlan(config,baseline);
 expect(plan.length).toBeGreaterThan(4);expect(plan.flatMap(x=>x.ids).sort()).toEqual(identities.map(x=>x.ao_session_id).sort());
 let workerSeen=false;const byId=new Map(identities.map(x=>[x.ao_session_id,x]));
 const calls=[];const runner=createSystemdReleaseRunner(config,{run:(cmd,args)=>{
  if(cmd!==path.join(root,'native/ao'))return '';
  const project=args[args.indexOf('--project')+1];const ids=args.flatMap((v,i)=>v==='--session-id'?[args[i+1]]:[]);calls.push(ids);
  expect(Buffer.byteLength(JSON.stringify({project,concurrency:2,includeTerminated:true,sessionIds:ids}))).toBeLessThanOrEqual(4096);
  for(const id of ids){if(byId.get(id).kind==='worker')workerSeen=true;else expect(workerSeen).toBe(false);}
  return JSON.stringify({projectId:project,results:ids.map(sessionId=>({sessionId,outcome:'restored',reason:'already_running'}))});
 },fetchImpl:async(url)=>({ok:true,json:async()=>url.pathname.includes('sessions')?{sessions:[]}:{status:'ready',ready:true,reasons:[]}}),sleep:async()=>{}});
 const result=await runner.start({releaseRoot:root,mode:'first',baseline});expect(result.restore_results.flatMap(x=>x.results)).toHaveLength(600);expect(calls).toHaveLength(plan.length);
});

it('supports only named proxy override variables and rejects executable or arbitrary environment injection',()=>{
 const text='[Service]\nEnvironment="HTTPS_PROXY=http://proxy.example:8080"\nEnvironment="https_proxy=http://proxy.example:8080"\nEnvironment="NO_PROXY=localhost,127.0.0.1"\n';
 expect(validateEnvironmentOverride(text)).toEqual({HTTPS_PROXY:'http://proxy.example:8080',https_proxy:'http://proxy.example:8080',NO_PROXY:'localhost,127.0.0.1'});
 for(const key of ['LD_PRELOAD','NODE_OPTIONS','arbitrary_lowercase','http_PROXY'])expect(()=>validateEnvironmentOverride(`[Service]\nEnvironment="${key}=bad"\n`)).toThrow('unsafe_unit_override');
});
it('restores only live by default, permits explicit historical IDs, and schedules protected workers individually last',()=>{
 const config={restoreProjects:['one'],restoreConcurrency:2,firstRestoreSessionIDs:['orc','worker','last-2','last-4'],restoreLastSessionIDs:['last-2','last-4']};
 const baseline={projects:['one'],identities:[['orc','orchestrator',0],['worker','worker',0],['last-2','worker',0],['last-4','worker',1],['historical','worker',1]].map(([ao_session_id,kind,is_terminated])=>({ao_session_id,kind,is_terminated,project_id:'one'}))};
 expect(firstRestorePlan(config,baseline)).toEqual([{project:'one',ids:['orc']},{project:'one',ids:['worker']},{project:'one',ids:['last-2']},{project:'one',ids:['last-4']}]);
 expect(firstRestorePlan({...config,firstRestoreSessionIDs:undefined,restoreLastSessionIDs:undefined},baseline).flatMap(row=>row.ids).sort()).toEqual(['last-2','orc','worker']);
});
