//go:build linux

package runfile

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// atomicCreate publishes src at dst without replacing an existing file.
// renameat2 works on filesystems such as FAT/exFAT that do not support hard
// links. Older kernels/filesystems fall back to a same-directory hard link.
func atomicCreate(src, dst string) error {
	err := unix.Renameat2(unix.AT_FDCWD, src, unix.AT_FDCWD, dst, unix.RENAME_NOREPLACE)
	if err == nil {
		return nil
	}
	if !errors.Is(err, unix.ENOSYS) && !errors.Is(err, unix.EINVAL) && !errors.Is(err, unix.EOPNOTSUPP) {
		return &os.LinkError{Op: "renameat2", Old: src, New: dst, Err: err}
	}
	return os.Link(src, dst)
}
