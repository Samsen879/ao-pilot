package runfile

import (
	"errors"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/ownership"
)

const ExpectedInstanceHeader = "X-AO-Expected-Instance"
const LegacyInstance = "legacy-owner"

var ErrOwnerAlive = errors.New("recorded AO owner is alive or cannot be proven stopped")
var ErrSuccessor = errors.New("daemon discovery has been taken over by another instance")

type ProcessProbe func(int) (bool, error)

// Publisher holds both admission locks. It is the only production writer of
// running.json; readers do not acquire leases.
type Publisher struct{ lease *ownership.Lease }

// Admit rejects even a legacy live PID with failed health. Old binaries do not
// obey our locks, so a successful lock acquisition alone cannot prove absence.
func Admit(dataDir, runFile string, probe ProcessProbe) (*Publisher, error) {
	lease, err := ownership.Acquire(dataDir, runFile)
	if err != nil {
		return nil, err
	}
	if probe == nil {
		probe = ownership.ProcessAlive
	}
	err = lease.Do(func() error {
		info, err := Read(lease.RunFile())
		if err != nil {
			return err
		}
		if info == nil {
			return nil
		}
		alive, err := probe(info.PID)
		if err != nil {
			return fmt.Errorf("%w: pid %d: %v", ErrOwnerAlive, info.PID, err)
		}
		if alive {
			return fmt.Errorf("%w: pid %d; stop and confirm the previous process first", ErrOwnerAlive, info.PID)
		}
		return remove(lease.RunFile())
	})
	if err != nil {
		_ = lease.Close()
		return nil, err
	}
	return &Publisher{lease: lease}, nil
}

func (p *Publisher) DataDir() string         { return p.lease.DataDir() }
func (p *Publisher) RunFile() string         { return p.lease.RunFile() }
func (p *Publisher) InstanceID() string      { return p.lease.InstanceID() }
func (p *Publisher) RetainForProcess() error { return p.lease.RetainForProcess() }

// Close releases an unretained fixture/short owner, never a process owner.
func (p *Publisher) Close() error { return p.lease.Close() }

func (p *Publisher) info(info Info) Info {
	info.InstanceID = p.InstanceID()
	info.DataDir = p.DataDir()
	return info
}
func (p *Publisher) Publish(info Info) error {
	return p.lease.Do(func() error {
		current, err := Read(p.RunFile())
		if err != nil {
			return err
		}
		if current != nil && (current.InstanceID != p.InstanceID() || current.DataDir != p.DataDir()) {
			return ErrSuccessor
		}
		return write(p.RunFile(), p.info(info))
	})
}
func (p *Publisher) Restore(info Info) (restored bool, err error) {
	err = p.lease.Do(func() error { var err error; restored, err = restoreIfMissing(p.RunFile(), p.info(info)); return err })
	return
}
func (p *Publisher) Remove() error {
	return p.lease.Do(func() error {
		info, err := Read(p.RunFile())
		if err != nil {
			return err
		}
		if info == nil {
			return nil
		}
		if info.InstanceID != p.InstanceID() || info.DataDir != p.DataDir() {
			return ErrSuccessor
		}
		return remove(p.RunFile())
	})
}

// CleanupStopped acquires the same two locks as a daemon. Missing discovery is
// not sufficient: a recovering or draining process may still hold either lock.
// expected binds a stop to its original record; nil only accepts missing files.
func CleanupStopped(dataDir, runFile string, expected *Info, probe ProcessProbe) error {
	lease, err := ownership.Acquire(dataDir, runFile)
	if err != nil {
		return err
	}
	defer lease.Close()
	if probe == nil {
		probe = ownership.ProcessAlive
	}
	return lease.Do(func() error {
		current, err := Read(lease.RunFile())
		if err != nil {
			return err
		}
		if expected != nil {
			alive, err := probe(expected.PID)
			if err != nil {
				return fmt.Errorf("%w: %v", ErrOwnerAlive, err)
			}
			if alive {
				return ErrOwnerAlive
			}
		}
		if current == nil {
			return nil
		}
		if expected == nil || !sameInstance(current, expected) {
			return ErrSuccessor
		}
		// Never remove a differently bound namespace, even if its PID is gone.
		if current.DataDir != "" && current.DataDir != lease.DataDir() {
			return ErrSuccessor
		}
		return remove(lease.RunFile())
	})
}
func sameInstance(a, b *Info) bool {
	if a.InstanceID != "" || b.InstanceID != "" {
		return a.InstanceID != "" && a.InstanceID == b.InstanceID && a.PID == b.PID && a.DataDir == b.DataDir
	}
	return a.PID == b.PID && a.Port == b.Port && a.StartedAt.Equal(b.StartedAt)
}
