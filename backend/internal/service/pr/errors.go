package pr

import "errors"

// Sentinel errors returned by the PR action service.
var (
	ErrPRNotFound       = errors.New("pr: not found")
	ErrPRAmbiguous      = errors.New("pr: ambiguous ownership")
	ErrPROwnerInactive  = errors.New("pr: owner inactive")
	ErrPRHeadChanged    = errors.New("pr: head changed")
	ErrPRNotMergeable   = errors.New("pr: not mergeable")
	ErrPRPreconditions  = errors.New("pr: merge preconditions unmet")
	ErrPRProvider       = errors.New("pr: provider failure")
	ErrPRMergeMismatch  = errors.New("pr: merge readback mismatch")
	ErrPRNotImplemented = errors.New("pr: action not implemented")
	ErrNothingToResolve = errors.New("pr: nothing to resolve")
)
