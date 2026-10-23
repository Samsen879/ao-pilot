#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease } from './ao/lib/release-builder.js';
export async function runCli(argv) {
  if (argv.includes('--help')) {
    process.stdout.write('Usage: node scripts/build-release.js --commit <sha> --version <version> --output <directory> --adapter-root <tracked-directory> --adapter-entry <tracked-entry> --adapter-license <tracked-license> --compatibility <tracked-evidence>\n'); return 0;
  }
  try {
    const options = {};
    for (let i = 0; i < argv.length; i += 2) {
      if (!['--commit', '--version', '--output', '--repository', '--adapter-root', '--adapter-entry', '--adapter-license', '--compatibility', '--old-binary'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid release build arguments');
      options[argv[i].slice(2)] = argv[i + 1];
    }
    const adapter = options['adapter-root'] && options['adapter-entry'] && options['adapter-license']
      ? { root: options['adapter-root'], entrypoint: options['adapter-entry'], license: options['adapter-license'] } : undefined;
    const result = await buildRelease({ repository: path.resolve(options.repository ?? '.'), commit: options.commit,
      version: options.version, output: path.resolve(options.output ?? 'release-output'), adapter, compatibilityEvidence: options.compatibility, oldBinary: options['old-binary'] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) { process.stderr.write(`${error.code ?? 'release_build_failed'}\n`); return 2; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
