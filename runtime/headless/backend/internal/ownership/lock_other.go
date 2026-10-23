//go:build !linux && !darwin && !freebsd && !openbsd && !netbsd && !dragonfly && !windows

package ownership

import (
	"errors"
	"os"
)

func lockFile(*os.File) error {
	return errors.New("OS ownership locking is unsupported on this platform")
}
