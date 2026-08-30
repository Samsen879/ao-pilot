import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import * as rootApi from 'ao-pilot';
import * as cli from 'ao-pilot/cli';
import * as contracts from 'ao-pilot/contracts';
import * as repository from 'ao-pilot/repository';
import * as engines from 'ao-pilot/engines';
import * as protocols from 'ao-pilot/protocols';
import * as providers from 'ao-pilot/providers';

const PROJECT_ROOT = process.cwd();

const CIE_CLI_EXPORTS = [
  'runControllerCli',
  'runDoctorCli',
  'runEvalCli',
  'runHandoffCli',
  'runKnowledgeCli',
  'runLifecycleCli',
  'runManageCli',
  'runMetricsCli',
  'runOverrideCli',
  'runReconcileCli',
  'runReviewCli',
  'runStateCli',
];

describe('ao-pilot public library API', () => {
  it('declares an ESM root and explicit public subpaths', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    );

    expect(packageJson.version).toBe('0.2.0');
    expect(packageJson.type).toBe('module');
    expect(packageJson.main).toBe('./lib/index.js');
    expect(packageJson.files).toContain('lib');
    expect(packageJson.files).toContain('schemas');
    expect(packageJson.exports).toEqual({
      '.': './lib/index.js',
      './cli': './lib/cli.js',
      './contracts': './lib/contracts.js',
      './repository': './lib/repository.js',
      './engines': './lib/engines.js',
      './protocols': './lib/protocols.js',
      './providers': './lib/providers.js',
      './schemas/ao.child-completion.v1alpha1.schema.json':
        './schemas/ao.child-completion.v1alpha1.schema.json',
      './schemas/ao.child-completion-input-manifest.v1alpha1.schema.json':
        './schemas/ao.child-completion-input-manifest.v1alpha1.schema.json',
      './schemas/ao.task-relation.v1alpha1.schema.json':
        './schemas/ao.task-relation.v1alpha1.schema.json',
      './schemas/ao.or-authorization-grant.v1.schema.json':
        './schemas/ao.or-authorization-grant.v1.schema.json',
      './schemas/ao.or-authorization-escalation.v1.schema.json':
        './schemas/ao.or-authorization-escalation.v1.schema.json',
      './schemas/ao.or-merge-preflight.v1.schema.json':
        './schemas/ao.or-merge-preflight.v1.schema.json',
      './schemas/ao.github-merge-observation.v1.schema.json':
        './schemas/ao.github-merge-observation.v1.schema.json',
      './schemas/ao.or-merge-outcome.v1.schema.json':
        './schemas/ao.or-merge-outcome.v1.schema.json',
      './package.json': './package.json',
    });
  });

  it('exports stable names for every embedded CIE CLI facade', () => {
    for (const exportName of CIE_CLI_EXPORTS) {
      expect(cli[exportName]).toEqual(expect.any(Function));
      expect(rootApi[exportName]).toBe(cli[exportName]);
    }

    expect(cli.runAoPilotCli).toEqual(expect.any(Function));
    expect(cli.runInitCli).toEqual(expect.any(Function));
  });

  it('exposes generic contracts, repositories, engines, protocols, and providers', () => {
    expect(contracts.createPrScope(42)).toMatchObject({
      mode: 'pr',
      selected_pr_numbers: [42],
    });
    expect(contracts.CONTROL_PLANE_SCHEMA_VERSION).toBe(
      'ao.control-plane.schema.v1alpha1',
    );
    expect(contracts.RUNTIME_LOCK_SCHEMA_VERSION).toBe('ao.runtime-lock.v1');
    expect(contracts.createRuntimeProvenance).toEqual(expect.any(Function));
    expect(contracts.normalizeAuthorizationGrant).toEqual(expect.any(Function));
    expect(contracts.evaluateAuthorizationGrant).toEqual(expect.any(Function));
    expect(contracts.INTERVENTION_JUDGMENT_SCHEMA_VERSION).toBe('ao.intervention-judgment.v1');
    expect(contracts.TASK_RELATION_SCHEMA_VERSION).toBe('ao.task-relation.v1alpha1');
    expect(contracts.createTaskRelation).toEqual(expect.any(Function));
    expect(contracts.RESERVED_MANAGED_TASK_METADATA_REGISTRY_VERSION).toBe(
      'ao.reserved-managed-task-metadata.v1',
    );
    expect(contracts.RESERVED_MANAGED_TASK_METADATA_KEYS.parent_task_id).toMatchObject({
      target_contract: 'ao.task-relation.v1alpha1',
      support: 'available',
    });
    expect(contracts.scanManagedTaskMetadata).toEqual(expect.any(Function));
    expect(contracts.evaluateDeliveryStatusTransition).toEqual(expect.any(Function));
    expect(contracts.projectDocumentationTrigger).toEqual(expect.any(Function));
    expect(contracts.createRetryRequiredDecision).toEqual(expect.any(Function));
    expect(contracts.interventionJudgmentContracts.INTERVENTION_JUDGMENTS)
      .toMatchObject({ RETRY_REQUIRED: 'retry_required' });
    expect(repository.createStateRepository).toEqual(expect.any(Function));
    expect(repository.bootstrapControlPlaneState).toEqual(expect.any(Function));
    expect(engines.reconcileObservations).toEqual(expect.any(Function));
    expect(engines.evaluatePolicyDecision).toEqual(expect.any(Function));
    expect(engines.executeAssistActions).toEqual(expect.any(Function));
    expect(engines.runControllerLoop).toEqual(expect.any(Function));
    expect(engines.inspectTaskGraph).toEqual(expect.any(Function));
    expect(protocols.createHandoffProtocol).toEqual(expect.any(Function));
    expect(protocols.createReviewProtocol).toEqual(expect.any(Function));
    expect(protocols.evaluateOrMergePreflight).toEqual(expect.any(Function));
    expect(protocols.bindGitHubMergeOutcome).toEqual(expect.any(Function));
    expect(providers.createLocalCommandRunner).toEqual(expect.any(Function));
    expect(providers.createBlockedNotificationWebhookTransport).toEqual(expect.any(Function));
    expect(providers.listRuntimeProviderContracts()).toEqual(expect.any(Array));
    expect(providers.resolveManagedRuntime).toEqual(expect.any(Function));
    expect(providers.loadGitHubMergeObservation).toEqual(expect.any(Function));

    expect(rootApi.contracts).toBeDefined();
    expect(rootApi.repository).toBeDefined();
    expect(rootApi.engines).toBeDefined();
    expect(rootApi.protocols).toBeDefined();
    expect(rootApi.providers).toBeDefined();
  });

  it('does not publish CIE domain names', () => {
    expect(Object.keys(rootApi).filter((name) => /cie|9709|questionpart/i.test(name))).toEqual([]);
  });
});
