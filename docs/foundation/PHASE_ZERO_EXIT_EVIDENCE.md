# Phase 0 integrated exit evidence

Status: accepted for a no-merge Foundation #23 handoff. This freeze integrates
Foundation F01–F11 evidence; it does not merge #23, close the issue, change
lane #8, or admit a successor.

## Evidence authority

[`phase-zero-exit-manifest.v1.json`](phase-zero-exit-manifest.v1.json) is the
machine-readable evidence manifest. Each F01–F11 row binds the issue, principal
PR, governed head, merge commit and tree, exact post-merge CI run with its three
required jobs, two connector review rounds, and terminal closeout. The chain is
continuous from the admitted predecessor of F01 through accepted `main`
`b2bd4a68ad84758eb5c7c7bb19932d897f6605a8`, tree
`ea50c914949c44a8832c538eae412e0caba01121`.

F11 intentionally has two delivery entries. PR #86 and invalid closeout
5232632993 remain immutable audit history. The later scope-drift finding,
revocation, corrective PR #87, corrected closeout 5232936158, corrected lane
transition 5232956289, and re-admission 5232956646 are the authoritative
terminal chain. The discarded uncommitted #23 draft from the aborted worker did
not reach Git and is not classified as repository contamination.

## Frozen integrated reports

- [`trajectory-truthfulness-report.v1.json`](trajectory-truthfulness-report.v1.json)
  freezes the vocabulary/false-success result and Completion Record v1alpha1
  schema plus 40-field coverage. The 15 negative producers remain deliberately
  blocked; there are zero unresolved paths that can promote them to success.
- [`controller-lease-single-authority-report.v1.json`](controller-lease-single-authority-report.v1.json)
  accepts `controller-leases.json` as the sole persistent authority and the
  snapshot lease collection as a nonpersistent projection. Missing or invalid
  canonical evidence never revives a shadow.
- [`judgment-or-effect-contract-freeze.v1.json`](judgment-or-effect-contract-freeze.v1.json)
  versions the accepted boundary: AO judges, OR performs an exact-scope effect,
  and GitHub supplies external outcome authority. No earlier stage proves a
  later one.
- [`phase-zero-remaining-risk-register.v1.json`](phase-zero-remaining-risk-register.v1.json)
  records accepted operational and availability risks plus the complete #22
  invalid-closeout/revocation/corrective history.

## Deterministic replay

The fixture pack covers success, failure, missing evidence, and replay. The
verifier checks closed top-level contracts, every immutable F01–F11 link,
artifact SHA-256 custody, accepted authority boundaries, truthful residual
risk, and excluded scope. It executes the fixtures twice and compares the
committed [`phase-zero-exit-replay-receipt.v1.json`](phase-zero-exit-replay-receipt.v1.json).

```sh
npm run verify:phase-zero-exit
node scripts/verify-phase-zero-exit-evidence.js \
  --expected-head <reviewed-head-sha> --expected-tree <reviewed-tree-sha>
```

The first command binds its output to the live Git HEAD/tree. The second also
fails unless that live identity equals the independently supplied reviewed
candidate. A committed manifest cannot contain its own commit hash without a
self-reference cycle, so immutable head authority comes from the exact-head
CI/review/provider handoff; the repository freezes the semantic receipt and
explicitly claims no merge.

Any missing evidence, digest drift, chain contradiction, false-success
promotion, persistent lease shadow, AO merge claim, narrowed Completion Record
coverage, or excluded-scope admission fails closed.

## Non-goals

This freeze adds no Episode Record storage, Multi-Workstream implementation,
Knowledge Track promotion, provider effect, controller execution, credential,
or destructive recovery behavior.
