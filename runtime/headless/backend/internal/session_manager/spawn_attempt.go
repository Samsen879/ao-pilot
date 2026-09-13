package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/spawnattempt"
	"github.com/google/uuid"
	"os"
	"time"
)

type attemptStore interface {
	SpawnAttemptForSession(context.Context, domain.SessionID) (string, error)
	SessionForSpawnAttempt(context.Context, string) (domain.SessionID, error)
}

func CallerSpawnFingerprint(cfg ports.SpawnConfig) (string, error) {
	cfg.AttemptID = ""
	cfg.CallerFingerprint = ""
	return spawnattempt.Fingerprint(cfg)
}
func rollbackContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
}
func (m *Manager) Spawn(ctx context.Context, cfg ports.SpawnConfig) (rec domain.SessionRecord, promptBytes, systemBytes int, err error) {
	if m.dataDir == "" {
		return rec, 0, 0, fmt.Errorf("spawn attempt requires explicit data directory")
	}
	if _, ok := m.store.(attemptStore); !ok {
		return rec, 0, 0, fmt.Errorf("spawn attempt requires atomic custody store")
	}
	if cfg.AttemptID == "" {
		cfg.AttemptID = uuid.NewString()
	}
	fp := cfg.CallerFingerprint
	if fp == "" {
		fp, err = CallerSpawnFingerprint(cfg)
		if err != nil {
			return
		}
	}
	a, previous, reserveErr := spawnattempt.Reserve(m.dataDir, cfg.AttemptID, fp, string(cfg.ProjectID))
	if reserveErr != nil {
		return rec, 0, 0, fmt.Errorf("attempt %s: %w", cfg.AttemptID, reserveErr)
	}
	if previous != nil {
		if previous.Outcome != "committed" {
			return rec, 0, 0, fmt.Errorf("attempt %s phase %s outcome %s: %w", cfg.AttemptID, previous.Phase, previous.Outcome, spawnattempt.ErrHold)
		}
		rec, err = m.verifyCommittedAttempt(ctx, *previous)
		return rec, 0, 0, err
	}
	defer func() {
		if err == nil {
			a.Record.Outcome = "committed"
			a.Record.ResidualsUnknown = false
		} else {
			a.Record.Outcome = "failed"
		}
		if saveErr := a.Save(); saveErr != nil {
			err = fmt.Errorf("attempt %s terminal journal failed: %w", cfg.AttemptID, saveErr)
		}
		if err != nil {
			err = fmt.Errorf("attempt %s phase %s: %w", cfg.AttemptID, a.Record.Phase, err)
		}
	}()
	rec, promptBytes, systemBytes, err = m.spawnWithAttempt(ctx, cfg, a)
	if err == nil {
		_, err = m.verifyCommittedAttempt(ctx, a.Record)
	}
	return
}
func (m *Manager) verifyCommittedAttempt(ctx context.Context, a spawnattempt.Record) (domain.SessionRecord, error) {
	rec, err := m.getRecord(ctx, domain.SessionID(a.SessionID))
	if err != nil {
		return rec, fmt.Errorf("%w: committed session missing", spawnattempt.ErrHold)
	}
	project, projectErr := m.loadProject(ctx, rec.ProjectID)
	projectFP, fpErr := spawnattempt.Fingerprint(project)
	if projectErr != nil || fpErr != nil || projectFP != a.ProjectFingerprint {
		return rec, fmt.Errorf("%w: project/config drift", spawnattempt.ErrHold)
	}
	if rec.CreatedAt.Format(time.RFC3339Nano) != a.SessionBirth || rec.CleanupGeneration != a.Generation {
		return rec, fmt.Errorf("%w: session generation drift", spawnattempt.ErrHold)
	}
	if rec.IsTerminated || rec.Metadata.RuntimeLaunchID != a.LaunchID || rec.Metadata.RuntimeHandleID != a.Runtime || rec.Metadata.WorkspacePath != a.Workspace || rec.Metadata.Branch != a.Branch || a.Runtime == "" || a.Workspace == "" {
		return rec, fmt.Errorf("%w: committed identity drift", spawnattempt.ErrHold)
	}
	info, err := os.Lstat(a.Workspace)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return rec, fmt.Errorf("%w: workspace missing", spawnattempt.ErrHold)
	}
	rows, err := m.store.ListSessionWorktrees(ctx, rec.ID)
	if err != nil {
		return rec, err
	}
	if len(rows) != len(a.Worktrees) {
		return rec, fmt.Errorf("%w: worktree custody drift", spawnattempt.ErrHold)
	}
	for _, expected := range a.Worktrees {
		found := false
		for _, row := range rows {
			if row.WorktreePath == expected.Path && row.Branch == expected.Branch && row.RepoName == expected.Repo {
				found = true
			}
		}
		if !found {
			return rec, fmt.Errorf("%w: child worktree drift", spawnattempt.ErrHold)
		}
		info, err := os.Lstat(expected.Path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return rec, fmt.Errorf("%w: child worktree missing", spawnattempt.ErrHold)
		}
	}
	alive, err := m.runtime.IsAlive(ctx, ports.RuntimeHandle{ID: a.Runtime})
	if err != nil || !alive {
		return rec, fmt.Errorf("%w: runtime not confirmed alive", spawnattempt.ErrHold)
	}
	return rec, nil
}
func (m *Manager) spawnAttemptAllowed(ctx context.Context, id domain.SessionID) bool {
	store, ok := m.store.(attemptStore)
	if !ok {
		return true
	} // No new attempts can be created through such a store.
	attempt, err := store.SpawnAttemptForSession(ctx, id)
	if err != nil {
		m.logger.Error("spawn custody unavailable", "sessionID", id)
		return false
	}
	if attempt == "" {
		return true
	}
	record, err := spawnattempt.Read(m.dataDir, attempt)
	return err == nil && record.Outcome == "committed"
}

type SpawnAttemptDiagnosis struct {
	Attempt           spawnattempt.Record     `json:"attempt"`
	SessionID         domain.SessionID        `json:"session_id,omitempty"`
	State             string                  `json:"state"`
	Action            string                  `json:"action"`
	ObservedSession   bool                    `json:"observed_session"`
	ObservedRuntime   string                  `json:"observed_runtime"`
	ObservedWorktrees []spawnattempt.Worktree `json:"observed_worktrees"`
	ObservedPaths     map[string]string       `json:"observed_paths"`
}

func (m *Manager) InspectSpawnAttempt(ctx context.Context, id string) (SpawnAttemptDiagnosis, error) {
	record, err := spawnattempt.Read(m.dataDir, id)
	if err != nil {
		return SpawnAttemptDiagnosis{}, err
	}
	result := SpawnAttemptDiagnosis{Attempt: record, State: record.Outcome, Action: "HOLD"}
	store, ok := m.store.(attemptStore)
	if !ok {
		return result, spawnattempt.ErrHold
	}
	result.SessionID, err = store.SessionForSpawnAttempt(ctx, id)
	if err != nil {
		return result, err
	}
	result.ObservedRuntime = "unknown"
	result.ObservedPaths = map[string]string{}
	if result.SessionID != "" {
		rec, found, readErr := m.store.GetSession(ctx, result.SessionID)
		result.ObservedSession = readErr == nil && found
		if result.ObservedSession {
			if rec.Metadata.WorkspacePath != "" {
				result.ObservedPaths[rec.Metadata.WorkspacePath] = "unknown"
			}
			handle := rec.Metadata.RuntimeHandleID
			if handle == "" {
				handle = record.Runtime
			}
			if handle != "" {
				alive, probeErr := m.runtime.IsAlive(ctx, ports.RuntimeHandle{ID: handle})
				if probeErr == nil {
					if alive {
						result.ObservedRuntime = "retained"
					} else {
						result.ObservedRuntime = "missing"
					}
				}
			}
			rows, rowErr := m.store.ListSessionWorktrees(ctx, rec.ID)
			if rowErr == nil {
				for _, row := range rows {
					result.ObservedWorktrees = append(result.ObservedWorktrees, spawnattempt.Worktree{Path: row.WorktreePath, Branch: row.Branch, Repo: row.RepoName})
				}
			}
		}
	}
	if record.Workspace != "" {
		result.ObservedPaths[record.Workspace] = "unknown"
	}
	for _, row := range append(append([]spawnattempt.Worktree{}, record.Worktrees...), result.ObservedWorktrees...) {
		result.ObservedPaths[row.Path] = "unknown"
	}
	for p := range result.ObservedPaths {
		info, statErr := os.Lstat(p)
		if os.IsNotExist(statErr) {
			result.ObservedPaths[p] = "missing"
		} else if statErr == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			result.ObservedPaths[p] = "retained"
		}
	}

	if record.Outcome == "committed" {
		if _, err = m.verifyCommittedAttempt(ctx, record); err != nil {
			result.State = "unknown"
		} else {
			result.Action = "none"
		}
	}
	if record.Outcome == "running" {
		boot, bootErr := os.ReadFile("/proc/sys/kernel/random/boot_id")
		if record.Boot == "NOT_ESTABLISHED" || bootErr != nil {
			result.State = "unknown"
		} else if string(boot) != record.Boot+"\n" {
			result.State = "interrupted"
		} else {
			start, startErr := spawnattempt.ProcessStart(record.OwnerPID)
			if errors.Is(startErr, os.ErrNotExist) || startErr == nil && start != record.OwnerStart {
				result.State = "unknown"
			}
		}
	}
	return result, nil
}
