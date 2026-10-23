import { describe, it, expect } from "vitest";
import { messageResponseNotice } from "@/lib/message-outcome";
const result = (outcome: string) => ({ message_id: "stable-id", outcome, evidence: { code: "FIXTURE", signal: outcome === "submitted_confirmed" ? "activity_active" : outcome === "acknowledged" ? "explicit_ack" : "none", attempts: 1, recorded_at: "2026-10-23T00:00:00Z" } });
describe("message response presentation", () => {
  it.each(["submitted_confirmed", "acknowledged"])("accepts HTTP200 %s", async (outcome) => {
    expect(await messageResponseNotice({ status: 200, json: async () => result(outcome) })).toBeNull();
  });
  it.each([[202, "submitted_unconfirmed"], [409, "rejected"], [504, "ack_timeout"], [200, "submitted_unconfirmed"]])("shows uncertainty for HTTP%s %s", async (status, outcome) => {
    expect(await messageResponseNotice({ status: Number(status), json: async () => result(String(outcome)) })).toMatch(/not confirmed|could not be verified/);
  });
  it.each(["submitted_confirmed", "acknowledged"])("shows unknown for %s without its required signal", async (outcome) => {
    const invalid = { ...result(outcome), evidence: { ...result(outcome).evidence, signal: "none", attempts: 0 } };
    expect(await messageResponseNotice({ status: 200, json: async () => invalid })).toMatch(/could not be verified/);
  });
  it("does not accept old ok/success or unreadable JSON as confirmation", async () => {
    expect(await messageResponseNotice({ status: 200, json: async () => ({ ok: true, success: true }) })).toMatch(/could not be verified/);
    expect(await messageResponseNotice({ status: 200, json: async () => { throw new Error("bad JSON"); } })).toMatch(/could not be verified/);
  });
});
