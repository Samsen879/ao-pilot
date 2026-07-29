# AO Evaluation

AO evaluation is a deterministic, fixture-backed check of control-plane
behavior. It is not a benchmark of model intelligence and does not invoke an
AI provider.

## Run Built-in Packs

The npm package includes public AO scenarios:

```bash
ao-pilot eval --pack all
ao-pilot eval --pack policy-fail-closed --json
```

Every scenario runs at least twice. AO fingerprints a stable result vector with
SHA-256 and fails the replay check when any execution differs.

## Project-owned Packs

Configure a fixture root relative to `ao.config.json`:

```json
{
  "evaluation": {
    "fixture_root": "./eval",
    "packs": ["smoke"],
    "replay_count": 3
  }
}
```

The root contains `packs.json` and a `scenarios/` directory. Registries and
scenario documents use versioned formats and fail closed on malformed or
unknown definitions.

The library API accepts `runnerOverrides` as an object or `Map` from runner id
to async runner function. This keeps domain-specific scenario execution in the
downstream adapter instead of the public AO core.

## Metrics

Inspect all durable measurements:

```bash
ao-pilot metrics --json
```

Bound a report to an inclusive time window:

```bash
ao-pilot metrics \
  --since 2026-07-01T00:00:00Z \
  --until 2026-07-31T23:59:59Z \
  --json
```

Reports include measurement counts, record-level intervention and failure
rates, taxonomy counts, and recent traces.

## Scorecards and Baselines

Each eval run produces a scorecard with:

- verification, replay, and continuity outcomes;
- intervention and failure distributions;
- an explicit quality gate;
- an order-independent scope fingerprint;
- scenario-level evidence.

Save and compare a named baseline:

```bash
ao-pilot eval --save-baseline main
ao-pilot eval --baseline main
```

Comparison fails closed when project, pack, or scenario scope changes. A real
scope change should create a new named baseline rather than silently comparing
unlike suites.
