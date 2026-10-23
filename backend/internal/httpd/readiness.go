package httpd

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"sort"
)

// ReadinessReason uses stable codes; messages are diagnostic, not API enums.
type ReadinessReason = controllers.ReadinessReason
type ReadinessSnapshot = controllers.ReadinessSnapshot

// MarkDegraded records a dependency failure without admitting a still-booting
// daemon. MarkReady independently completes boot admission for recovery APIs.
func (s *Server) MarkDegraded(reasons ...ReadinessReason) {
	s.readinessMu.Lock()
	defer s.readinessMu.Unlock()
	if s.degraded == nil {
		s.degraded = make(map[string]string)
	}
	for _, r := range reasons {
		if r.Code != "" {
			s.degraded[r.Code] = r.Message
		}
	}
}

func (s *Server) ClearDegraded(code string) {
	s.readinessMu.Lock()
	defer s.readinessMu.Unlock()
	delete(s.degraded, code)
}

func (s *Server) Readiness() ReadinessSnapshot {
	s.readinessMu.RLock()
	defer s.readinessMu.RUnlock()
	out := ReadinessSnapshot{Status: "starting", Reasons: []ReadinessReason{}}
	for code, message := range s.degraded {
		out.Reasons = append(out.Reasons, ReadinessReason{Code: code, Message: message})
	}
	sort.Slice(out.Reasons, func(i, j int) bool { return out.Reasons[i].Code < out.Reasons[j].Code })
	if s.ready.Load() {
		out.Status, out.Ready = "ready", true
	}
	if len(out.Reasons) > 0 {
		out.Status, out.Ready = "degraded", false
	}
	return out
}
