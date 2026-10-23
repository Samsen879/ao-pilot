package sqlite

import (
	"context"
	"database/sql"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/pressly/goose/v3"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
)

func TestMessageMigration43To44AndReopen(t *testing.T) {
	root := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(root, "ao.db")+pragmas)
	if err != nil {
		t.Fatal(err)
	}
	gooseMu.Lock()
	goose.SetBaseFS(migrationsFS)
	goose.SetLogger(goose.NopLogger())
	err = goose.SetDialect("sqlite3")
	if err == nil {
		err = goose.UpTo(db, "migrations", 43)
	}
	gooseMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{`INSERT INTO projects(id,path,registered_at) VALUES('p','/fixture','2026-10-23T00:00:00Z')`, `INSERT INTO sessions(id,project_id,num,kind,activity_last_at,created_at,updated_at,agent_session_id,runtime_launch_id) VALUES('p-1','p',1,'worker','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z','original-native-cid','original-launch')`} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	rec, ok, err := store.GetSession(context.Background(), "p-1")
	if err != nil || !ok || rec.Metadata.AgentSessionID != "original-native-cid" || rec.Metadata.RuntimeLaunchID != "original-launch" {
		t.Fatal(rec, ok, err)
	}
	message := domain.MessageRecord{MessageResult: domain.MessageResult{MessageID: "id", Outcome: "submitted_unconfirmed", Evidence: domain.MessageEvidence{Code: "RESERVED", Signal: "none", RecordedAt: "now"}}, SessionID: rec.ID, TextSHA256: strings.Repeat("0", 64), Phase: "reserved"}
	if created, err := store.ReserveMessage(context.Background(), message); err != nil || !created {
		t.Fatal(created, err)
	}
	store.Close()
	store, err = Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	got, ok, err := store.GetMessage(context.Background(), "id")
	if err != nil || !ok || got != message {
		t.Fatalf("reopened=%+v original=%+v err=%v", got, message, err)
	}
}
func TestMessageUniqueReservationAndMonotonicCASAcrossStores(t *testing.T) {
	root := t.TempDir()
	a, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	rec := domain.MessageRecord{MessageResult: domain.MessageResult{MessageID: "race", Outcome: "submitted_unconfirmed", Evidence: domain.MessageEvidence{Code: "STARTED", Signal: "none"}}, SessionID: "p-1", TextSHA256: strings.Repeat("a", 64), RequireAck: true, Phase: "started"}
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			store := a
			if i%2 == 0 {
				store = b
			}
			won, err := store.ReserveMessage(context.Background(), rec)
			if err != nil {
				t.Error(err)
			}
			if won {
				winners.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatal(winners.Load())
	}
	ack := rec
	ack.Outcome = "acknowledged"
	ack.Evidence.Signal = "explicit_ack"
	ack.Phase = "final"
	if won, err := a.CompareAndSwapMessage(context.Background(), ack, 0); err != nil || !won {
		t.Fatal(won, err)
	}
	rec.Outcome = "ack_timeout"
	if won, err := b.CompareAndSwapMessage(context.Background(), rec, 0); err != nil || won {
		t.Fatal("stale CAS overwrote ACK", won, err)
	}
	// Even a current version cannot downgrade an acknowledged result.
	if won, err := b.CompareAndSwapMessage(context.Background(), rec, 1); err != nil || won {
		t.Fatal("ACK downgrade", won, err)
	}
	got, _, err := b.GetMessage(context.Background(), "race")
	if err != nil || got.Outcome != "acknowledged" {
		t.Fatal(got, err)
	}
}

// This emulates the pre-44 migration loader, not an exact shipped old artifact.
func TestPreviousMigrationLoaderRetainsMessageAudit(t *testing.T) {
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	rec := domain.MessageRecord{MessageResult: domain.MessageResult{MessageID: "audit", Outcome: "acknowledged", Evidence: domain.MessageEvidence{Code: "ACKNOWLEDGED", Signal: "explicit_ack"}}, SessionID: "p-1", TextSHA256: strings.Repeat("f", 64), RequireAck: true, Phase: "final"}
	if _, err := store.ReserveMessage(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	store.Close()
	oldFS := fstest.MapFS{}
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "0044_") {
			continue
		}
		name := "migrations/" + entry.Name()
		body, err := migrationsFS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		oldFS[name] = &fstest.MapFile{Data: body, Mode: 0644}
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(root, "ao.db")+pragmas)
	if err != nil {
		t.Fatal(err)
	}
	gooseMu.Lock()
	goose.SetBaseFS(oldFS)
	err = goose.Up(db, "migrations", goose.WithAllowMissing())
	goose.SetBaseFS(migrationsFS)
	gooseMu.Unlock()
	db.Close()
	if err != nil {
		t.Fatalf("pre44 loader rejected schema44: %v", err)
	}
	store, err = Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	got, ok, err := store.GetMessage(context.Background(), "audit")
	if err != nil || !ok || got != rec {
		t.Fatalf("audit changed: %+v %v", got, err)
	}
}
