//go:build windows

package ownership

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
)

func ProcessAlive(pid int) (bool, error) {
	if pid <= 0 {
		return false, fmt.Errorf("invalid owner PID %d", pid)
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return false, nil
	}
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(handle)
	status, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, err
	}
	switch status {
	case uint32(windows.WAIT_TIMEOUT):
		return true, nil
	case windows.WAIT_OBJECT_0:
		return false, nil
	default:
		return false, fmt.Errorf("unknown process wait status %d", status)
	}
}
