import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockReadFileSync = jest.fn();

jest.unstable_mockModule('node:fs', async () => {
  const actual = await jest.requireActual('node:fs');
  return {
    ...actual,
    readFileSync: mockReadFileSync,
  };
});

const { matchesRecordedProcessIdentity } = await import('../../scripts/ao/lib/state-storage.js');

describe('state storage process identity matching', () => {
  let killSpy;

  beforeEach(() => {
    mockReadFileSync.mockReset();
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('fails closed when a recorded process_start_token exists but the live token cannot be read', () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (filePath === '/proc/123/stat') {
        throw new Error('proc stat unavailable');
      }
      throw new Error(`Unexpected read: ${filePath}`);
    });

    expect(matchesRecordedProcessIdentity({
      process_pid: 123,
      process_start_token: 'stale-process-token',
    })).toBe(false);
  });

  it('keeps legacy tokenless metadata compatible when the live token cannot be read', () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (filePath === '/proc/123/stat') {
        throw new Error('proc stat unavailable');
      }
      throw new Error(`Unexpected read: ${filePath}`);
    });

    expect(matchesRecordedProcessIdentity({
      process_pid: 123,
    })).toBe(true);
  });
});
