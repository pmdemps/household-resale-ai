// Resale HQ service worker: shows the phone notifications sent by /api/push/dispatch and opens the right page
// when one is tapped. It has no fetch handler and caches nothing, so the app always loads fresh from the server.
// Registered by components/push-toggle.tsx when someone turns notifications on.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Resale HQ";
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/";
  const options = {
    body: typeof data.body === "string" && data.body ? data.body : "Something needs us.",
    tag: typeof data.tag === "string" && data.tag ? data.tag : undefined,
    icon: "/apple-icon",
    data: { url },
  };
  // iPhone requires every push to show a notification, or it stops delivering them. Always show one.
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), setBadge(data.badge)]));
});

/** Number on the app icon (iPhone home-screen apps, installed desktop apps). A nice-to-have: never throws. */
function setBadge(count) {
  try {
    const nav = self.navigator;
    if (typeof count !== "number" || !nav) return Promise.resolve();
    if (count > 0 && nav.setAppBadge) return nav.setAppBadge(count).catch(() => undefined);
    if (count === 0 && nav.clearAppBadge) return nav.clearAppBadge().catch(() => undefined);
  } catch {
    // Badging is not supported here.
  }
  return Promise.resolve();
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data && typeof event.notification.data.url === "string" ? event.notification.data.url : "/";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(openOrFocus(target));
});

async function openOrFocus(target) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    try {
      const focused = await client.focus();
      if (focused && "navigate" in focused) await focused.navigate(target);
      return;
    } catch {
      // Not controlled by this worker yet, or focus was refused: fall through and open a window.
    }
  }
  await self.clients.openWindow(target);
}
