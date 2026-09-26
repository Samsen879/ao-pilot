// Package ownership admits cooperating writers to one data directory and one
// discovery directory. Lock files are permanent; never unlink or replace them.
package ownership

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

var ErrBusy = errors.New("AO ownership is held by another process")

// Lease is a short critical section until RetainForProcess transfers it to the
// process lifetime. A retained lease cannot be explicitly closed, even when Run
// returns: old background writers must stop before the OS admits a successor.
type Lease struct {
	mu                           sync.Mutex
	files                        []*os.File
	retained                     bool
	closed                       bool
	dataDir, runFile, instanceID string
}

var processCustody struct {
	sync.Mutex
	leases []*Lease
}

func directory(name string) (string, error) {
	if name == "" {
		return "", errors.New("ownership directory is empty")
	}
	abs, err := filepath.Abs(name)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return "", err
	}
	canonical, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("ownership path is not a directory: %s", canonical)
	}
	return canonical, nil
}

// Acquire always locks data first, then the discovery parent (which also owns
// the fixed browser.sock/supervise.sock names). Contention is nonblocking.
func Acquire(dataDir, runFile string) (*Lease, error) {
	data, err := directory(dataDir)
	if err != nil {
		return nil, err
	}
	if runFile == "" {
		return nil, errors.New("run-file path is empty")
	}
	abs, err := filepath.Abs(runFile)
	if err != nil {
		return nil, err
	}
	discovery, err := directory(filepath.Dir(abs))
	if err != nil {
		return nil, err
	}
	l := &Lease{dataDir: data, runFile: filepath.Join(discovery, filepath.Base(abs))}
	for _, name := range []string{filepath.Join(data, ".daemon-owner.lock"), filepath.Join(discovery, ".daemon-discovery.lock")} {
		if info, err := os.Lstat(name); err == nil && !info.Mode().IsRegular() {
			_ = l.Close()
			return nil, fmt.Errorf("ownership lock is not a regular file: %s", name)
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			_ = l.Close()
			return nil, err
		}
		file, err := os.OpenFile(name, os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			_ = l.Close()
			return nil, err
		}
		if err = lockFile(file); err != nil {
			_ = file.Close()
			_ = l.Close()
			return nil, fmt.Errorf("lock %s: %w", name, err)
		}
		l.files = append(l.files, file)
	}
	if err := l.Do(func() error { return nil }); err != nil {
		_ = l.Close()
		return nil, err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		_ = l.Close()
		return nil, err
	}
	l.instanceID = hex.EncodeToString(nonce[:])
	return l, nil
}

func (l *Lease) DataDir() string    { return l.dataDir }
func (l *Lease) RunFile() string    { return l.runFile }
func (l *Lease) InstanceID() string { return l.instanceID }

// Do serializes in-process publishers and rejects use after short-lease close.
// The final run-file component must not be a symlink; its parent is canonical.
func (l *Lease) Do(fn func() error) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return errors.New("ownership lease is closed")
	}
	info, err := os.Lstat(l.runFile)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("run-file must be a regular file, not a symlink or directory: %s", l.runFile)
	}
	return fn()
}

// RetainForProcess intentionally has no release counterpart. Both CLI and the
// compatibility main exit after Run returns. Strong roots prevent GC finalizers
// from closing these non-inherited handles before OS process termination.
func (l *Lease) RetainForProcess() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return errors.New("ownership lease is closed")
	}
	if l.retained {
		return errors.New("ownership lease is already retained")
	}
	l.retained = true
	processCustody.Lock()
	processCustody.leases = append(processCustody.leases, l)
	processCustody.Unlock()
	return nil
}

func (l *Lease) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.retained {
		return errors.New("process ownership cannot be released before process exit")
	}
	if l.closed {
		return nil
	}
	l.closed = true
	var errs []error
	for i := len(l.files) - 1; i >= 0; i-- {
		errs = append(errs, l.files[i].Close())
	}
	return errors.Join(errs...)
}
