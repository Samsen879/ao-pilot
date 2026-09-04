# Controller lease authority design and caller audit

Status: design/audit deliverable for issue #16 at governed base
`025bf55bfac0397da20a46671adcf1084aea802a` (tree
`adade1d2b31eef5aea0aad66aa4a9fbfde3fa2e6`). This change deliberately does
not implement the lease repair.

## Finding

`controller-leases.json` is the intended isolated store and has its own lock,
but it is not the sole recovery authority today. `readSnapshot()` reads
`state.json`, reads the isolated file, and overlays the isolated array onto
`snapshot.state.controller_leases`. If the isolated file is missing or its
valid JSON top level is not an array, the overlay receives `null` and
`sortRepositoryStateCollections()` retains the `state.json` array. Bootstrap
also creates and migrates that shadow while it does not create the isolated
file. A stale shadow can therefore be revived after file loss, partial restore,
or a mixed-version migration. Ordinary collection writes, runtime-preflight
writes, and repo-knowledge writes clone this projected snapshot and persist it
through `persistState()`, continuously refreshing the second persistent copy.
If either schema or `state.json` is absent, `readSnapshot()` returns a virtual
empty state without even reading an extant isolated file.

An existing empty isolated array also overlays a nonempty shadow with empty;
it is distinct from a missing file. Malformed JSON throws during parsing and invalid records in an isolated array
throw during contract normalization. Those failures are not shadow fallbacks.
The committed characterization pack freezes all four distinctions.

## Exhaustive caller inventory

The machine-readable inventory is
[`controller-lease-authority-sites.v2.json`](controller-lease-authority-sites.v2.json).
Its verifier scans every JavaScript file under `scripts/ao/lib` for the file
path, state property, atomic API, and upsert API selectors. It also requires a
unique normalized semantic binding set for every authority site below. The
complete authority design, admission/migration provenance, stable site
identities, roles, bindings, scan boundary, selector patterns, and all
selector-usage semantics are pinned in one semantic manifest. Every selector
occurrence must be covered exactly once by a registered whitespace/comment-
normalized semantic usage. Normalization retains whitespace inside string and
template literal text while normalizing formatting inside `${...}` expressions,
and retains every ECMAScript line terminator after restricted productions such
as `return`, so automatic-semicolon-insertion changes remain visible. Protected
controller, repository read/write/mutation, shadow-stripper, synchronous
upsert, and migration transition operations are also pinned as complete
normalized semantic regions rather than selector-local prefixes. The scan
also matches every `persistState`
definition and call, closing the generic shadow-writer path, and includes the
production phase-zero evidence module rather than treating it as exempt.

Issue #94 migrated the accepted v1 inventory to this v2 representation. The
v1 digest included file paths, line numbers, and trimmed source lines for all
61 selector matches. That detected drift, but it also forced evidence rebinding
after unrelated line movement. V2 separates the evidence layers:

- stable authority evidence contains site IDs, roles, whitespace-normalized
  authority bindings, plus stable IDs and counts for the 63 registered semantic
  selector usages;
- file paths and line numbers are emitted only as failure diagnostics;
- inventory version, accepted v1 migration evidence, governed base, and #94
  admission provenance are frozen as canonical evidence; site path and symbol
  hints remain diagnostic-only so whole-site relocation stays stable;
- the semantic manifest digest is frozen in the verifier, so a legitimate
  authority change requires an explicit manifest and verifier update;
- missing or duplicated bindings identify the exact stable binding ID, while
  added or removed unregistered paths identify the selector and observed
  locations.

This keeps formatting, unrelated edits, and source relocation out of the
normalized evidence without weakening exhaustive coverage. Stable explicit
site and semantic-usage IDs plus normalized bindings were selected over a
path/line manifest, which preserves the original brittleness; over selector
counts alone, which cannot detect a bypassed check that retains the same
tokens; and over AST/symbol extraction, which would add a general
static-analysis dependency for a bounded invariant.

| Boundary | Reads | Writes | Fallback/projection consequence |
| --- | --- | --- | --- |
| `state-contracts.createEmptyControlPlaneState` | no | seeds `state.json.controller_leases` | creates the shadow shape |
| `state-migrations.buildBootstrapState` and `bootstrapControlPlaneState` | copies an existing shadow | writes it to `state.json` | preserves shadow through every migration; creates no isolated file |
| `state-migrations.resolveControlPlanePaths` | no | no | names `controller-leases.json` |
| `collections.STATE_REPOSITORY_COLLECTIONS` | state collection metadata | no generic upsert | marks leases isolated, but keeps them in the shared state vocabulary |
| `collections.sortRepositoryStateCollections` | reads state collection; accepts isolated array | writes only the returned in-memory projection | `null` means retain the shadow; an array means overlay |
| `state-repository.readControllerLeaseRecords` | reads and validates isolated JSON array | no | missing/non-array returns `null`; parse/record errors throw |
| `state-repository.readSnapshot` | reads schema, `state.json`, isolated file | no | publishes the compatible `snapshot.state.controller_leases` projection |
| `state-repository.persistControllerLeases` | no | atomically replaces isolated file and appends audit | intended canonical writer |
| `state-repository.persistState` and its generic collection/preflight/knowledge callers | reads the in-memory projected snapshot | writes that projection back to `state.json` | refreshes a persistent shadow during unrelated state changes |
| `state-repository.mutateControllerLeasesAtomically` | starts from projected snapshot under isolated lock | persists the resulting isolated array | current missing/non-array fallback can become mutation input |
| `state-repository.upsertControllerLease` | starts from projected snapshot under isolated lock | persists the resulting isolated array | same fallback exposure on synchronous writes |
| controller acquire/renew/release | finds active/by-id leases via atomic mutation | expires, activates, heartbeats, or releases through callback | all leadership transitions depend on repository authority selection |
| `state-runner.buildControllerRuntimeSummary` | projection | no | controller health, active/latest lease, and timestamps |
| `state-runner.loadAoStateReport` | projection and active count | returns raw projection in report | CLI/JSON compatibility surface; feeds debt report |
| `debt-report.buildHistoricalDebtReport` | projection | no | emits expired controller lease cleanup candidates |
| `state-report.formatAoStateReport` | derived active count | no | text-only downstream consumer |

No other production JavaScript occurrence is present at the governed base.
Tests are consumers, not runtime authorities; the new fixtures isolate the
authority-selection behavior, while existing repository/controller-loop tests
cover lock serialization and lease lifecycle operations.

The v2 audit binds 11 normalized semantic regions covering canonical envelope
validation, collection isolation, migration/bootstrap installation, repository
reads and writes, and controller acquire/renew/release operations. Normalization
removes formatting trivia while retaining JavaScript token boundaries,
restricted-production line terminators, and template-literal contents. Full
source discovery uses parser-provided lexical tokens and comment ranges, so
documentation-only mentions do not create evidence churn and regex/division
ambiguity cannot hide or invent executable occurrences. Comment masking retains
the parser's UTF-16 offsets even when astral characters precede a range. Explicit
operation boundaries keep unrelated declarations outside the protected semantic
regions.

## Frozen canonical-authority design

The repair issue must preserve the public read shape while eliminating the
second persistent authority:

1. `controller-leases.json` is the only persistent controller lease authority.
   Its validated, versioned contents are read under the existing isolated lock
   whenever authority selection and mutation must be atomic.
2. `snapshot.state.controller_leases` remains a compatible, ephemeral
   projection populated exclusively from that canonical read. It may be
   sorted/cloned for callers, but it is never persisted into `state.json` and
   never consulted to reconstruct the canonical file.
3. Generic `state.json` writes must strip or overwrite the shadow with no
   recoverable lease data. The preferred post-migration representation is
   omission; a temporary empty-array compatibility field is acceptable only
   if every writer guarantees it is empty and every reader ignores it as
   evidence.
4. Missing authority is not equivalent to an empty authority. A proven fresh
   bootstrap may initialize an empty canonical envelope. Otherwise missing,
   malformed, unsupported-version, or integrity-failed authority blocks
   leadership and requires explicit recovery evidence.
5. Migration consumes a legacy shadow at most once under an explicit schema
   transition, with provenance and an audit receipt. Normal startup/recovery
   must never contain a shadow fallback.

This retains compatibility for `state-runner`, debt reporting, controller
leadership helpers, and external JSON consumers without creating another
persistent source of truth.

## Why the shadow cannot be recovery authority

The shadow has no independent lock, generation, canonical version, or write
ordering with the isolated file. An ordinary stale `state.json` write can land
after a lease heartbeat; backups can restore the two files from different
points; and current migration copies the shadow without proving whether it
predates the isolated file. Consequently no deterministic comparison can
establish that a shadow lease is current. Timestamps inside the lease are
self-described payload, not evidence that the containing file won the last
serialized write. Selecting by timestamp, non-emptiness, or apparent schema
version can resurrect an expired/superseded leader and create split brain.

The missing and non-array fixtures demonstrate that the current code does
exactly this unsafe fallback. That behavior is characterized, not endorsed.
The missing-state fixture also proves an extant canonical file is hidden by the
virtual snapshot branch, and the ordinary-write test proves a later canonical
update can be lost from the shadow before file loss revives the older view.
Because the evidence lacks a safe ordering relation, the only deterministic
recovery rule is: use a validated canonical file, execute a separately
authorized one-time migration with provenance, or fail closed. `state.json`
MUST NOT be automatic recovery authority.

## Migration and recovery threat model

| Scenario | Risk | Required future disposition |
| --- | --- | --- |
| Fresh install, neither file exists | confusing absence with data loss | initialize empty canonical state only with fresh-bootstrap provenance |
| Canonical missing, shadow present | stale leader resurrection/split brain | fail closed; never copy during ordinary recovery |
| Canonical JSON malformed or top level wrong | silent fallback masks corruption | fail closed and preserve bytes for operator diagnosis |
| Canonical record invalid | partially trusted leadership set | reject the entire authority; no per-record salvage during startup |
| Canonical version older but supported | ambiguous interpretation | migrate canonical file atomically under lock and audit it |
| Canonical version newer/unsupported | downgrade data loss | fail closed; require compatible software |
| Canonical and shadow disagree | freshness heuristic chooses stale data | canonical wins; shadow is ignored and removed/emptied by migration |
| Crash during migration | half-written authority or repeated import | atomic rename plus durable migration marker/provenance; replay idempotently |
| Backup restores files from different times | cross-file time skew | canonical alone determines leases; shadow carries no evidence |
| Concurrent heartbeat and ordinary state write | lost renewal through shadow overwrite | ordinary state writer never writes lease data |
| Replay after completed migration | duplicate import | marker prevents re-import; projection is regenerated from canonical only |
| Rollback to pre-repair binary | old binary revives retained shadow | erase/empty shadow before declaring migration complete; gate rollback compatibility |

Migration receipts should bind source digest, destination digest, schema
versions, project id, timestamp, and migration id. They are audit evidence, not
a second authority. Manual salvage is outside unattended recovery and requires
the existing human authority gate.

## Principal PR boundary and rollback plan

This principal PR contains only the audit document, machine-readable caller
inventory, deterministic verifier, and current-behavior fixtures/tests. It does
not modify repository, migration, controller-loop, task ownership lease, or
storage behavior; it adds no SQLite dependency. Issue #17 is not started.

The later repair should be a separate principal PR limited to canonical file
versioning/initialization, one-time migration, nonpersistent projection, and
the callers enumerated here. It must not combine task ownership lease changes
or unrelated state refactors.

Rollback of this audit PR is a normal revert because it changes no runtime
state. Rollback of the later data repair must be forward-recovery, not blind
code downgrade: stop controllers, retain/copy the canonical file and migration
receipt, verify no active mutation, restore a compatible reader, and only then
resume. Never repopulate `state.json` from canonical data to make an old binary
work; that recreates the prohibited authority. If compatible code cannot be
restored, remain failed closed and escalate rather than synthesize a shadow.

## Verification contract

- `npm run verify:controller-lease-audit` is the canonical generation and
  verification path. It emits deterministic normalized v2 evidence while
  excluding diagnostic locations from its authority digest.
- `tests/ao/controller-lease-authority-audit.test.js` covers deterministic
  inventory success/failure; formatting and relocation stability;
  missing/extra/duplicate/mutated/bypassed authority negatives; exact semantic
  usage coverage (including phase-zero evidence); frozen provenance; v1
  migration; deterministic replay; and success, invalid-record failure, missing,
  syntactically/semantically malformed, mixed-version, and projection replay
  behavior.
- Existing targeted repository, migration, controller-loop, state-runner, and
  collection tests remain the regression boundary.
- Full `npm test` and package verification must remain green.
