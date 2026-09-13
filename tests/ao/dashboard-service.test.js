import { test, expect } from '@jest/globals';
import { buildDashboardUnits } from '../../scripts/ao/lib/dashboard-service.js';
test('service runs verified foreground lifecycle and native Dashboard in isolated store', () => {
  const units = buildDashboardUnits({packageRoot:'/repo/ao-pilot',nodePath:'/node/bin/node',home:'/user'});
  expect(units['ao-pilot-runtime.service']).toContain('ao-runtime-foreground.js');
  expect(units['ao-pilot-runtime.service']).toContain('AO_DATA_DIR=/user/.local/share/ao-pilot/cie-runtime/data');
  expect(units['ao-pilot-dashboard.service']).toContain('Requires=ao-pilot-runtime.service');
  expect(JSON.stringify(units)).not.toContain('agent-orchestrator');
});
test('rejects systemd expansion and multiline injection', () => {
  for (const packageRoot of ['relative','/bad\nExecStart=x','/bad%h']) expect(() => buildDashboardUnits({packageRoot,nodePath:'/bin/node',home:'/user'})).toThrow();
});
