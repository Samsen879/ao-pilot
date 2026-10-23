import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "./index.js";
import { managedAckDirectory, setupManagedMessageAck } from "./managed-ack.js";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs(); });
const contract = { schema_version: "ao.message-contract.v1", authority: "native", require_ack: true, default_ack_timeout_ms: 30000, max_ack_timeout_ms: 60000, send_timeout_ms: 90000,
  outcomes: ["submitted_confirmed", "submitted_unconfirmed", "rejected", "acknowledged", "ack_timeout"] };
function fixture(supported = true, wrongTarget = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-worker-ack-")); roots.push(root);
  const binary = path.join(root, "release-native-ao");
  fs.writeFileSync(binary, `#!/bin/sh
if [ -n "$PROBE_LOG" ]; then printf '%s\\n' "$1" >> "$PROBE_LOG"; fi
if [ "$1" = message-contract ]; then
${supported ? `printf '%s\\n' '${JSON.stringify(contract)}'` : "exit 1"}
exit 0
fi
if [ "$1" = session ]; then
printf '{"session":{"id":"%s","projectId":"native-project"}}\\n' ${wrongTarget ? "wrong-native" : '"$3"'}
exit 0
fi
if [ "$1" = send ]; then
printf '%s' native-send > "$RECEIPT"
exit 3
fi
if [ "$1" = ack ]; then
printf '%s|%s|%s' "$AO_DATA_DIR" "$AO_RUN_FILE" "$AO_SESSION_ID" > "$RECEIPT"
printf '%s\\n' '{"outcome":"acknowledged"}'
exit 0
fi
exit 2
`, { mode: 0o700 });
  const sha = createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  const env = { ...process.env, PROBE_LOG: path.join(root, "probes"), AO_MANAGED_RUNTIME_BINARY: binary, AO_MANAGED_RUNTIME_BINARY_SHA256: sha,
    AO_MANAGED_RUNTIME_DATA_DIR: path.join(root, "data"), AO_MANAGED_RUNTIME_RUN_FILE: path.join(root, "run/running.json") };
  const binding = { sessionId: "original-native", projectId: "native-project", binarySha256: sha, dataDir: env.AO_MANAGED_RUNTIME_DATA_DIR, runFile: env.AO_MANAGED_RUNTIME_RUN_FILE };
  return { root, binary, sha, env, binding };
}
it("executes the prescribed ACK with fixed verified native identity after the original release is deleted", async () => {
  const { root, binary, env, binding } = fixture(); expect(await setupManagedMessageAck(env, binding)).toBe(true);
  expect(fs.readFileSync(env.PROBE_LOG, "utf8")).toBe("message-contract\nsession\n");
  const directory = managedAckDirectory(env, binding)!; fs.rmSync(binary);
  const receipt = path.join(root, "receipt");
  const result = spawnSync(path.join(directory, "ao-pilot"), ["ack", "message-1"], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin", AO_SESSION_ID: "wrong-browser-id", AO_DATA_DIR: "/wrong/project-data", AO_RUN_FILE: "/wrong/discovery", RECEIPT: receipt } });
  expect(result.status).toBe(0); expect(fs.readFileSync(receipt, "utf8")).toBe(`${binding.dataDir}|${binding.runFile}|${binding.sessionId}`);
});
it("separates wrappers by verified native session and refuses an ambient collision without explicit binding", async () => {
  const { root, env, binding } = fixture(); const second = { ...binding, sessionId: "second-native" };
  expect(await setupManagedMessageAck(env, binding)).toBe(true); expect(await setupManagedMessageAck(env, second)).toBe(true);
  expect(managedAckDirectory(env, binding)).not.toBe(managedAckDirectory(env, second));
  for (const [name, value] of Object.entries(env)) if (name.startsWith("AO_MANAGED_RUNTIME_")) vi.stubEnv(name, value);
  const agent = create();
  const projectConfig = { name: "Fixture", repo: "test/fixture", path: root, defaultBranch: "main", sessionPrefix: "fixture" };
  for (const sessionId of ["legacy-browser", binding.sessionId]) {
    const launch = agent.getEnvironment({ sessionId, projectConfig });
    expect(launch.AO_MESSAGE_ACK_AVAILABLE).toBe(""); expect(launch.PATH).not.toContain("message-cli/wrappers");
  }
  const launch = agent.getEnvironment({ sessionId: "browser-id-is-not-owner", projectConfig, nativeMessageBinding: binding });
  expect(launch.AO_MESSAGE_ACK_AVAILABLE).toBe("1"); expect(launch.AO_SESSION_ID).toBe(binding.sessionId);
  expect(launch.PATH?.split(":")[0]).toBe(managedAckDirectory(env, binding));
});
it("missing or partial explicit ownership does no native probes and publishes no wrapper", async () => {
  const { env, binding } = fixture();
  expect(await setupManagedMessageAck(env)).toBe(false);
  expect(await setupManagedMessageAck(env, { ...binding, projectId: "" })).toBe(false);
  expect(managedAckDirectory(env)).toBeNull(); expect(fs.existsSync(env.PROBE_LOG)).toBe(false); expect(fs.existsSync(binding.dataDir)).toBe(false);
});
it.each(["target", "project", "namespace", "digest"])("refuses mismatched %s ownership before publishing a wrapper", async (mismatch) => {
  const { env, binding } = fixture(true, mismatch === "target");
  const changed = { ...binding, ...(mismatch === "project" ? { projectId: "other-project" } : mismatch === "namespace" ? { dataDir: "/other-data" } : mismatch === "digest" ? { binarySha256: "a".repeat(64) } : {}) };
  expect(await setupManagedMessageAck(env, changed)).toBe(false); expect(fs.existsSync(binding.dataDir)).toBe(false);
});
it("retains separate namespaces and rejects retained helper tampering without ACK effects", async () => {
  const { root, sha, env, binding } = fixture(); const other = { ...env, AO_MANAGED_RUNTIME_DATA_DIR: path.join(root, "other-data"), AO_MANAGED_RUNTIME_RUN_FILE: path.join(root, "other-run/running.json") };
  const otherBinding = { ...binding, dataDir: other.AO_MANAGED_RUNTIME_DATA_DIR, runFile: other.AO_MANAGED_RUNTIME_RUN_FILE };
  expect(await setupManagedMessageAck(env, binding)).toBe(true); expect(await setupManagedMessageAck(other, otherBinding)).toBe(true);
  expect(managedAckDirectory(env, binding)).not.toBe(managedAckDirectory(other, otherBinding));
  fs.appendFileSync(path.join(binding.dataDir, "message-cli/bin", sha, "ao"), "# changed");
  const receipt = path.join(root, "must-not-exist");
  const result = spawnSync(path.join(managedAckDirectory(env, binding)!, "ao-pilot"), ["ack", "message-1"], { encoding: "utf8", env: { ...process.env, RECEIPT: receipt } });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("ACK_HELPER_DRIFT"); expect(fs.existsSync(receipt)).toBe(false);
});
it("old capability publishes no wrapper even with an explicit native binding", async () => {
  const { env, binding } = fixture(false); expect(await setupManagedMessageAck(env, binding)).toBe(false);
  expect(fs.existsSync(path.join(managedAckDirectory(env, binding)!, "ao-pilot"))).toBe(false);
});
it("an incomplete managed namespace cannot resolve a wrapper or fall back to ambient ao-pilot", async () => {
  const { env, binding } = fixture(); expect(await setupManagedMessageAck({ ...env, AO_MANAGED_RUNTIME_BINARY_SHA256: "" }, binding)).toBe(false);
  expect(managedAckDirectory({ ...env, AO_MANAGED_RUNTIME_RUN_FILE: "" }, binding)).toBeNull();
});

it("the managed task command reaches ao with an ACK-only ao-pilot first on the worker PATH", async () => {
  const { root, env, binding, binary } = fixture();
  expect(await setupManagedMessageAck(env, binding)).toBe(true);
  const bin = path.join(root, "native-bin"); fs.mkdirSync(bin); fs.symlinkSync(binary, path.join(bin, "ao"));
  const receipt = path.join(root, "send-receipt");
  const workerEnv = { ...process.env, PATH: `${managedAckDirectory(env, binding)}:${bin}:/usr/bin:/bin`, RECEIPT: receipt };
  const send = spawnSync("/bin/sh", ["-c", "ao send --session original-native --message task --message-id same-episode --require-ack --json"], { env: workerEnv });
  expect(send.status).toBe(3); expect(fs.readFileSync(receipt, "utf8")).toBe("native-send");
  const unavailable = spawnSync("/bin/sh", ["-c", "ao-pilot send --session original-native --message task"], { env: workerEnv });
  expect(unavailable.status).toBe(2);
});
