# Changelog

All notable changes to `ao-pilot` are documented here.

The project follows semantic versioning while its public interfaces stabilize.

## [0.2.0] - Unreleased

### Added

- independently installable `ao-pilot` CLI and portable configuration;
- controller and file-state structural splits;
- provider command-runner boundary;
- deterministic evaluation packs, configurable replay, and downstream runner API;
- bounded metrics reports, scorecard quality gates, and baseline scope checks;
- isolated npm tarball installation and evaluation verification;
- Node 20 and 22 continuous integration and release artifact checks.

### Changed

- CLI version output now comes from package metadata;
- Jest development tooling upgraded to version 30;
- vulnerable `brace-expansion` transitive versions are overridden by 5.0.8;
- supported Node versions are Node 20 and Node 22 or newer, excluding unsupported
  odd-numbered Node 21.

### Security

- full development and runtime `npm audit` reports contain zero known
  vulnerabilities at release preparation time.
