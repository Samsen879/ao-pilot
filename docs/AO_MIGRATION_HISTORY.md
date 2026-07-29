# AO Migration History

## Independent product baseline

The public repository baseline removes documentation-contract tests that
depended on files from a downstream product repository. It adds deterministic
package scripts, a lockfile, public architecture and development documentation,
and continuous integration for clean-install verification.

Future generic improvements are migrated one capability at a time with tests
and compatibility notes. Large state-contract and evaluation-harness rewrites
are intentionally out of scope for this baseline.
