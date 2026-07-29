import { createHash } from 'node:crypto';

function stableObject(value) {
  if (Array.isArray(value)) return value.map((item) => stableObject(item));
  if (value != null && typeof value === 'object') {
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .reduce((result, key) => {
        result[key] = stableObject(value[key]);
        return result;
      }, {});
  }
  return value;
}

export function buildEvalFingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(stableObject(value)))
    .digest('hex');
}

export async function replayEvalScenario({ execute, replayCount = 2 } = {}) {
  if (typeof execute !== 'function') throw new Error('Missing eval scenario executor');
  if (!Number.isInteger(replayCount) || replayCount < 2) {
    throw new Error('Eval replayCount must be an integer greater than or equal to 2');
  }

  const executions = [];
  for (let index = 0; index < replayCount; index += 1) {
    executions.push(await execute());
  }
  const fingerprints = executions.map(
    (result) => buildEvalFingerprint(result?.stabilityVector),
  );

  return {
    primary: executions[0],
    replay: {
      stable: fingerprints.every((fingerprint) => fingerprint === fingerprints[0]),
      fingerprint: fingerprints[0],
      replay_fingerprint: fingerprints[1],
      fingerprints,
      execution_count: replayCount,
    },
  };
}
