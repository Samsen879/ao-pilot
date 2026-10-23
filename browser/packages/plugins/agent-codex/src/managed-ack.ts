import { isNativeMessageContract } from "@composio/ao-core/message-contract";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile, rename, chmod, realpath, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, isAbsolute, dirname } from "node:path";
const execute = promisify(execFile);
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function managedAckDirectory(env = process.env): string | null {
  const data = env["AO_MANAGED_RUNTIME_DATA_DIR"]; const run = env["AO_MANAGED_RUNTIME_RUN_FILE"]; const sha = env["AO_MANAGED_RUNTIME_BINARY_SHA256"];
  if (!data || !isAbsolute(data) || !run || !isAbsolute(run) || !sha || !/^[a-f0-9]{64}$/.test(sha)) return null;
  return join(data, "message-cli", "wrappers", digest(run), sha);
}
async function ownedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || await realpath(directory) !== directory) throw new Error("ACK helper directory is not owned/canonical");
}
async function publish(file: string, bytes: Uint8Array | string): Promise<void> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || digest(await readFile(file)) !== digest(bytes)) throw new Error("ACK helper already exists with unknown bytes");
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(temp, bytes, { flag: "wx", mode: 0o700 });
  const fd = await open(temp, "r"); try { await fd.sync(); } finally { await fd.close(); }
  await rename(temp, file); await chmod(file, 0o700);
  const directory = await open(dirname(file), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
/** Retained native bytes live with the namespace and are independent of release GC. */
export async function setupManagedMessageAck(env = process.env): Promise<boolean> {
  const binary = env["AO_MANAGED_RUNTIME_BINARY"]; const sha = env["AO_MANAGED_RUNTIME_BINARY_SHA256"];
  const data = env["AO_MANAGED_RUNTIME_DATA_DIR"]; const run = env["AO_MANAGED_RUNTIME_RUN_FILE"]; const wrapper = managedAckDirectory(env);
  if (!binary || !isAbsolute(binary) || !sha || !data || !run || !wrapper || [binary, data, run].some((value) => /[\r\n\0]/.test(value))) return false;
  try {
    const stat = await lstat(binary);
    if (!stat?.isFile() || stat.isSymbolicLink()) return false;
    const bytes = await readFile(binary); if (digest(bytes) !== sha) return false;
    const probe = await execute(binary, ["message-contract", "--json"], { env: { ...env, AO_DATA_DIR: data, AO_RUN_FILE: run }, timeout: 3000 });
    if (!isNativeMessageContract(JSON.parse(probe.stdout))) return false;
    await ownedDirectory(data);
    const retained = join(data, "message-cli", "bin", sha); await ownedDirectory(retained); await ownedDirectory(wrapper);
    const helper = join(retained, "ao"); await publish(helper, bytes);
    const script = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" != ack ]]; then echo "ao-pilot: this worker entry supports ack only" >&2; exit 2; fi
shift
helper=${quote(helper)}
expected=${quote(sha)}
if [[ ! -f "$helper" || ! -x "$helper" || -L "$helper" ]]; then echo "ACK_HELPER_UNAVAILABLE" >&2; exit 1; fi
observed="$(sha256sum -- "$helper")"; observed="\${observed%% *}"
if [[ "$observed" != "$expected" ]]; then echo "ACK_HELPER_DRIFT" >&2; exit 1; fi
if [[ ! "\${AO_SESSION_ID:-}" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then echo "ACK_SESSION_UNAVAILABLE" >&2; exit 2; fi
export AO_DATA_DIR=${quote(data)}
export AO_RUN_FILE=${quote(run)}
exec "$helper" ack "$@"
`;
    await publish(join(wrapper, "ao-pilot"), script); return true;
  } catch { return false; }
}
