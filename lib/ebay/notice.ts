import "server-only";
import { cookies } from "next/headers";

// One-shot status messages from eBay server actions / routes to the eBay UI components, carried in a
// short-lived httpOnly cookie. Server components cannot write cookies, so the notice simply expires
// (60 s) instead of being cleared; the next eBay action overwrites it. Keeps the integration UI
// self-contained without edits to the pages that mount it.

export const EBAY_NOTICE_COOKIE = "rhq_ebay_notice";
const TTL_SECONDS = 60;

export type EbayNotice = { kind: "ok" | "error"; message: string; at: number };

export function ebayNoticeCookie(kind: EbayNotice["kind"], message: string) {
  return {
    name: EBAY_NOTICE_COOKIE,
    value: JSON.stringify({ kind, message: message.slice(0, 400), at: Date.now() } satisfies EbayNotice),
    options: { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", maxAge: TTL_SECONDS, path: "/" },
  };
}

/** For server actions (route handlers set the cookie on their NextResponse instead). */
export async function setEbayNotice(kind: EbayNotice["kind"], message: string): Promise<void> {
  try {
    const c = ebayNoticeCookie(kind, message);
    (await cookies()).set(c.name, c.value, c.options);
  } catch {
    // Not in a context that can set cookies (e.g. rendering); nothing to do.
  }
}

export async function readEbayNotice(): Promise<EbayNotice | null> {
  try {
    const raw = (await cookies()).get(EBAY_NOTICE_COOKIE)?.value;
    if (!raw) return null;
    const n = JSON.parse(raw) as EbayNotice;
    if (!n || (n.kind !== "ok" && n.kind !== "error") || typeof n.message !== "string") return null;
    if (Date.now() - n.at > TTL_SECONDS * 1000) return null;
    return n;
  } catch {
    return null;
  }
}
