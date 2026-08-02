const CANONICAL_REPOSITORY = 'Samsen879/ao-pilot';

export function issueLinkedPrEvidenceFromTimeline(timeline) {
  if (timeline.pageInfo.hasNextPage) throw new Error('Issue-linked PR evidence exceeds the bounded GraphQL page');
  const linked = new Map();
  for (const event of timeline.nodes) {
    const source = event.source;
    if (source?.__typename !== 'PullRequest' || source.repository?.nameWithOwner !== CANONICAL_REPOSITORY) continue;
    linked.set(source.number, {
      repository: source.repository.nameWithOwner,
      number: source.number,
      url: source.url,
      created_at: source.createdAt,
      head_ref: source.headRefName,
      base_ref: source.baseRefName,
    });
  }
  return [...linked.values()];
}
