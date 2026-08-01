# AO Independent-review Harvest

`ao:harvest:reviews` captures a repository-parameterized, immutable GitHub REST
snapshot and deterministically rebuilds the P0-A blocker inventory and review
round baseline. It only issues `GET` requests through the GitHub CLI provider.
It does not read `.ao-control-plane`, infer parent chains, call a model, or
mutate GitHub state.

## Network harvest

```sh
npm run ao:harvest:reviews -- network \
  --repository OWNER/REPOSITORY \
  --merged-at-start 2026-07-01T00:00:00Z \
  --merged-at-end-exclusive 2026-08-01T00:00:00Z \
  --expected-pr-count 371 \
  --concurrency 2 \
  --output artifacts/harvest/OWNER__REPOSITORY/2026-07
```

Search is used only to create the candidate manifest. Every candidate is then
filtered by its actual pull-request `merged_at`. A mismatch with
`--expected-pr-count` writes `scope/COUNT_MISMATCH.json` and stops before formal
normalization. Successful pages are content-addressed and never overwritten;
`scope/checkpoint.json` makes a repeat invocation resume safely.

The default reserve thresholds are Core 1500, GraphQL 1500, and Search 10.
Concurrency is bounded to two. Primary and secondary limits honor reset or
`Retry-After` evidence and use bounded exponential backoff when a header does not
provide a delay.

## Offline replay

```sh
npm run ao:harvest:reviews -- replay \
  --manifest artifacts/harvest/OWNER__REPOSITORY/2026-07/ao.github-review-snapshot-manifest.v1alpha1.json \
  --output /tmp/ao-review-replay-1
```

Replay verifies every page reference, page sequence, raw SHA-256, redacted
header set, and required per-PR endpoint before generating any normalized
artifact. Missing or changed input fails closed. The snapshot timestamps are
reused; replay does not create new output timestamps.

## Deterministic classification boundary

Independent reviewer role and verdict require the versioned body protocol,
`BLOCKED` or `PASS`, the `independent exact-head` marker, a declared 40-character
reviewed HEAD, and an equal GitHub `commit_id`. A mismatch is `unknown`.
Connector-bot P1/P2 inline comments are retained as
`automated_inline_suggestion` evidence and excluded from primary blocker counts.
No semantic NLP or model classifier is used.

`first_detectable_stage` is only advanced when the finding text contains an
explicit stage marker covered by a versioned rule. Otherwise it is
`not_established`.

## Package boundary

Repository-specific output belongs under top-level `artifacts/`. The package
`files` allowlist does not include that directory, so raw harvest bytes are not
published in the npm tarball.
