import type { MessageResult } from "./types.js";
export const MESSAGE_OUTCOMES = ["submitted_confirmed", "submitted_unconfirmed", "rejected", "acknowledged", "ack_timeout"] as const;
export function isMessageResult(value: unknown): value is MessageResult {
  if (!value || typeof value !== "object") return false;
  const result = value as MessageResult;
  return typeof result.message_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(result.message_id)
    && MESSAGE_OUTCOMES.includes(result.outcome) && !!result.evidence
    && typeof result.evidence.code === "string" && result.evidence.code.length > 0
    && ["none", "activity_active", "explicit_ack"].includes(result.evidence.signal)
    && Number.isInteger(result.evidence.attempts) && result.evidence.attempts >= 0
    && typeof result.evidence.recorded_at === "string" && Number.isFinite(Date.parse(result.evidence.recorded_at));
}
export function messageHttpStatus(result: MessageResult): number {
  return { submitted_confirmed: 200, acknowledged: 200, submitted_unconfirmed: 202, rejected: 409, ack_timeout: 504 }[result.outcome];
}
export function messageExitCode(result: MessageResult): number {
  return { submitted_confirmed: 0, acknowledged: 0, submitted_unconfirmed: 3, rejected: 4, ack_timeout: 5 }[result.outcome];
}
export function localMessageResult(messageId: string, outcome: "rejected" | "submitted_unconfirmed", code: string): MessageResult {
  return { message_id: messageId, outcome, evidence: { code, signal: "none", attempts: outcome === "rejected" ? 0 : 1, recorded_at: new Date().toISOString() } };
}
export function isNativeMessageContract(value: unknown): boolean {
  const contract = value as Record<string, unknown>;
  return !!contract && contract.schema_version === "ao.message-contract.v1" && contract.authority === "native" && contract.require_ack === true
    && contract.default_ack_timeout_ms === 30000 && contract.max_ack_timeout_ms === 60000 && contract.send_timeout_ms === 90000
    && Array.isArray(contract.outcomes) && contract.outcomes.length === MESSAGE_OUTCOMES.length
    && MESSAGE_OUTCOMES.every((outcome) => (contract.outcomes as unknown[]).includes(outcome));
}
