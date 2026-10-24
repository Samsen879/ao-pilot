import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { verifyPackageDependencies } from '../../scripts/ao/lib/package-dependencies.js';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(type, exports) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-package-dependency-')); roots.push(root);
  const consumer = path.join(root, 'browser/packages/web'); fs.mkdirSync(consumer, { recursive: true });
  const dependency = path.join(root, 'browser/node_modules/fixture'); fs.mkdirSync(dependency, { recursive: true });
  const file = path.join(consumer, 'package.json');
  fs.writeFileSync(file, JSON.stringify({ type, dependencies: { fixture: '*' } }));
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'fixture', exports }));
  fs.writeFileSync(path.join(dependency, 'index.js'), 'throw new Error("resolution must not execute dependencies");');
  return { file, dependency };
}
it.each(['module', 'commonjs'])('resolves using the %s consumer conditions and nested node_modules', (type) => {
  const condition = type === 'module' ? 'import' : 'require';
  const { file } = fixture(type, { '.': { [condition]: './index.js' } });
  expect(() => verifyPackageDependencies(file)).not.toThrow();
});
it('rejects an ESM-only dependency used through CommonJS', () => {
  const { file } = fixture('commonjs', { '.': { import: './index.js' } });
  expect(() => verifyPackageDependencies(file)).toThrow('ERR_PACKAGE_PATH_NOT_EXPORTED');
});
it.each(['missing', 'directory'])('rejects an ESM export whose target is %s', (kind) => {
  const { file, dependency } = fixture('module', { '.': { import: './target' } });
  if (kind === 'directory') fs.mkdirSync(path.join(dependency, 'target'));
  expect(() => verifyPackageDependencies(file)).toThrow();
});
