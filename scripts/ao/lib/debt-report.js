import fs from 'node:fs';
import path from 'node:path';

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''));
}

function compareTimestampAscending(left, right) {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return leftTime - rightTime;
}

function summarizeCountMap(keys, records = [], keyName) {
  const summary = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const record of records) {
    const key = record?.[keyName];
    if (key == null || !Object.hasOwn(summary, key)) continue;
    summary[key] += 1;
  }
  return summary;
}

function normalizeTaskWorktreeEntry(entry, repoRoot) {
  if (typeof entry === 'string') {
    return {
      worktree_name: path.basename(entry),
      worktree_path: path.isAbsolute(entry) ? entry : path.join(repoRoot, entry),
    };
  }

  const worktreeName = String(entry?.worktree_name ?? path.basename(entry?.worktree_path ?? '')).trim();
  const worktreePath = String(entry?.worktree_path ?? '').trim();
  if (worktreeName === '' || worktreePath === '') return null;

  return {
    worktree_name: worktreeName,
    worktree_path: path.isAbsolute(worktreePath) ? worktreePath : path.join(repoRoot, worktreePath),
  };
}

function normalizeTaskBranchName(value) {
  const branchName = String(value ?? '').trim();
  return branchName === '' ? null : branchName;
}

function normalizeLooseArtifactPath(value) {
  const artifactPath = String(value ?? '').trim();
  return artifactPath === '' ? null : artifactPath;
}

function parseTaskWorktreeName(worktreeName) {
  const taskMatch = /^task-(.+?)--([a-z0-9][a-z0-9-]*)$/.exec(String(worktreeName ?? '').trim());
  if (!taskMatch) return null;
  const [, id, slug] = taskMatch;
  return {
    branch_name: `task/${id}-${slug}`,
  };
}

function collectTaskWorktrees(repoRoot) {
  const worktreesRoot = path.join(repoRoot, '.worktrees');
  if (!fs.existsSync(worktreesRoot)) return [];

  return fs.readdirSync(worktreesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^task-/.test(entry.name))
    .map((entry) => normalizeTaskWorktreeEntry({
      worktree_name: entry.name,
      worktree_path: path.join(worktreesRoot, entry.name),
    }, repoRoot))
    .filter(Boolean)
    .sort((left, right) => compareText(left.worktree_name, right.worktree_name));
}

function collectLooseTaskBranchesFromRefsDir(repoRoot) {
  const branches = [];
  const refsRoot = path.join(repoRoot, '.git', 'refs', 'heads', 'task');
  if (!fs.existsSync(refsRoot)) return branches;

  function walk(currentPath, prefix = '') {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const nextPrefix = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const nextPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath, nextPrefix);
        continue;
      }
      branches.push(`task/${nextPrefix}`);
    }
  }

  walk(refsRoot);
  return branches;
}

function collectPackedTaskBranches(repoRoot) {
  const packedRefsPath = path.join(repoRoot, '.git', 'packed-refs');
  if (!fs.existsSync(packedRefsPath)) return [];

  return fs.readFileSync(packedRefsPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('^'))
    .map((line) => line.split(' ')[1] ?? null)
    .filter((ref) => typeof ref === 'string' && ref.startsWith('refs/heads/task/'))
    .map((ref) => ref.replace(/^refs\/heads\//, ''));
}

function collectTaskBranches(repoRoot) {
  return [...new Set([
    ...collectLooseTaskBranchesFromRefsDir(repoRoot),
    ...collectPackedTaskBranches(repoRoot),
  ])].sort(compareText);
}

function collectLooseArtifacts(repoRoot) {
  const artifactPattern = /^(?:phase\d+_.+|jest_.+|ao_.+)\.(?:txt|log)$/i;
  return fs.readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && artifactPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareText);
}

function resolveRepoInventory(repoRoot, repoInventory = null) {
  const taskWorktrees = Array.isArray(repoInventory?.task_worktrees)
    ? repoInventory.task_worktrees
        .map((entry) => normalizeTaskWorktreeEntry(entry, repoRoot))
        .filter(Boolean)
        .sort((left, right) => compareText(left.worktree_name, right.worktree_name))
    : collectTaskWorktrees(repoRoot);
  const taskBranches = Array.isArray(repoInventory?.task_branches)
    ? repoInventory.task_branches
        .map((value) => normalizeTaskBranchName(value))
        .filter(Boolean)
        .sort(compareText)
    : collectTaskBranches(repoRoot);
  const looseArtifacts = Array.isArray(repoInventory?.loose_artifacts)
    ? repoInventory.loose_artifacts
        .map((value) => normalizeLooseArtifactPath(value))
        .filter(Boolean)
        .sort(compareText)
    : collectLooseArtifacts(repoRoot);

  return {
    task_worktrees: taskWorktrees,
    task_branches: taskBranches,
    loose_artifacts: looseArtifacts,
  };
}

function buildWorktreeInspection({
  worktree,
  task = null,
  taskInspection = null,
} = {}) {
  if (!task || !taskInspection) {
    return {
      item_kind: 'task_worktree',
      item_id: worktree.worktree_name,
      item_ref: worktree.worktree_path,
      task_id: null,
      category: 'cleanup_candidate',
      recommended_action: 'remove_task_worktree',
      reason_codes: ['orphaned_task_worktree'],
    };
  }

  if (taskInspection.closeout_status === 'active') {
    return {
      item_kind: 'task_worktree',
      item_id: worktree.worktree_name,
      item_ref: worktree.worktree_path,
      task_id: task.task_id,
      category: 'keep_evidence',
      recommended_action: 'retain_active_worktree',
      reason_codes: ['task_still_active'],
    };
  }

  if (taskInspection.closeout_status === 'hold') {
    return {
      item_kind: 'task_worktree',
      item_id: worktree.worktree_name,
      item_ref: worktree.worktree_path,
      task_id: task.task_id,
      category: 'keep_evidence',
      recommended_action: 'retain_hold_worktree',
      reason_codes: ['task_on_hold'],
    };
  }

  return {
    item_kind: 'task_worktree',
    item_id: worktree.worktree_name,
    item_ref: worktree.worktree_path,
    task_id: task.task_id,
    category: 'cleanup_candidate',
    recommended_action: 'remove_task_worktree',
    reason_codes: [
      taskInspection.closeout_status === 'retired'
        ? 'task_already_retired'
        : 'task_ready_to_retire',
    ],
  };
}

function buildBranchInspection({
  branchName,
  task = null,
  taskInspection = null,
} = {}) {
  if (!task || !taskInspection) {
    return {
      item_kind: 'task_branch',
      item_id: branchName,
      item_ref: branchName,
      task_id: null,
      category: 'cleanup_candidate',
      recommended_action: 'delete_task_branch',
      reason_codes: ['orphaned_task_branch'],
    };
  }

  if (taskInspection.closeout_status === 'active') {
    return {
      item_kind: 'task_branch',
      item_id: branchName,
      item_ref: branchName,
      task_id: task.task_id,
      category: 'keep_evidence',
      recommended_action: 'retain_active_branch',
      reason_codes: ['task_still_active'],
    };
  }

  if (taskInspection.closeout_status === 'hold') {
    return {
      item_kind: 'task_branch',
      item_id: branchName,
      item_ref: branchName,
      task_id: task.task_id,
      category: 'keep_evidence',
      recommended_action: 'retain_hold_branch',
      reason_codes: ['task_on_hold'],
    };
  }

  return {
    item_kind: 'task_branch',
    item_id: branchName,
    item_ref: branchName,
    task_id: task.task_id,
    category: 'cleanup_candidate',
    recommended_action: 'delete_task_branch',
    reason_codes: [
      taskInspection.closeout_status === 'retired'
        ? 'task_already_retired'
        : 'task_ready_to_retire',
    ],
  };
}

export function buildHistoricalDebtReport({
  repoRoot,
  snapshot,
  taskInspections = [],
  repoInventory = null,
  now = new Date().toISOString(),
} = {}) {
  const inventory = resolveRepoInventory(repoRoot, repoInventory);
  const timestamp = resolveNow(now);
  const taskInspectionByTaskId = new Map(taskInspections.map((inspection) => [inspection.task_id, inspection]));
  const tasksByBranchName = new Map((snapshot?.state?.managed_tasks ?? [])
    .filter((task) => task?.branch_name)
    .map((task) => [task.branch_name, task]));
  const tasksByWorktreePath = new Map((snapshot?.state?.managed_tasks ?? [])
    .filter((task) => task?.worktree_path)
    .map((task) => [task.worktree_path, task]));
  const inspections = [];

  for (const worktree of inventory.task_worktrees) {
    const parsed = parseTaskWorktreeName(worktree.worktree_name);
    const task = tasksByWorktreePath.get(worktree.worktree_path)
      ?? (parsed?.branch_name ? tasksByBranchName.get(parsed.branch_name) : null)
      ?? null;
    inspections.push(buildWorktreeInspection({
      worktree,
      task,
      taskInspection: task ? taskInspectionByTaskId.get(task.task_id) ?? null : null,
    }));
  }

  for (const branchName of inventory.task_branches) {
    const task = tasksByBranchName.get(branchName) ?? null;
    inspections.push(buildBranchInspection({
      branchName,
      task,
      taskInspection: task ? taskInspectionByTaskId.get(task.task_id) ?? null : null,
    }));
  }

  for (const lease of snapshot?.state?.controller_leases ?? []) {
    if (lease?.status !== 'active') continue;
    if (compareTimestampAscending(lease?.expires_at ?? null, timestamp) >= 0) continue;

    inspections.push({
      item_kind: 'controller_lease',
      item_id: lease.lease_id,
      item_ref: lease.lease_id,
      task_id: null,
      category: 'cleanup_candidate',
      recommended_action: 'reclaim_stale_controller_lease',
      reason_codes: ['controller_lease_expired'],
    });
  }

  for (const lease of snapshot?.state?.ownership_leases ?? []) {
    if (lease?.status !== 'active') continue;
    if (compareTimestampAscending(lease?.expires_at ?? null, timestamp) >= 0) continue;

    inspections.push({
      item_kind: 'ownership_lease',
      item_id: lease.lease_id,
      item_ref: lease.lease_id,
      task_id: lease.task_id ?? null,
      category: 'cleanup_candidate',
      recommended_action: 'release_stale_ownership_lease',
      reason_codes: ['ownership_lease_expired'],
    });
  }

  for (const artifactPath of inventory.loose_artifacts) {
    inspections.push({
      item_kind: 'artifact',
      item_id: artifactPath,
      item_ref: artifactPath,
      task_id: null,
      category: 'cleanup_candidate',
      recommended_action: 'move_to_runs_or_delete',
      reason_codes: ['loose_temp_artifact'],
    });
  }

  for (const inspection of taskInspections) {
    if (inspection?.closeout_status !== 'retired') continue;
    if ((inspection?.bound_pr_count ?? 0) > 0) continue;
    if ((inspection?.active_ownership_lease_count ?? 0) > 0) continue;
    if ((inspection?.active_handoff_count ?? 0) > 0) continue;

    inspections.push({
      item_kind: 'managed_task',
      item_id: inspection.task_id,
      item_ref: inspection.task_id,
      task_id: inspection.task_id,
      category: 'archive_candidate',
      recommended_action: 'archive_retired_task_history',
      reason_codes: ['retired_task_history'],
    });
  }

  const sortedInspections = inspections.sort((left, right) => (
    compareText(left.item_kind, right.item_kind)
      || compareText(left.item_ref, right.item_ref)
  ));

  return {
    summary: {
      category_counts: summarizeCountMap(
        ['keep_evidence', 'archive_candidate', 'cleanup_candidate'],
        sortedInspections,
        'category',
      ),
      item_kind_counts: summarizeCountMap(
        ['task_worktree', 'task_branch', 'controller_lease', 'ownership_lease', 'artifact', 'managed_task'],
        sortedInspections,
        'item_kind',
      ),
    },
    inspections: sortedInspections,
  };
}
