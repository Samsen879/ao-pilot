import fs from 'node:fs';
import path from 'node:path';

const PACK_REGISTRY_SCHEMA_VERSION = 'ao.eval-pack-registry.v1alpha1';
const PACK_REGISTRY_FORMAT = 'ao_eval_pack_registry';
const SCENARIO_SCHEMA_VERSION = 'ao.eval-scenario.v1alpha1';
const SCENARIO_FORMAT = 'ao_eval_scenario';

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid eval JSON at ${filePath}: ${error.message}`);
  }
}

function requireString(value, fieldName, sourcePath) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName} in ${sourcePath}`);
  }
  return value.trim();
}

function requireStringArray(value, fieldName, sourcePath) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid ${fieldName} in ${sourcePath}`);
  }
  return value.map((item, index) => requireString(
    item,
    `${fieldName}[${index}]`,
    sourcePath,
  ));
}

export function loadEvalPackRegistry(fixtureRoot) {
  const registryPath = path.join(fixtureRoot, 'packs.json');
  const registry = readJsonFile(registryPath);
  if (
    registry?.schema_version !== PACK_REGISTRY_SCHEMA_VERSION
      || registry?.format !== PACK_REGISTRY_FORMAT
      || !Array.isArray(registry?.packs)
      || registry.packs.length === 0
  ) {
    throw new Error(`Invalid eval pack registry: ${registryPath}`);
  }

  const packIds = new Set();
  const packs = registry.packs.map((pack, index) => {
    const packId = requireString(pack?.pack_id, `packs[${index}].pack_id`, registryPath);
    if (packIds.has(packId)) throw new Error(`Duplicate eval pack: ${packId}`);
    packIds.add(packId);
    return {
      ...pack,
      pack_id: packId,
      title: requireString(pack?.title, `packs[${index}].title`, registryPath),
      scenario_ids: requireStringArray(
        pack?.scenario_ids,
        `packs[${index}].scenario_ids`,
        registryPath,
      ),
    };
  });

  return { ...registry, packs };
}

export function resolveEvalPacks(packRegistry, packNames = ['all']) {
  const requested = packNames.length ? packNames : ['all'];
  const packById = new Map(packRegistry.packs.map((pack) => [pack.pack_id, pack]));
  const resolved = [];

  for (const packId of requested) {
    if (!packById.has(packId)) throw new Error(`Unknown eval pack: ${packId}`);
    const packIds = packId === 'all'
      ? packRegistry.packs.filter((pack) => pack.pack_id !== 'all').map((pack) => pack.pack_id)
      : [packId];
    for (const resolvedPackId of packIds) {
      if (!resolved.includes(resolvedPackId)) resolved.push(resolvedPackId);
    }
  }

  return resolved;
}

export function resolveEvalScenarioIds(packRegistry, resolvedPackIds) {
  const packById = new Map(packRegistry.packs.map((pack) => [pack.pack_id, pack]));
  const scenarioIds = [];
  for (const packId of resolvedPackIds) {
    const pack = packById.get(packId);
    if (!pack) throw new Error(`Unknown eval pack: ${packId}`);
    for (const scenarioId of pack.scenario_ids) {
      if (!scenarioIds.includes(scenarioId)) scenarioIds.push(scenarioId);
    }
  }
  return scenarioIds;
}

export function loadEvalScenario(fixtureRoot, scenarioId) {
  const scenarioPath = path.join(fixtureRoot, 'scenarios', `${scenarioId}.json`);
  const scenario = readJsonFile(scenarioPath);
  if (
    scenario?.schema_version !== SCENARIO_SCHEMA_VERSION
      || scenario?.format !== SCENARIO_FORMAT
      || requireString(scenario?.scenario_id, 'scenario_id', scenarioPath) !== scenarioId
  ) {
    throw new Error(`Invalid eval scenario: ${scenarioPath}`);
  }
  return {
    ...scenario,
    pack_id: requireString(scenario?.pack_id, 'pack_id', scenarioPath),
    runner: requireString(scenario?.runner, 'runner', scenarioPath),
    title: requireString(scenario?.title, 'title', scenarioPath),
  };
}
