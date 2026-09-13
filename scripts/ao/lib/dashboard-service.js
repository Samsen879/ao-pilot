import path from 'node:path';
export function buildDashboardUnits({ packageRoot, nodePath, home }) {
  for (const value of [packageRoot, nodePath, home]) {
    if (!path.isAbsolute(value) || /[\r\n\x00"%\\]/.test(value)) throw new Error('Unsafe service path');
  }
  const base = path.join(home, '.local/share/ao-pilot/cie-runtime');
  const command = script => `"${nodePath}" "${path.join(packageRoot, 'scripts', script)}"`;
  const common = `WorkingDirectory=${packageRoot}\nEnvironment="PATH=${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin"\nEnvironment="AO_DATA_DIR=${base}/data"\nEnvironment="AO_RUN_FILE=${base}/running.json"\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nUMask=0077\n`;
  return {
    'ao-pilot-runtime.service': `[Unit]\nDescription=AO Pilot verified CIE headless runtime\nAfter=network-online.target\n\n[Service]\nType=simple\n${common}ExecStart=${command('ao-runtime-foreground.js')}\nKillMode=mixed\n\n[Install]\nWantedBy=default.target\n`,
    'ao-pilot-dashboard.service': `[Unit]\nDescription=AO Pilot localhost Dashboard\nRequires=ao-pilot-runtime.service\nAfter=ao-pilot-runtime.service\n\n[Service]\nType=simple\n${common}ExecStart=${command('ao-dashboard.js')}\n\n[Install]\nWantedBy=default.target\n`,
  };
}
