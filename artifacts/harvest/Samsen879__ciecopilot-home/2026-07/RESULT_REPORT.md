# AO Track A P0-A Result Report

## Scope and custody

- Repository: `Samsen879/ciecopilot-home`
- GitHub UTC selector: `merged_at >= 2026-07-01T00:00:00Z && merged_at < 2026-08-01T00:00:00Z`
- Search total / actual exact-window PR count / expected count: `371 / 371 / 371`
- Full source coverage: `371/371` for PR metadata, commits, formal reviews,
  inline review comments, and conversation comments
- GitHub GET requests: `1,897`
- Endpoint/page snapshots: `1,859`
- Unique raw bodies: `1,747`
- Uncompressed raw bytes: `70,671,757`
- Raw corpus digest: `6f4d9adb2651d3d7d898ca472fab04c714cf732049314cf2eb55245de7ac5c78`
- Final remaining: Core `3,620`, GraphQL `4,994`, Search `30`
- Rate-limit pauses: `0`; secondary-limit events: `0`; recovered transient GETs: `1`

The initial invocation stopped fail-closed on a TLS handshake timeout and then
resumed from its checkpoint after the generic transient-retry repair. No failed
request produced a successful page artifact.

## Normalized inventory

- Independent-review blockers: `40`
- Unknown review classifications: `49` (`30` formal submissions plus `19`
  unbound conversation-review evidence records)
- Independent blocker episodes: `12`
- Recurring patterns: `4`
- Resolved / unresolved blockers: `35 / 5`
- Automated inline suggestions retained outside the primary corpus: `522`
- Automated formal review submissions retained in raw snapshots: `397`
- Protocol-marker coverage: `76/125` (`0.608`)
- Exact-head binding among protocol markers: `43/76` (`0.565789`)

Recurring patterns meeting the three-episode rule are deterministic replay (3
episodes), evidence custody (9), fail-closed contract (3), and semantic authority
(3).

All 40 `first_detectable_stage` values are `not_established`. This is deliberate:
the review evidence establishes where the findings were observed, but does not
reliably establish an earlier stage under the frozen deterministic rules.

## Review-round baseline

- Review rounds: `43`
- Blocking rounds: `20`
- Correction rounds: `17`
- PRs with exact-head independent rounds: `23`
- First-pass independent review: `11/23` (`0.478261`)
- First-review-to-merge duration: min `27s`, median `776s`, p95 `6,213s`, max `6,917s`
- Blockers per blocking round histogram: `1:9, 2:5, 3:4, 4:1, 5:1`
- Review-round histogram by PR: `0:348, 1:10, 2:9, 3:1, 4:3`
- Blocking-round histogram by PR: `0:359, 1:7, 2:2, 3:3`
- Correction-round histogram by PR: `0:360, 1:8, 3:3`

## Knowledge gate

| Gate | Result |
|---|---|
| normalized blockers >= 50 | FAIL (`40`) |
| independent episodes >= 10 | PASS (`12`) |
| recurring patterns >= 3 | PASS (`4`) |
| each recurring pattern in >= 3 episodes | PASS |
| first-detectable-stage baseline exists | PASS (conservative `not_established` baseline) |

Overall result: **Knowledge Track proposal gate not met**. The permitted
conclusion `Knowledge Track proposal may start` is not issued.

## Replay and validation

- Snapshot manifest SHA-256: `250ce4452a5b80b9f81441e5aef0a81962c67e691877eb04e38ac4123caf827b`
- Block inventory SHA-256: `1e10e8d5455e20495172640b82845cafe3571e47c364bcbf52adc83d4f8b6277`
- Review baseline SHA-256: `f2117d31269665ae90a72bda79996cdf3f49fa035e54b73b45669b3568aa98d1`
- Stable output-set digest: `59f90eda557f2e5bf8e12b7890b57901d51f6162a0ff2cda407bee50e23b4a56`
- Focused harvest suite: `25/25` PASS
- Full AO suite: `74/74` suites, `396/396` tests PASS
- Acceptance: `7/7` PASS
- Operator smoke: PASS
- Package verification: PASS; raw artifacts excluded from npm package

## Coverage limitations

Thirty formal human review submissions remain `unknown` because the frozen
minimum role/verdict/head protocol was incomplete or absent. Nineteen
deterministically marked exact-head verdicts from PR conversation comments are
also retained as `unknown` evidence because GitHub provides no `commit_id` on
that source. Together, 33 protocol-marker records lack exact GitHub HEAD binding;
none was promoted into an exact-head round or primary blocker. GitHub login,
comment timing, merge outcome, later commits, CI outcome, and bot severity labels
were not used to fill those gaps.

This run used `Samsen879/ciecopilot-home` only as a GitHub GET-only historical
source. It did not enter or modify that repository, `.ao-control-plane`, the live
AO worktree/state, GitHub reviews/comments/labels/branches/settings, or any
historical record.
