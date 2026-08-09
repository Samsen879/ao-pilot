import { describe, expect, it } from '@jest/globals';

import {
  RELEASE_JUDGMENT_SCHEMA_VERSION,
  RELEASE_READY_AUTHORITY_SCOPE,
  adaptLifecycleReportForObservation,
  createReleaseReadyDecision,
} from '../../scripts/ao/lib/release-judgment.js';

describe('release judgment migration', () => {
  it('defines release_ready as OR-preflight authority with explicit non-claims', () => {
    expect(createReleaseReadyDecision()).toEqual({
      disposition: 'release_ready',
      basis: ['release_preflight_authorized'],
      authoritative: true,
      judgment_contract: RELEASE_JUDGMENT_SCHEMA_VERSION,
      authority_scope: RELEASE_READY_AUTHORITY_SCOPE,
      claims: {
        merge: false,
        external_effect: false,
        human_approval: false,
      },
    });
  });

  it('observes a legacy notification report canonically without mutating its interpretation', () => {
    const legacyReport = {
      schema_version: 'ao.lifecycle.v1alpha1',
      release_decision: {
        disposition: 'notify_human_ready',
        basis: ['ready_for_human_notification'],
        authoritative: true,
      },
      findings: [],
      actions: [{
        id: 'notify_human_ready',
        action_class: 'notify_human',
        summary: 'Notify the human.',
        commands: ['gh pr view 44'],
        rationale: 'Legacy notification.',
      }],
    };
    const before = JSON.stringify(legacyReport);

    const observed = adaptLifecycleReportForObservation(legacyReport);

    expect(JSON.stringify(legacyReport)).toBe(before);
    expect(observed.release_decision).toEqual(legacyReport.release_decision);
    expect(observed.release_decision_observation).toMatchObject({
      disposition: 'release_ready',
      basis: ['release_preflight_authorized'],
      authority_scope: 'observation_only',
      source_interpretation: {
        schema_version: 'ao.lifecycle.v1alpha1',
        disposition: 'notify_human_ready',
        basis: ['ready_for_human_notification'],
        immutable: true,
        deprecated_vocabulary: true,
      },
    });
    expect(observed.actions).toEqual(legacyReport.actions);
    expect(observed.findings).toEqual([
      expect.objectContaining({ code: 'legacy_notify_human_ready_deprecated' }),
    ]);
  });

  it('keeps legacy auto-merge effect requests distinct from release_ready', () => {
    const observed = adaptLifecycleReportForObservation({
      schema_version: 'ao.lifecycle.v1alpha1',
      release_decision: {
        disposition: 'auto_merge_ready_pr',
        basis: ['ready_for_auto_merge'],
        expected_head_sha: 'abc123',
        authoritative: true,
      },
      findings: [],
      actions: [],
    });

    expect(observed.release_decision.disposition).toBe('auto_merge_ready_pr');
    expect(observed.release_decision.authority_scope).toBeUndefined();
    expect(observed.release_decision_observation.disposition).toBe('auto_merge_ready_pr');
    expect(observed.findings).toEqual([
      expect.objectContaining({ code: 'legacy_auto_merge_ready_pr_deprecated' }),
    ]);
  });
});
