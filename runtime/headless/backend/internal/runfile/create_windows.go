//go:build windows

package runfile

import (
	"os"

	"golang.org/x/sys/windows"
)

// atomicCreate uses MoveFileEx without MOVEFILE_REPLACE_EXISTING, so the
// complete temporary file is published atomically and a concurrent owner wins.
func atomicCreate(src, dst string) error {
	from, err := windows.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(from, to, windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return &os.LinkError{Op: "MoveFileEx", Old: src, New: dst, Err: err}
	}
	return nil
}
