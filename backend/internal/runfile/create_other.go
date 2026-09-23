//go:build !linux && !windows

package runfile

import "os"

// atomicCreate's portable fallback uses a same-directory hard link. The
// published inode is complete and an existing destination is never replaced.
func atomicCreate(src, dst string) error {
	return os.Link(src, dst)
}
