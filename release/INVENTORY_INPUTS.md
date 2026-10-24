# Registered release inventory inputs

The first complete local inventory diagnosis at source commit
`3915b0983cab5c9c4e6a1f521d0050ff879b7827` found exactly four violations.
All four were regular files with link count 2, in two complete internal pairs.
The result remained FAIL with `unsupported_release_file`; no pack occurred.
No unsupported special file or unsafe symlink was observed in that inventory.

| Complete violating release-relative path | Locked version | Classification and treatment |
| --- | --- | --- |
| `browser/node_modules/@esbuild/linux-x64/bin/esbuild` | 0.27.7 | Platform binary in the retained browser dependency tree; register as a regular file, preserve bytes/mode, remove inode sharing with its alias. |
| `browser/node_modules/esbuild/bin/esbuild` | 0.27.7 | Install-time alias of the preceding binary; replace only this exact alias with an independent regular file containing the same bytes/mode. |
| `browser/packages/web/node_modules/@esbuild/linux-x64/bin/esbuild` | 0.21.5 | Platform binary in the retained web workspace dependency tree; register as a regular file, preserve bytes/mode, remove inode sharing with its alias. |
| `browser/packages/web/node_modules/esbuild/bin/esbuild` | 0.21.5 | Install-time alias of the preceding workspace binary; replace only this exact alias with an independent regular file containing the same bytes/mode. |

Both esbuild source tarballs were checked against the SHA512 integrity in
`browser/package-lock.json`. Their `install.js:maybeOptimizePackage` creates
these aliases with `linkSync` and `renameSync`. The builder intentionally
installs and binds the complete locked dependency trees, including build tools;
this correction preserves that input contract rather than partially pruning
packages and leaving dangling launchers or incomplete dependencies.

`scripts/ao/lib/release-inputs.js` declares the exact two pairs for Linux x64
and the exact corresponding paths for Linux arm64. There are no wildcard path
rules or caller-supplied registrations. The real observed list above is x64;
arm64 materialization is covered by filesystem tests, and a real arm64 build
remains NOT_RUN.

Before any change, the materializer requires regular executable files, no
symlink path components, a shared inode and exactly two links accounted for by
the registered pair. A third/external link, missing peer, mixed group or wrong
type fails. If all pairs are absent after dependency deduplication it does
nothing; already-independent files, including esbuild's JS fallback launcher,
remain normal inventory inputs.

The alias is written through an exclusive owned temporary file and atomically
renamed. Both final paths must then be regular single-link files with unchanged
bytes, size and mode. `release/materialized-inputs.json` records those relative
paths and hashes; the normal manifest inventory and envelope bind this proof.
No production or already-installed release is modified.

**The inventory check still requires `nlink === 1`.** There is no hardlink
allowlist in the verifier. Unknown shared inodes and all unsafe types remain
failures. Registration converts only these proven private internal aliases to
the required representation before inventory; it does not accept shared inodes
in the published payload or relax containment, digest or package checks.

## Complete private diagnostics

`build-release.js --diagnostics <private-json>` persists every inventory
violation before the failed temporary build is removed. The file is mode 0600
and contains release-relative paths, reasons, types/link counts and opaque link
group IDs. It is private diagnostic data, not an install public receipt. Normal
CLI output still reports the fixed first error code and does not print paths.
The collector does not read FIFOs/devices or follow rejected symlinks, does not
return a partial accepted inventory, and preserves the original first failure.
