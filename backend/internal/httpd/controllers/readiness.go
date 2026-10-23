package controllers

// Readiness is separate from boot admission: degraded recovery endpoints stay
// reachable while /readyz remains 503 for strict installation verification.
type ReadinessReason struct {
	Code    string `json:"code" description:"Stable diagnostic code; additional dependency codes may be added."`
	Message string `json:"message"`
}

type ReadinessSnapshot struct {
	Status  string            `json:"status" enum:"starting,ready,degraded"`
	Ready   bool              `json:"ready"`
	Reasons []ReadinessReason `json:"reasons"`
}

type ReadinessResponse struct {
	ReadinessSnapshot
	Service                 string `json:"service"`
	PID                     int    `json:"pid"`
	ExecutablePath          string `json:"executablePath,omitempty"`
	WorkingDirectory        string `json:"workingDirectory,omitempty"`
	StartupWorkingDirectory string `json:"startupWorkingDirectory,omitempty"`
}
