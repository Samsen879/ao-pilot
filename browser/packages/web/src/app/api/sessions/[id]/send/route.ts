import { randomUUID } from "node:crypto";
import { isMessageResult, messageHttpStatus, localMessageResult } from "@composio/ao-core/message-contract";
import { type NextRequest } from "next/server";
import { validateIdentifier, validateString, stripControlChars } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { SessionNotFoundError } from "@composio/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

const MAX_MESSAGE_LENGTH = 10_000;

/** POST /api/sessions/:id/send — Send a message to a session */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const messageErr = validateString(body?.message, "message", MAX_MESSAGE_LENGTH);
  if (messageErr) {
    return jsonWithCorrelation({ error: messageErr }, { status: 400 }, correlationId);
  }

  // Strip control characters to prevent injection when passed to shell-based runtimes
  const message = stripControlChars(String(body?.message ?? ""));

  // Re-validate after stripping — a control-char-only message becomes empty
  if (message.trim().length === 0) {
    return jsonWithCorrelation(
      { error: "message must not be empty after sanitization" },
      { status: 400 },
      correlationId,
    );
  }

  const messageId = body?.message_id === undefined ? randomUUID() : body.message_id;
  if (typeof messageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(messageId)
    || (body?.require_ack !== undefined && typeof body.require_ack !== "boolean")
    || (body?.ack_timeout_ms !== undefined && (body.require_ack !== true || !Number.isInteger(body.ack_timeout_ms) || Number(body.ack_timeout_ms) < 1 || Number(body.ack_timeout_ms) > 60000))) {
    return jsonWithCorrelation({ error: "Invalid message options" }, { status: 400 }, correlationId);
  }
  const requireAck = body?.require_ack === true;
  try {
    const { config, sessionManager } = await getServices();
    const projectId = resolveProjectIdForSessionId(config, id);
    const delivered = requireAck && sessionManager.messageContract !== "ao.message-contract.v1"
      ? localMessageResult(messageId, "rejected", "ACK_UNSUPPORTED_AUTHORITY")
      : await sessionManager.send(id, message, { messageId, requireAck, ...(body?.ack_timeout_ms !== undefined ? { ackTimeoutMs: Number(body.ack_timeout_ms) } : {}) });
    const result = delivered === undefined ? localMessageResult(messageId, "submitted_unconfirmed", "LEGACY_UNCONFIRMED") : delivered;
    if (!isMessageResult(result) || result.message_id !== messageId) throw new Error("Invalid message result");
    const status = messageHttpStatus(result);
    recordApiObservation({
      config,
      method: "POST",
      path: "/api/sessions/[id]/send",
      correlationId,
      startedAt,
      outcome: status === 200 ? "success" : "failure",
      statusCode: status,
      projectId,
      sessionId: id,
      data: { messageLength: message.length, messageOutcome: result.outcome, messageId: result.message_id },
    });
    return jsonWithCorrelation(
      result,
      { status },
      correlationId,
    );
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    const { config } = await getServices().catch(() => ({ config: undefined }));
    const projectId = config ? resolveProjectIdForSessionId(config, id) : undefined;
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/[id]/send",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId: id,
        reason: err instanceof Error ? err.message : "Failed to send message",
        data: { messageLength: message.length },
      });
    }
    const msg = err instanceof Error ? err.message : "Failed to send message";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
