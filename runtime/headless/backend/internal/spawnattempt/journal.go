// Package spawnattempt records native spawn custody independently of request lifetime.
package spawnattempt

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const Schema = "ao.spawn-attempt.v1"

var ErrHold = errors.New("spawn attempt requires reconciliation")

type Record struct {
	Schema              string     `json:"schema_version"`
	ID                  string     `json:"attempt_id"`
	RequestFingerprint  string     `json:"request_fingerprint"`
	ProjectFingerprint  string     `json:"project_fingerprint,omitempty"`
	SessionBirth        string     `json:"session_birth,omitempty"`
	Generation          int64      `json:"generation"`
	ResolvedFingerprint string     `json:"resolved_fingerprint,omitempty"`
	Project             string     `json:"project"`
	Phase               string     `json:"phase"`
	Outcome             string     `json:"outcome"`
	SessionID           string     `json:"session_id,omitempty"`
	Branch              string     `json:"branch,omitempty"`
	Workspace           string     `json:"workspace,omitempty"`
	Runtime             string     `json:"runtime,omitempty"`
	LaunchID            string     `json:"launch_id,omitempty"`
	Worktrees           []Worktree `json:"worktrees,omitempty"`
	ResidualsUnknown    bool       `json:"residuals_unknown"`
	Boot                string     `json:"boot_id"`
	OwnerPID            int        `json:"owner_pid"`
	OwnerStart          string     `json:"owner_start"`
	CreatedAt           string     `json:"created_at"`
	UpdatedAt           string     `json:"updated_at"`
}
type Worktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Repo   string `json:"repo"`
}
type Attempt struct {
	Record    Record
	directory string
}

func Fingerprint(value any) (string, error) {
	b, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}
func validID(id string) bool {
	parsed, err := uuid.Parse(id)
	return err == nil && parsed.String() == id
}
func directory(dataDir, id string, create bool) (string, error) {
	if !validID(id) {
		return "", fmt.Errorf("invalid attempt UUID")
	}
	root := filepath.Join(dataDir, "spawn-attempts")
	// Check every existing ancestor before MkdirAll can follow any symlink.
	for p := root; ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil && !(create && os.IsNotExist(err)) {
			return "", err
		}
		if err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
			return "", ErrHold
		}
		if parent := filepath.Dir(p); parent == p {
			break
		}
	}
	if create {
		if err := os.MkdirAll(root, 0700); err != nil {
			return "", err
		}
	}
	info, err := os.Lstat(root)
	if err != nil {
		return "", err
	}
	if info.Mode().Perm()&0077 != 0 {
		return "", ErrHold
	}
	return filepath.Join(root, id), nil
}
func Read(dataDir, id string) (Record, error) {
	dir, err := directory(dataDir, id, false)
	if err != nil {
		return Record{}, err
	}
	return readDirectory(dir, id)
}
func readDirectory(dir, id string) (Record, error) {
	for _, p := range []string{dir, filepath.Join(dir, "record.json")} {
		info, err := os.Lstat(p)
		if err != nil {
			return Record{}, err
		}
		if info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
			return Record{}, ErrHold
		}
	}
	f, err := os.Open(filepath.Join(dir, "record.json"))
	if err != nil {
		return Record{}, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return Record{}, err
	}
	pathInfo, err := os.Lstat(filepath.Join(dir, "record.json"))
	if err != nil || !opened.Mode().IsRegular() || opened.Size() > 1<<20 || opened.Mode().Perm()&0077 != 0 || !os.SameFile(opened, pathInfo) {
		return Record{}, ErrHold
	}
	d := json.NewDecoder(io.LimitReader(f, 1<<20))
	d.DisallowUnknownFields()
	var rec Record
	if err := d.Decode(&rec); err != nil {
		return rec, fmt.Errorf("unreadable attempt: %w", err)
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return rec, ErrHold
	}
	if rec.Schema != Schema || rec.ID != id || len(rec.RequestFingerprint) != 64 || rec.Project == "" || rec.Phase == "" || (rec.Outcome != "running" && rec.Outcome != "failed" && rec.Outcome != "committed") {
		return rec, ErrHold
	}
	return rec, nil
}
func Reserve(dataDir, id, fingerprint, project string) (*Attempt, *Record, error) {
	dir, err := directory(dataDir, id, true)
	if err != nil {
		return nil, nil, err
	}
	if err = os.Mkdir(dir, 0700); err != nil {
		if !os.IsExist(err) {
			return nil, nil, err
		}
		rec, readErr := readDirectory(dir, id)
		if readErr != nil {
			return nil, nil, fmt.Errorf("%w: unreadable reservation", ErrHold)
		}
		if rec.RequestFingerprint != fingerprint || rec.Project != project {
			return nil, &rec, fmt.Errorf("%w: attempt request substitution", ErrHold)
		}
		return nil, &rec, nil
	}

	boot := []byte("NOT_ESTABLISHED")
	start := "NOT_ESTABLISHED"
	if runtime.GOOS == "linux" {
		boot, err = os.ReadFile("/proc/sys/kernel/random/boot_id")
		if err != nil {
			return nil, nil, err
		}
		start, err = ProcessStart(os.Getpid())
		if err != nil {
			return nil, nil, err
		}
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	a := &Attempt{directory: dir, Record: Record{Schema: Schema, ID: id, RequestFingerprint: fingerprint, Project: project, Phase: "reserved", Outcome: "running", ResidualsUnknown: true, Boot: strings.TrimSpace(string(boot)), OwnerPID: os.Getpid(), OwnerStart: start, CreatedAt: now, UpdatedAt: now}}
	if err := a.Save(); err != nil {
		return nil, nil, err
	}
	return a, nil, nil
}
func ProcessStart(pid int) (string, error) {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", err
	}
	end := strings.LastIndex(string(b), ")")
	if end < 0 {
		return "", ErrHold
	}
	fields := strings.Fields(string(b)[end+1:])
	if len(fields) < 20 {
		return "", ErrHold
	}
	return fields[19], nil
}
func (a *Attempt) Save() error {
	a.Record.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	b, err := json.Marshal(a.Record)
	if err != nil {
		return err
	}
	name := filepath.Join(a.directory, "."+uuid.NewString()+".tmp")
	f, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(name)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(name, filepath.Join(a.directory, "record.json")); err != nil {
		return err
	}
	d, err := os.Open(a.directory)
	if err != nil {
		return err
	}
	defer d.Close()
	if err = d.Sync(); err != nil {
		return err
	}
	parent, err := os.Open(filepath.Dir(a.directory))
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}
func (a *Attempt) Phase(phase string) error { a.Record.Phase = phase; return a.Save() }
