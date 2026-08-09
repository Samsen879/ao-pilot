# Changelog

All notable changes to `ao-pilot` are documented here.

The project follows semantic versioning while its public interfaces stabilize.

## Unreleased

### Changed

- lifecycle reports now emit the versioned `release_ready` AO judgment, which
  authorizes OR release preflight only and explicitly disclaims merge, external
  effect, and human approval;
- legacy `notify_human_ready` and `auto_merge_ready_pr` records retain their
  immutable historical meanings through observation/reporting adapters and
  produce deprecation findings without rewriting stored state.

## [0.2.0] - 2026-08-01

### Added

- independently installable `ao-pilot` CLI and portable configuration;
- controller and file-state structural splits;
- provider command-runner boundary;
- deterministic evaluation packs, configurable replay, and downstream runner API;
- bounded metrics reports, scorecard quality gates, and baseline scope checks;
- isolated npm tarball installation and evaluation verification;
- explicit public library exports for CLI, contracts, repository, engines,
  protocols, and providers;
- deterministic cross-repository consolidation parity replay and fingerprinted
  approved-difference registry;
- generic guarded auto-merge and blocked-notification provider mechanisms;
- durable, versioned OR authorization grants with exact effect scope, canonical
  policy fingerprints, replay/revocation checks, and exception-only escalation;
- Node 20 and 22 continuous integration and release artifact checks.

### Changed

- CLI version output now comes from package metadata;
- Jest development tooling upgraded to version 30;
- vulnerable `brace-expansion` transitive versions are overridden by 5.0.8;
- supported Node versions are Node 20 and Node 22 or newer, excluding unsupported
  odd-numbered Node 21.
- PR-scoped commands preserve the configured project id, and library CLI runners
  honor the caller-supplied working directory.
- generic action-effect `status` now uses the exact vocabulary `durable_only`,
  `attempted`, `succeeded`, and `failed`; an unconfirmed in-flight result is
  represented by `execution.outcome=effect_attempted`, not a fifth status.

### Security

- full development and runtime `npm audit` reports contain zero known
  vulnerabilities at release preparation time.
- irreversible merge effects require durable exact-head authorization,
  `--match-head-commit`, strict CheckRun/StatusContext evidence, current-head
  independent review, repository-scoped cwd, and post-effect confirmation.
- a merge command failure is treated as ambiguous after dispatch: AO accepts it
  only when the immediate live read confirms the exact reviewed head was merged;
  otherwise the attempted claim remains durable and automatic replay is blocked.
