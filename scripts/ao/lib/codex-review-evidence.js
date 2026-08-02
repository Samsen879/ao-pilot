export function ownerExactHeadReviewRequests(comments) {
  return comments
    .filter((comment) => (
      comment.user?.login === 'Samsen879'
      && comment.author_association === 'OWNER'
      && comment.body?.trimStart().startsWith('@codex review')
      && comment.created_at === comment.updated_at
    ))
    .map((comment) => {
      const matches = comment.body.match(/\b[0-9a-f]{40}\b/gi) ?? [];
      return {
        comment_id: comment.id,
        head_sha: matches.length === 1 ? matches[0].toLowerCase() : null,
        requested_at: comment.created_at,
      };
    })
    .filter((comment) => comment.head_sha != null);
}

export function submittedCodexReviewEvidence(reviews, requests) {
  return reviews
    .filter((review) => review.user?.login === 'chatgpt-codex-connector[bot]')
    .map((review) => {
      const matchingRequests = requests.filter((comment) => (
        comment.head_sha === review.commit_id?.toLowerCase()
        && Date.parse(comment.requested_at) <= Date.parse(review.submitted_at)
      ));
      const requestValid = matchingRequests.length === 1;
      const formalReview = /\bCodex Review\b/i.test(review.body ?? '');
      const submitted = review.submitted_at != null && ['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'].includes(review.state);
      return {
        kind: 'submitted_review',
        evidence_id: review.id,
        request_comment_id: requestValid ? matchingRequests[0].comment_id : null,
        request_valid: requestValid,
        formal_review: formalReview,
        head_sha: review.commit_id,
        completed_at: review.submitted_at,
        actor: review.user.login,
        completed: submitted && requestValid && formalReview,
      };
    });
}

export function collectCodexReviewEvidence({ comments, reviews, reactionsForComment }) {
  const requests = ownerExactHeadReviewRequests(comments);
  const submitted = submittedCodexReviewEvidence(reviews, requests);
  const completedSubmitted = submitted.filter((review) => review.completed === true);
  const completedRequestIds = new Set(completedSubmitted.map((review) => review.request_comment_id));
  const clean = [];

  for (const comment of requests) {
    if (completedRequestIds.has(comment.comment_id)) continue;
    const reactions = reactionsForComment(comment.comment_id);
    if (!Array.isArray(reactions)) throw new Error(`Invalid reactions for review request ${comment.comment_id}`);
    const reaction = reactions.find((item) => (
      item?.user?.login === 'chatgpt-codex-connector[bot]'
      && item.content === '+1'
      && Date.parse(item.created_at) >= Date.parse(comment.requested_at)
    ));
    if (reaction == null) continue;
    clean.push({
      kind: 'clean_reaction',
      evidence_id: comment.comment_id,
      request_comment_id: comment.comment_id,
      request_valid: true,
      head_sha: comment.head_sha,
      completed_at: reaction.created_at,
      actor: reaction.user.login,
      completed: true,
    });
  }

  return [...completedSubmitted, ...clean];
}
