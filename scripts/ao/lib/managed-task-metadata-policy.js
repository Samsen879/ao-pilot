export const RESERVED_MANAGED_TASK_METADATA_REGISTRY_VERSION =
  'ao.reserved-managed-task-metadata.v1';
export const RESERVED_MANAGED_TASK_METADATA_FINDING_VERSION =
  'ao.reserved-managed-task-metadata-finding.v1';
export const RESERVED_MANAGED_TASK_METADATA_SCAN_VERSION =
  'ao.reserved-managed-task-metadata-scan.v1';

const REGISTRY_ENTRIES = [
  {
    key: 'parent_task_id',
    target_contract: 'ao.task-relation.v1alpha1',
    migration_destination: 'state.task_relations (relation_kind=parent_of)',
    support: 'available',
  },
  {
    key: 'parent_task_refs',
    target_contract: 'ao.child-completion.v1alpha1.parent_task_refs',
    migration_destination: 'Completion Record parent_task_refs',
    support: 'available',
  },
  {
    key: 'task_relations',
    target_contract: 'ao.task-relation.v1alpha1',
    migration_destination: 'state.task_relations',
    support: 'available',
  },
  {
    key: 'completion_record',
    target_contract: 'ao.child-completion.v1alpha1',
    migration_destination: 'versioned Completion Record artifact',
    support: 'available',
  },
  {
    key: 'completion_record_id',
    target_contract: 'ao.child-completion.v1alpha1.record_id',
    migration_destination: 'Completion Record record_id',
    support: 'available',
  },
  {
    key: 'documentation_status',
    target_contract: 'ao.child-completion.v1alpha1.delivery_status',
    migration_destination: 'Completion Record delivery_status',
    support: 'available',
  },
  {
    key: 'workstream_id',
    target_contract: 'managed_task.workstream_id (future versioned first-class field)',
    migration_destination: 'unsupported until a versioned Workstream contract is implemented',
    support: 'unsupported',
  },
  {
    key: 'path_claims',
    target_contract: 'path_claim (future versioned first-class record)',
    migration_destination: 'unsupported until a versioned path-claim contract is implemented',
    support: 'unsupported',
  },
  {
    key: 'path_scope',
    target_contract: 'path_claim (future versioned first-class record)',
    migration_destination: 'unsupported until a versioned path-claim contract is implemented',
    support: 'unsupported',
  },
  {
    key: 'controller_scope',
    target_contract: 'controller_scope (future versioned first-class contract)',
    migration_destination: 'unsupported until a versioned controller-scope contract is implemented',
    support: 'unsupported',
  },
];

export const RESERVED_MANAGED_TASK_METADATA_KEYS = Object.freeze(
  Object.fromEntries(REGISTRY_ENTRIES.map((entry) => [entry.key, Object.freeze({ ...entry })])),
);

function assertPlainObject(value, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}; expected an object`);
  }
}

function assertSupportedRegistryVersion(registryVersion) {
  if (registryVersion !== RESERVED_MANAGED_TASK_METADATA_REGISTRY_VERSION) {
    throw new Error(`Unsupported reserved managed-task metadata registry version: ${String(registryVersion)}`);
  }
}

function normalizeSourceArtifact(sourceArtifact) {
  if (typeof sourceArtifact !== 'string' || sourceArtifact.trim() === '') {
    throw new Error('Missing managed-task metadata source artifact evidence');
  }
  return sourceArtifact.trim().replaceAll('\\', '/');
}

export function lintManagedTaskMetadata({
  task,
  sourceArtifact,
  registryVersion = RESERVED_MANAGED_TASK_METADATA_REGISTRY_VERSION,
} = {}) {
  assertSupportedRegistryVersion(registryVersion);
  assertPlainObject(task, 'managed task');
  if (typeof task.task_id !== 'string' || task.task_id.trim() === '') {
    throw new Error('Missing managed-task identity evidence');
  }
  const artifact = normalizeSourceArtifact(sourceArtifact);
  const metadata = task.metadata ?? {};
  assertPlainObject(metadata, `managed-task metadata for ${task.task_id}`);

  return Object.keys(metadata)
    .filter((key) => Object.hasOwn(RESERVED_MANAGED_TASK_METADATA_KEYS, key))
    .sort()
    .map((key) => {
      const registry = RESERVED_MANAGED_TASK_METADATA_KEYS[key];
      return {
        schema_version: RESERVED_MANAGED_TASK_METADATA_FINDING_VERSION,
        code: 'reserved_managed_task_metadata_key',
        severity: 'blocker',
        disposition: registry.support === 'available' ? 'invalid' : 'unsupported',
        task_id: task.task_id.trim(),
        issue_number: task.issue_number ?? null,
        offending_key: key,
        source: {
          artifact,
          collection: 'managed_tasks',
          selector: `task_id=${task.task_id.trim()}.metadata.${key}`,
        },
        target: {
          contract: registry.target_contract,
          migration_destination: registry.migration_destination,
          support: registry.support,
        },
        message: `Managed-task metadata key ${key} is reserved; migrate to ${registry.migration_destination}.`,
      };
    });
}

export function scanManagedTaskMetadata({
  managedTasks,
  sourceArtifact,
  registryVersion = RESERVED_MANAGED_TASK_METADATA_REGISTRY_VERSION,
} = {}) {
  assertSupportedRegistryVersion(registryVersion);
  if (!Array.isArray(managedTasks)) {
    throw new Error('Invalid managed_tasks evidence; expected an array');
  }
  const artifact = normalizeSourceArtifact(sourceArtifact);
  const findings = managedTasks
    .flatMap((task) => lintManagedTaskMetadata({
      task,
      sourceArtifact: artifact,
      registryVersion,
    }))
    .sort((left, right) => (
      left.task_id.localeCompare(right.task_id)
      || left.offending_key.localeCompare(right.offending_key)
    ));

  return {
    schema_version: RESERVED_MANAGED_TASK_METADATA_SCAN_VERSION,
    registry_version: registryVersion,
    source_artifact: artifact,
    status: findings.length === 0 ? 'pass' : 'blocked',
    scanned_task_count: managedTasks.length,
    finding_count: findings.length,
    findings,
  };
}

export function assertManagedTaskMetadataAllowed(metadata, {
  taskId,
  issueNumber = null,
  sourceArtifact = 'managed_task_write',
} = {}) {
  const findings = lintManagedTaskMetadata({
    task: {
      task_id: taskId,
      issue_number: issueNumber,
      metadata: metadata ?? {},
    },
    sourceArtifact,
  });
  if (findings.length === 0) return;

  const summary = findings
    .map((finding) => `${finding.offending_key} -> ${finding.target.migration_destination}`)
    .join('; ');
  throw new Error(`Reserved managed-task metadata is prohibited for ${taskId}: ${summary}`);
}
