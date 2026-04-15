import { createHash } from 'node:crypto';

export const RUNTIME_PROVIDER_SCHEMA_VERSION = 'ao.runtime-provider.v1alpha1';
export const RUNTIME_PREFLIGHT_SCHEMA_VERSION = 'ao.runtime-preflight.v1alpha1';
export const RUNTIME_PREFLIGHT_FORMAT = 'ao_runtime_preflight';

export const RUNTIME_PROVIDER_KINDS = ['github_local'];
export const BOOTSTRAP_REQUIREMENT_KINDS = [
  'language_runtime',
  'package_manager',
  'setup_step',
  'network_posture',
  'filesystem_posture',
  'secret_posture',
];
export const BOOTSTRAP_PROBE_KINDS = ['command', 'path', 'capability'];
export const RUNTIME_PREFLIGHT_CHECK_STATUSES = ['satisfied', 'missing', 'unsupported'];
export const RUNTIME_PREFLIGHT_STATUSES = ['clean', 'missing_dependency', 'unsupported_provider'];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}`);
  }

  return value.trim();
}

function normalizeOptionalString(value, fieldName) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}`);
  }

  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function normalizeIsoTimestamp(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName);
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return normalized;
}

function normalizeEnum(value, fieldName, allowedValues) {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!allowedValues.includes(normalized)) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return normalized;
}

function normalizeStringArray(values, fieldName) {
  if (!Array.isArray(values)) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return values.map((value, index) => normalizeRequiredString(value, `${fieldName}[${index}]`));
}

function normalizeMetadata(value = {}) {
  if (value == null) return {};
  if (!isPlainObject(value)) {
    throw new Error('Invalid metadata');
  }

  return cloneJsonValue(value);
}

function normalizeProbe(probe) {
  if (!isPlainObject(probe)) {
    throw new Error('Invalid probe');
  }

  const kind = normalizeEnum(probe.kind, 'probe.kind', BOOTSTRAP_PROBE_KINDS);
  if (kind === 'command') {
    return {
      kind,
      command: normalizeRequiredString(probe.command, 'probe.command'),
    };
  }

  if (kind === 'path') {
    return {
      kind,
      path: normalizeRequiredString(probe.path, 'probe.path'),
    };
  }

  return {
    kind,
    capability: normalizeRequiredString(probe.capability, 'probe.capability'),
  };
}

function buildRuntimePreflightReplayKey(snapshot) {
  const digest = createHash('sha1')
    .update(JSON.stringify({
      runtime_ref: snapshot.runtime_ref,
      provider_id: snapshot.provider_id,
      status: snapshot.status,
      contract: snapshot.contract,
      checks: snapshot.checks,
    }))
    .digest('hex');

  return `runtime_preflight:${digest}`;
}

export function createBootstrapRequirement({
  requirement_id,
  requirement_kind,
  summary,
  probe,
  setup_steps = [],
  metadata = {},
} = {}) {
  return {
    requirement_id: normalizeRequiredString(requirement_id, 'requirement_id'),
    requirement_kind: normalizeEnum(
      requirement_kind,
      'requirement_kind',
      BOOTSTRAP_REQUIREMENT_KINDS,
    ),
    summary: normalizeRequiredString(summary, 'summary'),
    probe: normalizeProbe(probe),
    setup_steps: normalizeStringArray(setup_steps, 'setup_steps'),
    metadata: normalizeMetadata(metadata),
  };
}

export function createRuntimeProviderContract({
  runtime_ref,
  provider_id,
  provider_kind,
  display_name,
  bootstrap_requirements = [],
  metadata = {},
} = {}) {
  return {
    schema_version: RUNTIME_PROVIDER_SCHEMA_VERSION,
    runtime_ref: normalizeRequiredString(runtime_ref, 'runtime_ref'),
    provider_id: normalizeRequiredString(provider_id, 'provider_id'),
    provider_kind: normalizeEnum(provider_kind, 'provider_kind', RUNTIME_PROVIDER_KINDS),
    display_name: normalizeRequiredString(display_name, 'display_name'),
    bootstrap_requirements: (bootstrap_requirements ?? []).map((item) => createBootstrapRequirement(item)),
    metadata: normalizeMetadata(metadata),
  };
}

export function createRuntimePreflightCheck({
  requirement_id,
  requirement_kind,
  status,
  summary,
  details = [],
  setup_steps = [],
} = {}) {
  return {
    requirement_id: normalizeRequiredString(requirement_id, 'requirement_id'),
    requirement_kind: normalizeRequiredString(requirement_kind, 'requirement_kind'),
    status: normalizeEnum(status, 'status', RUNTIME_PREFLIGHT_CHECK_STATUSES),
    summary: normalizeRequiredString(summary, 'summary'),
    details: normalizeStringArray(details, 'details'),
    setup_steps: normalizeStringArray(setup_steps, 'setup_steps'),
  };
}

export function createRuntimePreflightSnapshot({
  runtime_ref,
  provider_id = null,
  observed_at,
  status,
  contract = null,
  checks = [],
} = {}) {
  const normalizedContract = contract == null ? null : createRuntimeProviderContract(contract);
  const normalizedProviderId = normalizedContract?.provider_id ?? normalizeOptionalString(provider_id, 'provider_id');
  const normalizedSnapshot = {
    schema_version: RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    format: RUNTIME_PREFLIGHT_FORMAT,
    runtime_ref: normalizeRequiredString(runtime_ref, 'runtime_ref'),
    provider_id: normalizedProviderId,
    status: normalizeEnum(status, 'status', RUNTIME_PREFLIGHT_STATUSES),
    observed_at: normalizeIsoTimestamp(observed_at, 'observed_at'),
    contract: normalizedContract,
    checks: (checks ?? []).map((item) => createRuntimePreflightCheck(item)),
  };

  return {
    ...normalizedSnapshot,
    replay_key: buildRuntimePreflightReplayKey(normalizedSnapshot),
  };
}
