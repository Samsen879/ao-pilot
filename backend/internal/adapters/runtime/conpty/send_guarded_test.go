package conpty

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type recordingConn struct{ writes int }

type failingFrameConn struct {
	recordingConn
	failAt int
	wrote  int
	err    error
}

func (c *failingFrameConn) Write(p []byte) (int, error) {
	c.writes++
	if c.writes == c.failAt {
		return c.wrote, c.err
	}
	return len(p), nil
}

func TestConPTYClassifiesFailedFrameByBytesAlreadyWritten(t *testing.T) {
	for _, tc := range []struct {
		name     string
		text     string
		failAt   int
		wrote    int
		writeErr error
		want     error
	}{
		{"first frame zero with error", "review text", 1, 0, io.ErrClosedPipe, ports.ErrPaneWriteNotStarted},
		{"first frame zero short write", "review text", 1, 0, nil, ports.ErrPaneWriteNotStarted},
		{"first frame partial", "review text", 1, 1, io.ErrClosedPipe, ports.ErrPaneDraftIncomplete},
		{"later frame zero", strings.Repeat("a", ptyInputChunkRunes+1), 2, 0, io.ErrClosedPipe, ports.ErrPaneDraftIncomplete},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn := &failingFrameConn{failAt: tc.failAt, wrote: tc.wrote, err: tc.writeErr}
			err := sendMessageOnConn(context.Background(), conn, tc.text, nil)
			if !errors.Is(err, tc.want) {
				t.Fatalf("error=%v, want %v", err, tc.want)
			}
		})
	}
}

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
