package tmux

import (
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
)

// ParseCgroups parses /proc/PID/cgroup without equating a substring with a
// cgroup ancestry. Controller names, rather than v1 numeric hierarchy IDs,
// identify the same hierarchy across process observations.
func ParseCgroups(data []byte) (map[string]string, error) {
	groups := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		fields := strings.SplitN(line, ":", 3)
		if len(fields) != 3 || fields[0] == "" || !strings.HasPrefix(fields[2], "/") || strings.ContainsAny(fields[2], "\x00\r") {
			return nil, fmt.Errorf("invalid cgroup record")
		}
		hierarchy, err := strconv.Atoi(fields[0])
		if err != nil || hierarchy < 0 {
			return nil, fmt.Errorf("invalid cgroup hierarchy ID")
		}
		names := strings.Split(fields[1], ",")
		sort.Strings(names)
		key := "v1:" + strings.Join(names, ",")
		if fields[1] == "" {
			if fields[0] != "0" {
				return nil, fmt.Errorf("unknown cgroup hierarchy")
			}
			key = "v2"
		}
		if _, exists := groups[key]; exists {
			return nil, fmt.Errorf("duplicate cgroup hierarchy")
		}
		clean := path.Clean(fields[2])
		if clean != fields[2] {
			return nil, fmt.Errorf("noncanonical cgroup path")
		}
		groups[key] = clean
	}
	if len(groups) == 0 {
		return nil, fmt.Errorf("empty cgroup membership")
	}
	return groups, nil
}

func inCgroup(child, parent string) bool {
	return child == parent || parent == "/" || strings.HasPrefix(child, parent+"/")
}

// IndependentCgroups validates the complete observation, then compares only
// the hierarchy systemd uses for unit ownership and KillMode. Resource-only v1
// controllers may legitimately place sibling units in the same root/user group.
func IndependentCgroups(server, daemon map[string]string) (bool, error) {
	if len(server) != len(daemon) || len(server) == 0 {
		return false, fmt.Errorf("cgroup hierarchies do not correspond")
	}
	for key := range daemon {
		if _, found := server[key]; !found {
			return false, fmt.Errorf("missing cgroup hierarchy %s", key)
		}
	}
	serverOwner, err := systemdCgroup(server)
	if err != nil {
		return false, err
	}
	daemonOwner, err := systemdCgroup(daemon)
	if err != nil {
		return false, err
	}
	return !inCgroup(serverOwner, daemonOwner), nil
}

func systemdCgroup(groups map[string]string) (string, error) {
	// In a hybrid layout, a resource-only unified mount may coexist with the
	// v1 named systemd hierarchy. The named hierarchy remains ownership authority.
	if group, ok := groups["v1:name=systemd"]; ok {
		return group, nil
	}
	if group, ok := groups["v2"]; ok {
		return group, nil
	}
	return "", fmt.Errorf("systemd cgroup hierarchy unavailable")
}
