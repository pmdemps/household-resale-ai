// Browser-side helpers for turning phone notifications on and off (components/push-toggle.tsx).
// The byte helpers are pure and covered by lib/push/push.test.ts; pushSupport() needs a real browser.

/** base64url (the VAPID public key) → bytes, for pushManager.subscribe({ applicationServerKey }). */
export function urlBase64ToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToUrlBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = "";
  for (let i = 0; i < view.length; i++) raw += String.fromCharCode(view[i]);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** True when an existing subscription was made with this VAPID public key (otherwise subscribe again). */
export function sameServerKey(current: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!current) return false;
  return bytesToUrlBase64(current) === publicKey.replace(/=+$/, "");
}

export type PushSupport = "supported" | "needs-install" | "unsupported";

/**
 * iPhone and iPad only do push from the home-screen app (iOS 16.4+), never from a Safari tab, so there the
 * answer is "needs-install" until the app is opened from its icon.
 */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (capable) return "supported";
  return iOS && !standalone ? "needs-install" : "unsupported";
}
