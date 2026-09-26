//go:build windows

package ownership

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
)

func lockFile(file *os.File) error {
	// Go's os.OpenFile handle is non-inheritable; no child receives this handle.
	var overlap windows.Overlapped
	err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlap)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return ErrBusy
	}
	return err
}
