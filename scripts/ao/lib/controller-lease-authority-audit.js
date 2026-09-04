import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

const FROZEN_AUTHORITY_DESIGN = Object.freeze({
  canonical_persistent_authority: 'controller-leases.json',
  compatible_read_projection: 'snapshot.state.controller_leases',
  projection_persistent: false,
  state_shadow_recovery_authority: false,
  missing_authority_policy: 'fail_closed_after_explicit_migration_or initialize_empty_only_when fresh-state provenance is proven',
  malformed_authority_policy: 'fail_closed',
  mixed_version_policy: 'validate and migrate the canonical file; never select the state.json shadow by freshness',
});
const FROZEN_SEMANTIC_MANIFEST_DIGEST = 'b6744c90f594a8ae94912757251a0f6cc788cf6985aa1b14eeb5267216c50101';

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

function regexLiteralEnd(source, start, semanticPrefix) {
  const prefix = semanticPrefix.trimEnd();
  const previousCharacter = prefix.at(-1) ?? '';
  const previousWord = prefix.match(/[A-Za-z_$][A-Za-z0-9_$]*$/)?.[0] ?? '';
  const canStartRegex = prefix === ''
    || /[([{,:;=!?&|+\-*%^~<>]/.test(previousCharacter)
    || ['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'of', 'return', 'throw', 'typeof', 'void', 'yield'].includes(previousWord);
  if (!canStartRegex || source[start] !== '/' || ['/', '*'].includes(source[start + 1])) return null;

  let escaped = false;
  let inCharacterClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (/\r|\n|\u2028|\u2029/.test(character)) return null;
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '[') {
      inCharacterClass = true;
    } else if (character === ']') {
      inCharacterClass = false;
    } else if (character === '/' && !inCharacterClass) {
      let end = index;
      while (/[A-Za-z]/.test(source[end + 1] ?? '')) end += 1;
      return end;
    }
  }
  return null;
}

export function normalizeSemanticSource(source) {
  let normalized = '';
  let quote = null;
  let escaped = false;
  const templateExpressionDepths = [];
  const appendRestrictedLineTerminator = () => {
    if (/(?:^|[^A-Za-z0-9_$.])(?:async|break|continue|return|throw|yield)$/.test(normalized)) {
      normalized += '\n';
      return true;
    }
    return false;
  };
  const appendRequiredTokenSeparator = (nextIndex) => {
    let offset = nextIndex;
    while (offset < source.length && /\s/.test(source[offset])) offset += 1;
    const previous = normalized.at(-1) ?? '';
    const next = source[offset] ?? '';
    if (/[A-Za-z0-9_$]/.test(previous) && /[A-Za-z0-9_$]/.test(next)) normalized += ' ';
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote != null) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (quote === '`' && character === '$' && source[index + 1] === '{') {
        normalized += '{';
        index += 1;
        quote = null;
        templateExpressionDepths.push(1);
      }
      else if (character === quote) quote = null;
      continue;
    }
    if (templateExpressionDepths.length > 0 && character === '{') {
      templateExpressionDepths[templateExpressionDepths.length - 1] += 1;
      normalized += character;
      continue;
    }
    if (templateExpressionDepths.length > 0 && character === '}') {
      const top = templateExpressionDepths.length - 1;
      templateExpressionDepths[top] -= 1;
      normalized += character;
      if (templateExpressionDepths[top] === 0) {
        templateExpressionDepths.pop();
        quote = '`';
      }
      continue;
    }
    const regexEnd = character === '/' ? regexLiteralEnd(source, index, normalized) : null;
    if (character === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && !/[\r\n\u2028\u2029]/.test(source[index])) index += 1;
      if (!appendRestrictedLineTerminator()) appendRequiredTokenSeparator(index + 1);
    } else if (character === '/' && source[index + 1] === '*') {
      const commentStart = index;
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      const hasLineTerminator = /[\r\n\u2028\u2029]/.test(source.slice(commentStart, index + 1));
      if (!(hasLineTerminator && appendRestrictedLineTerminator())) {
        appendRequiredTokenSeparator(index + 1);
      }
    } else if (regexEnd != null) {
      normalized += source.slice(index, regexEnd + 1);
      index = regexEnd;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
      normalized += character;
    } else if (/\s/.test(character)) {
      const whitespaceStart = index;
      while (index + 1 < source.length && /\s/.test(source[index + 1])) index += 1;
      const hasLineTerminator = /[\r\n\u2028\u2029]/.test(source.slice(whitespaceStart, index + 1));
      if (!(hasLineTerminator && appendRestrictedLineTerminator())) {
        appendRequiredTokenSeparator(index + 1);
      }
    } else {
      normalized += character;
    }
  }
  return normalized;
}

function parseLexicalSource(source) {
  return parse(source, {
    sourceType: 'module',
    tokens: true,
  });
}

function maskComments(source, parsed = parseLexicalSource(source)) {
  const characters = source.split('');
  for (const comment of parsed.comments) {
    for (let index = comment.start; index < comment.end; index += 1) {
      if (!/[\r\n\u2028\u2029]/.test(characters[index])) characters[index] = ' ';
    }
  }
  return characters.join('');
}

function normalizeParsedSemanticSource(source, parsed) {
  const commentStarts = new Set(parsed.comments.map((comment) => comment.start));
  let normalized = '';
  let previousToken = null;
  for (const token of parsed.tokens) {
    if (token.type.label === 'eof' || commentStarts.has(token.start)) continue;
    const raw = source.slice(token.start, token.end);
    if (previousToken != null) {
      const trivia = source.slice(previousToken.end, token.start);
      const previousRaw = source.slice(previousToken.start, previousToken.end);
      if (
        /[\r\n\u2028\u2029]/.test(trivia)
        && ['async', 'break', 'continue', 'return', 'throw', 'yield'].includes(previousRaw)
      ) {
        normalized += '\n';
      } else if (/[A-Za-z0-9_$]/.test(normalized.at(-1) ?? '') && /^[A-Za-z0-9_$]/.test(raw)) {
        normalized += ' ';
      }
    }
    normalized += raw;
    previousToken = token;
  }
  return normalized;
}

function normalizedOffsetForSourceOffset(source, parsed, sourceOffset) {
  const commentStarts = new Set(parsed.comments.map((comment) => comment.start));
  let normalized = '';
  let previousToken = null;
  for (const token of parsed.tokens) {
    if (token.type.label === 'eof' || commentStarts.has(token.start)) continue;
    const raw = source.slice(token.start, token.end);
    if (previousToken != null) {
      const trivia = source.slice(previousToken.end, token.start);
      const previousRaw = source.slice(previousToken.start, previousToken.end);
      if (
        /[\r\n\u2028\u2029]/.test(trivia)
        && ['async', 'break', 'continue', 'return', 'throw', 'yield'].includes(previousRaw)
      ) {
        normalized += '\n';
      } else if (/[A-Za-z0-9_$]/.test(normalized.at(-1) ?? '') && /^[A-Za-z0-9_$]/.test(raw)) {
        normalized += ' ';
      }
    }
    if (sourceOffset >= token.start && sourceOffset < token.end) {
      return normalized.length + sourceOffset - token.start;
    }
    normalized += raw;
    previousToken = token;
  }
  return normalized.length;
}

function sourceDocuments(inventory, repositoryRoot) {
  const documents = [];
  for (const sourceRoot of inventory.source_scan.roots) {
    const absoluteRoot = path.join(repositoryRoot, sourceRoot);
    for (const filePath of listSourceFiles(absoluteRoot, inventory.source_scan.extensions)) {
      const relativePath = path.relative(repositoryRoot, filePath).split(path.sep).join('/');
      if ((inventory.source_scan.exclude_paths ?? []).includes(relativePath)) continue;
      const source = fs.readFileSync(filePath, 'utf8');
      const parsed = parseLexicalSource(source);
      documents.push({
        path: relativePath,
        source,
        parsed,
        selector_source: maskComments(source, parsed),
        normalized_source: normalizeParsedSemanticSource(source, parsed),
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
    inventory_version: inventory.inventory_version,
    migrated_from: inventory.migrated_from,
    governed_base: inventory.governed_base,
    hardening_admission: inventory.hardening_admission,
    authority_design: inventory.authority_design,
    authority_sites: inventory.authority_sites.map((site) => ({
      id: site.id,
      roles: [...site.roles].sort(compareStrings),
      bindings: site.anchors.map((anchor, index) => ({
        id: `${site.id}#${index + 1}`,
        semantic_source: normalizeSemanticSource(anchor),
      })),
      semantic_regions: (site.semantic_regions ?? []).map((region) => ({
        id: region.id,
        start: normalizeSemanticSource(region.start),
        end: region.end == null ? null : normalizeSemanticSource(region.end),
        expected_digest: region.expected_digest,
      })).sort((left, right) => compareStrings(left.id, right.id)),
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
      semantic_usages: inventory.source_scan.semantic_usages.map((usage) => ({
        id: usage.id,
        selector: usage.selector,
        semantic_source: normalizeSemanticSource(usage.semantic_source),
        expected_count: usage.expected_count,
      })).sort((left, right) => compareStrings(left.id, right.id)),
    },
  };
}

export function scanControllerLeaseSources(
  inventory,
  repositoryRoot,
  documents = sourceDocuments(inventory, repositoryRoot),
) {
  const matches = [];
  for (const selector of inventory.source_scan.selectors) {
    const regex = new RegExp(selector.pattern, 'g');
    for (const document of documents) {
      for (const match of document.selector_source.matchAll(regex)) {
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

function validateSelectorSemanticUsages(
  inventory,
  repositoryRoot,
  documents = sourceDocuments(inventory, repositoryRoot),
) {
  const selectorsById = new Map(inventory.source_scan.selectors
    .map((selector) => [selector.id, selector]));
  const coverage = new Map();
  const usageEvidence = [];

  for (const usage of inventory.source_scan.semantic_usages) {
    const selector = selectorsById.get(usage.selector);
    if (selector == null) {
      throw new Error(`Controller lease semantic usage ${usage.id} names unknown selector ${usage.selector}`);
    }
    if (!Number.isInteger(usage.expected_count) || usage.expected_count <= 0) {
      throw new Error(`Controller lease semantic usage ${usage.id} must declare a positive expected count`);
    }
    const semanticSource = normalizeSemanticSource(usage.semantic_source);
    if (semanticSource === '') {
      throw new Error(`Controller lease semantic usage ${usage.id} must not be empty`);
    }
    const selectorMatches = [...usage.semantic_source.matchAll(new RegExp(selector.pattern, 'g'))];
    if (selectorMatches.length !== 1) {
      throw new Error(`Controller lease semantic usage ${usage.id} must contain its selector exactly once`);
    }
    const normalizedSelector = normalizeSemanticSource(selectorMatches[0][0]);
    const selectorOffsetInSemanticSource = semanticSource.indexOf(normalizedSelector);
    if (selectorOffsetInSemanticSource === -1) {
      throw new Error(`Controller lease semantic usage ${usage.id} cannot locate its normalized selector`);
    }

    let observedCount = 0;
    for (const document of documents) {
      for (const anchorOffset of countLiteralOccurrences(document.normalized_source, semanticSource)) {
        observedCount += 1;
        const selectorOffset = anchorOffset + selectorOffsetInSemanticSource;
        const key = `${usage.selector}\0${document.path}\0${selectorOffset}`;
        const bindings = coverage.get(key) ?? [];
        bindings.push(usage.id);
        coverage.set(key, bindings);
      }
    }
    if (observedCount !== usage.expected_count) {
      throw new Error(`Controller lease semantic usage ${usage.id} drifted: expected ${usage.expected_count}, got ${observedCount}`);
    }
    usageEvidence.push({ id: usage.id, selector: usage.selector, count: observedCount });
  }

  for (const selector of inventory.source_scan.selectors) {
    const regex = new RegExp(selector.pattern, 'g');
    for (const document of documents) {
      for (const match of document.selector_source.matchAll(regex)) {
        if (match[0] === '') {
          throw new Error(`Controller lease selector must not match empty source: ${selector.id}`);
        }
        const normalizedOffset = normalizedOffsetForSourceOffset(document.source, document.parsed, match.index);
        const key = `${selector.id}\0${document.path}\0${normalizedOffset}`;
        const bindings = coverage.get(key) ?? [];
        if (bindings.length === 0) {
          throw new Error(`Controller lease selector ${selector.id} has unregistered semantic usage at ${document.path}`);
        }
        if (bindings.length > 1) {
          throw new Error(`Controller lease selector ${selector.id} has ambiguous semantic usage at ${document.path}: ${bindings.join(', ')}`);
        }
      }
    }
  }

  return usageEvidence.sort((left, right) => compareStrings(left.id, right.id));
}

function validateAuthoritySiteBindings(
  inventory,
  repositoryRoot,
  documents = sourceDocuments(inventory, repositoryRoot),
) {
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

function validateAuthoritySemanticRegions(
  inventory,
  repositoryRoot,
  documents = sourceDocuments(inventory, repositoryRoot),
) {
  const regionEvidence = [];
  for (const site of inventory.authority_sites) {
    for (const region of site.semantic_regions ?? []) {
      const start = normalizeSemanticSource(region.start);
      const end = region.end == null ? null : normalizeSemanticSource(region.end);
      const candidates = documents.filter((document) => (
        countLiteralOccurrences(document.normalized_source, start).length === 1
        && (end == null || (
          countLiteralOccurrences(document.normalized_source, end).length === 1
          && document.normalized_source.indexOf(start) < document.normalized_source.indexOf(end)
        ))
      ));
      if (candidates.length !== 1) {
        throw new Error(`Controller lease semantic region ${region.id} must resolve to exactly one source`);
      }
      const [document] = candidates;
      const startOffset = document.normalized_source.indexOf(start);
      const endOffset = end == null ? document.normalized_source.length : document.normalized_source.indexOf(end);
      const digest = stableDigest(document.normalized_source.slice(startOffset, endOffset));
      if (digest !== region.expected_digest) {
        throw new Error(`Controller lease semantic region ${region.id} drifted: expected ${region.expected_digest}, got ${digest}`);
      }
      regionEvidence.push({ id: region.id, site_id: site.id, digest });
    }
  }
  return regionEvidence.sort((left, right) => compareStrings(left.id, right.id));
}

export function generateControllerLeaseAuthorityEvidence(inventory, repositoryRoot) {
  const documents = sourceDocuments(inventory, repositoryRoot);
  const semanticManifest = createControllerLeaseSemanticManifest(inventory);
  const bindingEvidence = validateAuthoritySiteBindings(inventory, repositoryRoot, documents);
  const semanticRegionEvidence = validateAuthoritySemanticRegions(inventory, repositoryRoot, documents);
  const semanticUsageEvidence = validateSelectorSemanticUsages(inventory, repositoryRoot, documents);
  const scan = scanControllerLeaseSources(inventory, repositoryRoot, documents);
  const evidence = {
    schema_version: 'ao.controller-lease-authority-evidence.v2',
    semantic_manifest_digest: stableDigest(semanticManifest),
    authority_site_count: inventory.authority_sites.length,
    binding_count: bindingEvidence.length,
    bindings: bindingEvidence,
    semantic_region_count: semanticRegionEvidence.length,
    semantic_regions: semanticRegionEvidence,
    selector_counts: scan.selector_counts,
    semantic_usage_count: semanticUsageEvidence.reduce((total, usage) => total + usage.count, 0),
    semantic_usages: semanticUsageEvidence,
    selector_evidence_digest: stableDigest(semanticUsageEvidence),
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
  const semanticUsageIds = inventory.source_scan.semantic_usages.map((usage) => usage.id);
  if (new Set(semanticUsageIds).size !== semanticUsageIds.length) {
    throw new Error('Controller lease semantic usage ids must be unique');
  }
  const semanticRegions = inventory.authority_sites.flatMap((site) => site.semantic_regions ?? []);
  const semanticRegionIds = semanticRegions.map((region) => region.id);
  if (new Set(semanticRegionIds).size !== semanticRegionIds.length) {
    throw new Error('Controller lease semantic region ids must be unique');
  }
  if (semanticRegions.some((region) => !/^[0-9a-f]{64}$/.test(region.expected_digest))) {
    throw new Error('Controller lease semantic regions must declare SHA-256 digests');
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
