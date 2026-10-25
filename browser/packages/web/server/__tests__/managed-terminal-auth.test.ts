import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createDirectTerminalServer, type DirectTerminalServer } from "../direct-terminal-ws.js";

const origin = "http://127.0.0.1:43210";
const token = "b".repeat(64);
let root: string; let terminal: DirectTerminalServer; let port: number;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-direct-auth-"));
  const file = path.join(root, "token"); fs.writeFileSync(file, token, { mode: 0o600 });
  const configFile = path.join(root, "adapter.json"); fs.writeFileSync(configFile, JSON.stringify({ TERMINAL_TOKEN_FILE: file, TERMINAL_ORIGIN: origin }), { mode: 0o600 });
  for (const [key, value] of Object.entries({ AO_RELEASE_ID: "fixture", AO_DASHBOARD_ADAPTER_CONFIG: configFile,
    AO_TMUX_SOCKET: "ao-pilot-staging-browser-auth", AO_TMUX_UNIT: "ao-pilot-staging-browser-auth-tmux.service", AO_TMUX_TMPDIR: root, TMUX_TMPDIR: root })) vi.stubEnv(key, value);
  terminal = createDirectTerminalServer();
  await new Promise<void>(resolve => terminal.server.listen(0, "127.0.0.1", resolve));
  const address = terminal.server.address(); port = typeof address === "object" && address ? address.port : 0;
});
afterAll(() => { terminal?.shutdown(); vi.unstubAllEnvs(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
function admission(headers: Record<string, string>, requestedOrigin = origin): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=not-present`, { origin: requestedOrigin, headers });
    const timer = setTimeout(() => { ws.terminate(); reject(Error("handshake timeout")); }, 2000);
    const finish = (status: number) => { clearTimeout(timer); ws.terminate(); resolve(status); };
    ws.on("unexpected-response", (_req, res) => { res.resume(); finish(res.statusCode ?? 0); });
    ws.on("open", () => finish(101)); ws.on("error", () => {});
  });
}
describe("direct managed terminal cannot bypass adapter authentication", () => {
  it("rejects absent and incorrect credentials before upgrading", async () => {
    expect(await admission({})).toBe(401);
    expect(await admission({ Authorization: "Bearer invalid" })).toBe(401);
    expect(await admission({ Cookie: `ao_terminal=${token}` })).toBe(401);
  });
  it("rejects an original foreign Origin even with the correct capability", async () => {
    expect(await admission({ Authorization: `Bearer ${token}` }, "http://invalid.example")).toBe(403);
  });
  it("admits valid Bearer and browser HTTP Basic (not PTY restoration proof)", async () => {
    expect(await admission({ Authorization: `Bearer ${token}` })).toBe(101);
    expect(await admission({ Authorization: `Basic ${Buffer.from("ao:"+token).toString("base64")}` })).toBe(101);
  });
});
