# OR Authorization Grants

`ao.or-authorization-grant.v1` is the durable authorization envelope for an
Orchestrator (OR) to perform already-admitted repository work without a routine
human approval step. It defines authority; it does not execute a merge, obtain
credentials, or optimize policy globally.

The public JSON Schema is
[`schemas/ao.or-authorization-grant.v1.schema.json`](../../schemas/ao.or-authorization-grant.v1.schema.json).
The contract functions are exported from `ao-pilot/contracts` and the package
root.

## Authority boundary

Every grant binds all of the following as contract fields:

- immutable issuer authority and exact OR subject/session;
- repository numeric identity and case-sensitive `owner/name` slug;
- task identity, issue number, and admission reference;
- an enumerated effect/action allow-list with no wildcard action;
- exact base/head branch refs, admitted base SHA, PR numbers, and optional merge
  method/base/head;
- issue and expiry timestamps, live revocation-registry freshness, audience,
  nonce, and single-use-per-action ledger;
- fresh, independent, exact-head review requirements for merge; and
- non-destructive rollback strategy plus a durable recovery reference.

All objects are closed. Unknown fields are invalid, and `metadata`, `prompt`, or
`instructions` are explicitly treated as attempted scope expansion by the
evaluator. Contract strings reject padding, whitespace, and wildcard syntax.
Repository, task, subject, branch, PR, and action comparisons are exact; case
folding or display text never participates in authorization.

## Validation and fingerprints

`normalizeAuthorizationGrant` and `normalizeAuthorizationRequest` require exact
keys and supported v1 values. `canonicalAuthorizationGrant` sorts object keys
and set-like action/reference arrays before emitting canonical UTF-8 JSON.
`authorizationGrantFingerprint` is SHA-256 over those bytes.

`authorizationPolicyInput` contains only the normalized request and the grant
fingerprint. `authorizationPolicyInputFingerprint` is SHA-256 over its canonical
bytes. Object insertion order and allow-list order therefore cannot change a
policy identity, while any semantic repository, task, effect, branch, PR,
review, revocation, rollback, or replay change does.

If an input is rejected before request normalization, the same exported policy
input function emits a closed rejected-input projection containing the canonical
raw request fingerprint. Escalation records therefore remain reproducible with
the public fingerprint API without treating rejected fields as authority.

Before returning `authorize`, `evaluateAuthorizationGrant` requires:

1. a currently valid grant and exact repository/task/subject/audience scope;
2. an explicitly allowed effect/action and exact branch/PR bindings;
3. recent active revocation evidence from the bound registry for the exact grant
   fingerprint;
4. recent `unused` evidence from the bound replay ledger for the exact grant
   fingerprint, action key, and request ID; and
5. for merge only, the bound method/base/head plus fresh independent approval
   of that exact head.

Routine in-scope review requests and exact-head merges return
`exact_scope_authorized`. The caller remains responsible for atomically marking
the ledger use and performing the provider operation; this module never performs
an external effect.

## Fail-closed outcomes

Ordinary absence or invalidity—expired, revoked, missing review, stale evidence,
mixed version, or replay—returns `deny` with no human gate. Cross-project,
cross-task, cross-subject, action, branch, PR, or audience substitution is never
silently normalized.

Only these four admitted exception classes return `escalate`:

| Durable `reason_kind` | Trigger class |
| --- | --- |
| `authority_scope_expansion` | Any requested authority outside exact grant scope, including descriptive scope material |
| `irreversible_effect_ambiguity` | Merge or recovery bindings are incomplete or contradictory |
| `security_or_credential_boundary` | A request or grant attempts to carry credential/security authority |
| `destructive_migration_or_rollback` | Destructive rollback, delete, destroy, or force-push authority is requested |

Every escalation includes canonical grant and policy-input fingerprints, both
the authorized and requested repository/task context when available, the recovery reference, timestamp, and
a content-derived identifier under
`ao.or-authorization-escalation.v1`. The corresponding closed Schema is
[`schemas/ao.or-authorization-escalation.v1.schema.json`](../../schemas/ao.or-authorization-escalation.v1.schema.json).
Malformed pre-normalization repository/task values are recorded as `null`; their
exact raw bytes remain auditable through the rejected policy-input fingerprint.

Durable positive, negative, expired, revoked, missing, mixed-version,
cross-scope, and replay fixtures live in
[`tests/ao/fixtures/or-authorization/pack.v1.json`](../../tests/ao/fixtures/or-authorization/pack.v1.json).
