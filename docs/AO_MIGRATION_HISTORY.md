# AO Migration History

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
incident record. Fresh-clone release gating and workstation self-hosting remain
unestablished until P0-R07 and P0-R08. The lifecycle start path invokes the
locked binary's `daemon` entrypoint directly and deliberately avoids upstream's
mutable desktop acquisition command named `ao start`.

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
