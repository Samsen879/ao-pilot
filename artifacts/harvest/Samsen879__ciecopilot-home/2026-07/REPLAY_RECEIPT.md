# AO P0-A Deterministic Replay Receipt

Source manifest:
`ao.github-review-snapshot-manifest.v1alpha1.json`

Two consecutive offline replays were run from the same immutable snapshot
manifest with GitHub access unused. Canonical bytes and SHA-256 digests matched:

| Artifact | Replay 1 SHA-256 | Replay 2 SHA-256 |
|---|---|---|
| Snapshot manifest | `250ce4452a5b80b9f81441e5aef0a81962c67e691877eb04e38ac4123caf827b` | `250ce4452a5b80b9f81441e5aef0a81962c67e691877eb04e38ac4123caf827b` |
| Block inventory | `1e10e8d5455e20495172640b82845cafe3571e47c364bcbf52adc83d4f8b6277` | `1e10e8d5455e20495172640b82845cafe3571e47c364bcbf52adc83d4f8b6277` |
| Review-round baseline | `f2117d31269665ae90a72bda79996cdf3f49fa035e54b73b45669b3568aa98d1` | `f2117d31269665ae90a72bda79996cdf3f49fa035e54b73b45669b3568aa98d1` |

Output-set digest for both runs:
`59f90eda557f2e5bf8e12b7890b57901d51f6162a0ff2cda407bee50e23b4a56`.

Replay validation checked schema versions, all 371 PR source bundles, every
manifest page reference, continuous pagination, raw SHA-256, PR metadata/ref
relationships, PR commit counts, safe header names, and secret-like token
patterns. Replays to separate directories copied the referenced content-addressed
raw pages; after the original source directory was removed, the copied manifest
remained replayable with identical digests. The focused suite also proves that
deleting a referenced page fails closed before normalized output is accepted.
