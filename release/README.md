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


## Checked-in release input (2026-10-24)

`compatibility.json` selects the exact currently deployed
`0.11.2-local.20261023` artifact as the primary old reader. Its SHA256 is
`45705237dcda7a8916b8291364869c181a1d9d70f7cd636932c301242268909a`.
The binary is a separate private `--old-binary` input; no installed binary,
production database, private log or session identity is committed here.

`fixtures/empty-schema43.db` is generated from a new empty database using the
migrations at source commit `47062799b4840463521ab45afa90920e63f324f4`.
It contains no production-derived pages. All non-migration tables are empty;
`projects`, `sessions` and `session_worktrees` each have zero rows. The schema
version is 43, integrity is `ok`, and foreign-key checking returns no rows.
Its SHA256 is `03ba28d7eeadb52cd2293fb1fe3fadd6514ed49b54dda6f917bead8b43d30f84`.
Only the SQLite database is tracked, never WAL/SHM files.

To generate it, use Go 1.25.7 with CGO disabled and the backend module's pinned
Go dependencies. In a fresh copy of that exact source, run a temporary Go
program from `runtime/headless/backend` that:

1. Opens a previously nonexistent SQLite file using `database/sql` and the
   backend's `modernc.org/sqlite` driver.
2. Calls `goose.SetBaseFS(os.DirFS("internal/storage/sqlite"))`,
   `goose.SetDialect("sqlite3")`, then `goose.UpTo(db, "migrations", 43)`.
3. Closes the Go database. With SQLite 3.45.1, opens that file, executes
   `UPDATE goose_db_version SET tstamp='2000-01-01 00:00:00'`, and commits.
4. Executes `PRAGMA journal_mode=DELETE`, then `VACUUM`, and closes the file.
5. Checks the schema, all table counts, integrity and foreign keys before
   comparing SHA256 with the descriptor. Two fresh independent generations
   using these same steps produced identical bytes.

Do not sanitize a production database to produce this public fixture. Use
SQLite's backup API when making private migration-test copies so committed WAL
content is included; copying only the main database file is insufficient.

### Observed reader behavior and limits

The exact-main CGO=0 storage harness migrated a consistent private schema-43
copy to schema 44 without starting any sessions. Counts, session identity
hashes and integrity were preserved. On separate consistent schema-44 copies,
the following artifacts started, answered session queries, and exited cleanly:

| Old artifact | Exact SHA256 | Observed read | Schema/count/identity/integrity |
| --- | --- | --- | --- |
| 0.11.2-local.20261023 | 45705237dcda7a8916b8291364869c181a1d9d70f7cd636932c301242268909a | PASS | PASS |
| locked 0.11.2-p0.4 | 45d257d19810cb606917ce734ec281c16617b0ec0088591e3cea909c27868919 | PASS | PASS |

The old-reader probes used private filesystem, network and PID namespaces,
without production worktrees, credentials, sockets or service access. tmux and
systemctl execution were denied. No cloned production session was restored.
These are observed reads, not certification of restoration or all writes.
Untested artifacts and failed or unknown probes are incompatible for rollback;
there is no compatibility claim for any other binary. Operational rollback
remains **previous + pre-migration backup** until its complete behavior is
verified. The loss window is backup completion through writer stop at rollback;
external effects are not undone, and worktrees are not overwritten by DB restore.

### Original verifier blocker and corrected boot contract

The initial L1 empty-fixture verifier returned
`compatibility_candidate_failed`: after the candidate daemon starts, schema is
44 and session/worktree counts remain zero, but it creates one default scratch
project. The verifier required the post-start project count to remain zero.
The old phase of that attempt was therefore NOT_RUN, and no generated
`previous_reader_compatible` result or complete release PASS was claimed for
that attempt.
The input-only PR did not change that verifier, the daemon,
the installer, the runtime lock or any production service. Source review and
merge of these inputs do not establish L1 staging or production acceptance.

The separate verifier correction retains the empty input requirement. After
candidate boot it accepts either no projects, or exactly the built-in `scratch`
row: scratch kind, default name, no origin/archive, the exact private candidate
DataDir's `scratch/default` path, a registration time within the owned probe
(with one second of timestamp tolerance),
and only the default role configuration. The probe explicitly pins the agent
to `claude-code`; hooks, tracker intake and additional config are rejected.
All project columns are inspected, not just the count or display name.

The old reader must preserve the complete validated project snapshot, including
the original candidate path, timestamp and raw config. Deletion, reseeding,
relocation, any metadata mutation or extra project makes it incompatible.
Schema/version, integrity, foreign keys, zero sessions/worktrees, exact input
hashes and owned-process exit checks remain mandatory. The input database is
never pre-seeded or modified. An older artifact that does not seed is still
supported, but it may not add a project when reading the candidate's copy.

Real empty-fixture replay with the unchanged native development binary and the
two exact old artifacts above passed migration 43→44 and old-reader checks.
This corrects the schema harness contract; complete release construction,
staging, recovery/write behavior and production acceptance retain their
separate gates and historical FAIL/NOT_RUN qualifications.
