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

Command-line `--project` values override the configured project. PR-scoped
doctor, lifecycle, and reconciliation commands retain their explicit PR scope.

`evaluation.fixture_root` is resolved relative to the configuration file. Leave
it as `null` to use the public packs bundled with the installed package.
`evaluation.packs` selects the default pack set, and
`evaluation.replay_count` controls deterministic replay with a minimum of two
executions per scenario. Explicit eval CLI options override these values.
