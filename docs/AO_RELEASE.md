# AO Release

Releases are prepared from a clean, exact `main` checkout. Publishing to npm is
an explicit maintainer action and is not performed by CI.

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

## Second-machine Verification

On a fresh Node 20 or Node 22+ machine:

```bash
git clone https://github.com/Samsen879/ao-pilot.git
cd ao-pilot
npm ci
npm test
node ./bin/ao-pilot.js init --project release-smoke
node ./bin/ao-pilot.js eval --pack policy-fail-closed
```

## Tag and GitHub Release

After the release-hardening PR is merged:

1. replace `Unreleased` in `CHANGELOG.md` with the release date;
2. verify `main` is clean and matches the intended release commit;
3. create the annotated tag `v0.2.0`;
4. push the tag;
5. confirm the `release-check` workflow succeeds;
6. attach the generated tarball artifact to the GitHub Release.

## npm Publication

The package name `ao-pilot` was unclaimed during release preparation, but that
can change. Recheck immediately before publishing:

```bash
npm view ao-pilot
npm publish --provenance --access public
```

Do not publish without an authenticated npm maintainer account and explicit
release authorization. After publishing, verify the registry version and a
fresh registry install.
