package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/ownership"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

const defaultStopTimeout = 10 * time.Second

type stopOptions struct {
	timeout time.Duration
	json    bool
}

func newStopCommand(ctx *commandContext) *cobra.Command {
	opts := stopOptions{timeout: defaultStopTimeout}
	cmd := &cobra.Command{
		Use:   "stop",
		Short: "Stop the AO daemon",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := ctx.stopDaemon(cmd.Context(), opts)
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSON(cmd.OutOrStdout(), st)
			}
			if st.State == stateStopped {
				_, err = fmt.Fprintln(cmd.OutOrStdout(), "AO daemon stopped")
				return err
			}
			return writeStatus(cmd, st)
		},
	}
	cmd.Flags().DurationVar(&opts.timeout, "timeout", defaultStopTimeout, "How long to wait for daemon shutdown")
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output stop result as JSON")
	return cmd
}

func (c *commandContext) stopDaemon(ctx context.Context, opts stopOptions) (daemonStatus, error) {
	cfg, err := config.Load()
	if err != nil {
		return daemonStatus{}, err
	}
	st, err := c.inspectDaemon(ctx)
	if err != nil {
		return daemonStatus{}, err
	}
	switch st.State {
	case stateStopped, stateStale:
		// Missing discovery can mean startup or draining, so also test both leases.
		return c.waitForStopped(ctx, st.record, cfg.RunFilePath, cfg.DataDir, opts.timeout)
	}
	if !st.owned {
		if st.Error != "" {
			return daemonStatus{}, fmt.Errorf("daemon pid %d is alive but ownership could not be verified: %s", st.PID, st.Error)
		}
		return daemonStatus{}, fmt.Errorf("daemon pid %d is alive but ownership could not be verified", st.PID)
	}

	if err := c.requestShutdown(ctx, st.Port, st.record); err != nil {
		return daemonStatus{}, fmt.Errorf("request daemon shutdown: %w", err)
	}
	return c.waitForStopped(ctx, st.record, cfg.RunFilePath, cfg.DataDir, opts.timeout)
}

func (c *commandContext) requestShutdown(ctx context.Context, port int, expected *runfile.Info) error {
	reqCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, fmt.Sprintf("http://%s:%d/shutdown", config.LoopbackHost, port), http.NoBody)
	if err != nil {
		return err
	}
	instance := runfile.LegacyInstance
	if expected != nil && expected.InstanceID != "" {
		instance = expected.InstanceID
	}
	req.Header.Set(runfile.ExpectedInstanceHeader, instance)
	resp, err := c.deps.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func (c *commandContext) waitForStopped(ctx context.Context, expected *runfile.Info, runFilePath, dataDir string, timeout time.Duration) (daemonStatus, error) {
	if timeout <= 0 {
		timeout = defaultStopTimeout
	}
	deadline := c.deps.Now().Add(timeout)
	for {
		if err := ctx.Err(); err != nil {
			return daemonStatus{}, err
		}
		err := runfile.CleanupStopped(dataDir, runFilePath, expected, c.deps.OwnerProcessAlive)
		if err == nil {
			return daemonStatus{State: stateStopped, RunFile: runFilePath, DataDir: dataDir}, nil
		}
		if !errors.Is(err, ownership.ErrBusy) && !errors.Is(err, runfile.ErrOwnerAlive) {
			return daemonStatus{}, err
		}
		if !c.deps.Now().Before(deadline) {
			return daemonStatus{}, fmt.Errorf("daemon ownership did not become fully stopped within %s: %w", timeout, err)
		}
		c.deps.Sleep(100 * time.Millisecond)
	}
}
