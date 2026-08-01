# AO P0-A Deterministic Replay Receipt

Source manifest:
`ao.github-review-snapshot-manifest.v1alpha1.json`

Two consecutive offline replays were run from the same immutable snapshot
manifest with GitHub access unused. Canonical bytes and SHA-256 digests matched:

| Artifact | Replay 1 SHA-256 | Replay 2 SHA-256 |
|---|---|---|
| Snapshot manifest | `250ce4452a5b80b9f81441e5aef0a81962c67e691877eb04e38ac4123caf827b` | `250ce4452a5b80b9f81441e5aef0a81962c67e691877eb04e38ac4123caf827b` |
| Block inventory | `e45368681bfc79f2a9a731d93382c931b3d347af53920580bbd454f9284dbffb` | `e45368681bfc79f2a9a731d93382c931b3d347af53920580bbd454f9284dbffb` |
| Review-round baseline | `d4aa201445b7304627a33b97ae2025f4ecaaa31c6ec58a53b2b7d0b2c61f9984` | `d4aa201445b7304627a33b97ae2025f4ecaaa31c6ec58a53b2b7d0b2c61f9984` |

Output-set digest for both runs:
`79f898386a76935eda02dafd0774a1a899080954ee19d05f94a15a78d430970d`.

Replay validation checked schema versions, all 371 PR source bundles, every
manifest page reference, continuous pagination, raw SHA-256, PR commit counts,
safe header names, and secret-like token patterns. The focused suite also proves
that deleting a referenced page fails closed before normalized output is
accepted.
