import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function getAoFixtureRoot() {
  const value = process.env.AO_FIXTURE_ROOT;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return path.resolve(value.trim());
}

export function readAoFixture(...candidates) {
  const fixtureRoot = getAoFixtureRoot();
  if (!fixtureRoot) return null;

  for (const candidate of candidates) {
    const relativePath = Array.isArray(candidate) ? candidate : [candidate];
    const absolutePath = path.join(fixtureRoot, ...relativePath);
    if (!existsSync(absolutePath)) continue;
    return {
      path: absolutePath,
      text: readFileSync(absolutePath, 'utf8'),
    };
  }

  return null;
}

export function sanitizeFixtureToken(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_');
}
