package gitworktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
)

// Stored in the preserve commit message: durable with the ref, no second write.
type preserveReceipt struct {
	SchemaVersion string   `json:"schema_version"`
	ConeDrift     []string `json:"cone_drift"`
}

type preserveChange struct {
	Path, HeadMode, HeadBlob string
	Mode, Blob               string // Final worktree snapshot; empty means deleted.
}

func (c preserveChange) status() string {
	if c.HeadMode == "000000" {
		return "A"
	}
	if c.Mode == "" {
		return "D"
	}
	if c.HeadMode != c.Mode && (c.HeadMode == "120000" || c.Mode == "120000" || c.HeadMode == "160000" || c.Mode == "160000") {
		return "T"
	}
	return "M"
}

func (w *Workspace) preserveChanges(ctx context.Context, path string) ([]preserveChange, error) {
	// Normalize renames to D+A, matching the verification diff.
	out, err := w.run(ctx, w.binary, "-C", path, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames")
	if err != nil {
		return nil, err
	}
	changes := map[string]preserveChange{}
	for _, record := range strings.Split(string(out), "\x00") {
		if record == "" {
			continue
		}
		switch record[0] {
		case '1':
			fields := strings.SplitN(record, " ", 9)
			if len(fields) != 9 {
				return nil, fmt.Errorf("malformed porcelain v2 record")
			}
			changes[fields[8]] = preserveChange{Path: fields[8], HeadMode: fields[3], HeadBlob: fields[6], Mode: fields[5]}
		case '?':
			if !strings.HasPrefix(record, "? ") {
				return nil, fmt.Errorf("malformed untracked record")
			}
			name := record[2:]
			if _, ok := changes[name]; !ok {
				changes[name] = preserveChange{Path: name, HeadMode: "000000"}
			}
		default:
			return nil, fmt.Errorf("unsupported or unmerged porcelain record %q; worktree retained", record)
		}
	}
	names := make([]string, 0, len(changes))
	for name := range changes {
		names = append(names, name)
	}
	slices.Sort(names)
	result := make([]preserveChange, 0, len(names))
	for _, name := range names {
		c := changes[name]
		full := filepath.Join(path, name)
		info, err := os.Lstat(full)
		if os.IsNotExist(err) || errors.Is(err, syscall.ENOTDIR) {
			c.Mode = ""
			if c.HeadMode == "000000" {
				continue
			} // Staged addition then removed.
		} else if err != nil {
			return nil, err
		} else if info.IsDir() && c.Mode == "000000" && c.HeadMode != "000000" {
			// A tracked file replaced by a directory is a deletion at this path;
			// its non-ignored children have their own explicit status records.
			c.Mode = ""
		} else {
			var contents []byte
			switch {
			case info.Mode()&os.ModeSymlink != 0:
				target, err := os.Readlink(full)
				if err != nil {
					return nil, err
				}
				contents, c.Mode = []byte(target), "120000"
			case info.Mode().IsRegular():
				contents, err = os.ReadFile(full)
				if err != nil {
					return nil, err
				}
				// Porcelain respects core.fileMode=false for tracked paths.
				if c.Mode != "100644" && c.Mode != "100755" && c.Mode != "120000" {
					c.Mode = "100644"
					fileMode, configErr := w.run(ctx, w.binary, "-C", path, "config", "--bool", "core.fileMode")
					if configErr != nil && !isGitConfigMissing(configErr) {
						return nil, configErr
					}
					if strings.TrimSpace(string(fileMode)) == "false" {
						// A staged deletion has no index mode; git add into our
						// HEAD-seeded index retains HEAD's trusted executable bit.
						if c.HeadMode == "100755" {
							c.Mode = "100755"
						}
					} else if info.Mode().Perm()&0111 != 0 {
						c.Mode = "100755"
					}
					if c.HeadMode == "120000" {
						symlinks, configErr := w.run(ctx, w.binary, "-C", path, "config", "--bool", "core.symlinks")
						if configErr != nil && !isGitConfigMissing(configErr) {
							return nil, configErr
						}
						if strings.TrimSpace(string(symlinks)) == "false" {
							c.Mode = "120000"
						}
					}
				}
			case info.IsDir() && (c.Mode == "160000" || c.HeadMode == "160000"):
				blob, err := w.run(ctx, w.binary, "-C", full, "rev-parse", "--verify", "HEAD")
				if err != nil {
					return nil, err
				}
				c.Mode, c.Blob = "160000", strings.TrimSpace(string(blob))
			default:
				return nil, fmt.Errorf("cannot preserve non-file %q; worktree retained", name)
			}
			if c.Mode != "160000" {
				args := []string{"-C", path, "hash-object", "--stdin"}
				// Symlink targets are literal; regular files use git-add attributes.
				if c.Mode != "120000" {
					args = append(args, "--path="+name)
				}
				cmd := exec.CommandContext(ctx, w.binary, args...)
				cmd.Stdin = strings.NewReader(string(contents))
				hash, err := cmd.CombinedOutput()
				if err != nil {
					return nil, fmt.Errorf("snapshot %q: %w: %s", name, err, hash)
				}
				c.Blob = strings.TrimSpace(string(hash))
			}
			if c.HeadMode == c.Mode && c.HeadBlob == c.Blob {
				continue
			} // Staged edit reverted on disk.
		}
		result = append(result, c)
	}
	return result, nil
}

func (w *Workspace) verifyPreservedTree(ctx context.Context, path, head, tree string, changes []preserveChange) error {
	if head == "" {
		out, err := w.run(ctx, w.binary, "-C", path, "mktree")
		if err != nil {
			return fmt.Errorf("empty preserve base: %w", err)
		}
		head = strings.TrimSpace(string(out))
	}
	out, err := w.run(ctx, w.binary, "-C", path, "diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", head, tree)
	if err != nil {
		return fmt.Errorf("verify preserved diff: %w", err)
	}
	expected := make([]string, 0, len(changes))
	for _, c := range changes {
		expected = append(expected, c.status()+"\x00"+c.Path+"\x00")
	}
	records := strings.Split(string(out), "\x00")
	actual := make([]string, 0, len(changes))
	if len(records)%2 != 1 || records[len(records)-1] != "" {
		return fmt.Errorf("malformed preserved diff; worktree retained")
	}
	for i := 0; i+1 < len(records); i += 2 {
		actual = append(actual, records[i]+"\x00"+records[i+1]+"\x00")
	}
	slices.Sort(actual)
	slices.Sort(expected)
	if !slices.Equal(actual, expected) {
		return fmt.Errorf("preserved diff differs from real-index change set; worktree retained")
	}
	// Names/status alone miss a file changed during capture. Check saved bytes too.
	entries, err := w.run(ctx, w.binary, "-C", path, "ls-tree", "-r", "-z", tree)
	if err != nil {
		return err
	}
	blobs := map[string]string{}
	for _, entry := range strings.Split(string(entries), "\x00") {
		if entry == "" {
			continue
		}
		meta, name, ok := strings.Cut(entry, "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) != 3 {
			return fmt.Errorf("malformed preserve tree")
		}
		blobs[name] = fields[0] + " " + fields[2]
	}
	for _, c := range changes {
		if c.Mode != "" && blobs[c.Path] != c.Mode+" "+c.Blob {
			return fmt.Errorf("preserved bytes or mode changed for %q; worktree retained", c.Path)
		}
	}
	return nil
}

func (w *Workspace) preserveConeDrift(ctx context.Context, path string, changes []preserveChange) ([]string, error) {
	drift := []string{}
	out, err := w.run(ctx, w.binary, "-C", path, "config", "--bool", "core.sparseCheckout")
	if isGitConfigMissing(err) || (err == nil && strings.TrimSpace(string(out)) != "true") {
		return drift, nil
	}
	if err != nil {
		return nil, err
	}
	out, err = w.run(ctx, w.binary, "-C", path, "config", "--bool", "core.sparseCheckoutCone")
	if err != nil || strings.TrimSpace(string(out)) != "true" {
		return nil, fmt.Errorf("preserve requires cone-mode sparse checkout; worktree retained")
	}
	out, err = w.run(ctx, w.binary, "-C", path, "sparse-checkout", "list")
	if err != nil {
		return nil, err
	}
	dirs := []string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(out), "\n"), "\n") {
		if strings.HasPrefix(line, "\"") {
			line, err = strconv.Unquote(line)
			if err != nil {
				return nil, err
			}
		}
		if line != "" {
			dirs = append(dirs, line)
		}
	}
	for _, c := range changes {
		if c.Mode != "" && !sparseCheckoutContains(c.Path, dirs) {
			drift = append(drift, c.Path)
		}
	}
	return drift, nil
}
