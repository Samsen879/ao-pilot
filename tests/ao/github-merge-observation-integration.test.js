import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';

import {
  createLocalCommandRunner,
  loadGitHubMergeObservation,
} from 'ao-pilot/providers';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('GitHub merge observation production invocation', () => {
  it('uses supported gh api fields and never requests unsupported pr JSON fields', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gh-observation-'));
    temporaryDirectories.push(directory);
    const ghPath = path.join(directory, 'gh');
    fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args.some((arg) => arg.includes('baseRefOid'))) {
  process.stderr.write('Unknown JSON field: "baseRefOid"\\n');
  process.exit(1);
}
if (args.join(' ') === 'api repos/example/project') {
  process.stdout.write(JSON.stringify({
    id: 321,
    full_name: 'example/project',
    url: 'https://api.github.com/repos/example/project',
  }));
  process.exit(0);
}
if (args.join(' ') === 'api repos/example/project/pulls/7') {
  process.stdout.write(JSON.stringify({
    number: 7,
    state: 'closed',
    merged: true,
    base: {
      ref: 'main',
      sha: '${'0'.repeat(40)}',
      repo: { id: 321, full_name: 'example/project' },
    },
    head: { sha: '${'1'.repeat(40)}' },
    merge_commit_sha: '${'2'.repeat(40)}',
    merged_at: '2026-08-09T12:31:00Z',
    url: 'https://api.github.com/repos/example/project/pulls/7',
    html_url: 'https://github.com/example/project/pull/7',
  }));
  process.exit(0);
}
process.stderr.write('unsupported invocation: ' + args.join(' ') + '\\n');
process.exit(2);
`);
    fs.chmodSync(ghPath, 0o755);
    const commandRunner = createLocalCommandRunner({
      baseEnv: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    const observation = await loadGitHubMergeObservation({
      repository: { repository_id: 321, slug: 'example/project' },
      prNumber: 7,
      now: '2026-08-09T12:32:00.000Z',
      commandRunner,
    });

    expect(observation).toMatchObject({
      source_ok: true,
      repository: { repository_id: 321, slug: 'example/project' },
      pull_request: {
        number: 7,
        state: 'MERGED',
        base_ref: 'main',
        base_sha: '0'.repeat(40),
        head_sha: '1'.repeat(40),
        merge_commit_sha: '2'.repeat(40),
      },
    });
  });
});
