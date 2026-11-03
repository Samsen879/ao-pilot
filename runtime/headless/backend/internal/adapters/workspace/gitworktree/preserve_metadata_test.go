package gitworktree

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestStashUncommittedPreservesMetadataBeyondArgumentLimit(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("regression for Linux's per-argument limit and long paths")
	}
	_, _, workspace := newSparseRepoFixture(t)
	info, err := workspace.Create(context.Background(), ports.WorkspaceConfig{
		ProjectID: "project", SessionID: "large-receipt-1", Branch: "feature/large-receipt",
		BaseBranch: "main", SparseCheckout: []string{"keep"},
	})
	if err != nil {
		t.Fatal(err)
	}
	indexPath := runGitTest(t, info.Path, "rev-parse", "--git-path", "index")
	beforeIndex, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	// Fifty tiny files are enough to exceed 128 KiB of receipt metadata. Keep
	// each physical path below PATH_MAX without creating a large-data fixture.
	parent := "outside/" + strings.Repeat(strings.Repeat("p", 179)+"/", 18)
	var expected []string
	for i := 0; i < 50; i++ {
		rel := parent + fmt.Sprintf("file-%02d.txt", i)
		expected = append(expected, rel)
		writeSparseFile(t, info.Path, rel, fmt.Sprintf("WIP %d", i))
	}
	if len(strings.Join(expected, "")) <= 128*1024 {
		t.Fatal("fixture must exceed the Linux single-argument limit")
	}
	writeSparseFile(t, info.Path, ".gitignore", "local.secret\n")
	writeSparseFile(t, info.Path, "local.secret", "ignored bytes stay here")

	ref, err := workspace.StashUncommitted(context.Background(), info)
	if err != nil || ref == "" {
		t.Fatalf("large receipt preserve failed: %.180v", err)
	}
	message := runGitTest(t, info.Path, "show", "-s", "--format=%B", ref)
	parts := strings.SplitN(message, "\n\n", 2)
	if len(parts) != 2 {
		t.Fatal("missing full preserve receipt")
	}
	var receipt preserveReceipt
	if err := json.Unmarshal([]byte(parts[1]), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.SchemaVersion != "ao.wip-preserve.v1" || !slices.Equal(receipt.ConeDrift, expected) {
		t.Fatal("preserve receipt omitted or changed cone-drift paths")
	}
	for i, rel := range expected {
		want := fmt.Sprintf("WIP %d", i)
		if got := runGitTest(t, info.Path, "show", ref+":"+rel); got != want {
			t.Fatalf("saved blob %d changed", i)
		}
		if got, err := os.ReadFile(filepath.Join(info.Path, rel)); err != nil || string(got) != want {
			t.Fatalf("physical WIP %d changed: %v", i, err)
		}
	}
	afterIndex, err := os.ReadFile(indexPath)
	if err != nil || !bytes.Equal(beforeIndex, afterIndex) {
		t.Fatalf("real index changed: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(info.Path, "local.secret")); err != nil || string(got) != "ignored bytes stay here" {
		t.Fatalf("ignored file changed: %v", err)
	}
}
