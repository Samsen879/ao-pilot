import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FROZEN_AUTHORITY_DESIGN = Object.freeze({
  canonical_persistent_authority: 'controller-leases.json',
  compatible_read_projection: 'snapshot.state.controller_leases',
  projection_persistent: false,
  state_shadow_recovery_authority: false,
  missing_authority_policy: 'fail_closed_after_explicit_migration_or initialize_empty_only_when fresh-state provenance is proven',
  malformed_authority_policy: 'fail_closed',
  mixed_version_policy: 'validate and migrate the canonical file; never select the state.json shadow by freshness',
});
const FROZEN_CALLER_METADATA_DIGEST = '9a33c814e330606fb9022b399c5feed85b4d37b4886aa24f7c125e5bce141859';

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

export function stableDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableJson(value))).digest('hex');
}

function listSourceFiles(root, extensions) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (extensions.includes(path.extname(entry.name))) files.push(entryPath);
    }
  }
  visit(root);
  return files.sort();
}

export function loadControllerLeaseInventory(inventoryPath) {
  return JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
}

export function scanControllerLeaseSources(inventory, repositoryRoot) {
  const matches = [];
  const extensions = inventory.source_scan.extensions;
  const selectors = inventory.source_scan.selectors.map((selector) => ({
    ...selector,
    regex: new RegExp(selector.pattern),
  }));

  for (const sourceRoot of inventory.source_scan.roots) {
    const absoluteRoot = path.join(repositoryRoot, sourceRoot);
    for (const filePath of listSourceFiles(absoluteRoot, extensions)) {
      const relativePath = path.relative(repositoryRoot, filePath).split(path.sep).join('/');
      if ((inventory.source_scan.exclude_paths ?? []).includes(relativePath)) continue;
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      for (const [lineIndex, line] of lines.entries()) {
        const normalizedLine = line.trim();
        for (const selector of selectors) {
          if (selector.regex.test(line)) {
            matches.push({
              selector: selector.id,
              path: relativePath,
              line: lineIndex + 1,
              source: normalizedLine,
            });
          }
        }
      }
    }
  }

  matches.sort((left, right) => (
    left.selector.localeCompare(right.selector)
    || left.path.localeCompare(right.path)
    || left.line - right.line
    || left.source.localeCompare(right.source)
  ));
  return {
    matches,
    match_count: matches.length,
    digest: stableDigest(matches),
  };
}

export function validateControllerLeaseInventory(inventory, repositoryRoot) {
  if (inventory.schema_version !== 'ao.controller-lease-caller-inventory.v1') {
    throw new Error(`Unsupported controller lease inventory schema: ${inventory.schema_version}`);
  }
  if (inventory.authority_design?.canonical_persistent_authority !== 'controller-leases.json') {
    throw new Error('The inventory must name controller-leases.json as the only persistent authority');
  }
  if (inventory.authority_design?.state_shadow_recovery_authority !== false) {
    throw new Error('The inventory must prohibit state.json shadow recovery authority');
  }
  if (stableDigest(inventory.authority_design) !== stableDigest(FROZEN_AUTHORITY_DESIGN)) {
    throw new Error('The complete frozen controller lease authority design has drifted');
  }

  const ids = inventory.callers.map((caller) => caller.id);
  if (new Set(ids).size !== ids.length) throw new Error('Controller lease caller ids must be unique');
  const callerMetadataDigest = stableDigest({
    governed_base: inventory.governed_base,
    callers: inventory.callers,
  });
  if (callerMetadataDigest !== FROZEN_CALLER_METADATA_DIGEST) {
    throw new Error('The frozen controller lease caller or governed-base metadata has drifted');
  }
  if (inventory.callers.some((caller) => caller.roles.includes('fallback') || caller.roles.includes('shadow-writer'))) {
    throw new Error('Controller lease inventory must not retain a fallback or state shadow writer');
  }
  if (!inventory.callers.some((caller) => caller.roles.includes('writer'))) {
    throw new Error('Controller lease inventory must account for writers');
  }
  if (!inventory.callers.some((caller) => caller.roles.includes('consumer'))) {
    throw new Error('Controller lease inventory must account for projection consumers');
  }

  for (const caller of inventory.callers) {
    const source = fs.readFileSync(path.join(repositoryRoot, caller.path), 'utf8');
    for (const anchor of caller.anchors) {
      const occurrences = source.split(anchor).length - 1;
      if (occurrences !== 1) {
        throw new Error(`${caller.id} anchor must occur exactly once in ${caller.path}: ${anchor}`);
      }
    }
  }

  const scan = scanControllerLeaseSources(inventory, repositoryRoot);
  if (scan.match_count !== inventory.source_scan.expected_match_count) {
    throw new Error(`Controller lease source match count drifted: expected ${inventory.source_scan.expected_match_count}, got ${scan.match_count}`);
  }
  if (scan.digest !== inventory.source_scan.expected_digest) {
    throw new Error(`Controller lease source inventory drifted: expected ${inventory.source_scan.expected_digest}, got ${scan.digest}`);
  }

  return {
    caller_count: inventory.callers.length,
    caller_metadata_digest: callerMetadataDigest,
    source_match_count: scan.match_count,
    source_digest: scan.digest,
  };
}
