import { test, expect } from '@jest/globals';
import { buildDashboardUnits } from '../../scripts/ao/lib/dashboard-service.js';
test('service runs verified foreground lifecycle and native Dashboard in isolated store', () => {
  const units = buildDashboardUnits({packageRoot:'/repo/ao-pilot',nodePath:'/node/bin/node',home:'/user',managedRuntimeBinary:'/managed/runtime/bin/ao',managedRuntimeBinarySha256:'a'.repeat(64),managedRuntimeStore:'/managed/runtime'});
  expect(units['ao-pilot-runtime.service']).toContain('ao-runtime-foreground.js');
  expect(units['ao-pilot-runtime.service']).toContain('AO_DATA_DIR=/user/.local/share/ao-pilot/cie-runtime/data');
  expect(units['ao-pilot-dashboard.service']).toContain('Requires=ao-pilot-runtime.service');
  expect(units['ao-pilot-dashboard.service']).toContain('AO_CONFIG_PATH=/user/agent-orchestrator.yaml');
  expect(units['ao-pilot-dashboard.service']).toContain('AO_DASHBOARD_AUTOMATION=0');
  expect(units['ao-pilot-dashboard.service']).toContain('AO_DASHBOARD_READ_ONLY=1');
  expect(units['ao-pilot-dashboard.service']).toContain('AO_MANAGED_RUNTIME_BINARY=/managed/runtime/bin/ao');
  expect(units['ao-pilot-session-recovery.service']).toContain('AO_MANAGED_RUNTIME_BINARY=/managed/runtime/bin/ao');
  expect(units['ao-pilot-runtime.service']).toContain(`AO_MANAGED_RUNTIME_BINARY_SHA256=${'a'.repeat(64)}`);
  expect(units['ao-pilot-runtime.service']).toContain('AO_PILOT_RUNTIME_STORE=/managed/runtime');
  expect(units['ao-pilot-dashboard.service']).toContain('AO_MANAGED_RUNTIME_DATA_DIR=/user/.local/share/ao-pilot/cie-runtime/data');
  expect(units['ao-pilot-session-recovery.service']).toContain('AO_MANAGED_RUNTIME_RUN_FILE=/user/.local/share/ao-pilot/cie-runtime/running.json');
  expect(units['ao-pilot-session-recovery.service']).toContain('Requires=ao-pilot-runtime.service');
  expect(units['ao-pilot-session-recovery.service']).toContain('After=network-online.target ao-pilot-runtime.service');
});
test('rejects systemd expansion and multiline injection', () => {
  for (const packageRoot of ['relative','/bad\nExecStart=x','/bad%h']) expect(() => buildDashboardUnits({packageRoot,nodePath:'/bin/node',home:'/user'})).toThrow();
});
test('requires an exact digest and store whenever a managed runtime binary is bound', () => {
  expect(() => buildDashboardUnits({packageRoot:'/repo',nodePath:'/bin/node',home:'/user',managedRuntimeBinary:'/runtime/ao'})).toThrow('identity');
  expect(() => buildDashboardUnits({packageRoot:'/repo',nodePath:'/bin/node',home:'/user',managedRuntimeBinarySha256:'a'.repeat(64)})).toThrow('identity');
  expect(() => buildDashboardUnits({packageRoot:'/repo',nodePath:'/bin/node',home:'/user',managedRuntimeBinary:'/runtime/ao',managedRuntimeBinarySha256:'a'.repeat(64)})).toThrow('identity');
});
test('terminal access is explicit and never unlocks API writes or automation', () => {
  for (const terminalAccess of [false, true]) {
    const unit = buildDashboardUnits({packageRoot:'/repo/ao-pilot',nodePath:'/node/bin/node',home:'/user',terminalAccess})['ao-pilot-dashboard.service'];
    expect(unit).toContain(`AO_DASHBOARD_TERMINAL_ACCESS=${terminalAccess ? '1' : '0'}`);
    expect(unit).toContain('AO_DASHBOARD_READ_ONLY=1');
    expect(unit).toContain('AO_DASHBOARD_AUTOMATION=0');
  }
});
