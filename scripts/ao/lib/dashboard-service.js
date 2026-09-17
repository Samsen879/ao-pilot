import path from 'node:path';
export function buildDashboardUnits({ packageRoot, nodePath, home, managedRuntimeBinary = null, terminalAccess = false }) {
  for (const value of [packageRoot, nodePath, home, managedRuntimeBinary].filter(Boolean)) {
    if (!path.isAbsolute(value) || /[\r\n\x00"%\\]/.test(value)) throw new Error('Unsafe service path');
  }
  const base = path.join(home, '.local/share/ao-pilot/cie-runtime');
  const command = script => `"${nodePath}" "${path.join(packageRoot, 'scripts', script)}"`;
  const common = `WorkingDirectory=${packageRoot}\nEnvironment="PATH=${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin"\nEnvironment="AO_DATA_DIR=${base}/data"\nEnvironment="AO_RUN_FILE=${base}/running.json"\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nUMask=0077\n`;
  const terminalEnvironment = `Environment="AO_DASHBOARD_TERMINAL_ACCESS=${terminalAccess ? '1' : '0'}"\n`;
  const runtimeEnvironment = managedRuntimeBinary == null
    ? ''
    : `Environment="AO_MANAGED_RUNTIME_BINARY=${managedRuntimeBinary}"\n`;
  return {
    'ao-pilot-session-recovery.service': `[Unit]\nDescription=AO Pilot pinned original-session recovery lifecycle\nAfter=network-online.target\n\n[Service]\nType=simple\n${common}${runtimeEnvironment}Environment="AO_CONFIG_PATH=${home}/agent-orchestrator.yaml"\nExecStart=${command('ao-session.js')} serve\n\n[Install]\nWantedBy=default.target\n`,
    'ao-pilot-runtime.service': `[Unit]\nDescription=AO Pilot verified CIE headless runtime\nAfter=network-online.target\n\n[Service]\nType=simple\n${common}ExecStart=${command('ao-runtime-foreground.js')}\nKillMode=mixed\n\n[Install]\nWantedBy=default.target\n`,
    'ao-pilot-dashboard.service': `[Unit]\nDescription=AO Pilot original localhost browser Dashboard\nRequires=ao-pilot-runtime.service\nAfter=ao-pilot-runtime.service\n\n[Service]\nType=simple\n${common}${runtimeEnvironment}${terminalEnvironment}Environment="NODE_ENV=production"\nEnvironment="AO_CONFIG_PATH=${home}/agent-orchestrator.yaml"\nEnvironment="AO_DASHBOARD_READ_ONLY=1"\nEnvironment="AO_DASHBOARD_AUTOMATION=0"\nExecStart=${command('ao-dashboard.js')}\n\n[Install]\nWantedBy=default.target\n`,
  };
}
