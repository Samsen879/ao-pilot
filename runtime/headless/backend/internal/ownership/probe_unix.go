//go:build !windows

package ownership

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ProcessAlive distinguishes absence (including a confirmed zombie) from an
// unknown probe error. Only the former permits legacy-record reclamation.
func ProcessAlive(pid int) (bool, error) {
	if pid <= 0 {
		return false, fmt.Errorf("invalid owner PID %d", pid)
	}
	err := syscall.Kill(pid, 0)
	if errors.Is(err, syscall.ESRCH) {
		return false, nil
	}
	if errors.Is(err, syscall.EPERM) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	state := strings.TrimSpace(string(out))
	if err != nil || state == "" {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return false, nil
		}
		return false, fmt.Errorf("cannot determine owner process state: %v", err)
	}
	return state[0] != 'Z', nil
}
