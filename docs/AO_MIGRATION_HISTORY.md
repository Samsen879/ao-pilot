# AO Migration History

## P0 runtime portability correction

The independently installable package baseline did not establish operational
runtime portability. A later P0 incident found no deterministic external
runtime lock/bootstrap, no `ao-pilot start`, and an unverified PATH dependency
in `scripts/ao/start-clean.sh`. Package/source separation remains accepted, but
fresh-clone runtime recovery and self-hosting remain blocked until P0-R08. The
full frozen/live ledger is in
[P0-R01](runtime-portability/P0-R01_INCIDENT_BASELINE.md).

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
