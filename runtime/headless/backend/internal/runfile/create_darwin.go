//go:build darwin

package runfile

import (
	"os"

	"golang.org/x/sys/unix"
)

// atomicCreate uses macOS renamex_np with RENAME_EXCL. It works on exFAT and
// other mounted filesystems that do not support hard links while preserving
// the concurrent publisher's destination.
func atomicCreate(src, dst string) error {
	if err := unix.RenamexNp(src, dst, unix.RENAME_EXCL); err != nil {
		return &os.LinkError{Op: "renamex_np", Old: src, New: dst, Err: err}
	}
	return nil
}
