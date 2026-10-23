import { isMessageResult, messageHttpStatus } from "@composio/ao-core/message-contract";
/** null proves the new confirmation contract; every other value is visible uncertainty/error. */
export async function messageResponseNotice(response: Pick<Response, "status" | "json">): Promise<string | null> {
  let value: unknown;
  try { value = await response.json(); } catch { return "Message delivery could not be verified."; }
  if (!isMessageResult(value) || messageHttpStatus(value) !== response.status) return "Message delivery could not be verified.";
  if (response.status === 200 && (value.outcome === "submitted_confirmed" || value.outcome === "acknowledged")) return null;
  return `Message not confirmed: ${value.outcome} (${value.evidence.code}).`;
}
