import { GITHUB_LOCAL_RUNTIME_PROVIDER } from './github-local.js';

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

const PROVIDERS_BY_RUNTIME_REF = new Map([
  [GITHUB_LOCAL_RUNTIME_PROVIDER.runtime_ref, GITHUB_LOCAL_RUNTIME_PROVIDER],
]);

export function listRuntimeProviderContracts() {
  return [...PROVIDERS_BY_RUNTIME_REF.values()].map((provider) => cloneJsonValue(provider));
}

export function getRuntimeProviderContract(runtimeRef) {
  const normalizedRuntimeRef = typeof runtimeRef === 'string' ? runtimeRef.trim() : '';
  if (!normalizedRuntimeRef) return null;

  const provider = PROVIDERS_BY_RUNTIME_REF.get(normalizedRuntimeRef);
  return provider == null ? null : cloneJsonValue(provider);
}
