import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SEPARATE,
  clip,
  cleanOrigin,
  composeNotifications,
  deviceLabelFromUserAgent,
  isAllowedPushEndpoint,
  normalizeKey,
  pushErrorMessage,
  validSubscriptionKeys,
  vapidSubject,
  type ClaimItem,
  type PushTask,
} from "./notify.ts";
import { bytesToUrlBase64, sameServerKey, urlBase64ToBytes } from "./browser.ts";

const task = (over: Partial<PushTask> = {}): PushTask => ({
  id: over.id ?? "t1",
  kind: over.kind ?? "offer_decision",
  status: over.status ?? "pending",
  title: over.title ?? "Offer: $30.00 for Helmet wall mount on eBay",
  detail: over.detail ?? null,
  item_id: over.item_id ?? null,
  offer_id: over.offer_id ?? null,
});
const item = (t: PushTask, queueId = 1): ClaimItem => ({ queue_id: queueId, kind: "task", target_user: null, task: t });

test("an offer becomes one notification that opens the Offers page", () => {
  const out = composeNotifications([item(task())], 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].targetUser, null);
  assert.deepEqual(out[0].payload, {
    title: "Somebody wants our shit",
    body: "Offer: $30.00 for Helmet wall mount on eBay",
    url: "/offers",
    tag: "task-t1",
    badge: 2,
  });
});

test("other to-dos open Home and carry their detail on a second line", () => {
  const [n] = composeNotifications([item(task({ id: "t2", kind: "other", title: "Confirm sale: Helmet mount on Etsy for $35", detail: 'Tap Open, then use "Sold at a price" on the listing to record it.' }))], 1);
  assert.equal(n.payload.title, "Heads up");
  assert.equal(n.payload.url, "/");
  assert.equal(n.payload.body, 'Confirm sale: Helmet mount on Etsy for $35\nTap Open, then use "Sold at a price" on the listing to record it.');
  const [m] = composeNotifications([item(task({ id: "t3", kind: "message_reply", title: "Buyer message on Vinted: still available?" }))], 1);
  assert.equal(m.payload.title, "A buyer's hitting us up");
  const [d] = composeNotifications([item(task({ id: "t4", kind: "delist", title: "Pull it off eBay, it already fucking sold" }))], 1);
  assert.equal(d.payload.title, "Sold! Pull the other listings");
  const [u] = composeNotifications([item(task({ id: "t5", kind: "something_new" }))], 1);
  assert.equal(u.payload.title, "Something needs us");
});

test("to-dos handled before the push went out are skipped, duplicates collapse", () => {
  const out = composeNotifications([item(task({ id: "a", status: "done" })), item(task({ id: "b" }), 2), item(task({ id: "b" }), 3)], 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.tag, "task-b");
  assert.deepEqual(composeNotifications([{ queue_id: 9, kind: "task", target_user: null, task: null }], 0), []);
});

test(`more than ${MAX_SEPARATE} new to-dos become one summary`, () => {
  const tasks = Array.from({ length: 5 }, (_, i) => item(task({ id: `s${i}`, kind: i ? "other" : "offer_decision", title: `Thing ${i}` }), i));
  const out = composeNotifications(tasks, 7);
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.title, "5 new things need us");
  assert.equal(out[0].payload.body, "Thing 0\nThing 1\n…and 3 more");
  assert.equal(out[0].payload.url, "/");
  assert.equal(out[0].payload.badge, 7);
  const offers = Array.from({ length: 4 }, (_, i) => item(task({ id: `o${i}` }), i));
  assert.equal(composeNotifications(offers, 4)[0].payload.url, "/offers");
  assert.equal(composeNotifications(tasks.slice(0, MAX_SEPARATE), 3).length, MAX_SEPARATE);
});

test("a test goes only to the member who asked, alongside any to-dos", () => {
  const out = composeNotifications([{ queue_id: 1, kind: "test", target_user: "u1", task: null }, item(task(), 2)], 0);
  assert.equal(out.length, 2);
  assert.equal(out[0].targetUser, "u1");
  assert.equal(out[0].payload.tag, "test");
  assert.equal(out[0].payload.url, "/settings");
  assert.equal(out[1].targetUser, null);
  assert.equal(composeNotifications([{ queue_id: 1, kind: "test", target_user: null, task: null }], 0).length, 0, "a test without a target is dropped");
});

test("badge is a whole, non-negative number", () => {
  assert.equal(composeNotifications([item(task())], -3)[0].payload.badge, 0);
  assert.equal(composeNotifications([item(task())], 2.7)[0].payload.badge, 2);
  assert.equal(composeNotifications([item(task())], Number.NaN)[0].payload.badge, 0);
});

test("long titles are clipped so the notification stays readable", () => {
  assert.equal(clip("  lots   of\n space  ", 50), "lots of space");
  assert.equal(clip("abcdefghij", 5), "abcd…");
  const [n] = composeNotifications([item(task({ title: "x".repeat(400), detail: "y".repeat(400) }))], 0);
  const [title, detail] = n.payload.body.split("\n");
  assert.equal(title.length, 140);
  assert.equal(detail.length, 110);
});

test("only real push services are accepted as endpoints", () => {
  assert.ok(isAllowedPushEndpoint("https://web.push.apple.com/QGd8zQ-abc"));
  assert.ok(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc:def"));
  assert.ok(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"));
  assert.ok(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=abc"));
  assert.ok(!isAllowedPushEndpoint("http://web.push.apple.com/abc"), "plain http");
  assert.ok(!isAllowedPushEndpoint("https://evil.example.com/push.apple.com"), "host is not a push service");
  assert.ok(!isAllowedPushEndpoint("https://push.apple.com.evil.example.com/x"), "lookalike host");
  assert.ok(!isAllowedPushEndpoint("https://user:pw@web.push.apple.com/x"), "credentials in the URL");
  assert.ok(!isAllowedPushEndpoint("not a url"));
  assert.ok(!isAllowedPushEndpoint("https://web.push.apple.com/" + "a".repeat(1100)), "too long");
});

test("subscription keys must look like a P-256 key and a 16-byte secret", () => {
  const p256dh = "B" + "A".repeat(86);
  const auth = "a".repeat(22);
  assert.ok(validSubscriptionKeys(p256dh, auth));
  assert.equal(normalizeKey(" abc== "), "abc");
  assert.ok(!validSubscriptionKeys("short", auth));
  assert.ok(!validSubscriptionKeys(p256dh, "has spaces in it!!!!!!"));
  assert.ok(!validSubscriptionKeys(p256dh + "+/", auth), "standard base64 characters are not base64url");
});

test("the database only gets a clean scheme://host[:port] to call", () => {
  assert.equal(cleanOrigin("https://resale.example.com/"), "https://resale.example.com");
  assert.equal(cleanOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(cleanOrigin("https://resale.example.com/path"), null);
  assert.equal(cleanOrigin("javascript:alert(1)"), null);
  assert.equal(cleanOrigin(undefined), null);
});

test("VAPID subject is the app's https address, never localhost", () => {
  assert.equal(vapidSubject("https://resale.example.com"), "https://resale.example.com");
  assert.equal(vapidSubject("http://localhost:3000"), "mailto:notifications@resale-hq.invalid");
  assert.equal(vapidSubject("https://localhost:3000"), "mailto:notifications@resale-hq.invalid");
  assert.equal(vapidSubject(null), "mailto:notifications@resale-hq.invalid");
});

test("device names for the Settings list", () => {
  assert.equal(deviceLabelFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15"), "iPhone");
  assert.equal(deviceLabelFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5), "iPad");
  assert.equal(deviceLabelFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 0), "Mac");
  assert.equal(deviceLabelFromUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36"), "Android phone");
  assert.equal(deviceLabelFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "Windows PC");
  assert.equal(deviceLabelFromUserAgent(""), "This device");
});

test("a missing migration is explained in plain words", () => {
  assert.match(pushErrorMessage({ code: "PGRST202", message: "Could not find the function public.push_prepare" }), /20261031010000_push_notifications\.sql/);
  assert.match(pushErrorMessage({ code: "PGRST205", message: "Could not find the table" }), /isn't set up yet/);
  assert.equal(pushErrorMessage({ code: "P0002", message: "Household not found" }), "Couldn't find our household.");
  assert.equal(pushErrorMessage({ code: "XX000", message: "ERROR: something odd" }), "something odd");
  assert.equal(pushErrorMessage(null), "Something went wrong.");
});

test("VAPID public key round-trips between base64url and bytes", () => {
  const bytes = new Uint8Array(65).map((_, i) => (i * 37 + 4) % 256);
  bytes[0] = 4;
  const encoded = bytesToUrlBase64(bytes);
  assert.equal(encoded.length, 87);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual([...urlBase64ToBytes(encoded)], [...bytes]);
  assert.ok(sameServerKey(bytes.buffer, encoded));
  assert.ok(sameServerKey(bytes.buffer, encoded + "="), "padding does not matter");
  assert.ok(!sameServerKey(new Uint8Array(65).buffer, encoded));
  assert.ok(!sameServerKey(null, encoded));
});
