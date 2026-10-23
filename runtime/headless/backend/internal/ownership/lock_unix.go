//go:build linux || darwin || freebsd || openbsd || netbsd || dragonfly

package ownership

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
)

func lockFile(file *os.File) error {
	// os.OpenFile creates close-on-exec descriptors. Never add them to ExtraFiles.
	err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
		return ErrBusy
	}
	return err
}
