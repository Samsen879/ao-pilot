// Modified by the ao-pilot project in 2026 to remove all desktop
// acquisition, installation, discovery, and launch behavior.
package cli

import (
	"errors"

	"github.com/spf13/cobra"
)

var errDesktopEntrypointDisabled = errors.New(
	"desktop entrypoint disabled: use ao-pilot's governed headless lifecycle",
)

// newStartCommand deliberately retains the upstream command name so ambient
// invocations fail closed. It performs no filesystem discovery, network
// request, download, process creation, or desktop launch.
func newStartCommand(_ *commandContext) *cobra.Command {
	return &cobra.Command{
		Use:   "start",
		Short: "Reject the removed desktop entrypoint",
		Args:  noArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return errDesktopEntrypointDisabled
		},
	}
}
