import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { sendNativeMessage, probeNativeMessageCapability, type NativeMessageCommand } from "../native-message-client.js";
import { type MessageOutcome } from "../types.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const contract = { schema_version: "ao.message-contract.v1", authority: "native", require_ack: true, default_ack_timeout_ms: 30000, max_ack_timeout_ms: 60000, send_timeout_ms: 90000,
  outcomes: ["submitted_confirmed", "submitted_unconfirmed", "rejected", "acknowledged", "ack_timeout"] };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-native-message-")); roots.push(root);
  const binary = path.join(root, "retained-native"); fs.writeFileSync(binary, "fake exact binary fixture");
  const sha = createHash("sha256").update(fs.readFileSync(binary)).digest("hex"); const data = path.join(root, "data"); const runFile = path.join(root, "discovery/running.json");
  return { binary, binding: { sessionId: "native-original", projectId: "native-project", binarySha256: sha, dataDir: data, runFile },
    env: { AO_MANAGED_RUNTIME_BINARY: binary, AO_MANAGED_RUNTIME_BINARY_SHA256: sha, AO_MANAGED_RUNTIME_DATA_DIR: data, AO_MANAGED_RUNTIME_RUN_FILE: runFile } };
}
it.each([["submitted_confirmed", 0], ["submitted_unconfirmed", 3], ["rejected", 4], ["acknowledged", 0], ["ack_timeout", 5]] as [MessageOutcome, number][])("preserves %s after capability and exact native ownership checks", async (outcome, exitCode) => {
  const { binding, env } = fixture(); const calls: string[][] = [];
  const result = { message_id: "same-id", outcome, evidence: { code: "FIXTURE", signal: "none", attempts: 1, recorded_at: new Date().toISOString() } };
  const run: NativeMessageCommand = async (_binary, args, options) => {
    calls.push(args); expect(options.env["AO_DATA_DIR"]).toBe(binding.dataDir); expect(options.env["AO_RUN_FILE"]).toBe(binding.runFile);
    return { stdout: JSON.stringify(args[0] === "message-contract" ? contract : args[0] === "session" ? { session: { id: binding.sessionId, projectId: binding.projectId } } : result), stderr: "", exitCode: args[0] === "send" ? exitCode : 0 };
  };
  expect(await sendNativeMessage(binding, "task text", { messageId: "same-id", requireAck: true }, { env, run })).toEqual(result);
  expect(calls.map((args) => args[0])).toEqual(["message-contract", "session", "send"]); expect(calls[2]).toContain("--require-ack"); expect(calls[2]).toContain("same-id");
});
it("ordinary native messages do not add ACK and no message is submitted to an old daemon", async () => {
  const { binding, env } = fixture(); const calls: string[][] = [];
  const old: NativeMessageCommand = async (_binary, args) => { calls.push(args); return { stdout: "", stderr: "404", exitCode: 1 }; };
  expect(await probeNativeMessageCapability(env, old)).toBe(false);
  await expect(sendNativeMessage(binding, "ordinary", { messageId: "ordinary-id" }, { env, run: old })).rejects.toThrow("MESSAGE_CONTRACT_UNAVAILABLE");
  expect(calls.every((args) => args[0] === "message-contract")).toBe(true);
  calls.length = 0;
  const run: NativeMessageCommand = async (_binary, args) => { calls.push(args); return { stdout: JSON.stringify(args[0] === "message-contract" ? contract : args[0] === "session" ? { session: { id: binding.sessionId, projectId: binding.projectId } } : { message_id: "ordinary-id", outcome: "submitted_confirmed", evidence: { code: "FIXTURE", signal: "activity_active", attempts: 1, recorded_at: new Date().toISOString() } }), stderr: "", exitCode: 0 }; };
  await sendNativeMessage(binding, "ordinary", { messageId: "ordinary-id" }, { env, run }); expect(calls[2]).not.toContain("--require-ack");
});
it("a different project/ID or malformed mapping cannot reach the send command", async () => {
  const { binding, env } = fixture(); const calls: string[][] = [];
  const run: NativeMessageCommand = async (_binary, args) => { calls.push(args); return { stdout: JSON.stringify(args[0] === "message-contract" ? contract : { session: { id: "other", projectId: binding.projectId } }), stderr: "", exitCode: 0 }; };
  await expect(sendNativeMessage(binding, "task", { messageId: "same-id", requireAck: true }, { env, run })).rejects.toThrow("NATIVE_TARGET_UNVERIFIED");
  expect(calls).toHaveLength(2);
  await expect(sendNativeMessage({ ...binding, dataDir: "/other" }, "task", { messageId: "same-id", requireAck: true }, { env, run })).rejects.toThrow("NATIVE_TARGET_UNVERIFIED"); expect(calls).toHaveLength(2);
});
it("daemon downgrade after handshake fails without retry, restoration, a new ID or legacy fallback", async () => {
  const { binding, env } = fixture(); const calls: string[][] = [];
  const run: NativeMessageCommand = async (_binary, args) => { calls.push(args); return { stdout: args[0] === "send" ? "" : JSON.stringify(args[0] === "message-contract" ? contract : { session: { id: binding.sessionId, projectId: binding.projectId } }), stderr: "new /messages returned404", exitCode: args[0] === "send" ? 1 : 0 }; };
  await expect(sendNativeMessage(binding, "task", { messageId: "original-id", requireAck: true }, { env, run })).rejects.toThrow("NATIVE_MESSAGE_PROTOCOL_ERROR");
  expect(calls.map((args) => args[0])).toEqual(["message-contract", "session", "send"]); expect(calls[2]).toContain("original-id");
});
