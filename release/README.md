# Schema compatibility inputs

A complete unified release requires a **tracked**, sanitized, empty SQLite
fixture and `release/compatibility.json` (or `--compatibility <tracked-path>`):

```json
{
  "schema_version": "ao.schema-compatibility-input.v1",
  "old_binary_sha256": "<independently selected exact old binary SHA256>",
  "fixture_database": "release/fixtures/empty-old-schema.db",
  "fixture_sha256": "<SHA256 of that tracked empty fixture>"
}
```

The placeholders above are documentation, not acceptable build inputs. This PR
does not certify an old artifact or supply production-derived database bytes.
The old binary is a separate explicit `--old-binary /absolute/path/to/ao` input;
its bytes must match the tracked descriptor. Never import a local installation
or accept a descriptor that merely says `passed`.

`verify-schema-compatibility.js` first requires zero projects, sessions and
worktrees, integrity `ok` and no foreign-key errors. It copies the fixture into
isolated private directories, executes the exact candidate and old artifacts,
queries empty sessions, proves owned process exit, checks migrated schema and
integrity, and binds all three input hashes to the generated result. Old-reader
failure records incompatibility; candidate failure or unknown exit blocks the
build. This empty-fixture harness is a promotion prerequisite, not production DB
migration or recovery acceptance. Recovery operations, realistic migrated data,
new→old→new and production-copy migration remain explicit local staging checks.

The generated `release/compatibility-result.json` is included in the manifest
and package. `previous_reader_compatible` never comes from a JSON `passed` label.
Missing descriptor, fixture, old artifact or platform digest rejects the build.
The release workflow remains blocked until these reviewable inputs are added.
