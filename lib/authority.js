// Opt-in trusted-host authority. Existing structural OR v1 grants are unchanged.
export {
  OWNER_AUTHORITY_SCHEMA,
  authorityDigest,
  canonicalAuthorityJson,
  createOwnerAuthorityLedger,
  normalizeOwnerAuthorityEvent,
  normalizeOwnerScope,
} from '../scripts/ao/lib/owner-authority-ledger.js';
export {createOwnerRecoveryPolicy} from '../scripts/ao/lib/owner-recovery-policy.js';
