# AO Configuration

`ao-pilot` reads `ao.config.json` from the current directory or the nearest
parent directory. Generate a portable starting configuration with:

```bash
ao-pilot init --project my-project
```

Use an explicit path when needed:

```bash
ao-pilot state --config ./config/ao.config.json --json
```

## Schema

```json
{
  "config_version": 1,
  "project_id": "my-project",
  "providers": {
    "agent_runtime": "agent-orchestrator-cli",
    "source_control": "github-cli"
  },
  "verification": {
    "commands": [
      "npm test"
    ]
  },
  "evaluation": {
    "fixture_root": null,
    "packs": [
      "all"
    ],
    "replay_count": 2
  }
}
```

The initial public release supports the local `agent-orchestrator-cli` runtime
provider and the `github-cli` source-control provider. Unsupported provider
names fail during configuration loading.

The provider name is a logical control-plane selection, not proof that an
external runtime is installed. The package-owned
[runtime lock](AO_RUNTIME.md) separately binds the public repository, upstream
package identity, version, annotated tag object, commit, tree integrity, build
contract, managed binary path, and compatibility range. `PATH` order and old
HOME checkouts are never runtime authority. P0-R05 still owns deterministic
installation and provenance materialization; the incident limitations remain
frozen in [P0-R01](runtime-portability/P0-R01_INCIDENT_BASELINE.md).

Command-line `--project` values override the configured project. PR-scoped
doctor, lifecycle, and reconciliation commands retain their explicit PR scope.

`evaluation.fixture_root` is resolved relative to the configuration file. Leave
it as `null` to use the public packs bundled with the installed package.
`evaluation.packs` selects the default pack set, and
`evaluation.replay_count` controls deterministic replay with a minimum of two
executions per scenario. Explicit eval CLI options override these values.
