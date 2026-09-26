package main

import (
	"fmt"
	"os"

	"github.com/aoagents/agent-orchestrator/backend/internal/cli"
)

// Ownership handles retained by daemon/import deliberately live until this
// process exits. Do not add an unlock defer or reuse this entrypoint in a host.
func main() {
	if err := cli.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(cli.ExitCode(err))
	}
}
