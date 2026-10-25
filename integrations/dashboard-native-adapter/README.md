# Native-session Dashboard adapter

This is the standalone HTTP/SSE/WebSocket compatibility proxy recovered from
the local service installation. It reads native daemon sessions while serving
the existing browser Dashboard and forwarding its direct-terminal WebSocket.
It has no npm dependencies. Use Node.js 22 or newer.

```sh
cd integrations/dashboard-native-adapter
npm test
AO_DASHBOARD_ADAPTER_CONFIG=./config.example.json npm start
```

The example uses only localhost and illustrative ports. Configure the actual
upstreams before use. No host or service-port defaults are supplied by the
program. All keys in `config.example.json` can instead be environment variables;
environment variables override JSON. `PROJECT_NAME` is optional (otherwise the
session project ID is shown); `ISSUE_BASE_URL` is optional (otherwise links are
null). `DIRECT_TERMINAL_BROWSER_PORT` defaults to the explicitly configured
terminal upstream port. `LISTEN_PORT=0` requests a fresh ephemeral test port.
Host settings accept DNS names and IPv4 literals. Upstream transport is HTTP;
`TERMINAL_ORIGIN` is an explicit HTTP(S) origin, without credentials. Keep site
configuration outside the repository; the proxy does not load production
configuration or start/restore sessions on its own.

## Provenance

- Original: the standalone `server.mjs` selected by the effective
  `ao-pilot-dashboard-adapter.service` ExecStart, verified with
  `systemctl --user cat` plus effective `show` and process command-line readback.
- Original SHA256:
  `f583b09d7a9898798ee44aa4b67d2284d49837fb4838116f03bb3063cb7fc7e1`.
- Original mtime: `2026-09-28T05:14:15.496435212Z`
  (epoch nanoseconds `1790572455496435212`).
- Local original-tool records show file creation on
  `2026-09-22T16:50:41.261Z` and the final same-origin WebSocket/HTML-shim
  patch on `2026-09-28T05:14:15.521Z`, matching the on-disk mtime.
  Git history contains no original adapter path/blob lineage. This was a local
  hotfix after #104/#105, not code imported from those PRs. The exact original
  Git commit is NOT_ESTABLISHED; no commit is invented from an installation name.
- Original directory contained only this file: no sibling modules,
  `package.json`, `node_modules`, or nonstandard dependencies; sole import was
  `node:http`. The recovered version also uses Node's fs/path/url modules for
  explicit configuration and direct execution.
- First-party local hotfix incorporated under this repository's MIT license;
  no additional third-party source was copied. `package.json` is new metadata,
  not an original build input. No install or build step is needed.

## Comparison with existing implementations

[#104](https://github.com/Samsen879/ao-pilot/pull/104) imported the full original
Next.js browser and its core/plugins. `scripts/ao-dashboard.js` launches that
browser and its terminal processes; the browser backend reads legacy metadata.
This adapter instead queries `/api/v1/sessions` and translates active native
records into the browser list/detail/SSE shape. Other HTTP traffic goes to the
existing Dashboard. Its HTML shim rewrites the browser's direct-terminal URL
to the adapter's same-origin `/ao-terminal-ws`, then forwards the upgrade to
the existing terminal server's `/ws`, preserving query and subprotocol headers.

[#105](https://github.com/Samsen879/ao-pilot/pull/105) repaired cold-start tmux
socket recovery. The separate `scripts/ao/lib/session-recovery.js` verifies
pinned transcript/workspace/runtime identity and can restore original sessions
under its recovery policy. This adapter neither imports nor replaces recovery;
it only projects daemon state and proxies the browser/terminal transport.

The inherited projection still presents active native sessions as `working`
and reports zero PR/review counts. Those are compatibility placeholders,
not source-of-truth workflow status. API writes remain rejected; terminal
WebSocket authorization/interactive access remains the upstream server's
responsibility. The proxy does not add an authentication layer.

## Changes from the original

- All listen/upstream hosts and ports now come from explicit environment/JSON.
  The hardcoded loopback host and private service-drop-in address are not
  production defaults. The HTML shim's fixed terminal port is configurable too.
- CIE project name and repository issue URL are optional configuration; no
  machine account, internal address, original service port, token or credential
  is copied into executable defaults. The original JS contained no token or
  credential literal; proxy environment values and YAML values stay private.
- Configuration errors name only a key; invalid JSON errors do not echo input,
  and startup logs do not print endpoint hosts or configuration paths.
- A server factory supports isolated tests; importing it opens no listener.
  WebSocket socket errors/close now tear down the paired proxy socket.
- A regression test found the old shim preserved a terminal port when the
  public page used the HTTPS default port. It now explicitly sets the page
  port, including an empty/default port, when rewriting to the same origin.

## Lane B2 and source boundary

Read against main `28b4fc767880b6529f38efa87d72a99f4e2007a9`,
[issue #125](https://github.com/Samsen879/ao-pilot/issues/125) and
`docs/design/2026-10-install-convergence.md` from merged #136.
B2 owns installer/manifest/systemd templates/doctor/root packaging. Its design
suggests `adapter/server.mjs`, with the source then missing. No active public
B2 PR/path claim was visible during intake; unpublished cloud edits cannot be
confirmed. Therefore this PR creates only `integrations/dashboard-native-adapter/`.
It changes no existing files, units, installer, root package metadata or runtime
lock. The redacted site records are inventory, not a competing unit generator.

B2 can consume this source in a later integration commit after reconciling its
file claims and release manifest. The root npm `files` allowlist currently
excludes `integrations`; this source-intake PR does not claim it is already
included in the root release tarball. `git archive` includes the new tracked
source. Package/release wiring belongs to B2.

## Read-only inventory and verification

[Inventory](inventory/README.md) lists the effective startup chains, every
loaded unit/drop-in/EnvironmentFile, referenced entrypoints, relative helper
imports and repository comparisons. [File manifest](inventory/files.json)
contains original file SHA256 and mtimes. [Site records](inventory/site-inputs.sanitized.json)
capture missing local unit/config structures without private values. They
are not installable templates. Historical shadowed ExecStart targets are
explicitly retained; generated binaries/build outputs are mapped to existing
source instead of being vendored.

| Check | Result |
| --- | --- |
| `node --check server.mjs`, `node --check config.mjs` | PASS |
| `npm test` on Node 22.22.1 | PASS: 8 tests |
| Real CLI process starts with explicit config and ephemeral loopback port | PASS |
| Mock daemon list/detail/filter/read-only API and failure behavior | PASS |
| Mock Dashboard HTML/shim and native SSE snapshot | PASS |
| Real WebSocket handshake, query/subprotocol/origin forwarding and bidirectional message | PASS |
| Production units/EnvironmentFile/entrypoints/CLI symlink and original adapter SHA/mtime unchanged | PASS: readback also preserves PID/start identity for all three services |
| Existing browser rebuild, full repository suite, real daemon/browser acceptance | NOT_RUN: isolated intake only |
| CI, root npm package/release-manifest inclusion, deployment/restart/cutover | NOT_RUN |

An initial test run was FAIL (7/8) for the inherited default-port shim bug;
the fix above passed 8/8. No production service command other than read-only
`cat`/`show` is used by this intake. The active services continue using their
original installation paths.
# Managed release authentication

Managed releases provide `TERMINAL_TOKEN_FILE` and the exact `TERMINAL_ORIGIN`
through their private adapter configuration. The capability must be a private
0600 regular file owned by the service user. Missing/invalid credentials reject
before WebSocket upgrade, and the original browser Origin is checked before
proxy rewriting. The direct terminal port enforces the same capability.

Programs use `Authorization: Bearer`. Browsers authenticate with HTTP Basic
(username `ao`, password equal to the private capability); the browser's
origin-scoped HTTP auth cache authenticates terminal upgrades. Capabilities
are never issued to unauthenticated requests, placed in cookies or URLs. Keep the
capability persistent across upgrades and cold boots; never publish its bytes.

Standalone unmanaged use retains its existing configuration behavior. This does
not certify an unmanaged deployment as authenticated. A managed release cannot
disable authentication by omitting its required token file.
