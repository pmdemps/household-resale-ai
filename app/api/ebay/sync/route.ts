import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isEbayConfigured } from "@/lib/ebay/config";
import { syncEbayOffers, type SyncResult } from "@/lib/ebay/sync";
import { createServiceClient } from "@/lib/supabase/service";
import type { MarketplaceConnection } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Scheduled poll of eBay Best Offers for every household with an active eBay connection.
// Call: POST /api/ebay/sync with `Authorization: Bearer ${CRON_SECRET}` every 10-15 minutes from an
// external scheduler (Vercel Hobby crons are daily at most, so no vercel.json cron is added here).
// Needs SUPABASE_SERVICE_ROLE_KEY (server-only) to read connections across households without a session;
// without it the route answers 503 and does nothing. Only proposes offers (agent_tasks); never responds.

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 16 || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isEbayConfigured()) return NextResponse.json({ error: "eBay integration is not configured", skipped: true }, { status: 503 });
  const db = createServiceClient();
  if (!db) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set; sync is disabled", skipped: true }, { status: 503 });

  const { data, error } = await db.from("marketplace_connections").select("*").eq("platform", "ebay").eq("status", "active").not("refresh_token_enc", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const connections = (data ?? []) as MarketplaceConnection[];

  const results: SyncResult[] = [];
  const failures: { householdId: string; error: string }[] = [];
  for (const conn of connections) {
    try {
      results.push(await syncEbayOffers(db, conn, { actorAgent: "ebay-sync" }));
    } catch (e) {
      failures.push({ householdId: conn.household_id, error: (e as Error).message.slice(0, 300) });
    }
  }
  const totals = results.reduce(
    (t, r) => ({ listings: t.listings + r.listingsChecked, newOffers: t.newOffers + r.newOffers, updated: t.updated + r.updatedOffers, expired: t.expired + r.expiredOffers, errors: t.errors + r.errors.length }),
    { listings: 0, newOffers: 0, updated: 0, expired: 0, errors: 0 },
  );
  return NextResponse.json({ households: connections.length, ...totals, failures, ranAt: new Date().toISOString() });
}

export async function GET() {
  return NextResponse.json({ error: "Use POST with Authorization: Bearer <CRON_SECRET>" }, { status: 405 });
}
