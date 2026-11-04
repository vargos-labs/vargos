import { NextResponse } from "next/server";
import { rpcCall } from "../../server/rpc";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await rpcCall<{ running: boolean; url: string; reason: string | null }>("browser.status");
    if (status.running) return NextResponse.redirect(status.url);
    return new Response(status.reason || "Browser dashboard is unavailable.", { status: 503 });
  } catch { /* daemon unavailable */ }
  return new Response("Browser dashboard is unavailable. Keep the agent idle before taking control.", { status: 503 });
}
