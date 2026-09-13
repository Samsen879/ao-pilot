import {authorityDigest, normalizeOwnerScope} from './owner-authority-ledger.js';

// Trusted-host API, deliberately without a CLI module-loader or unsigned fallback.
// Enrollment is explicit on a binding. Unenrolled v1 recovery remains outside this contract.
export function createOwnerRecoveryPolicy({ledger, reconcileExecutionAndPermit}) {
  if(typeof ledger?.consumeAndPermit !== 'function' || typeof reconcileExecutionAndPermit !== 'function') throw new Error('Trusted ledger and execution observer required; HOLD');
  return {
    async restore(id,binding,permit) {
      const enrollment=binding.authorityEnrollment;
      if(!enrollment || enrollment.schema_version!=='ao.owner-recovery-enrollment.v1' ||
         Object.keys(enrollment).sort().join(',')!=='gate_proofs,invocation_id,schema_version,scope') throw new Error('Invalid recovery enrollment; HOLD');
      const scope=normalizeOwnerScope(enrollment.scope);
      if(scope.session_id!==id || scope.project_id!==binding.projectId || scope.prior_invocation_id===null) throw new Error('Recovery enrollment identity mismatch; HOLD');
      return ledger.consumeAndPermit({scope,action:'conversation.restore',invocationId:enrollment.invocation_id,gateProofs:enrollment.gate_proofs},
        () => reconcileExecutionAndPermit(id,binding,scope,async observation => {
          if(!observation || !['completed','interrupted'].includes(observation.state) ||
             observation.evidence_status!=='established' ||
             observation.invocation_id!==scope.prior_invocation_id ||
             authorityDigest(observation.bound_scope)!==authorityDigest(scope)) throw new Error('Execution not safely terminal or identity unknown; HOLD');
          return permit();
        }));
    },
  };
}
