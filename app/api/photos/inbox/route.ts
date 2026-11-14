import { NextResponse, type NextRequest } from "next/server";
import { InboxError, processPhotoInbox } from "@/lib/photo-inbox";
import { pushDb } from "@/lib/push/send";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Stores photos waiting in photo_inbox. The caller is the database: the photo_inbox_poke trigger
// (supabase/migrations/20261114000000_photo_inbox.sql) POSTs {"household_id", "token"} through pg_net.
// The token is the household's push dispatch token and is checked inside the SQL functions.

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
  const storage = createServiceClient();
  if (!db || !storage) return NextResponse.json({ error: "Supabase or SUPABASE_SERVICE_ROLE_KEY is not configured on the server" }, { status: 503 });

  try {
    return NextResponse.json(await processPhotoInbox(db, storage, householdId, token));
  } catch (e) {
    if (e instanceof InboxError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("photo inbox failed", (e as Error).message?.slice(0, 200));
    return NextResponse.json({ error: "Photo inbox failed" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: "The database calls this with POST" }, { status: 405 });
}
