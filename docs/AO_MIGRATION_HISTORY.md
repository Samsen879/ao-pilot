# AO Migration History

## Deterministic task graph queries

`inspectTaskGraph` validates the existing `task_relations` collection and
returns a stable `ao.task-graph-result.v1alpha1` projection. The result includes
canonical ordered traversal, direct dependency readiness, child terminality,
all-children terminality, structured blocking findings, and a SHA-256 result
fingerprint. Record ordering does not affect any result field.

Cycles, missing endpoints, malformed or unsupported relation records,
mixed-version edges, and missing or contradictory terminal evidence fail
closed. Terminal evidence is explicit; GitHub labels are not an accepted
source. `ao state` includes the full projection and fingerprint, while doctor
maps graph-health findings to control-plane blockers.

## Control-plane v12 task relations

Migration `0012_task_relations_v1alpha1` adds the durable `task_relations`
collection. Existing state is preserved byte-for-byte at the record level and
the new collection starts empty; relation-like task metadata is deliberately
not promoted. Every accepted edge is instead represented by the public
`ao.task-relation.v1alpha1` contract with a canonical identity derived from its
type and endpoints.

The allowed edge kinds are `parent_of` (source is the parent, target is the
child) and `depends_on` (source depends on target). Repository writes require
both endpoints to exist in `managed_tasks` and reject self edges, duplicate
creates, non-canonical identities, and cycles across the stored relation graph.
The repository exposes create/upsert, read, filtered list, and delete operations;
each mutation records a `task_relation` audit entry. Task metadata is never
read as graph authority.

Steady-state bootstrap validates the `migration-12` audit identity, version,
key, and applied timestamp, recreating only missing evidence and rejecting
contradictory evidence. Ordinary state writers and relation writers share the
full `state.json.lock` read-modify-write boundary. A durable mutation journal
recovers an interrupted state/audit pair before any snapshot is returned, so a
persisted relation cannot remain without its matching audit entry.

## P0 runtime portability correction

The independently installable package baseline did not establish operational
runtime portability. A later P0 incident found no deterministic external
runtime lock/bootstrap, no `ao-pilot start`, and an unverified PATH dependency
in `scripts/ao/start-clean.sh`. Package/source separation remains accepted, but
fresh-clone runtime recovery and self-hosting remain blocked until P0-R08. The
full frozen/live ledger is in
[P0-R01](runtime-portability/P0-R01_INCIDENT_BASELINE.md).

P0-R04 added the immutable runtime/provenance lock. P0-R05 adds the formal
`scripts/bootstrap.sh` entrypoint, an official Go archive lock, public exact-tag
source retrieval, atomic managed installation, interrupted-run recovery,
verified offline cache reuse, and clean reinstall. This advances bootstrap
portability but does not supersede the P0-R06 lifecycle, P0-R07 fresh-clone
gate, or P0-R08 self-hosting requirements.

P0-R06 adds runtime-aware doctor/auth inspection, exact managed
`start`/`stop`/`status`/`runtime-path` entrypoints, and routes AO
observation through the verified absolute binary. It supersedes the executable
PATH dependency in `scripts/ao/start-clean.sh` without rewriting the historical
incident record. The lifecycle start path invokes the
locked binary's `daemon` entrypoint directly and deliberately avoids upstream's
mutable desktop acquisition command named `ao start`.

P0-R07 adds distinct package, bootstrap, lifecycle, fresh-clone, and protected
self-hosting gates. The fresh-clone gate performs a credential-free exact-clone
install/bootstrap/doctor/daemon/worktree smoke in bounded isolated state and
uploads a machine-readable CI receipt. This establishes the release gate only;
workstation self-hosting remains unestablished until P0-R08 is executed by the
newly bootstrapped AO and its strict receipt passes the manual verifier.

## Independent product baseline

The public repository baseline removes documentation-contract tests that
depended on files from a downstream product repository. It adds deterministic
package scripts, a lockfile, public architecture and development documentation,
and continuous integration for clean-install verification.

Future generic improvements are migrated one capability at a time with tests
and compatibility notes. Large state-contract and evaluation-harness rewrites
are intentionally out of scope for this baseline.

## P2 evaluation productization

The evaluation framework now separates generic pack catalog validation,
deterministic replay, and built-in runner implementations. Installed packages
resolve their bundled public packs without depending on files in the consuming
repository, while downstream projects can configure their own fixture root and
register runners through the library API.

Metrics reports support bounded time windows and derived intervention/failure
rates. Scorecards include order-independent scope fingerprints and an explicit
quality gate. The file-based artifact and baseline model remains compatible.
