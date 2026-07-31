import { describe, expect, it } from '@jest/globals';

import {
  buildBlockedNotificationIntent,
  createBlockedNotificationWebhookTransport,
} from '../../scripts/ao/lib/blocked-notification-transport.js';

describe('blocked notification transport', () => {
  it('builds a provider-neutral, stable notification intent', () => {
    expect(buildBlockedNotificationIntent({
      projectId: 'my-project',
      prNumber: 411,
      actionId: 'action-blocked-notify',
      summary: 'Human input is required.',
      timestamp: '2026-06-08T15:50:00.000Z',
    })).toEqual({
      schema_version: 'ao.blocked-notification-intent.v1alpha1',
      format: 'ao_blocked_notification_intent',
      event_kind: 'ao_blocked_notification',
      project_id: 'my-project',
      pr_number: 411,
      action_id: 'action-blocked-notify',
      summary: 'Human input is required.',
      dedupe_key: 'my-project:pr-411',
      dedupe_marker: '<!-- ao:blocked-notification key=my-project:pr-411 -->',
      observed_at: '2026-06-08T15:50:00.000Z',
    });
  });

  it('stays disabled unless explicitly enabled with a webhook URL', () => {
    expect(createBlockedNotificationWebhookTransport({ env: {} })).toBeNull();
    expect(createBlockedNotificationWebhookTransport({
      env: { AO_BLOCKED_NOTIFICATION_WEBHOOK_ENABLED: '1' },
    })).toBeNull();
  });

  it('sends the generic intent and never exposes the webhook URL in its receipt', async () => {
    const calls = [];
    const transport = createBlockedNotificationWebhookTransport({
      enabled: true,
      webhookUrl: 'https://hooks.example.test/secret-token',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 202, text: async () => '' };
      },
    });
    const intent = buildBlockedNotificationIntent({
      projectId: 'my-project',
      actionId: 'action-blocked-notify',
      timestamp: '2026-06-08T15:50:00.000Z',
    });

    const result = await transport.sendBlockedNotification(intent);

    expect(result).toEqual({
      status: 'succeeded',
      transport: 'webhook',
      attempts: 1,
      http_status: 202,
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.parse(calls[0].options.body)).toEqual(intent);
  });

  it('supports an injected provider adapter and returns sanitized retry failure', async () => {
    const requests = [];
    const transport = createBlockedNotificationWebhookTransport({
      enabled: true,
      webhookUrl: 'https://hooks.example.test/secret-token',
      maxAttempts: 2,
      transportName: 'custom-chat',
      requestBuilder: (intent) => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: intent.summary }),
      }),
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return {
          ok: false,
          status: 503,
          text: async () => 'upstream secret-token',
        };
      },
    });

    const result = await transport.sendBlockedNotification({
      projectId: 'my-project',
      actionId: 'action-blocked-notify',
      summary: 'Human input is required.',
    });

    expect(requests).toHaveLength(2);
    expect(result).toEqual({
      status: 'failed',
      transport: 'custom-chat',
      attempts: 2,
      http_status: 503,
      reason: 'webhook_http_error',
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.parse(requests[0].options.body)).toEqual({
      message: 'Human input is required.',
    });
  });
});
