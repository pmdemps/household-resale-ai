// Phone notifications (web push): the pure parts, shared by the dispatch route, the server actions, the
// Settings card and the tests. No "server-only" and no "@/..." imports, so node --test can load it.
//
// Flow (see supabase/migrations/20261031010000_push_notifications.sql): a new pending to-do is queued by a
// trigger, the database POSTs to /api/push/dispatch, the route claims the queue (push_claim) and turns the
// claimed rows into notifications with composeNotifications below.

export type PushTask = {
  id: string;
  kind: string;
  status: string;
  title: string;
  detail: string | null;
  item_id: string | null;
  offer_id: string | null;
  /** Whose thing the to-do is about (inventory_items.owner_user); null or missing when it's ours. */
  owner_id?: string | null;
  /** That member's display name; null when they haven't set one. */
  owner_name?: string | null;
};

export type ClaimItem = {
  queue_id: number;
  /** "handoff": one member asked another about their thing ("that's Lauren's, go ask her"). */
  kind: "task" | "test" | "handoff";
  target_user: string | null;
  /** Hand-offs: who asked, and their display name (null when they haven't set one). */
  from_user?: string | null;
  from_name?: string | null;
  /** The thing a hand-off or to-do is about. */
  item?: { id: string; name: string } | null;
  task: PushTask | null;
};

export type ClaimedSubscription = { endpoint: string; p256dh: string; auth: string; user_id: string };

/** What push_claim returns. */
export type PushClaim = {
  items: ClaimItem[];
  pending_count: number;
  origin: string | null;
  vapid_public_key: string;
  vapid_private_key: string;
  subscriptions: ClaimedSubscription[];
};

/** The JSON a phone receives; public/sw.js turns it into the notification. */
export type PushPayload = { title: string; body: string; url: string; tag: string; badge: number };

/** targetUser null = every member's devices; exceptUser leaves one member's devices out. */
export type OutgoingNotification = { targetUser: string | null; exceptUser?: string | null; payload: PushPayload };

/** What we call a member who hasn't put their name in Settings yet. */
export const UNNAMED_MEMBER = "your other half";

/** "Lauren" → "Lauren's", "James" → "James'". */
export function possessive(name: string): string {
  const n = name.trim();
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** More new to-dos than this at once become one summary instead of a pile of buzzes. */
export const MAX_SEPARATE = 3;

const HEADINGS: Record<string, string> = {
  offer_decision: "Somebody wants our shit",
  message_reply: "A buyer's hitting us up",
  delist: "Sold! Pull the other listings",
  price_change: "Price check",
  listing_draft: "A listing's ready to look at",
  relist: "Time to relist some shit",
  other: "Heads up",
};

export function headingFor(kind: string): string {
  return HEADINGS[kind] ?? "Something needs us";
}

/** Offers are decided on the Offers page; every other to-do lives on Home ("Shit to do"). */
export function urlFor(task: Pick<PushTask, "kind">): string {
  return task.kind === "offer_decision" ? "/offers" : "/";
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function notificationForTask(task: PushTask, badge: number, heading = headingFor(task.kind)): PushPayload {
  const title = clip(task.title, 140);
  const detail = task.detail ? clip(task.detail, 110) : "";
  return {
    title: heading,
    body: detail ? `${title}\n${detail}` : title,
    url: urlFor(task),
    tag: `task-${task.id}`,
    badge,
  };
}

/**
 * One to-do → its notification(s). Everyone gets buzzed, but an offer on someone's thing says so:
 * "Somebody wants your shit" on the owner's phones, "Somebody wants Lauren's shit" on everyone else's.
 */
export function notificationsForTask(task: PushTask, badge: number): OutgoingNotification[] {
  if (task.kind === "offer_decision" && task.owner_id) {
    const owner = task.owner_name?.trim() || UNNAMED_MEMBER;
    return [
      { targetUser: task.owner_id, payload: notificationForTask(task, badge, "Somebody wants your shit") },
      { targetUser: null, exceptUser: task.owner_id, payload: notificationForTask(task, badge, `Somebody wants ${possessive(owner)} shit`) },
    ];
  }
  return [{ targetUser: null, payload: notificationForTask(task, badge) }];
}

/** "Patrick says this is your shit. How badly do you wanna sell it?" Only the member who was asked gets it. */
export function handoffNotification(item: ClaimItem, badge: number): PushPayload {
  const from = item.from_name?.trim() || capitalize(UNNAMED_MEMBER);
  const task = item.task && item.task.status === "pending" ? item.task : null;
  const about = task ? clip(task.title, 140) : clip(item.item?.name ?? "Something of yours", 140);
  return {
    title: `${from} says this is your shit`,
    body: `How badly do you wanna sell it?\n${about}`,
    url: task?.kind === "offer_decision" ? "/offers" : item.item ? `/inventory/${item.item.id}` : "/",
    tag: `handoff-${task?.id ?? item.item?.id ?? item.queue_id}`,
    badge,
  };
}

export function summaryNotification(tasks: PushTask[], badge: number): PushPayload {
  const shown = tasks.slice(0, 2).map(t => clip(t.title, 80));
  const more = tasks.length - shown.length;
  return {
    title: `${tasks.length} new things need us`,
    body: shown.join("\n") + (more > 0 ? `\n…and ${more} more` : ""),
    url: tasks.every(t => t.kind === "offer_decision") ? "/offers" : "/",
    tag: "summary",
    badge,
  };
}

export function testNotification(badge: number): PushPayload {
  return {
    title: "Hell yeah, notifications work",
    body: "This phone will buzz when somebody makes an offer, something sells or a buyer messages us.",
    url: "/settings",
    tag: "test",
    badge,
  };
}

/**
 * Turns claimed queue rows into notifications. Tests and hand-offs go only to the member they are for (a
 * hand-off whose offer was answered in the meantime is dropped). To-dos that were already handled in the
 * seconds before the push went out are skipped; more than MAX_SEPARATE new ones become one summary. Every
 * notification carries the pending count for the app-icon badge.
 */
export function composeNotifications(items: ClaimItem[], pendingCount: number): OutgoingNotification[] {
  const badge = Math.max(0, Math.floor(Number(pendingCount)) || 0);
  const out: OutgoingNotification[] = [];

  for (const item of items) {
    if (item.kind === "test" && item.target_user) out.push({ targetUser: item.target_user, payload: testNotification(badge) });
    if (item.kind === "handoff" && item.target_user && (!item.task || item.task.status === "pending")) {
      out.push({ targetUser: item.target_user, payload: handoffNotification(item, badge) });
    }
  }

  const seen = new Set<string>();
  const tasks: PushTask[] = [];
  for (const item of items) {
    const t = item.kind === "task" ? item.task : null;
    if (!t || t.status !== "pending" || seen.has(t.id)) continue;
    seen.add(t.id);
    tasks.push(t);
  }

  if (tasks.length > MAX_SEPARATE) out.push({ targetUser: null, payload: summaryNotification(tasks, badge) });
  else for (const t of tasks) out.push(...notificationsForTask(t, badge));
  return out;
}

// ---------------------------------------------------------------------------
// Input checks (server actions) and small helpers
// ---------------------------------------------------------------------------

/** Push services of the browsers that can install this app. Anything else is refused. */
const PUSH_SERVICE_HOSTS = [
  "push.apple.com", // Safari / iPhone home-screen apps (web.push.apple.com)
  "fcm.googleapis.com", // Chrome, Edge on Android, Samsung Internet
  "android.googleapis.com",
  "push.services.mozilla.com", // Firefox (updates.push.services.mozilla.com)
  "notify.windows.com", // Edge on Windows (*.notify.windows.com)
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== "string" || endpoint.length < 12 || endpoint.length > 1024) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some(h => host === h || host.endsWith("." + h));
}

/** base64url without padding (what PushSubscription.toJSON() gives, and what the database stores). */
export function normalizeKey(value: unknown): string {
  return String(value ?? "").trim().replace(/=+$/, "");
}

/** p256dh is a 65-byte P-256 point (87 chars); auth is a 16-byte secret (22 chars). */
export function validSubscriptionKeys(p256dh: string, auth: string): boolean {
  return /^[A-Za-z0-9_-]{80,100}$/.test(p256dh) && /^[A-Za-z0-9_-]{16,30}$/.test(auth);
}

/** scheme://host[:port] the database may POST to, or null if the value is not one. */
export function cleanOrigin(value: string | null | undefined): string | null {
  const v = String(value ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(v) ? v : null;
}

/**
 * VAPID "sub" claim: the app's https address. Apple rejects localhost, and web-push refuses anything that is
 * not https: or mailto:, so local development falls back to a placeholder mailto.
 */
export function vapidSubject(origin: string | null | undefined): string {
  const o = cleanOrigin(origin);
  if (o && o.startsWith("https://") && !/^https:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o)) return o;
  return "mailto:notifications@resale-hq.invalid";
}

/** Short name for the device list in Settings ("Lauren's iPhone"). iPads report a Mac user agent with touch. */
export function deviceLabelFromUserAgent(ua: string, maxTouchPoints = 0): string {
  const s = String(ua ?? "");
  if (/iPad/.test(s) || (/Macintosh/.test(s) && maxTouchPoints > 1)) return "iPad";
  if (/iPhone|iPod/.test(s)) return "iPhone";
  if (/Android/.test(s)) return /Mobile/.test(s) ? "Android phone" : "Android tablet";
  if (/Macintosh/.test(s)) return "Mac";
  if (/Windows/.test(s)) return "Windows PC";
  if (/CrOS/.test(s)) return "Chromebook";
  if (/Linux/.test(s)) return "Linux computer";
  return "This device";
}

/** Plain-words message for a database error from the push_* functions. */
export function pushErrorMessage(err: { code?: string | null; message?: string | null } | null | undefined): string {
  const code = err?.code ?? "";
  const message = String(err?.message ?? "");
  if (["PGRST202", "PGRST205", "42883", "42P01"].includes(code) || /Could not find the (function|table)/i.test(message)) {
    return "The database part of notifications isn't set up yet. Run supabase/migrations/20261031010000_push_notifications.sql in Supabase → SQL Editor first.";
  }
  if (code === "28000") return "You need to be signed in.";
  if (code === "P0002") return "Couldn't find our household.";
  return message.replace(/^[^:]*: /, "").slice(0, 200) || "Something went wrong.";
}
