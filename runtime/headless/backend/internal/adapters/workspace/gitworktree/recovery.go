package gitworktree

// Filesystem recovery is deliberately independent of Git's ignored-file set.
// A durable sidecar owns each backup. Unknown leftovers fail closed; no age GC.
import (
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type recoveryFile struct {
	Kind string `json:"kind"`
	Hash string `json:"sha256"`
	Mode uint32 `json:"mode"`
}
type recoveryRecord struct {
	Version       int                     `json:"version"`
	Path          string                  `json:"path"`
	Repo          string                  `json:"repo"`
	Backup        string                  `json:"backup"`
	GitDir        string                  `json:"git_dir,omitempty"`
	GitBackup     string                  `json:"git_backup,omitempty"`
	Mode          string                  `json:"mode"`
	Phase         string                  `json:"phase"`
	Files         map[string]recoveryFile `json:"files"`
	After         map[string]recoveryFile `json:"verified_files,omitempty"`
	PreservedRef  string                  `json:"preserved_ref,omitempty"`
	RefPolicy     string                  `json:"ref_policy"`
	CleanupAt     string                  `json:"cleanup_at,omitempty"`
	GitFiles      map[string]recoveryFile `json:"git_files,omitempty"`
	CommonDir     string                  `json:"common_dir,omitempty"`
	CurrentDevice uint64                  `json:"current_device,omitempty"`
	CurrentInode  uint64                  `json:"current_inode,omitempty"`
}

func recoverySidecar(path string) string { return path + ".ao-recovery.json" }
func recoveryInventory(root string) (map[string]recoveryFile, error) {
	result := map[string]recoveryFile{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, e := filepath.Rel(root, path)
		if e != nil {
			return e
		}
		st, e := os.Lstat(path)
		if e != nil {
			return e
		}
		f := recoveryFile{Mode: uint32(st.Mode().Perm())}
		switch {
		case st.IsDir():
			f.Kind = "directory"
		case st.Mode()&os.ModeSymlink != 0:
			f.Kind = "symlink"
			v, e := os.Readlink(path)
			if e != nil {
				return e
			}
			h := sha256.Sum256([]byte(v))
			f.Hash = hex.EncodeToString(h[:])
		case st.Mode().IsRegular():
			f.Kind = "file"
			in, e := os.Open(path)
			if e != nil {
				return e
			}
			h := sha256.New()
			_, e = io.Copy(h, in)
			in.Close()
			if e != nil {
				return e
			}
			f.Hash = hex.EncodeToString(h.Sum(nil))
		default:
			return fmt.Errorf("cannot snapshot special file %q; original retained", rel)
		}
		result[rel] = f
		return nil
	})
	return result, err
}
func copyRecoveryTree(source, target string, skipGit bool) error {
	return filepath.WalkDir(source, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, e := filepath.Rel(source, path)
		if e != nil {
			return e
		}
		if skipGit && (rel == ".git" || strings.HasPrefix(rel, ".git/")) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		st, e := os.Lstat(path)
		if e != nil {
			return e
		}
		out := filepath.Join(target, rel)
		switch {
		case st.IsDir():
			if current, e := os.Lstat(out); e == nil && (!current.IsDir() || current.Mode()&os.ModeSymlink != 0) {
				return fmt.Errorf("recovery overlay directory collision %q", rel)
			}
			if e := os.MkdirAll(out, st.Mode().Perm()); e != nil {
				return e
			}
			return os.Chmod(out, st.Mode().Perm())
		case st.Mode()&os.ModeSymlink != 0:
			v, e := os.Readlink(path)
			if e != nil {
				return e
			}
			if old, e := os.Lstat(out); e == nil {
				if old.Mode()&os.ModeSymlink != 0 {
					if target, err := os.Readlink(out); err == nil && target == v {
						return nil
					}
				} else if !old.Mode().IsRegular() {
					return fmt.Errorf("recovery overlay symlink collision %q", rel)
				}
				// The target is the owned replacement, never the retained source.
				if err := os.Remove(out); err != nil {
					return err
				}
			} else if !os.IsNotExist(e) {
				return e
			}
			return os.Symlink(v, out)
		case st.Mode().IsRegular():
			if old, e := os.Lstat(out); e == nil && !old.Mode().IsRegular() {
				return fmt.Errorf("recovery overlay type collision %q", rel)
			}
			in, e := os.Open(path)
			if e != nil {
				return e
			}
			defer in.Close()
			f, e := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, st.Mode().Perm())
			if e != nil {
				return e
			}
			_, e = io.Copy(f, in)
			if e == nil {
				e = f.Chmod(st.Mode().Perm())
			}
			if e == nil {
				e = f.Sync()
			}
			closeErr := f.Close()
			return errors.Join(e, closeErr)
		default:
			return fmt.Errorf("cannot copy special recovery file %q", rel)
		}
	})
}
func writeRecovery(r recoveryRecord) error {
	raw, e := json.MarshalIndent(r, "", "  ")
	if e != nil {
		return e
	}
	name := recoverySidecar(r.Path)
	tmp := name + ".tmp"
	f, e := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(append(raw, '\n'))
	if e == nil {
		e = f.Sync()
	}
	e = errors.Join(e, f.Close())
	if e != nil {
		return e
	}
	if e = os.Rename(tmp, name); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(name))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func readRecovery(path string) (*recoveryRecord, error) {
	name := recoverySidecar(path)
	st, e := os.Lstat(name)
	if os.IsNotExist(e) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		return nil, fmt.Errorf("unsafe recovery receipt")
	}
	raw, e := os.ReadFile(name)
	if e != nil {
		return nil, e
	}
	var r recoveryRecord
	if e = json.Unmarshal(raw, &r); e != nil {
		return nil, e
	}
	if r.Version != 1 || r.Path != path || r.Backup != path+".ao-recovery-backup" || r.RefPolicy != "retained; explicit operator cleanup after verified cutover" {
		return nil, fmt.Errorf("unknown recovery receipt")
	}

	if len(r.Files) == 0 || (r.Mode != "copy" && r.Mode != "rename" && r.Mode != "reuse") {
		return nil, fmt.Errorf("invalid recovery manifest")
	}
	if r.GitBackup != "" && r.GitBackup != r.Backup+".git-metadata" {
		return nil, fmt.Errorf("invalid metadata backup path")
	}
	if r.GitDir != "" {
		common, e := recoveryCommonDir(r.Repo)
		if e != nil || r.CommonDir != common || filepath.Dir(r.GitDir) != filepath.Join(common, "worktrees") {
			return nil, fmt.Errorf("invalid recovery registration path: %w", e)
		}
	}
	for _, p := range []string{r.Backup, r.GitBackup} {
		if p != "" {
			if s, e := os.Lstat(p); e == nil && (!s.IsDir() || s.Mode()&os.ModeSymlink != 0) {
				return nil, fmt.Errorf("unsafe recovery backup")
			}
		}
	}
	return &r, nil
}
func sameRecoveryFiles(a, b map[string]recoveryFile, skipGit bool) bool {
	for name, x := range a {
		if skipGit && (name == ".git" || strings.HasPrefix(name, ".git/")) {
			continue
		}
		if b[name] != x {
			return false
		}
	}
	return true
}
func exactRecoveryFiles(a, b map[string]recoveryFile) bool {
	return len(a) == len(b) && sameRecoveryFiles(a, b, false)
}
func (w *Workspace) prepareRecovery(ctx context.Context, info ports.WorkspaceInfo, mode string) (*recoveryRecord, error) {
	if old, e := readRecovery(info.Path); e != nil {
		return nil, e
	} else if old != nil {
		if old.Phase == "pending" || old.Phase == "verified" {
			return old, nil
		}
		if old.Phase != "rolled_back" && old.Phase != "committed" {
			return nil, fmt.Errorf("unknown recovery phase")
		}
		if e = os.Rename(recoverySidecar(info.Path), recoverySidecar(info.Path)+"."+newWorktreeCreateToken()+".history"); e != nil {
			return nil, e
		}
	}
	backup := info.Path + ".ao-recovery-backup"
	if _, e := os.Lstat(backup); !os.IsNotExist(e) {
		return nil, fmt.Errorf("unowned recovery backup; retained")
	}
	files, e := recoveryInventory(info.Path)
	if e != nil {
		return nil, e
	}
	r := &recoveryRecord{Version: 1, Path: info.Path, Repo: info.RepoPath, Backup: backup, Mode: mode, Phase: "pending", Files: files, RefPolicy: "retained; explicit operator cleanup after verified cutover"}
	if mode == "copy" {
		st, e := os.Lstat(info.Path)
		if e != nil {
			return nil, e
		}
		id := st.Sys().(*syscall.Stat_t)
		r.CurrentDevice = uint64(id.Dev)
		r.CurrentInode = id.Ino
	}
	if mode == "copy" {
		raw, e := w.run(ctx, w.binary, "-C", info.Path, "rev-parse", "--absolute-git-dir")
		if e != nil {
			return nil, e
		}
		r.GitDir = strings.TrimSpace(string(raw))
		raw, e = w.run(ctx, w.binary, "-C", info.Path, "rev-parse", "--git-common-dir")
		if e != nil {
			return nil, e
		}
		common := strings.TrimSpace(string(raw))
		if !filepath.IsAbs(common) {
			common = filepath.Join(info.Path, common)
		}
		if !filepath.IsAbs(r.GitDir) || filepath.Clean(r.GitDir) == filepath.Clean(common) || !strings.HasPrefix(r.GitDir, filepath.Clean(common)+string(filepath.Separator)+"worktrees"+string(filepath.Separator)) {
			return nil, fmt.Errorf("recovery requires an owned linked worktree")
		}
		r.CommonDir = filepath.Clean(common)
		metadata, e := os.Lstat(r.GitDir)
		if e != nil {
			return nil, e
		}
		if uint64(metadata.Sys().(*syscall.Stat_t).Dev) != r.CurrentDevice {
			return nil, fmt.Errorf("cross-filesystem replay snapshot requires manual recovery; original retained")
		}
		r.GitFiles, e = recoveryInventory(r.GitDir)
		if e != nil {
			return nil, e
		}
		r.GitBackup = backup + ".git-metadata"
		if _, e := os.Lstat(r.GitBackup); !os.IsNotExist(e) {
			return nil, fmt.Errorf("unowned git recovery backup")
		}
		if e = copyRecoveryTree(info.Path, backup, false); e != nil {
			return nil, e
		}
		if e = copyRecoveryTree(r.GitDir, r.GitBackup, false); e != nil {
			return nil, e
		}
		meta, e := recoveryInventory(r.GitBackup)
		if e != nil || !exactRecoveryFiles(r.GitFiles, meta) {
			return nil, fmt.Errorf("git snapshot changed: %w", e)
		}

		copied, e := recoveryInventory(backup)
		if e != nil || !exactRecoveryFiles(files, copied) {
			return nil, fmt.Errorf("recovery snapshot changed: %w", e)
		}
		if e = writeRecovery(*r); e != nil {
			return nil, e
		}
	} else {
		// Record intent before the whole-directory rename. No existing bytes deleted.
		if e = writeRecovery(*r); e != nil {
			return nil, e
		}
		if e = os.Rename(info.Path, backup); e != nil {
			return nil, e
		}
	}
	return r, nil
}
func (w *Workspace) RollbackRestore(ctx context.Context, info ports.WorkspaceInfo) error {
	if _, err := w.validateManagedPath(info.Path); err != nil {
		return err
	}

	r, e := readRecovery(info.Path)
	if e != nil || r == nil {
		return e
	}
	if info.RepoPath != "" && r.Repo != info.RepoPath {
		return fmt.Errorf("recovery repo mismatch")
	}
	if r.Phase == "rolled_back" || r.Phase == "committed" {
		return nil
	}
	original, e := recoveryInventory(r.Backup)
	if os.IsNotExist(e) {
		current, ce := recoveryInventory(info.Path)
		if ce == nil && exactRecoveryFiles(r.Files, current) {
			if err := resumeRecoveryMetadata(r); err != nil {
				return err
			}
			r.Phase = "rolled_back"
			return writeRecovery(*r)
		}
	}
	if e != nil || !exactRecoveryFiles(r.Files, original) {
		return fmt.Errorf("original recovery backup unavailable; HOLD: %w", e)
	}
	if r.Mode == "copy" {
		meta, e := recoveryInventory(r.GitBackup)
		if e != nil || !exactRecoveryFiles(r.GitFiles, meta) {
			return fmt.Errorf("git recovery snapshot unavailable: %w", e)
		}
	}
	if st, e := os.Lstat(info.Path); e == nil {
		identity := st.Sys().(*syscall.Stat_t)
		if r.CurrentInode == 0 || identity.Ino != r.CurrentInode || uint64(identity.Dev) != r.CurrentDevice {
			return fmt.Errorf("replacement ownership changed; original quarantine retained")
		}
	}
	suffix := ".ao-failed-" + newWorktreeCreateToken()
	if _, e = os.Lstat(info.Path); e == nil {
		if e = os.Rename(info.Path, info.Path+suffix); e != nil {
			return e
		}
	}
	if e = os.Rename(r.Backup, info.Path); e != nil {
		return e
	}
	if r.Mode == "copy" {
		if e = resumeRecoveryMetadata(r); e != nil {
			return e
		}
	} else {
		// The replacement's private registration is moved aside, not pruned along
		// with unrelated worktrees. An originally unregistered tree stays unregistered.
		// A failed Create is otherwise responsible for its own owned registration.
		if r.GitDir != "" {
			if e = os.Rename(r.GitDir, r.Backup+suffix+".git-metadata"); e != nil {
				return e
			}
		}
	}
	current, e := recoveryInventory(info.Path)
	if e != nil || !exactRecoveryFiles(r.Files, current) {
		return fmt.Errorf("rollback byte verification failed: %w", e)
	}
	r.Phase = "rolled_back"
	return writeRecovery(*r)
}
func (w *Workspace) VerifyRestore(ctx context.Context, info ports.WorkspaceInfo) error {
	if _, err := w.validateManagedPath(info.Path); err != nil {
		return err
	}

	r, e := readRecovery(info.Path)
	if e != nil {
		return e
	}
	if r == nil {
		for _, backup := range []string{info.Path + ".ao-recovery-backup", info.Path + ".ao-recovery-backup.git-metadata"} {
			if _, err := os.Lstat(backup); !os.IsNotExist(err) {
				return fmt.Errorf("unowned recovery backup; retained")
			}
		}
		files, e := recoveryInventory(info.Path)
		if e != nil {
			return e
		}
		r = &recoveryRecord{Version: 1, Path: info.Path, Repo: info.RepoPath, Backup: info.Path + ".ao-recovery-backup", Mode: "reuse", Phase: "verified", Files: files, After: files, RefPolicy: "retained; explicit operator cleanup after verified cutover"}
		return writeRecovery(*r)
	}
	if info.RepoPath != "" && r.Repo != info.RepoPath {
		return fmt.Errorf("recovery repo mismatch")
	}
	if r.Phase == "committed" {
		return nil
	}
	if r.Phase == "rolled_back" {
		return fmt.Errorf("recovery is held after rollback")
	}
	current, e := recoveryInventory(info.Path)
	if e != nil {
		return e
	}
	// Replay may intentionally change tracked paths. Unrelated/ignored old bytes
	// must remain byte-identical. ApplyPreserved records the validated after map.
	expected := r.Files
	if r.After != nil {
		expected = r.After
	}
	if !sameRecoveryFiles(expected, current, r.Mode == "rename") {
		return fmt.Errorf("restored physical file manifest differs")
	}
	r.After = current
	r.Phase = "verified"
	return writeRecovery(*r)
}
func (w *Workspace) CommitRestore(ctx context.Context, info ports.WorkspaceInfo) error {
	if _, err := w.validateManagedPath(info.Path); err != nil {
		return err
	}

	r, e := readRecovery(info.Path)
	if e != nil || r == nil {
		return e
	}
	if info.RepoPath != "" && r.Repo != info.RepoPath {
		return fmt.Errorf("recovery repo mismatch")
	}
	if r.Phase == "committed" {
		return nil
	}
	if r.Phase != "verified" {
		return fmt.Errorf("refuse recovery cleanup before verification")
	}
	current, e := recoveryInventory(info.Path)
	if e != nil || !exactRecoveryFiles(r.After, current) {
		return fmt.Errorf("refuse recovery cleanup after drift: %w", e)
	}
	// Only this receipt's backups are eligible, after both replay and physical
	// verification. Never remove a preserved Git ref, even on success.
	if r.Mode != "reuse" {
		if original, e := recoveryInventory(r.Backup); e == nil && !exactRecoveryFiles(r.Files, original) {
			return fmt.Errorf("refuse cleanup of changed backup")
		}
		if e = os.RemoveAll(r.Backup); e != nil {
			return e
		}
	}
	if r.GitBackup != "" {
		if e = os.RemoveAll(r.GitBackup); e != nil {
			return e
		}
	}
	r.Phase = "committed"
	r.CleanupAt = time.Now().UTC().Format(time.RFC3339Nano)
	return writeRecovery(*r)
}

// Replay path set and final tree are read from the bound commit, never output
// text. A working tree already containing that snapshot needs no cherry-pick.

// Complete only metadata whose original bytes are bound by this receipt. This
// also resumes crashes between moving the original directory and its index.
func resumeRecoveryMetadata(r *recoveryRecord) error {
	if r.Mode != "copy" || r.GitBackup == "" {
		return nil
	}
	backup, err := recoveryInventory(r.GitBackup)
	if os.IsNotExist(err) {
		current, e := recoveryInventory(r.GitDir)
		if e == nil && exactRecoveryFiles(r.GitFiles, current) {
			return nil
		}
		return fmt.Errorf("original Git metadata unavailable; HOLD")
	}
	if err != nil || !exactRecoveryFiles(r.GitFiles, backup) {
		return fmt.Errorf("Git metadata backup differs; HOLD: %w", err)
	}
	if st, e := os.Lstat(r.GitDir); e == nil {
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Git registration ownership changed; HOLD")
		}
		if e = os.Rename(r.GitDir, r.Backup+".ao-failed-"+newWorktreeCreateToken()+".git-metadata"); e != nil {
			return e
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	if err := os.Rename(r.GitBackup, r.GitDir); err != nil {
		return err
	}
	current, err := recoveryInventory(r.GitDir)
	if err != nil || !exactRecoveryFiles(r.GitFiles, current) {
		return fmt.Errorf("restored Git metadata differs: %w", err)
	}
	return nil
}

type replayEntry struct{ Mode, Blob string }

func (w *Workspace) replayPaths(ctx context.Context, path, commit string) ([]string, map[string]replayEntry, error) {
	out, e := w.run(ctx, w.binary, "-C", path, "diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", commit)
	if e != nil {
		return nil, nil, e
	}
	names := strings.Split(strings.TrimSuffix(string(out), "\x00"), "\x00")
	if len(names) == 1 && names[0] == "" {
		names = nil
	}
	out, e = w.run(ctx, w.binary, "-C", path, "ls-tree", "-r", "-z", commit)
	if e != nil {
		return nil, nil, e
	}
	tree := map[string]replayEntry{}
	for _, entry := range strings.Split(string(out), "\x00") {
		if entry == "" {
			continue
		}
		meta, name, ok := strings.Cut(entry, "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) != 3 {
			return nil, nil, fmt.Errorf("malformed replay tree")
		}
		tree[name] = replayEntry{Mode: fields[0], Blob: fields[2]}
	}
	return names, tree, nil
}
func (w *Workspace) replaySnapshotPresent(ctx context.Context, path string, names []string, tree map[string]replayEntry, protectCurrent bool) (bool, error) {
	dirty := map[string]bool{}
	dirtyLoaded := false
	isDirty := func(name string) (bool, error) {
		if !protectCurrent {
			return false, nil
		}
		if !dirtyLoaded {
			out, e := w.run(ctx, w.binary, "-C", path, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames")
			if e != nil {
				return false, e
			}
			for _, record := range strings.Split(string(out), "\x00") {
				if record == "" {
					continue
				}
				if strings.HasPrefix(record, "? ") {
					dirty[record[2:]] = true
				} else if strings.HasPrefix(record, "1 ") {
					fields := strings.SplitN(record, " ", 9)
					if len(fields) != 9 {
						return false, fmt.Errorf("invalid WIP status")
					}
					dirty[fields[8]] = true
				} else {
					return false, fmt.Errorf("unmerged or unknown WIP must remain held")
				}
			}
			dirtyLoaded = true
		}
		return dirty[name], nil
	}
	for _, name := range names {
		if filepath.IsAbs(name) || filepath.Clean(name) == ".." || strings.HasPrefix(filepath.Clean(name), ".."+string(filepath.Separator)) {
			return false, fmt.Errorf("unsafe replay path")
		}
		full := filepath.Join(path, name)
		for parent := filepath.Dir(full); parent != path; parent = filepath.Dir(parent) {
			st, e := os.Lstat(parent)
			if e != nil {
				if os.IsNotExist(e) || errors.Is(e, syscall.ENOTDIR) {
					break
				}
				return false, e
			}
			if st.Mode()&os.ModeSymlink != 0 {
				return false, fmt.Errorf("refuse replay through symlink parent")
			}
		}

		st, e := os.Lstat(full)
		expected, exists := tree[name]
		if protected, e := isDirty(name); e != nil {
			return false, e
		} else if protected {
			continue
		}
		if !exists {
			if os.IsNotExist(e) || errors.Is(e, syscall.ENOTDIR) {
				continue
			}
			if e != nil {
				return false, e
			}
			if st.IsDir() {
				directory := false
				for candidate := range tree {
					if strings.HasPrefix(candidate, name+"/") {
						directory = true
						break
					}
				}
				if directory {
					continue
				}
			}
			return false, nil
		}
		if os.IsNotExist(e) {
			return false, nil
		}
		if e != nil {
			return false, e
		}
		mode := "100644"
		if st.Mode()&os.ModeSymlink != 0 {
			mode = "120000"
		} else if st.Mode().IsRegular() && st.Mode().Perm()&0111 != 0 {
			mode = "100755"
		}
		if expected.Mode == "120000" && st.Mode().IsRegular() {
			// Git's explicit core.symlinks=false represents a symlink blob as a
			// regular file. This is the only admitted physical type translation.
			value, err := w.run(ctx, w.binary, "-C", path, "config", "--bool", "core.symlinks")
			if err != nil && !isGitConfigMissing(err) {
				return false, err
			}
			if strings.TrimSpace(string(value)) == "false" {
				mode = "120000"
			}
		}
		if mode != expected.Mode {
			return false, nil
		}
		var contents []byte
		if st.Mode()&os.ModeSymlink != 0 {
			v, e := os.Readlink(full)
			if e != nil {
				return false, e
			}
			contents = []byte(v)
		} else if st.Mode().IsRegular() {
			contents, e = os.ReadFile(full)
			if e != nil {
				return false, e
			}
		} else {
			return false, nil
		}
		h := gitBlobHash(contents)
		if h != expected.Blob {
			// Attribute filters/EOL conversion are uncommon. Preserve their exact Git
			// semantics without spawning one Git process per ordinary file.
			cmd := exec.CommandContext(ctx, w.binary, "-C", path, "hash-object", "--stdin", "--path="+name)
			cmd.Stdin = bytes.NewReader(contents)
			out, e := cmd.Output()
			if e != nil {
				return false, e
			}
			if strings.TrimSpace(string(out)) != expected.Blob {
				return false, nil
			}
		}
	}
	return true, nil
}
func gitBlobHash(data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}
func (w *Workspace) applyPreservedSafely(ctx context.Context, info ports.WorkspaceInfo, ref, commit string) (err error) {
	names, tree, e := w.replayPaths(ctx, info.Path, commit)
	if e != nil {
		return e
	}
	present, e := w.replaySnapshotPresent(ctx, info.Path, names, tree, true)
	if e != nil {
		return e
	}
	if present {
		return nil
	}
	// Existing dirty paths must not be overwritten by an older preserve ref.
	changes, e := w.preserveChanges(ctx, info.Path)
	if e != nil {
		return e
	}
	wanted := map[string]bool{}
	for _, name := range names {
		wanted[name] = true
	}
	for _, change := range changes {
		if wanted[change.Path] && (change.Blob != tree[change.Path].Blob || change.Mode != tree[change.Path].Mode) {
			return fmt.Errorf("%w: current WIP differs at %q; retained in place", ports.ErrPreservedConflict, change.Path)
		}
	}
	// An ignored file can otherwise be silently overwritten during cone expansion.
	for _, name := range names {
		if _, e := os.Lstat(filepath.Join(info.Path, name)); e == nil {
			_, ignoreErr := w.run(ctx, w.binary, "-C", info.Path, "check-ignore", "-q", "--", name)
			if ignoreErr == nil {
				return fmt.Errorf("%w: ignored replay collision at %q", ports.ErrPreservedConflict, name)
			}
		}
	}
	r, e := w.prepareRecovery(ctx, info, "copy")
	if e != nil {
		return e
	}
	r.PreservedRef = ref
	if e = writeRecovery(*r); e != nil {
		return e
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, w.RollbackRestore(context.WithoutCancel(ctx), info))
		}
	}()
	if e = w.materializePreservedPaths(ctx, info.Path, commit); e != nil {
		return e
	}
	if e = w.runCherryPickNoCommit(ctx, info.Path, commit); e != nil {
		return fmt.Errorf("%w: %w", ports.ErrPreservedConflict, e)
	}
	present, e = w.replaySnapshotPresent(ctx, info.Path, names, tree, false)
	if e != nil || !present {
		return fmt.Errorf("replayed bytes not verified (read error: %v)", e)
	}
	current, e := recoveryInventory(info.Path)
	if e != nil {
		return e
	}
	for name, before := range r.Files {
		if name == ".git" || strings.HasPrefix(name, ".git/") || wanted[name] {
			continue
		}
		if current[name] != before {
			if before.Kind == "directory" {
				if _, exists := current[name]; !exists && replayRemovedDirectory(name, r.Files, wanted, tree) {
					continue
				}
			}
			return fmt.Errorf("unrelated/ignored bytes changed at %q", name)
		}
	}
	r.After = current
	return writeRecovery(*r)
}

func recoveryCommonDir(repo string) (string, error) {
	if !filepath.IsAbs(repo) {
		return "", fmt.Errorf("invalid repo")
	}
	dot := filepath.Join(repo, ".git")
	st, e := os.Lstat(dot)
	if e != nil {
		return "", e
	}
	if st.IsDir() {
		return dot, nil
	}
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("unsafe repo git pointer")
	}
	raw, e := os.ReadFile(dot)
	if e != nil {
		return "", e
	}
	v := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(v, "gitdir: ") {
		return "", fmt.Errorf("invalid repo git pointer")
	}
	gd := strings.TrimPrefix(v, "gitdir: ")
	if !filepath.IsAbs(gd) {
		gd = filepath.Join(repo, gd)
	}
	raw, e = os.ReadFile(filepath.Join(gd, "commondir"))
	if e != nil {
		return "", e
	}
	common := strings.TrimSpace(string(raw))
	if !filepath.IsAbs(common) {
		common = filepath.Join(gd, common)
	}
	return filepath.Clean(common), nil
}

func replayRemovedDirectory(name string, original map[string]recoveryFile, wanted map[string]bool, tree map[string]replayEntry) bool {
	removed := false
	for path, before := range original {
		if !strings.HasPrefix(path, name+"/") || before.Kind == "directory" {
			continue
		}
		if _, present := tree[path]; !wanted[path] || present {
			return false
		}
		removed = true
	}
	return removed
}
