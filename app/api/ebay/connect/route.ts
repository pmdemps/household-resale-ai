import { NextResponse, type NextRequest } from "next/server";
import { redirect } from "next/navigation";
import { getContext } from "@/lib/household";
import { isEbayConfigured, readEbayConfig } from "@/lib/ebay/config";
import { EBAY_NONCE_COOKIE, buildAuthorizeUrl, newNonce, signState } from "@/lib/ebay/oauth";

export const dynamic = "force-dynamic";

/** Start the eBay consent flow for the signed-in member's household. */
export async function GET(request: NextRequest) {
  if (!isEbayConfigured()) return NextResponse.redirect(new URL("/settings?ebay=not_configured", request.url));
  const ctx = await getContext(); // redirects to /login when signed out
  if (!ctx.household) redirect("/setup");

  const cfg = readEbayConfig();
  const nonce = newNonce();
  const state = signState({ h: ctx.household.id, u: ctx.userId, n: nonce });
  const res = NextResponse.redirect(buildAuthorizeUrl({ env: cfg.env, clientId: cfg.clientId, ruName: cfg.ruName, state }));
  // Double-submit check: the nonce inside the signed state must match this cookie on return.
  res.cookies.set(EBAY_NONCE_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", maxAge: 15 * 60, path: "/api/ebay" });
  return res;
}
