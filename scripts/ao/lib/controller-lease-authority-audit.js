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
const FROZEN_SEMANTIC_MANIFEST_DIGEST = 'c9760e15ce1feda28032c2113f43d148a2e6425e1730c358ccaa48085106f9f4';

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compareStrings)
      .map((key) => [key, stableJson(value[key])]));
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
  return files.sort(compareStrings);
}

function normalizeSemanticSource(source) {
  let normalized = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote != null) {
      if (quote !== '`' || !/\s/.test(character)) normalized += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && !/[\r\n]/.test(source[index])) index += 1;
    } else if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
      normalized += character;
    } else if (!/\s/.test(character)) {
      normalized += character;
    }
  }
  return normalized;
}

function sourceDocuments(inventory, repositoryRoot) {
  const documents = [];
  for (const sourceRoot of inventory.source_scan.roots) {
    const absoluteRoot = path.join(repositoryRoot, sourceRoot);
    for (const filePath of listSourceFiles(absoluteRoot, inventory.source_scan.extensions)) {
      const relativePath = path.relative(repositoryRoot, filePath).split(path.sep).join('/');
      if ((inventory.source_scan.exclude_paths ?? []).includes(relativePath)) continue;
      const source = fs.readFileSync(filePath, 'utf8');
      documents.push({
        path: relativePath,
        source,
        normalized_source: normalizeSemanticSource(source),
      });
    }
  }
  return documents.sort((left, right) => compareStrings(left.path, right.path));
}

function lineAtOffset(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function countLiteralOccurrences(source, literal) {
  const offsets = [];
  let offset = source.indexOf(literal);
  while (offset !== -1) {
    offsets.push(offset);
    offset = source.indexOf(literal, offset + Math.max(literal.length, 1));
  }
  return offsets;
}

export function loadControllerLeaseInventory(inventoryPath) {
  return JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
}

export function createControllerLeaseSemanticManifest(inventory) {
  return {
    schema_version: inventory.schema_version,
    authority_design: inventory.authority_design,
    authority_sites: inventory.authority_sites.map((site) => ({
      id: site.id,
      roles: [...site.roles].sort(compareStrings),
      bindings: site.anchors.map((anchor, index) => ({
        id: `${site.id}#${index + 1}`,
        semantic_source: normalizeSemanticSource(anchor),
      })),
    })).sort((left, right) => compareStrings(left.id, right.id)),
    source_coverage: {
      roots: [...inventory.source_scan.roots].sort(compareStrings),
      extensions: [...inventory.source_scan.extensions].sort(compareStrings),
      exclude_paths: [...(inventory.source_scan.exclude_paths ?? [])].sort(compareStrings),
      selectors: inventory.source_scan.selectors.map((selector) => ({
        id: selector.id,
        pattern: selector.pattern,
        expected_count: inventory.source_scan.expected_selector_counts[selector.id],
      })).sort((left, right) => compareStrings(left.id, right.id)),
    },
  };
}

export function scanControllerLeaseSources(inventory, repositoryRoot) {
  const matches = [];
  const documents = sourceDocuments(inventory, repositoryRoot);
  for (const selector of inventory.source_scan.selectors) {
    const regex = new RegExp(selector.pattern, 'g');
    for (const document of documents) {
      for (const match of document.source.matchAll(regex)) {
        if (match[0] === '') throw new Error(`Controller lease selector must not match empty source: ${selector.id}`);
        const line = lineAtOffset(document.source, match.index);
        matches.push({
          selector: selector.id,
          path: document.path,
          line,
          source: document.source.split(/\r?\n/)[line - 1].trim(),
        });
      }
    }
  }

  matches.sort((left, right) => (
    compareStrings(left.selector, right.selector)
    || compareStrings(left.path, right.path)
    || left.line - right.line
    || compareStrings(left.source, right.source)
  ));
  const selectorCounts = Object.fromEntries(inventory.source_scan.selectors
    .map((selector) => [
      selector.id,
      matches.filter((match) => match.selector === selector.id).length,
    ])
    .sort(([left], [right]) => compareStrings(left, right)));
  const normalizedEvidence = Object.entries(selectorCounts)
    .map(([selector, count]) => ({ selector, count }));
  return {
    matches,
    match_count: matches.length,
    selector_counts: selectorCounts,
    digest: stableDigest(normalizedEvidence),
  };
}

function validateAuthoritySiteBindings(inventory, repositoryRoot) {
  const documents = sourceDocuments(inventory, repositoryRoot);
  const bindingEvidence = [];
  for (const site of inventory.authority_sites) {
    const semanticAnchors = site.anchors.map(normalizeSemanticSource);
    const candidateDocuments = documents.filter((document) => semanticAnchors.every((anchor) => (
      document.normalized_source.includes(anchor)
    )));
    if (candidateDocuments.length !== 1) {
      const locations = candidateDocuments.map((document) => document.path);
      const diagnostic = locations.length === 0
        ? `found no source containing the complete binding set (hint: ${site.path} :: ${site.symbol})`
        : `found ${locations.length} sources containing the complete binding set: ${locations.join(', ')}`;
      throw new Error(`Controller lease authority site ${site.id} failed: ${diagnostic}`);
    }
    const [document] = candidateDocuments;
    const bindingOffsets = [];
    for (const [index, semanticSource] of semanticAnchors.entries()) {
      const bindingId = `${site.id}#${index + 1}`;
      if (semanticSource === '') {
        throw new Error(`Controller lease authority binding ${bindingId} must not be empty`);
      }
      const occurrences = countLiteralOccurrences(document.normalized_source, semanticSource).length;
      if (occurrences !== 1) {
        const diagnostic = `expected exactly one semantic binding, found ${occurrences} at ${document.path}`;
        throw new Error(`Controller lease authority binding ${bindingId} failed: ${diagnostic}`);
      }
      bindingOffsets.push(document.normalized_source.indexOf(semanticSource));
      bindingEvidence.push({ id: bindingId, site_id: site.id });
    }
    if (bindingOffsets.some((offset, index) => index > 0 && offset <= bindingOffsets[index - 1])) {
      throw new Error(`Controller lease authority site ${site.id} binding order drifted at ${document.path}`);
    }
  }
  return bindingEvidence.sort((left, right) => compareStrings(left.id, right.id));
}

export function generateControllerLeaseAuthorityEvidence(inventory, repositoryRoot) {
  const semanticManifest = createControllerLeaseSemanticManifest(inventory);
  const bindingEvidence = validateAuthoritySiteBindings(inventory, repositoryRoot);
  const scan = scanControllerLeaseSources(inventory, repositoryRoot);
  const evidence = {
    schema_version: 'ao.controller-lease-authority-evidence.v2',
    semantic_manifest_digest: stableDigest(semanticManifest),
    authority_site_count: inventory.authority_sites.length,
    binding_count: bindingEvidence.length,
    bindings: bindingEvidence,
    selector_counts: scan.selector_counts,
    selector_evidence_digest: scan.digest,
  };
  return {
    ...evidence,
    authority_evidence_digest: stableDigest(evidence),
    diagnostics: { source_matches: scan.matches },
  };
}

export function validateControllerLeaseInventory(inventory, repositoryRoot) {
  if (inventory.schema_version !== 'ao.controller-lease-authority-sites.v2') {
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

  const ids = inventory.authority_sites.map((site) => site.id);
  if (new Set(ids).size !== ids.length) throw new Error('Controller lease authority site ids must be unique');
  const selectorIds = inventory.source_scan.selectors.map((selector) => selector.id);
  if (new Set(selectorIds).size !== selectorIds.length) {
    throw new Error('Controller lease selector ids must be unique');
  }
  if (inventory.authority_sites.some((site) => (
    site.roles.includes('fallback') || site.roles.includes('shadow-writer')
  ))) {
    throw new Error('Controller lease authority sites must not retain a fallback or state shadow writer');
  }
  if (!inventory.authority_sites.some((site) => site.roles.includes('writer'))) {
    throw new Error('Controller lease authority sites must account for writers');
  }
  if (!inventory.authority_sites.some((site) => site.roles.includes('consumer'))) {
    throw new Error('Controller lease authority sites must account for projection consumers');
  }

  const semanticManifestDigest = stableDigest(createControllerLeaseSemanticManifest(inventory));
  if (semanticManifestDigest !== FROZEN_SEMANTIC_MANIFEST_DIGEST) {
    throw new Error(`The frozen controller lease semantic manifest has drifted: expected ${FROZEN_SEMANTIC_MANIFEST_DIGEST}, got ${semanticManifestDigest}`);
  }

  const evidence = generateControllerLeaseAuthorityEvidence(inventory, repositoryRoot);
  for (const selector of inventory.source_scan.selectors) {
    const expected = inventory.source_scan.expected_selector_counts[selector.id];
    const actual = evidence.selector_counts[selector.id];
    if (!Number.isInteger(expected) || expected < 0) {
      throw new Error(`Controller lease selector ${selector.id} must declare a non-negative expected count`);
    }
    if (actual !== expected) {
      const locations = evidence.diagnostics.source_matches
        .filter((match) => match.selector === selector.id)
        .map((match) => `${match.path}:${match.line}`);
      throw new Error(`Controller lease selector ${selector.id} coverage drifted: expected ${expected}, got ${actual}; observed at ${locations.join(', ') || 'none'}`);
    }
  }

  const { diagnostics, ...normalizedEvidence } = evidence;
  return normalizedEvidence;
}
