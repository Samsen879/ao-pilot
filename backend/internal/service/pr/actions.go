package pr

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ActionManager is the controller-facing contract for PR action routes.
type ActionManager interface {
	Merge(ctx context.Context, prID string) (MergeResult, error)
	ResolveComments(ctx context.Context, prID string, commentIDs []string) (ResolveResult, error)
}

// MergeResult is the successful outcome of a PR merge.
type MergeResult struct {
	PRNumber       int
	Method         string
	HeadSHA        string
	MergeCommitSHA string
}

// ResolveResult is the successful outcome of a resolve-comments operation.
type ResolveResult struct {
	Resolved int
}

// ActionStore is the durable ownership evidence needed for a PR mutation.
type ActionStore interface {
	ListPRsByNumber(ctx context.Context, number int) ([]domain.PullRequest, error)
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
}

// ActionProvider supplies live merge facts and the exact-HEAD mutation.
type ActionProvider interface {
	FetchPullRequests(ctx context.Context, refs []ports.SCMPRRef) ([]ports.SCMObservation, error)
	FetchReviewThreads(ctx context.Context, ref ports.SCMPRRef) (ports.SCMReviewObservation, error)
	MergePullRequest(ctx context.Context, ref ports.SCMPRRef, expectedHead string) (ports.SCMMergeResult, error)
}

// ActionService production-wires guarded PR mutations over durable AO
// ownership and live provider facts.
type ActionService struct {
	store    ActionStore
	provider ActionProvider
}

// NewActionService constructs the controller-facing PR action service.
func NewActionService(store ActionStore, provider ActionProvider) *ActionService {
	return &ActionService{store: store, provider: provider}
}

// Merge validates a single active AO owner, refreshes every merge gate from the
// provider, sends the exact live HEAD in the mutation, and confirms the merged
// commit with a second live read before returning success.
func (s *ActionService) Merge(ctx context.Context, prID string) (MergeResult, error) {
	number, err := strconv.Atoi(strings.TrimSpace(prID))
	if err != nil || number <= 0 {
		return MergeResult{}, ErrPRNotFound
	}
	if s == nil || s.store == nil || s.provider == nil {
		return MergeResult{}, fmt.Errorf("%w: dependencies unavailable", ErrPRProvider)
	}
	stored, err := s.loadOwnedPR(ctx, number)
	if err != nil {
		return MergeResult{}, err
	}
	ref, err := actionPRRef(stored)
	if err != nil {
		return MergeResult{}, fmt.Errorf("%w: %w", ErrPRPreconditions, err)
	}
	live, err := s.fetchOne(ctx, ref)
	if err != nil {
		return MergeResult{}, err
	}
	expectedHead := strings.TrimSpace(live.PR.HeadSHA)
	if strings.TrimSpace(stored.HeadSHA) == "" || expectedHead == "" || stored.HeadSHA != expectedHead || live.CI.HeadSHA != expectedHead {
		return MergeResult{}, ErrPRHeadChanged
	}
	if live.PR.Draft || live.PR.Merged || live.PR.Closed || live.CI.Summary != string(domain.CIPassing) {
		return MergeResult{}, ErrPRPreconditions
	}
	if live.Mergeability.State != string(domain.MergeMergeable) {
		return MergeResult{}, ErrPRNotMergeable
	}
	review, err := s.provider.FetchReviewThreads(ctx, ref)
	if err != nil {
		return MergeResult{}, fmt.Errorf("%w: refresh reviews: %w", ErrPRProvider, err)
	}
	if review.Partial || reviewBlocked(live.Review.Decision) || reviewBlocked(review.Decision) || hasUnresolvedThreads(review.Threads) {
		return MergeResult{}, ErrPRPreconditions
	}
	latestOwned, err := s.loadOwnedPR(ctx, number)
	if err != nil {
		return MergeResult{}, err
	}
	if latestOwned.SessionID != stored.SessionID || latestOwned.URL != stored.URL {
		return MergeResult{}, ErrPROwnerInactive
	}
	if strings.TrimSpace(latestOwned.HeadSHA) != expectedHead {
		return MergeResult{}, ErrPRHeadChanged
	}
	mutation, mutationErr := s.provider.MergePullRequest(ctx, ref, expectedHead)
	if mutationErr != nil && !errors.Is(mutationErr, ports.ErrSCMMergeOutcomeUnknown) {
		return MergeResult{}, fmt.Errorf("%w: merge mutation: %w", ErrPRProvider, mutationErr)
	}
	readback, readbackErr := s.fetchOne(ctx, ref)
	if readbackErr != nil {
		return MergeResult{}, fmt.Errorf("%w: %w", ErrPRMergeMismatch, readbackErr)
	}
	readbackConfirmed := readback.PR.Merged && readback.PR.HeadSHA == expectedHead &&
		strings.TrimSpace(readback.PR.MergeCommitSHA) != ""
	if mutationErr != nil {
		if readbackConfirmed {
			return MergeResult{PRNumber: number, Method: "squash", HeadSHA: expectedHead, MergeCommitSHA: readback.PR.MergeCommitSHA}, nil
		}
		return MergeResult{}, fmt.Errorf("%w: merge mutation: %w", ErrPRProvider, mutationErr)
	}
	if !mutation.Merged || strings.TrimSpace(mutation.MergeCommitSHA) == "" || !readbackConfirmed ||
		readback.PR.MergeCommitSHA != mutation.MergeCommitSHA {
		return MergeResult{}, ErrPRMergeMismatch
	}
	return MergeResult{PRNumber: number, Method: "squash", HeadSHA: expectedHead, MergeCommitSHA: mutation.MergeCommitSHA}, nil
}

func (s *ActionService) loadOwnedPR(ctx context.Context, number int) (domain.PullRequest, error) {
	owned, err := s.store.ListPRsByNumber(ctx, number)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("%w: list ownership: %w", ErrPRProvider, err)
	}
	if len(owned) == 0 {
		return domain.PullRequest{}, ErrPRNotFound
	}
	if len(owned) != 1 {
		return domain.PullRequest{}, ErrPRAmbiguous
	}
	owner, ok, err := s.store.GetSession(ctx, owned[0].SessionID)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("%w: read owner: %w", ErrPRProvider, err)
	}
	if !ok || owner.IsTerminated {
		return domain.PullRequest{}, ErrPROwnerInactive
	}
	return owned[0], nil
}

func (s *ActionService) fetchOne(ctx context.Context, ref ports.SCMPRRef) (ports.SCMObservation, error) {
	observations, err := s.provider.FetchPullRequests(ctx, []ports.SCMPRRef{ref})
	if err != nil {
		return ports.SCMObservation{}, fmt.Errorf("%w: refresh pull request: %w", ErrPRProvider, err)
	}
	if len(observations) != 1 || !observations[0].Fetched || observations[0].PR.Number != ref.Number ||
		!strings.EqualFold(observations[0].Provider, ref.Repo.Provider) ||
		!strings.EqualFold(observations[0].Host, ref.Repo.Host) ||
		!strings.EqualFold(observations[0].Repo, ref.Repo.Repo) {
		return ports.SCMObservation{}, fmt.Errorf("%w: provider returned no unique authoritative pull request", ErrPRProvider)
	}
	return observations[0], nil
}

// ResolveComments remains unavailable until a guarded provider implementation
// is production-wired for that separate mutation.
func (s *ActionService) ResolveComments(context.Context, string, []string) (ResolveResult, error) {
	return ResolveResult{}, ErrPRNotImplemented
}

func actionPRRef(pr domain.PullRequest) (ports.SCMPRRef, error) {
	parts := strings.Split(strings.TrimSpace(pr.Repo), "/")
	if !strings.EqualFold(pr.Provider, "github") || !strings.EqualFold(pr.Host, "github.com") || len(parts) != 2 ||
		strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" || pr.Number <= 0 {
		return ports.SCMPRRef{}, fmt.Errorf("unsupported or incomplete SCM identity")
	}
	repo := ports.SCMRepo{Provider: "github", Host: "github.com", Owner: parts[0], Name: parts[1], Repo: pr.Repo}
	return ports.SCMPRRef{Repo: repo, Number: pr.Number, URL: pr.URL}, nil
}

func reviewBlocked(decision string) bool {
	return decision == string(domain.ReviewChangesRequest) || decision == string(domain.ReviewRequired)
}

func hasUnresolvedThreads(threads []ports.SCMReviewThreadObservation) bool {
	for _, thread := range threads {
		if !thread.Resolved {
			return true
		}
	}
	return false
}
