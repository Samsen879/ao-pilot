# AO Release

Releases are prepared from a clean, exact `main` checkout. Publishing to npm is
an explicit maintainer action and is not performed by CI.

## P0 Release Blocker

The `0.2.0` package checks do not establish operational runtime portability.
Until P0-R08 is merged and replayed on exact main, no fresh-machine or
self-hosting claim may be made and the original AO Upgrade chain remains
blocked. `verify:package` verifies only the tarball, public imports, package CLI,
and bundled evaluation. It does not bootstrap, verify, start, or stop the
external Agent Orchestrator runtime. See the
[incident baseline](runtime-portability/P0-R01_INCIDENT_BASELINE.md).

## Release Candidate Checks

```bash
npm ci
npm run release:check
npm pack --dry-run
```

The release check runs the full test suite, lifecycle acceptance suite,
operator smoke, isolated tarball installation, bundled evaluation pack, and
full dependency audit.

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
test. The future runtime-bootstrap, fresh-clone, and protected workstation gates
are separate P0 deliverables.

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
