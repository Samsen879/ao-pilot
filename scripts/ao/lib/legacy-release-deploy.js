import { runCli } from '../../ao-upgrade.js';
// Compatibility names retain a single transaction owner; profiles no longer
// copy mutable dependencies or independently switch a subset of components.
export function runLegacyReleaseDeploy(argv) {
  const flags = new Set(['--deploy', '--install', '--replace', '--dashboard-only', '--recovery-only', '--terminal-access']);
  const args = argv.filter((value) => !flags.has(value));
  if (!args.includes('--release')) {
    process.stderr.write('Unified release required: add --release <id> --install-config <file>; units are rendered by the transaction.\n');
    return Promise.resolve({ exitCode: 2 });
  }
  return runCli(['apply', ...args]);
}
