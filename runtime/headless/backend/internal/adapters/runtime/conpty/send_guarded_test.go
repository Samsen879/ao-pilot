package conpty

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type recordingConn struct{ writes int }

func (c *recordingConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (c *recordingConn) Write(p []byte) (int, error)      { c.writes++; return len(p), nil }
func (c *recordingConn) Close() error                     { return nil }
func (c *recordingConn) LocalAddr() net.Addr              { return &net.TCPAddr{} }
func (c *recordingConn) RemoteAddr() net.Addr             { return &net.TCPAddr{} }
func (c *recordingConn) SetDeadline(time.Time) error      { return nil }
func (c *recordingConn) SetReadDeadline(time.Time) error  { return nil }
func (c *recordingConn) SetWriteDeadline(time.Time) error { return nil }

func TestGuardedConPTYWithholdsEnterAfterPaste(t *testing.T) {
	conn := &recordingConn{}
	checks := 0
	err := sendMessageOnConn(context.Background(), conn, "review text", func(context.Context) error {
		checks++
		if checks == 2 {
			return errors.New("permission dialog")
		}
		return nil
	})
	if !errors.Is(err, ports.ErrPaneDraftPending) || checks != 2 || conn.writes != 1 {
		t.Fatalf("error=%v checks=%d writes=%d, want paste without Enter", err, checks, conn.writes)
	}
}

func TestGuardedConPTYDoesNotPasteAfterPrewriteRejection(t *testing.T) {
	conn := &recordingConn{}
	err := sendMessageOnConn(context.Background(), conn, "review text", func(context.Context) error {
		return errors.New("session exited")
	})
	if !errors.Is(err, ports.ErrPaneWriteNotStarted) || conn.writes != 0 {
		t.Fatalf("error=%v writes=%d, want no pane write", err, conn.writes)
	}
}
