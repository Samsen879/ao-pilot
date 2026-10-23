package session

import (
	"context"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"testing"
)

type claimFacts struct {
	scmProvider
	facts ports.SCMPRObservation
}

func (f claimFacts) ParseRepository(string) (ports.SCMRepo, bool) {
	return ports.SCMRepo{Owner: "owner", Name: "repo"}, true
}
func (f claimFacts) FetchPullRequests(context.Context, []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	return []ports.SCMObservation{{Fetched: true, PR: f.facts}}, nil
}
func TestClaimPRDraftMergedClosedPrecedencePreservesSession(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		draft, merged, closed bool
		want                  error
	}{{"draft", true, false, false, ErrPRDraft}, {"merged", false, true, false, ErrPRMerged}, {"closed", false, false, true, ErrPRClosed}, {"merged_closed_draft", true, true, true, ErrPRMerged}, {"closed_draft", true, false, true, ErrPRClosed}} {
		t.Run(tc.name, func(t *testing.T) {
			store, err := sqlite.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			ctx := context.Background()
			if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: t.TempDir(), RepoOriginURL: "https://github.com/owner/repo"}); err != nil {
				t.Fatal(err)
			}
			rec, err := store.CreateSession(ctx, domain.SessionRecord{ProjectID: "p", Kind: domain.KindWorker, Metadata: domain.SessionMetadata{WorkspacePath: "/fixture/workspace", AgentSessionID: "cid"}})
			if err != nil {
				t.Fatal(err)
			}
			rec, _, err = store.GetSession(ctx, rec.ID)
			if err != nil {
				t.Fatal(err)
			}
			service := NewWithDeps(Deps{Store: store, SCM: claimFacts{facts: ports.SCMPRObservation{Draft: tc.draft, Merged: tc.merged, Closed: tc.closed}}})
			_, err = service.ClaimPR(ctx, rec.ID, "123", ClaimPROptions{})
			if !errors.Is(err, tc.want) {
				t.Fatalf("got=%v want=%v", err, tc.want)
			}
			after, _, err := store.GetSession(ctx, rec.ID)
			if err != nil || after != rec {
				t.Fatalf("claim refusal changed session %+v %v", after, err)
			}
		})
	}
}
