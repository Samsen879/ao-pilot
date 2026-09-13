import { NextRequest, NextResponse } from "next/server";

// Keep the original UI and API, but make validation fail closed for actions.
export function middleware(request: NextRequest) {
  const host = request.nextUrl.hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    return NextResponse.json({ error: "Localhost access only" }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${request.headers.get("host")}`) {
    return NextResponse.json({ error: "Cross-origin access denied" }, { status: 403 });
  }
  if (process.env["AO_DASHBOARD_READ_ONLY"] === "1" &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return NextResponse.json({ error: "Dashboard validation is read-only; action held" }, { status: 409 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
