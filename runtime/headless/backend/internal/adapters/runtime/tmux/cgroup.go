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

// IndependentCgroups fails closed if any hierarchy cannot be compared. Being
// outside the daemon only on one controller is insufficient for v1.
func IndependentCgroups(server, daemon map[string]string) (bool, error) {
	if len(server) != len(daemon) || len(server) == 0 {
		return false, fmt.Errorf("cgroup hierarchies do not correspond")
	}
	for key, group := range daemon {
		current, found := server[key]
		if !found {
			return false, fmt.Errorf("missing cgroup hierarchy %s", key)
		}
		if inCgroup(current, group) {
			return false, nil
		}
	}
	return true, nil
}

func systemdCgroup(groups map[string]string) (string, error) {
	if group, ok := groups["v2"]; ok {
		return group, nil
	}
	if group, ok := groups["v1:name=systemd"]; ok {
		return group, nil
	}
	return "", fmt.Errorf("systemd cgroup hierarchy unavailable")
}
