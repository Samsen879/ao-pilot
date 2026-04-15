export const GATE_NAMES = Object.freeze([
  'ownership',
  'review',
  'ci',
  'mergeability',
  'release',
]);

export const GATE_STATES = Object.freeze([
  'open',
  'pending',
  'blocked',
  'ambiguous',
  'not_applicable',
]);

export const GATE_BLOCKER_CODES = Object.freeze([
  'orphan_open_pr',
  'review_blocked',
  'ci_blocked',
  'merge_conflict_blocked',
]);

function uniqueStrings(values) {
  return [...new Set((values ?? [])
    .filter((value) => value != null)
    .map((value) => String(value))
    .filter((value) => value !== ''))];
}

function normalizeGateName(name) {
  const normalized = String(name ?? '').trim();
  if (!GATE_NAMES.includes(normalized)) {
    throw new Error(`Unsupported gate name: ${name}`);
  }

  return normalized;
}

function normalizeGateState(state) {
  const normalized = String(state ?? '').trim();
  if (!GATE_STATES.includes(normalized)) {
    throw new Error(`Unsupported gate state: ${state}`);
  }

  return normalized;
}

export function createGate({
  name,
  state,
  blocker_codes = [],
  reason_codes = [],
} = {}) {
  return {
    name: normalizeGateName(name),
    state: normalizeGateState(state),
    blocker_codes: uniqueStrings(blocker_codes),
    reason_codes: uniqueStrings(reason_codes),
  };
}

export function createGateSnapshot(overrides = {}) {
  return Object.fromEntries(
    Object.entries(overrides)
      .filter(([name]) => GATE_NAMES.includes(String(name)))
      .map(([name, gate]) => {
        if (gate?.name != null && gate.name !== name) {
          throw new Error(`Gate name mismatch for ${name}: ${gate.name}`);
        }

        return [name, createGate({
          name,
          ...(gate ?? {}),
        })];
      }),
  );
}

export function getGate(snapshot, name) {
  const normalizedName = normalizeGateName(name);
  const gate = snapshot?.[normalizedName];
  if (!gate) return null;

  return createGate({
    name: normalizedName,
    ...gate,
  });
}

export function collectGateBlockerCodes(snapshot) {
  return uniqueStrings(
    GATE_NAMES.flatMap((name) => {
      const gate = getGate(snapshot, name);
      return gate?.blocker_codes ?? [];
    }),
  ).sort((left, right) => left.localeCompare(right));
}
