export const BLOCKED_NOTIFICATION_INTENT_SCHEMA_VERSION = 'ao.blocked-notification-intent.v1alpha1';
export const BLOCKED_NOTIFICATION_INTENT_FORMAT = 'ao_blocked_notification_intent';
export const BLOCKED_NOTIFICATION_DELIVERY_SEMANTICS = 'at_least_once';

function normalizeString(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function toNullablePositiveInteger(value) {
  if (value == null) return null;
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

export function buildBlockedNotificationIntent({
  projectId,
  prNumber = null,
  actionId,
  summary = null,
  dedupeMarker = null,
  timestamp,
} = {}) {
  const normalizedProjectId = normalizeString(projectId) ?? 'unknown-project';
  const normalizedPrNumber = toNullablePositiveInteger(prNumber);
  const normalizedActionId = normalizeString(actionId);
  const dedupeKey = normalizedPrNumber == null
    ? `${normalizedProjectId}:project`
    : `${normalizedProjectId}:pr-${normalizedPrNumber}`;
  const deliveryId = `ao-blocked:${normalizedActionId ?? dedupeKey}`;

  return {
    schema_version: BLOCKED_NOTIFICATION_INTENT_SCHEMA_VERSION,
    format: BLOCKED_NOTIFICATION_INTENT_FORMAT,
    event_kind: 'ao_blocked_notification',
    delivery_semantics: BLOCKED_NOTIFICATION_DELIVERY_SEMANTICS,
    delivery_id: deliveryId,
    project_id: normalizedProjectId,
    pr_number: normalizedPrNumber,
    action_id: normalizedActionId,
    summary: normalizeString(summary) ?? 'AO is blocked and needs human input.',
    dedupe_key: dedupeKey,
    dedupe_marker: normalizeString(dedupeMarker)
      ?? `<!-- ao:blocked-notification key=${dedupeKey} -->`,
    observed_at: normalizeString(timestamp),
  };
}

function buildDefaultRequest(intent) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': intent.delivery_id,
      'x-ao-delivery-semantics': BLOCKED_NOTIFICATION_DELIVERY_SEMANTICS,
    },
    body: JSON.stringify(intent),
  };
}

function createResult({
  status,
  transportName,
  attempts,
  httpStatus = null,
  reason = null,
  deliveryId = null,
} = {}) {
  return {
    status,
    transport: transportName,
    attempts,
    delivery_semantics: BLOCKED_NOTIFICATION_DELIVERY_SEMANTICS,
    idempotency_key: deliveryId,
    ...(httpStatus == null ? {} : { http_status: httpStatus }),
    ...(reason == null ? {} : { reason }),
  };
}

export function createBlockedNotificationWebhookTransport({
  env = process.env,
  enabled = null,
  webhookUrl = null,
  fetchImpl = globalThis.fetch,
  maxAttempts = 2,
  transportName = 'webhook',
  requestBuilder = buildDefaultRequest,
} = {}) {
  const resolvedEnabled = enabled == null
    ? isEnabled(env?.AO_BLOCKED_NOTIFICATION_WEBHOOK_ENABLED)
    : enabled === true;
  if (!resolvedEnabled) return null;

  const resolvedWebhookUrl = normalizeString(webhookUrl)
    ?? normalizeString(env?.AO_BLOCKED_NOTIFICATION_WEBHOOK_URL);
  if (!resolvedWebhookUrl) return null;

  const normalizedTransportName = normalizeString(transportName) ?? 'webhook';
  const attempts = Math.max(1, Number.isInteger(maxAttempts) ? maxAttempts : 2);

  return {
    async sendBlockedNotification(payload = {}) {
      const intent = payload?.format === BLOCKED_NOTIFICATION_INTENT_FORMAT
        ? payload
        : buildBlockedNotificationIntent(payload);

      if (typeof fetchImpl !== 'function') {
        return createResult({
          status: 'failed',
          transportName: normalizedTransportName,
          attempts: 0,
          reason: 'fetch_unavailable',
          deliveryId: intent.delivery_id,
        });
      }

      let request;
      try {
        request = await requestBuilder(intent);
        request = {
          ...(request ?? {}),
          headers: {
            ...(request?.headers ?? {}),
            'idempotency-key': intent.delivery_id,
            'x-ao-delivery-semantics': BLOCKED_NOTIFICATION_DELIVERY_SEMANTICS,
          },
        };
      } catch {
        return createResult({
          status: 'failed',
          transportName: normalizedTransportName,
          attempts: 0,
          reason: 'request_builder_failed',
          deliveryId: intent.delivery_id,
        });
      }

      let lastStatus = null;
      let lastReason = 'webhook_request_failed';

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await fetchImpl(resolvedWebhookUrl, request);
          lastStatus = response?.status ?? null;
          if (response?.ok === true) {
            return createResult({
              status: 'succeeded',
              transportName: normalizedTransportName,
              attempts: attempt,
              httpStatus: lastStatus,
              deliveryId: intent.delivery_id,
            });
          }
          lastReason = 'webhook_http_error';
          if (typeof response?.text === 'function') {
            await response.text().catch(() => null);
          }
        } catch {
          lastReason = 'webhook_request_failed';
        }
      }

      return createResult({
        status: 'failed',
        transportName: normalizedTransportName,
        attempts,
        httpStatus: lastStatus,
        reason: lastReason,
        deliveryId: intent.delivery_id,
      });
    },
  };
}
