import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  loadAoConfig,
  normalizeAoConfig,
  resolveAoConfigPath,
  serializeAoConfig,
} from '../../scripts/ao/lib/config.js';

describe('ao public configuration', () => {
  it('normalizes a portable provider and verification profile', () => {
    expect(normalizeAoConfig({
      project_id: 'sample-project',
      providers: {
        agent_runtime: 'agent-orchestrator-cli',
        source_control: 'github-cli',
      },
      verification: {
        commands: ['npm test', 'npm run ao:smoke'],
      },
    })).toEqual({
      config_version: 1,
      project_id: 'sample-project',
      providers: {
        agent_runtime: 'agent-orchestrator-cli',
        source_control: 'github-cli',
      },
      verification: {
        commands: ['npm test', 'npm run ao:smoke'],
      },
    });
  });

  it('finds configuration from a nested repository path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-config-'));
    const nested = path.join(root, 'nested', 'worktree');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, 'ao.config.json'), serializeAoConfig({
      project_id: 'nested-project',
    }));

    try {
      expect(resolveAoConfigPath({ cwd: nested })).toBe(path.join(root, 'ao.config.json'));
      expect(loadAoConfig({ cwd: nested })).toMatchObject({
        config: {
          project_id: 'nested-project',
        },
        source: 'file',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsupported providers and malformed project ids', () => {
    expect(() => normalizeAoConfig({
      project_id: '../unsafe',
    })).toThrow('Invalid project_id');
    expect(() => normalizeAoConfig({
      providers: {
        source_control: 'unknown',
      },
    })).toThrow('Unsupported providers.source_control');
  });
});
