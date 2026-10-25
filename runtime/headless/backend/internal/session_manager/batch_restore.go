package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/spawnattempt"
)

// ErrRecoveryUnavailable means the initial recovery set could not be read.
// Unlike an individual failed restore, this prevents boot admission.
var ErrRecoveryUnavailable = errors.New("recovery inventory unavailable")

const MaxRestoreConcurrency = 16

type BatchRestoreOptions struct {
	Concurrency       int
	IncludeTerminated bool
	SessionIDs        []domain.SessionID
}

type BatchRestoreItem struct {
	SessionID   domain.SessionID `json:"sessionId"`
	Outcome     string           `json:"outcome" enum:"restored,skipped_hold,failed"`
	Reason      string           `json:"reason"`
	RestoreMode RestoreMode      `json:"restoreMode,omitempty" enum:"native,saved_prompt,fresh"`
}

type BatchRestoreResult struct {
	ProjectID domain.ProjectID   `json:"projectId"`
	Results   []BatchRestoreItem `json:"results"`
}

// RestoreProject explicitly restores a project's sessions without the automatic
// cold-start budget. Orchestrators finish before workers are admitted. Results
// keep deterministic order even when work is concurrent; no failure deletes a
// session or its recovery records.
func (m *Manager) RestoreProject(ctx context.Context, project domain.ProjectID, options BatchRestoreOptions) (BatchRestoreResult, error) {
	result := BatchRestoreResult{ProjectID: project, Results: []BatchRestoreItem{}}
	concurrency := options.Concurrency
	if strings.TrimSpace(string(project)) == "" || concurrency < 1 || concurrency > MaxRestoreConcurrency {
		return result, fmt.Errorf("project required and concurrency must be 1..%d", MaxRestoreConcurrency)
	}
	if _, err := m.loadProject(ctx, project); err != nil {
		return result, err
	}
	sessions, err := m.store.ListSessions(ctx, project)
	if err != nil {
		return result, err
	}
	// Capture scope before any restore can change IsTerminated. Install/cold-boot
	// callers bind an explicit pre-stop live ID set and opt in to restoring those
	// IDs after reconciliation has marked them terminated.
	selected := make(map[domain.SessionID]bool, len(options.SessionIDs))
	scoped := len(options.SessionIDs) > 0
	for _, id := range options.SessionIDs {
		if strings.TrimSpace(string(id)) == "" || selected[id] {
			return result, fmt.Errorf("session IDs must be nonempty and unique")
		}
		selected[id] = true
	}
	filtered := make([]domain.SessionRecord, 0, len(sessions))
	for _, session := range sessions {
		if scoped && !selected[session.ID] {
			continue
		}
		delete(selected, session.ID)
		if session.IsTerminated && !options.IncludeTerminated {
			continue
		}
		filtered = append(filtered, session)
	}
	if len(selected) != 0 {
		return result, fmt.Errorf("selected session is not in the project")
	}
	sessions = filtered
	sort.SliceStable(sessions, func(i, j int) bool {
		a, b := sessions[i], sessions[j]
		if (a.Kind == domain.KindOrchestrator) != (b.Kind == domain.KindOrchestrator) {
			return a.Kind == domain.KindOrchestrator
		}
		return a.ID < b.ID
	})
	result.Results = make([]BatchRestoreItem, len(sessions))
	boundary := 0
	for boundary < len(sessions) && sessions[boundary].Kind == domain.KindOrchestrator {
		boundary++
	}
	run := func(first, last int) {
		jobs := make(chan int)
		var workers sync.WaitGroup
		for worker := 0; worker < concurrency && worker < last-first; worker++ {
			workers.Add(1)
			go func() {
				defer workers.Done()
				for index := range jobs {
					result.Results[index] = m.restoreBatchItem(ctx, sessions[index].ID)
				}
			}()
		}
		for index := first; index < last; index++ {
			jobs <- index
		}
		close(jobs)
		workers.Wait()
	}
	run(0, boundary)
	run(boundary, len(sessions))
	return result, nil
}

func (m *Manager) restoreBatchItem(ctx context.Context, id domain.SessionID) BatchRestoreItem {
	item := BatchRestoreItem{SessionID: id, Outcome: "failed"}
	if err := ctx.Err(); err != nil {
		item.Reason = err.Error()
		return item
	}
	if !m.spawnAttemptAllowed(ctx, id) {
		item.Outcome, item.Reason = "skipped_hold", "spawn_hold_or_pending"
		return item
	}
	current, found, err := m.store.GetSession(ctx, id)
	if err != nil {
		item.Reason = err.Error()
		return item
	}
	if !found {
		item.Reason = "session_not_found"
		return item
	}
	if !current.IsTerminated {
		rows, err := m.store.ListSessionWorktrees(ctx, id)
		if err != nil {
			item.Reason = err.Error()
			return item
		}
		for _, row := range rows {
			if row.PreservedRef != "" {
				item.Reason = "preserved_replay_pending"
				return item
			}
		}
		if current.Metadata.RuntimeHandleID == "" {
			item.Reason = "incomplete_runtime_handle"
			return item
		}
		alive, err := m.runtime.IsAlive(ctx, ports.RuntimeHandle{ID: current.Metadata.RuntimeHandleID})
		if err != nil {
			item.Reason = err.Error()
			return item
		}
		if alive {
			item.Outcome, item.Reason = "restored", "already_running"
		} else {
			item.Reason = "runtime_not_alive_requires_reconcile"
		}
		return item
	}
	restored, err := m.RestoreWithMode(ctx, id)
	if err != nil {
		if errors.Is(err, spawnattempt.ErrHold) {
			item.Outcome, item.Reason = "skipped_hold", "spawn_hold_or_pending"
		} else {
			item.Reason = err.Error()
		}
		return item
	}
	if restored.PreservedWorkPending {
		item.Reason = "preserved_replay_pending"
		return item
	}
	item.Outcome, item.Reason, item.RestoreMode = "restored", "restored", restored.Mode
	return item
}
