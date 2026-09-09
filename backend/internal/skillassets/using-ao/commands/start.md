# ao start

The desktop entrypoint is removed from the ao-pilot headless runtime. `ao start`
always fails closed without performing discovery, network access, downloads, or
process creation. Use the `ao-pilot start` governed lifecycle instead.

## Syntax

```
ao start [flags]
```

## Examples

```bash
# Fails closed with desktop_entrypoint_disabled guidance
ao start
```
