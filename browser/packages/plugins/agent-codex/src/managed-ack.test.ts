import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { managedAckDirectory, setupManagedMessageAck } from "./managed-ack.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const contract = { schema_version: "ao.message-contract.v1", authority: "native", require_ack: true, default_ack_timeout_ms: 30000, max_ack_timeout_ms: 60000, send_timeout_ms: 90000,
  outcomes: ["submitted_confirmed", "submitted_unconfirmed", "rejected", "acknowledged", "ack_timeout"] };
function fixture(supported = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-worker-ack-")); roots.push(root);
  const binary = path.join(root, "release-native-ao");
  fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = message-contract ]; then\n${supported ? `printf '%s\\n' '${JSON.stringify(contract)}'` : "exit 1"}\nexit 0\nfi\nif [ "$1" = ack ]; then\nprintf '%s|%s|%s' "$AO_DATA_DIR" "$AO_RUN_FILE" "$AO_SESSION_ID" > "$RECEIPT"\nprintf '%s\\n' '{"outcome":"acknowledged"}'\nexit 0\nfi\nexit 2\n`, { mode: 0o700 });
  const sha = createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  const env = { ...process.env, AO_MANAGED_RUNTIME_BINARY: binary, AO_MANAGED_RUNTIME_BINARY_SHA256: sha,
    AO_MANAGED_RUNTIME_DATA_DIR: path.join(root, "data"), AO_MANAGED_RUNTIME_RUN_FILE: path.join(root, "run/running.json") };
  return { root, binary, sha, env };
}
it("executes the specified worker ACK command in the same namespace after the original release is deleted", async () => {
  const { root, binary, env } = fixture(); expect(await setupManagedMessageAck(env)).toBe(true);
  const directory = managedAckDirectory(env)!; fs.rmSync(binary);
  const receipt = path.join(root, "receipt");
  const result = spawnSync(path.join(directory, "ao-pilot"), ["ack", "message-1"], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin", AO_SESSION_ID: "original-native", AO_DATA_DIR: "/wrong/project-data", AO_RUN_FILE: "/wrong/discovery", RECEIPT: receipt } });
  expect(result.status).toBe(0); expect(fs.readFileSync(receipt, "utf8")).toBe(`${env.AO_MANAGED_RUNTIME_DATA_DIR}|${env.AO_MANAGED_RUNTIME_RUN_FILE}|original-native`);
});
it("retains separate namespace wrappers and rejects retained helper tampering without injection", async () => {
  const { root, sha, env } = fixture(); const other = { ...env, AO_MANAGED_RUNTIME_DATA_DIR: path.join(root, "other-data"), AO_MANAGED_RUNTIME_RUN_FILE: path.join(root, "other-run/running.json") };
  expect(await setupManagedMessageAck(env)).toBe(true); expect(await setupManagedMessageAck(other)).toBe(true);
  expect(managedAckDirectory(env)).not.toBe(managedAckDirectory(other));
  fs.appendFileSync(path.join(env.AO_MANAGED_RUNTIME_DATA_DIR, "message-cli/bin", sha, "ao"), "# changed");
  const receipt = path.join(root, "must-not-exist");
  const result = spawnSync(path.join(managedAckDirectory(env)!, "ao-pilot"), ["ack", "message-1"], { encoding: "utf8", env: { ...process.env, AO_SESSION_ID: "native-original", RECEIPT: receipt } });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("ACK_HELPER_DRIFT"); expect(fs.existsSync(receipt)).toBe(false);
});
it("old binary/daemon capability has zero ACK effects and does not publish a wrapper", async () => {
  const { env } = fixture(false); expect(await setupManagedMessageAck(env)).toBe(false);
  expect(fs.existsSync(path.join(managedAckDirectory(env)!, "ao-pilot"))).toBe(false);
});
it("an incomplete binding cannot resolve a wrapper or fall back to ambient ao-pilot", async () => {
  const { env } = fixture(); expect(await setupManagedMessageAck({ ...env, AO_MANAGED_RUNTIME_BINARY_SHA256: "" })).toBe(false);
  expect(managedAckDirectory({ ...env, AO_MANAGED_RUNTIME_RUN_FILE: "" })).toBeNull();
});
