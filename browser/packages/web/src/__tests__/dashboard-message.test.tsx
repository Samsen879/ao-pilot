import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Dashboard } from "@/components/Dashboard";
import { makeSession } from "./helpers";
vi.mock("@/hooks/useSessionEvents", () => ({ useSessionEvents: (sessions: unknown[]) => ({ sessions, globalPause: null }) }));
vi.mock("@/components/DynamicFavicon", () => ({ DynamicFavicon: () => null }));
vi.mock("@/components/ProjectSidebar", () => ({ ProjectSidebar: () => null }));
vi.mock("@/components/AttentionZone", () => ({ AttentionZone: ({ sessions, onSend }: { sessions: { id: string }[]; onSend: (id: string, message: string) => void }) => <>{sessions.map((session) => <button key={session.id} onClick={() => onSend(session.id, "task")}>Send fixture</button>)}</> }));
vi.mock("@/components/PRStatus", () => ({ PRTableRow: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("Dashboard delivery result", () => {
  it.each(["submitted_unconfirmed", "ack_timeout"])("shows %s and does not retry even when fetch res.ok is true", async (outcome) => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: outcome === "ack_timeout" ? 504 : 202, json: async () => ({ message_id: "stable-id", outcome, evidence: { code: "FIXTURE", signal: "none", attempts: 1, recorded_at: "2026-10-23T00:00:00Z" } }) });
    vi.stubGlobal("fetch", fetch);
    render(<Dashboard initialSessions={[makeSession()]} />);
    fireEvent.click(screen.getByText("Send fixture"));
    expect(await screen.findByRole("status")).toHaveTextContent(`Message not confirmed: ${outcome}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
