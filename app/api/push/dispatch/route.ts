import { NextResponse, type NextRequest } from "next/server";
import { appUrl } from "@/lib/ebay/config";
import { dispatchPush, pushDb, PushDispatchError } from "@/lib/push/send";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Sends phone notifications for whatever is waiting in push_queue. The caller is the database itself: the
// push_poke trigger (supabase/migrations/20261031010000_push_notifications.sql) POSTs
// {"household_id", "token"} through pg_net right after a to-do is written. The token is checked inside the
// SQL functions, so a request without the right one gets nothing. A repeated request is harmless: rows are
// claimed once.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;

export async function POST(request: NextRequest) {
  let body: { household_id?: unknown; token?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const householdId = typeof body?.household_id === "string" ? body.household_id : "";
  const token = typeof body?.token === "string" ? body.token : "";
  if (!UUID.test(householdId) || !TOKEN.test(token)) {
    return NextResponse.json({ error: "Expected {\"household_id\", \"token\"}" }, { status: 400 });
  }

  const db = pushDb();
  if (!db) return NextResponse.json({ error: "Supabase is not configured on the server" }, { status: 503 });

  try {
    return NextResponse.json(await dispatchPush(db, householdId, token, appUrl()));
  } catch (e) {
    if (e instanceof PushDispatchError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("push dispatch failed", (e as Error).message?.slice(0, 200));
    return NextResponse.json({ error: "Dispatch failed" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: "The database calls this with POST" }, { status: 405 });
}
