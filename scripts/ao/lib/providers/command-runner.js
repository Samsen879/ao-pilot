import { spawnSync } from 'node:child_process';

function normalizeResult(result) {
  return {
    status: Number.isInteger(result?.status) ? result.status : null,
    signal: result?.signal ?? null,
    stdout: result?.stdout == null ? '' : String(result.stdout),
    stderr: result?.stderr == null ? '' : String(result.stderr),
    error: result?.error ?? null,
  };
}

export function createLocalCommandRunner({
  spawn = spawnSync,
  baseEnv = process.env,
} = {}) {
  return {
    run(command, args = [], options = {}) {
      if (typeof command !== 'string' || command.trim() === '') {
        throw new Error('Command is required');
      }
      if (!Array.isArray(args)) {
        throw new Error('Command arguments must be an array');
      }

      return normalizeResult(spawn(command, args.map((value) => String(value)), {
        encoding: 'utf8',
        ...options,
        env: {
          ...baseEnv,
          ...(options.env ?? {}),
        },
      }));
    },
  };
}

export const LOCAL_COMMAND_RUNNER = createLocalCommandRunner();
