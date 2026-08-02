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
npm ci
npm run release:check
npm pack --dry-run
```

The release check runs the full test suite, lifecycle acceptance suite,
operator smoke, isolated tarball installation, bundled evaluation pack,
runtime-lock, bootstrap-contract, exact lifecycle-routing verification,
isolated fresh-clone runtime smoke, and full dependency audit.

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

On supported Linux x64/arm64 hosts with Git, curl, and tar:

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
