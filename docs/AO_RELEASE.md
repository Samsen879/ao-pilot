# AO Release

Releases are prepared from a clean, exact `main` checkout. Publishing to npm is
an explicit maintainer action and is not performed by CI.

## P0 Release Blocker

The `0.2.0` package checks do not establish operational runtime portability.
Until P0-R08 is merged and replayed on exact main, no fresh-machine or
self-hosting claim may be made and the original AO Upgrade chain remains
blocked. `verify:package` verifies only the tarball, public imports, package CLI,
bundled evaluation, and presence of the package-owned runtime lock.
`verify:runtime-lock` separately verifies the immutable identity, provenance,
build, binary-path, and compatibility contract. `verify:runtime-bootstrap`
validates the official toolchain lock and formal bootstrap entrypoint; an
explicit `./scripts/bootstrap.sh` performs the managed install. P0-R06 provides
verified doctor/start/stop/status/runtime-path entrypoints. P0-R07 adds the
empty-HOME `verify:fresh-clone` runtime smoke release gate. It does not satisfy
the protected P0-R08 AO-created Worker/GitHub delivery proof. See the
[incident baseline](runtime-portability/P0-R01_INCIDENT_BASELINE.md).

## Release Candidate Checks

```bash
# Use a clean checkout with complete history (fetch --unshallow if necessary).
export AO_PHASE_ZERO_EXPECTED_HEAD="$(git rev-parse HEAD)"
export AO_PHASE_ZERO_EXPECTED_TREE="$(git rev-parse HEAD^{tree})"
npm ci
npm run verify:release-prerequisites
npm run verify:source:native
npm run verify:source:browser
npm run release:check
npm pack --dry-run
```

The two current-source gates require Linux, Node 22+, Go 1.25.7, tmux,
and network access for Go/npm dependencies and Next font downloads. Native runs
CGO=0 build and uncached tests; browser installs its lockfile, builds core and
plugins, typechecks and tests all ten workspaces, then builds the web app.
Outputs go to unique directories under `AO_SOURCE_RECEIPT_DIR` (which must exist
outside the checkout) or the system temporary directory. Receipts bind the clean
commit/tree and source subtree to commands, exit codes, test counts and raw logs.
Failed, skipped, empty, timed-out and unexecuted suites cannot yield source PASS.
Go counts top-level tests and subtests separately; packages with no tests are
reported separately from skipped tests. Browser tests use a private HOME/config
and tmux socket; they do not attach to the workstation's AO tmux server.

CI runs native and browser as separate jobs. Release packaging depends on both;
self-hosting resolves default-branch HEAD once and reuses that immutable SHA/tree
for both source gates and receipt verification. Setup failures, cancellation or
missing artifacts are incomplete evidence, never PASS. Artifact upload uses
`always()`; raw runner logs remain available even when no receipt was produced.
These gates establish current Linux source behavior only: they do not prove
Windows ConPTY, race safety, the locked p0.4 artifact, or an installed-service
upgrade. Locked-runtime gates remain separate. `release:check` alone is not a
complete current-source verdict.

`release:check` first rejects missing/wrong expected identity, dirty or shallow
checkouts and unavailable historical baseline objects before expensive tests.
It then runs the root test suite, lifecycle acceptance suite,
operator smoke, isolated tarball installation, bundled evaluation pack,
runtime-lock, bootstrap-contract, exact lifecycle-routing verification,
isolated fresh-clone runtime smoke, the F01 trajectory-vocabulary source gate,
the deterministic false-success/unknown-outcome fixture audit, and the full
dependency audit. `npm run verify:false-success` replays the negative fixture
pack twice, requires stable fingerprints, and checks the committed 50-row
coverage report without writing to the worktree.

Confirm version consistency:

```bash
node -p "require('./package.json').version"
./bin/ao-pilot.js --version
```

## Package-only Second-machine Verification

On a fresh Node 20 or Node 22+ machine:

```bash
git clone https://github.com/Samsen879/ao-pilot.git
cd ao-pilot
npm ci
npm test
node ./bin/ao-pilot.js init --project release-smoke
node ./bin/ao-pilot.js eval --pack policy-fail-closed
```

This recipe is not a runtime bootstrap and is not a self-hosting acceptance
test. The runtime-bootstrap, fresh-clone, and protected workstation gates are
separate P0 deliverables.

## Runtime Bootstrap Gate

On supported Linux x64/arm64 hosts with Git, curl, tar, and gzip:

```bash
npm run verify:runtime-bootstrap
./scripts/bootstrap.sh --json
./scripts/bootstrap.sh --offline --json
./scripts/bootstrap.sh --offline --reinstall --json
```

The first install verifies the exact annotated Git tag object, commit, tree,
official Go archive SHA-256, final binary SHA-256, and compatibility contract.
The second proves idempotent reuse; the third performs an atomic clean rebuild
from verified caches. A PATH-shadowing `ao` makes the command fail closed and
is never used. P0-R06 lifecycle entrypoints may be inspected separately with
`node ./bin/ao-pilot.js runtime-path --json`; this bootstrap gate still does not
establish fresh-clone OR/Worker lifecycle or self-hosting.

`npm run verify:runtime-lifecycle` verifies that lifecycle and observation
routing use the exact resolved binary and that `start-clean.sh` contains no
direct PATH `ao` execution.

## Fresh-clone Runtime Gate

On a supported Linux target:

```bash
npm run verify:fresh-clone
```

The gate creates an exact detached clone and empty HOME, runs `npm ci`, proves
missing-runtime fail-closed behavior, installs the public pinned runtime,
recovers a bounded interrupted-bootstrap fixture, replays and reinstalls from
verified offline cache, rejects a hostile `node_modules/.bin/ao` without
executing it, verifies provenance with doctor, starts/statuses/stops the daemon,
and creates/removes a local Worker-worktree fixture. CI stores its JSON receipt
as `fresh-clone-runtime-receipt`.

This credential-free local-adapter gate cannot satisfy P0-R08. The latter is a
manual workflow that validates an AO-created new-workstation receipt:

```bash
# First complete the Release Candidate Checks source gates on this clean,
# full-history checkout, then bind the same candidate for receipt verification.
export AO_PHASE_ZERO_EXPECTED_HEAD="$(git rev-parse HEAD)"
export AO_PHASE_ZERO_EXPECTED_TREE="$(git rev-parse HEAD^{tree})"
npm run verify:self-hosting -- --receipt docs/runtime-portability/p0-r08-workstation-self-hosting-receipt.json
```

The command deliberately fails until a real new-workstation AO has created the
Worker, delivered and merged its PR, replayed exact main, and cleaned its state.

## Tag and GitHub Release

After the canonical consolidation PR is merged:

1. verify `main` is clean and matches the intended release commit;
2. create the annotated tag `v0.2.0` without moving any published tag;
3. push the tag;
4. confirm the `release-check` workflow succeeds;
5. attach the generated tarball artifact to the GitHub Release.

## npm Publication

Registry ownership and authentication must be verified separately immediately
before any future npm publication:

```bash
npm view ao-pilot
npm publish --provenance --access public
```

Do not publish without an authenticated npm maintainer account and explicit
release authorization. After publishing, verify the registry version and a
fresh registry install.
