import { createTaskSpecSnapshot } from './task-spec.js';

function normalizeHeading(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function parseMarkdownSections(markdown) {
  const sections = new Map();
  let currentHeading = null;
  let currentLines = [];

  const flush = () => {
    if (currentHeading == null) return;
    sections.set(currentHeading, currentLines.join('\n').trim());
  };

  for (const rawLine of String(markdown ?? '').split('\n')) {
    const headingMatch = rawLine.match(/^#{2,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      currentHeading = normalizeHeading(headingMatch[1]);
      currentLines = [];
      continue;
    }

    if (currentHeading != null) {
      currentLines.push(rawLine.replace(/\r$/, ''));
    }
  }

  flush();
  return sections;
}

function parseScalarSection(value) {
  const normalized = String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return normalized[0] ?? null;
}

function parseListSection(value) {
  const lines = String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];
  if (lines.some((line) => !/^[-*]\s+/.test(line))) {
    return value;
  }

  return lines.map((line) => line.replace(/^[-*]\s+/, '').trim());
}

export function normalizeIssueIntake({
  issueNumber = null,
  title = null,
  body = '',
  sourceKind = 'github_issue',
} = {}) {
  void title;

  const sections = parseMarkdownSections(body);
  const taskSpecSnapshot = createTaskSpecSnapshot({
    problem_type: parseScalarSection(sections.get('problem type')),
    acceptance_contract: parseListSection(sections.get('acceptance contract')),
    runtime_ref: parseScalarSection(sections.get('runtime ref')),
    policy_ref: parseScalarSection(sections.get('policy ref')),
    human_gates: parseListSection(sections.get('human gates')),
  });

  return {
    issue_number: issueNumber,
    source_kind: sourceKind,
    task_spec_snapshot: taskSpecSnapshot,
  };
}
