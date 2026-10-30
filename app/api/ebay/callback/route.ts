import { NextResponse, type NextRequest } from "next/server";
import { getContext } from "@/lib/household";
import { getEbayUser } from "@/lib/ebay/api";
import { EBAY_USER_SCOPES, isEbayConfigured, readEbayConfig } from "@/lib/ebay/config";
import { tokenColumns } from "@/lib/ebay/connection";
import { ebayNoticeCookie } from "@/lib/ebay/notice";
import { EBAY_NONCE_COOKIE, exchangeCode, verifyState } from "@/lib/ebay/oauth";

export const dynamic = "force-dynamic";

/**
 * eBay sends the user back here (via the RuName's "Your auth accepted URL") with ?code=&state=.
 * Verifies the signed state + nonce cookie, exchanges the code, stores encrypted tokens on the
 * household's connection row, logs it, and returns to Settings.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const finish = (location: string, kind: "ok" | "error", message: string) => {
    const res = NextResponse.redirect(new URL(location, request.url));
    const notice = ebayNoticeCookie(kind, message);
    res.cookies.set(notice.name, notice.value, notice.options);
    res.cookies.delete({ name: EBAY_NONCE_COOKIE, path: "/api/ebay" });
    return res;
  };
  const fail = (reason: string, message: string) => finish(`/settings?ebay=error&reason=${encodeURIComponent(reason)}`, "error", message);

  if (!isEbayConfigured()) return fail("not_configured", "eBay is not set up on this deployment yet.");
  if (params.get("error")) return fail("denied", "eBay sign-in was cancelled or denied.");
  const code = params.get("code");
  const state = verifyState(params.get("state"));
  const nonce = request.cookies.get(EBAY_NONCE_COOKIE)?.value;
  if (!code || !state || !nonce || state.n !== nonce) return fail("state", "That eBay sign-in link was stale or invalid. Please try Connect eBay again.");

  const ctx = await getContext(); // redirects to /login when signed out
  if (!ctx.household || ctx.household.id !== state.h || ctx.userId !== state.u) return fail("mismatch", "This eBay sign-in belongs to a different account or household.");

  const cfg = readEbayConfig();
  try {
    const tokens = await exchangeCode(cfg, code);
    const who = await getEbayUser(cfg, tokens.access_token);
    const { error } = await ctx.supabase.from("marketplace_connections").upsert(
      {
        household_id: ctx.household.id,
        platform: "ebay",
        environment: cfg.env,
        account_handle: who.username,
        external_user_id: who.userId,
        ...tokenColumns(tokens),
        scopes: EBAY_USER_SCOPES.join(" "),
        status: "active",
        last_error: null,
        connected_by: ctx.userId,
      },
      { onConflict: "household_id,platform" },
    );
    if (error) throw new Error(error.message);

    await ctx.supabase.from("activity_log").insert({
      household_id: ctx.household.id,
      actor_user: ctx.userId,
      action: "ebay_connected",
      entity_type: "household",
      entity_id: ctx.household.id,
      detail: { environment: cfg.env, account: who.username ?? null }, // token values are never logged
    });
    return finish("/settings?ebay=connected", "ok", `eBay connected${who.username ? ` as ${who.username}` : ""} (${cfg.env}).`);
  } catch (e) {
    console.error("[ebay/callback]", (e as Error).message);
    return fail("exchange", `Could not finish connecting eBay: ${(e as Error).message.slice(0, 200)}`);
  }
}
