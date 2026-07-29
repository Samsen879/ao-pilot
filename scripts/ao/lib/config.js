import fs from 'node:fs';
import path from 'node:path';

export const AO_CONFIG_VERSION = 1;
export const AO_CONFIG_FILENAME = 'ao.config.json';
export const DEFAULT_AO_CONFIG = Object.freeze({
  config_version: AO_CONFIG_VERSION,
  project_id: 'my-project',
  providers: {
    agent_runtime: 'agent-orchestrator-cli',
    source_control: 'github-cli',
  },
  verification: {
    commands: ['npm test'],
  },
  evaluation: {
    fixture_root: null,
    packs: ['all'],
    replay_count: 2,
  },
});

const SUPPORTED_AGENT_RUNTIME_PROVIDERS = ['agent-orchestrator-cli'];
const SUPPORTED_SOURCE_CONTROL_PROVIDERS = ['github-cli'];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}`);
  }
  return value.trim();
}

function normalizeProvider(value, fieldName, supportedValues) {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!supportedValues.includes(normalized)) {
    throw new Error(`Unsupported ${fieldName}: ${normalized}`);
  }
  return normalized;
}

function normalizeCommands(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid verification.commands');
  }
  return value.map((command, index) => normalizeRequiredString(
    command,
    `verification.commands[${index}]`,
  ));
}

function normalizeOptionalString(value, fieldName) {
  if (value == null) return null;
  return normalizeRequiredString(value, fieldName);
}

function normalizeStringList(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return value.map((item, index) => normalizeRequiredString(
    item,
    `${fieldName}[${index}]`,
  ));
}

function normalizeReplayCount(value) {
  const replayCount = Number(value);
  if (!Number.isInteger(replayCount) || replayCount < 2) {
    throw new Error('Invalid evaluation.replay_count');
  }
  return replayCount;
}

export function normalizeAoConfig(value = {}) {
  if (!isPlainObject(value)) {
    throw new Error('Invalid AO configuration');
  }

  const configVersion = value.config_version ?? AO_CONFIG_VERSION;
  if (configVersion !== AO_CONFIG_VERSION) {
    throw new Error(`Unsupported config_version: ${configVersion}`);
  }

  const projectId = normalizeRequiredString(
    value.project_id ?? DEFAULT_AO_CONFIG.project_id,
    'project_id',
  );
  if (!/^[A-Za-z0-9._-]+$/.test(projectId)) {
    throw new Error('Invalid project_id');
  }

  const providers = isPlainObject(value.providers) ? value.providers : {};
  const verification = isPlainObject(value.verification) ? value.verification : {};
  const evaluation = isPlainObject(value.evaluation) ? value.evaluation : {};

  return {
    config_version: AO_CONFIG_VERSION,
    project_id: projectId,
    providers: {
      agent_runtime: normalizeProvider(
        providers.agent_runtime ?? DEFAULT_AO_CONFIG.providers.agent_runtime,
        'providers.agent_runtime',
        SUPPORTED_AGENT_RUNTIME_PROVIDERS,
      ),
      source_control: normalizeProvider(
        providers.source_control ?? DEFAULT_AO_CONFIG.providers.source_control,
        'providers.source_control',
        SUPPORTED_SOURCE_CONTROL_PROVIDERS,
      ),
    },
    verification: {
      commands: normalizeCommands(
        verification.commands ?? DEFAULT_AO_CONFIG.verification.commands,
      ),
    },
    evaluation: {
      fixture_root: normalizeOptionalString(
        evaluation.fixture_root ?? DEFAULT_AO_CONFIG.evaluation.fixture_root,
        'evaluation.fixture_root',
      ),
      packs: normalizeStringList(
        evaluation.packs ?? DEFAULT_AO_CONFIG.evaluation.packs,
        'evaluation.packs',
      ),
      replay_count: normalizeReplayCount(
        evaluation.replay_count ?? DEFAULT_AO_CONFIG.evaluation.replay_count,
      ),
    },
  };
}

export function resolveAoConfigPath({
  cwd = process.cwd(),
  configPath = null,
} = {}) {
  if (configPath != null) {
    return path.resolve(cwd, configPath);
  }

  let currentPath = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(currentPath, AO_CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return null;
    currentPath = parentPath;
  }
}

export function loadAoConfig({
  cwd = process.cwd(),
  configPath = null,
  allowMissing = true,
} = {}) {
  const resolvedPath = resolveAoConfigPath({ cwd, configPath });
  if (resolvedPath == null || !fs.existsSync(resolvedPath)) {
    if (!allowMissing || configPath != null) {
      throw new Error(`AO configuration not found: ${resolvedPath ?? AO_CONFIG_FILENAME}`);
    }
    return {
      config: normalizeAoConfig(DEFAULT_AO_CONFIG),
      path: null,
      source: 'defaults',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid AO configuration at ${resolvedPath}: ${error.message}`);
  }

  return {
    config: normalizeAoConfig(parsed),
    path: resolvedPath,
    source: 'file',
  };
}

export function serializeAoConfig(value = DEFAULT_AO_CONFIG) {
  return `${JSON.stringify(normalizeAoConfig(value), null, 2)}\n`;
}
