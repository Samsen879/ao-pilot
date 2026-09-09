# Headless runtime source

This directory contains the minimal Go runtime source used by `ao-pilot`.

- Upstream project: `Untrivial-ai/agent-orchestrator`
- Imported through: `Samsen879/agent-orchestrator`
- Upstream package version: `0.11.2`
- Imported commit: `aae8a684357271acc7ad2fa1d4116c7c65c8fa9d`
- Imported tree: `e8adb9a31068810becfb5d31b46688b04202cf81`
- License: Apache-2.0; see `LICENSE.upstream`

The imported source was reduced to production Go files required to build
`backend/cmd/ao`. Upstream test files, generator-only code, and all frontend,
Electron, AppImage, installer, and desktop packaging trees were excluded.

`backend/internal/cli/start.go` is an ao-pilot modification. The upstream
desktop resolver/downloader/launcher was replaced with a fail-closed command
that has no discovery, network, download, or process-launch behavior.
