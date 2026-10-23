import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MessageResult, SendOptions, NativeMessageBinding } from "./types.js";
import { isMessageResult, messageExitCode, isNativeMessageContract } from "./message-contract.js";
const execFileAsync = promisify(execFile);
interface CommandResult { stdout: string; stderr: string; exitCode: number }
export type NativeMessageCommand = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<CommandResult>;
async function execute(binary: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }): Promise<CommandResult> {
  try { const result = await execFileAsync(binary, args, { ...options, maxBuffer: 4 * 1024 * 1024 }); return { ...result, exitCode: 0 }; }
  catch (error) {
    const result = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof result.code !== "number") throw error;
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code };
  }
}
function fail(reason: string): never { throw new Error(reason); }
export async function probeNativeMessageCapability(env = process.env, run: NativeMessageCommand = execute): Promise<boolean> {
  const binary = env["AO_MANAGED_RUNTIME_BINARY"]; const digest = env["AO_MANAGED_RUNTIME_BINARY_SHA256"];
  const data = env["AO_MANAGED_RUNTIME_DATA_DIR"]; const discovery = env["AO_MANAGED_RUNTIME_RUN_FILE"];
  try {
    if (!binary || !path.isAbsolute(binary) || !digest || !/^[a-f0-9]{64}$/.test(digest) || !data || !path.isAbsolute(data) || !discovery || !path.isAbsolute(discovery)) return false;
    const stat = fs.lstatSync(binary);
    if (!stat.isFile() || stat.isSymbolicLink() || createHash("sha256").update(fs.readFileSync(binary)).digest("hex") !== digest) return false;
    const result = await run(binary, ["message-contract", "--json"], { env: { ...env, AO_DATA_DIR: data, AO_RUN_FILE: discovery }, timeout: 3000 });
    return result.exitCode === 0 && isNativeMessageContract(JSON.parse(result.stdout));
  } catch { return false; }
}
export async function sendNativeMessage(binding: NativeMessageBinding, message: string, options: SendOptions, {
  env = process.env, run = execute,
}: { env?: NodeJS.ProcessEnv; run?: NativeMessageCommand } = {}): Promise<MessageResult> {
  if (!options.messageId || !/^[A-Za-z0-9_-]{1,128}$/.test(options.messageId) || (options.requireAck !== undefined && typeof options.requireAck !== "boolean")
    || (options.ackTimeoutMs !== undefined && (!options.requireAck || !Number.isInteger(options.ackTimeoutMs) || options.ackTimeoutMs < 1 || options.ackTimeoutMs > 60000))) fail("INVALID_MESSAGE_OPTIONS");
  const binary = env["AO_MANAGED_RUNTIME_BINARY"]; const digest = env["AO_MANAGED_RUNTIME_BINARY_SHA256"];
  const data = env["AO_MANAGED_RUNTIME_DATA_DIR"]; const discovery = env["AO_MANAGED_RUNTIME_RUN_FILE"];
  if (!binary || !path.isAbsolute(binary) || !digest || !/^[a-f0-9]{64}$/.test(digest)
    || !data || !path.isAbsolute(data) || !discovery || !path.isAbsolute(discovery)
    || digest !== binding.binarySha256 || data !== binding.dataDir || discovery !== binding.runFile
    || (env["AO_DATA_DIR"] && env["AO_DATA_DIR"] !== data) || (env["AO_RUN_FILE"] && env["AO_RUN_FILE"] !== discovery)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(binding.sessionId) || !binding.projectId) fail("NATIVE_TARGET_UNVERIFIED");
  const verify = () => { const stat = fs.lstatSync(binary); if (!stat.isFile() || stat.isSymbolicLink()
    || createHash("sha256").update(fs.readFileSync(binary)).digest("hex") !== digest) fail("NATIVE_BINARY_DRIFT"); };
  verify(); const namespace = { ...env, AO_DATA_DIR: data, AO_RUN_FILE: discovery };
  const probe = await run(binary, ["message-contract", "--json"], { env: namespace, timeout: 3000 });
  if (probe.exitCode !== 0) fail("MESSAGE_CONTRACT_UNAVAILABLE"); if (!isNativeMessageContract(JSON.parse(probe.stdout))) fail("MESSAGE_CONTRACT_UNAVAILABLE");
  const target = await run(binary, ["session", "get", binding.sessionId, "--json"], { env: namespace, timeout: 3000 });
  if (target.exitCode !== 0) fail("NATIVE_TARGET_UNVERIFIED");
  const session = (JSON.parse(target.stdout) as { session?: { id?: unknown; projectId?: unknown } }).session;
  if (!session || session.id !== binding.sessionId || session.projectId !== binding.projectId) fail("NATIVE_TARGET_UNVERIFIED");
  verify(); const args = ["send", "--session", binding.sessionId, "--message", message, "--message-id", options.messageId!, "--json"];
  if (options.requireAck) args.push("--require-ack"); if (options.ackTimeoutMs !== undefined) args.push("--ack-timeout", `${options.ackTimeoutMs}ms`);
  // Native CLI repeats the probe and uses /messages: replacing the daemon with
  // an older version cannot fall through to its permissive legacy /send route.
  const result = await run(binary, args, { env: namespace, timeout: 100000 });
  let parsed: unknown; try { parsed = JSON.parse(result.stdout); } catch { fail("NATIVE_MESSAGE_PROTOCOL_ERROR"); }
  if (!isMessageResult(parsed) || messageExitCode(parsed) !== result.exitCode || parsed.message_id !== options.messageId) fail("NATIVE_MESSAGE_PROTOCOL_ERROR");
  return parsed;
}
