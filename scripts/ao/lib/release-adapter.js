import path from 'node:path';
import { assertRelease } from './release-manifest.js';
export const NATIVE_ADAPTER_SOURCE = { root: 'integrations/dashboard-native-adapter', entrypoint: 'integrations/dashboard-native-adapter/server.mjs', license: 'LICENSE' };
export function adapterConfiguration(configuration) {
  const ports = configuration.listenPorts;
  assertRelease(Array.isArray(ports) && ports.length === 5 && new Set(ports).size === 5, 'invalid_install_ports');
  const daemon = new URL(configuration.daemonURL);
  const terminal = new URL(configuration.terminalURL);
  assertRelease(Number(daemon.port) === ports[0] && Number(terminal.port) === ports[2], 'adapter_endpoint_mismatch');
  return {
    LISTEN_HOST: '127.0.0.1', LISTEN_PORT: ports[2], DASHBOARD_UPSTREAM_HOST: '127.0.0.1', DASHBOARD_UPSTREAM_PORT: ports[1],
    AO_DAEMON_HOST: '127.0.0.1', AO_DAEMON_PORT: ports[0], DIRECT_TERMINAL_HOST: '127.0.0.1', DIRECT_TERMINAL_PORT: ports[3],
    DIRECT_TERMINAL_BROWSER_PORT: ports[3], TERMINAL_ORIGIN: configuration.terminalOrigin,
    TERMINAL_TOKEN_FILE: configuration.terminalTokenFile,
    PROJECT_NAME: configuration.projectName ?? 'AO Pilot',
  };
}
export const adapterConfigPath = (configuration) => path.join(configuration.stateRoot, 'dashboard-adapter.json');
