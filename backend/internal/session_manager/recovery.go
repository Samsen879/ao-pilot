package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Existing stray_moved state is a durable quarantine/HOLD, not a new schema.
// No automatic retry or agent message may consume a failed recovery's custody.
func (m *Manager) recoveryFailure(ctx context.Context, rec domain.SessionRecord, rows []domain.SessionWorktreeRecord, ws ports.WorkspaceInfo, projectRows []ports.WorkspaceRepoInfo, cause error) error {
	if life, ok := m.workspace.(ports.WorkspaceRecovery); ok {
		infos := []ports.WorkspaceInfo{ws}
		if len(projectRows) > 0 {
			infos = nil
			for _, r := range projectRows {
				infos = append(infos, workspaceInfoFromRepoInfo(r))
			}
		}
		for i := len(infos) - 1; i >= 0; i-- {
			cause = errors.Join(cause, life.RollbackRestore(context.WithoutCancel(ctx), infos[i]))
		}
	}
	if len(rows) == 0 {
		rows = []domain.SessionWorktreeRecord{{SessionID: rec.ID, RepoName: domain.RootWorkspaceRepoName, Branch: rec.Metadata.Branch, RepoPath: rec.Metadata.WorkspaceRepoPath, WorktreePath: rec.Metadata.WorkspacePath}}
	}
	for _, row := range rows {
		row.State = "stray_moved"
		cause = errors.Join(cause, m.store.UpsertSessionWorktree(context.WithoutCancel(ctx), row))
	}
	return fmt.Errorf("recovery failed; workspace restored and HOLD retained: %w", cause)
}
func (m *Manager) verifyRecoveredWorkspaces(ctx context.Context, ws ports.WorkspaceInfo, rows []ports.WorkspaceRepoInfo) error {
	life, ok := m.workspace.(ports.WorkspaceRecovery)
	if !ok {
		return nil
	}
	infos := []ports.WorkspaceInfo{ws}
	if len(rows) > 0 {
		infos = nil
		for _, row := range rows {
			infos = append(infos, workspaceInfoFromRepoInfo(row))
		}
	}
	for i := range infos {
		for j := range infos {
			if i != j && strings.HasPrefix(infos[j].Path, infos[i].Path+string(filepath.Separator)) {
				infos[i].RecoveryChildren = append(infos[i].RecoveryChildren, infos[j].Path)
			}
		}
	}
	sort.SliceStable(infos, func(i, j int) bool { return len(infos[i].Path) > len(infos[j].Path) })
	for _, info := range infos {
		if e := life.VerifyRestore(ctx, info); e != nil {
			return e
		}
	}
	for _, info := range infos {
		// A child commit changes only its verified, owned recovery artifacts.
		// Re-read the parent after child cleanup, retaining all other checks.
		if len(info.RecoveryChildren) > 0 {
			if e := life.VerifyRestore(ctx, info); e != nil {
				return e
			}
		}
		if e := life.CommitRestore(ctx, info); e != nil {
			return e
		}
	}
	return nil
}

// DeferBootRestore restricts automatic recovery only. Explicit, ordered restore
// remains available to the installer. The generated input is cleared after a
// committed install so normal subsequent cold starts retain the four-slot policy.
func (m *Manager) DeferBootRestore(raw string) error {
	m.deferredBootRestore = map[domain.SessionID]bool{}
	if raw == "" {
		return nil
	}
	for _, id := range strings.Split(raw, ",") {
		if !regexp.MustCompile(`^[A-Za-z0-9_.-]+$`).MatchString(id) || m.deferredBootRestore[domain.SessionID(id)] {
			return fmt.Errorf("invalid deferred boot restore ids")
		}
		m.deferredBootRestore[domain.SessionID(id)] = true
	}
	return nil
}
