import { NextResponse, type NextRequest } from "next/server";
import { challengeBody, isValidVerificationToken, parseAccountDeletionNotification } from "@/lib/ebay/account-deletion";
import { appUrl } from "@/lib/ebay/config";
import { createAnonClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// eBay Marketplace Account Deletion endpoint (required before a production keyset is enabled).
// Public: no session. Configure in the eBay developer portal with this URL and the same verification
// token as EBAY_DELETION_VERIFICATION_TOKEN. See docs/ebay-setup.md.

function endpointUrl(): string {
  return `${appUrl()}/api/ebay/account-deletion`;
}

/** Challenge: eBay calls GET ?challenge_code=... and expects {"challengeResponse": sha256(code+token+url)}. */
export async function GET(request: NextRequest) {
  const token = process.env.EBAY_DELETION_VERIFICATION_TOKEN;
  if (!isValidVerificationToken(token)) {
    return NextResponse.json({ error: "EBAY_DELETION_VERIFICATION_TOKEN is not set (32-80 chars of A-Z a-z 0-9 _ -)." }, { status: 503 });
  }
  const code = request.nextUrl.searchParams.get("challenge_code");
  if (!code) return NextResponse.json({ error: "Missing challenge_code" }, { status: 400 });
  // JSON.stringify (via NextResponse.json) avoids the BOM problem eBay warns about with hand-built bodies.
  return NextResponse.json(challengeBody(code, token!, endpointUrl()), { status: 200 });
}

/** Notification: revoke the matching eBay connection's tokens and log the notice. Always ack fast. */
export async function POST(request: NextRequest) {
  const token = process.env.EBAY_DELETION_VERIFICATION_TOKEN;
  if (!isValidVerificationToken(token)) return NextResponse.json({ error: "Endpoint not configured" }, { status: 503 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const notice = parseAccountDeletionNotification(body);
  if (!notice) return NextResponse.json({ error: "Not a MARKETPLACE_ACCOUNT_DELETION notification" }, { status: 400 });

  // TODO(security): verify the X-EBAY-SIGNATURE header against eBay's public key
  // (Commerce Notification API getPublicKey, ECDSA). Until then this relies on the payload shape, the
  // secret URL only eBay knows, and the fact that the only effect is revoking our copy of one user's tokens.
  const signature = request.headers.get("x-ebay-signature");

  const db = createAnonClient();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { username, userId } = notice.notification.data;
  const { error } = await db.rpc("record_ebay_account_deletion", {
    p_username: username ?? null,
    p_user_id: userId ?? null,
    p_raw: { ...notice, receivedSignature: signature ? "present" : "absent" },
  });
  if (error) {
    console.error("[ebay/account-deletion] record failed:", error.message);
    return NextResponse.json({ error: "Could not record notice" }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}
