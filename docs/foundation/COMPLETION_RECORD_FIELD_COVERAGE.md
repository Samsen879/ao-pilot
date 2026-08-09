# Completion Record field coverage ledger

Status: deterministic field audit for issue #14. This work derives a minimal
candidate set from the committed consolidation oracle and P0-A harvest. It does
not define a production schema, generate a Completion Record, or add state.

## Result

The machine-readable ledger is
[`completion-record-field-coverage.v1.json`](completion-record-field-coverage.v1.json).
It audits 40 candidates: 13 required, 23 conditional, and 4 unsupported. The
committed oracles establish 26 candidates and leave 10 explicitly
`not_established`. Each required or conditional candidate has one deterministic
source contract; each established candidate additionally maps to an exact JSON
pointer or Markdown marker in a digest-bound committed source.

Required means missing evidence fails closed. Conditional means the field is
present only when its declared evidence authority supplies it; otherwise its
value is `not_established` rather than false, zero, empty, or inferred.
Unsupported means the field is omitted.

## Oracle custody and replay

The ledger binds paths and SHA-256 digests for the structured consolidation
manifest, every phase report and the portability erratum in the human-readable consolidation oracle, the
P0-A snapshot manifest, normalized blocker inventory, review-round baseline,
result report, and replay receipt. Validation checks every path, digest, JSON
schema version, JSON pointer, and Markdown marker before accepting coverage.

Run the read-only double replay with:

```sh
npm run verify:completion-record-coverage
```

The replay report includes every candidate row, all source mappings, explicit
coverage gaps, explicit omissions, and a stable fingerprint. Identical inputs
must produce identical field-by-field output.

## Explicit gaps and omissions

The fixture does not authenticate child/record identity, issue identity,
parent relations, or TaskSpec/policy/grant/judgment/escalation references.
Required identity gaps fail closed; conditional gaps remain `not_established`.
P0-A merge observations retain the selected PR metadata request joined to its
digest-bound endpoint page, and review or branch context does not manufacture
task or issue identity.

`deviations[]`, `lesson_candidates[]`, `model_generated_narrative`, and
`narrative_summary` are unsupported and omitted. The consolidation Markdown is
a human comparison oracle, not permission to synthesize prose. Only
`important_decisions[]` is conditionally covered because the consolidation
manifest contains authenticated structured `canonical_decisions`; it may be
transcribed mechanically with its evidence mapping.

## Non-goals

This audit adds no Completion Record schema, generator, state collection,
narrative model call, classifier, migration, or runtime behavior.
