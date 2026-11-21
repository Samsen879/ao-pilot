package cli

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
)

// Build metadata. Release tooling can override these with -ldflags.
var (
	Version = "dev"
	Commit  = ""
	Date    = ""
)

// VersionString renders the build metadata as "<version> commit <c> built <d>",
// omitting the commit/date parts when they are unset.
func VersionString() string {
	parts := []string{Version}
	if Commit != "" {
		parts = append(parts, "commit "+Commit)
	}
	if Date != "" {
		parts = append(parts, "built "+Date)
	}
	return strings.Join(parts, " ")
}

// Package identity comes from the runtime pin selected by the adjacent release
// manifest. Standalone binaries can only report their own build metadata.
type executableIdentity struct {
	Version      string `json:"version"`
	Commit       string `json:"commit,omitempty"`
	Tree         string `json:"tree,omitempty"`
	ReleaseID    string `json:"release_id,omitempty"`
	BinarySHA256 string `json:"binary_sha256"`
}

func identifyExecutable(exe, runningImage string) (executableIdentity, error) {
	id := executableIdentity{Version: Version, Commit: Commit}
	f, err := os.Open(runningImage)
	if err != nil {
		return id, err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, f); err != nil {
		return id, err
	}
	id.BinarySHA256 = fmt.Sprintf("%x", hash.Sum(nil))
	if filepath.Base(exe) != "ao" || filepath.Base(filepath.Dir(exe)) != "native" {
		return id, nil
	}
	root := filepath.Dir(filepath.Dir(exe))
	data, err := os.ReadFile(filepath.Join(root, "release.json"))
	if errors.Is(err, os.ErrNotExist) {
		return id, nil
	}
	if err != nil {
		return id, err
	}
	var manifest struct {
		executableIdentity
		Schema string `json:"schema_version"`
		Lock   struct {
			Kind         string `json:"kind"`
			SHA256       string `json:"sha256"`
			BinarySHA256 string `json:"binary_sha256"`
			Commit       string `json:"commit"`
			Tree         string `json:"tree"`
		} `json:"runtime_lock"`
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		return id, err
	}
	if manifest.Schema != "ao.release.v1" || manifest.Lock.BinarySHA256 != id.BinarySHA256 {
		return id, errors.New("release manifest differs from executable")
	}
	if manifest.Lock.Kind == "" { // Earlier releases selected the archived lock.
		archived, err := os.ReadFile(filepath.Join(root, "runtime", "agent-orchestrator.lock.json"))
		if err != nil {
			return id, err
		}
		if fmt.Sprintf("%x", sha256.Sum256(archived)) != manifest.Lock.SHA256 {
			return id, errors.New("archived runtime lock differs from manifest")
		}
		id.ReleaseID = manifest.ReleaseID
		id.Version = manifest.Version
		id.Commit = manifest.Lock.Commit
		id.Tree = manifest.Lock.Tree
		return id, nil
	}
	if manifest.Lock.Kind != "candidate" {
		return id, errors.New("unknown release runtime lock")
	}
	pinBytes, err := os.ReadFile(filepath.Join(root, "release", "runtime-pin.json"))
	if err != nil {
		return id, err
	}
	var pin struct {
		executableIdentity
		Schema string `json:"schema_version"`
	}
	if err = json.Unmarshal(pinBytes, &pin); err != nil {
		return id, err
	}
	gitID := regexp.MustCompile("^[0-9a-f]{40}$")
	if fmt.Sprintf("%x", sha256.Sum256(pinBytes)) != manifest.Lock.SHA256 || pin.Schema != "ao.release-runtime-pin.v1" ||
		pin.BinarySHA256 != id.BinarySHA256 || !gitID.MatchString(pin.Commit) || !gitID.MatchString(pin.Tree) ||
		pin.Commit != manifest.Lock.Commit || pin.Tree != manifest.Lock.Tree || pin.Commit != manifest.Commit || pin.Tree != manifest.Tree ||
		pin.Version == "" || pin.Version != manifest.Version || pin.ReleaseID != manifest.ReleaseID || pin.ReleaseID != pin.Version+"+"+pin.Commit {
		return id, errors.New("candidate runtime pin differs from manifest or executable")
	}
	return pin.executableIdentity, nil
}

func newVersionCommand() *cobra.Command {
	var asJSON bool
	command := &cobra.Command{
		Use: "version", Short: "Print version information", Args: noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			runningImage := exe
			if runtime.GOOS == "linux" {
				runningImage = "/proc/self/exe"
			}
			id, err := identifyExecutable(exe, runningImage)
			if err != nil {
				return err
			}
			if asJSON {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(id)
			}
			label := VersionString()
			if id.ReleaseID != "" {
				label = id.ReleaseID + " binary " + id.BinarySHA256
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), label)
			return err
		},
	}
	command.Flags().BoolVar(&asJSON, "json", false, "Print release, source and executable identity as JSON")
	return command
}
