import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function verifyPackageDependencies(manifestFile) {
  const metadata = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const names = Object.keys(metadata.dependencies ?? {});
  if (names.length === 0) return;
  // Resolve from the consumer's directory and with its module conditions.
  // Resolution alone can return a nonexistent ESM target, so also stat it.
  const probe = `import fs from 'node:fs'; import {fileURLToPath} from 'node:url';
    import {createRequire,isBuiltin} from 'node:module'; const require=createRequire(import.meta.url);
    for (const name of JSON.parse(process.argv[1])) {
      if (isBuiltin(name)) continue;
      const resolved=${metadata.type === 'module' ? 'fileURLToPath(import.meta.resolve(name))' : 'require.resolve(name)'};
      if (!fs.statSync(resolved).isFile()) throw new Error('Dependency target is not a file');
    }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe, JSON.stringify(names)], {
    cwd: path.dirname(path.resolve(manifestFile)), encoding: 'utf8', timeout: 30000,
  });
  if (result.error || result.status !== 0) throw new Error(`Package dependency resolution failed: ${result.error?.message ?? result.stderr}`);
}
