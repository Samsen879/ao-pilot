//go:build windows

package gitworktree

import "golang.org/x/sys/windows"

// Windows free-space queries fail when the configured drive disappears.
func diskIdentity(string) (uint64, error) { return 0, nil }

func diskAvailableBytes(path string) (uint64, error) {
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var available uint64
	if err := windows.GetDiskFreeSpaceEx(ptr, &available, nil, nil); err != nil {
		return 0, err
	}
	return available, nil
}
