// Background worker: the only part that talks to Resale HQ (with the assistant key) and fetches photos.
// Content scripts ask it for the job of their tab and report back when a listing went live.
import "./sites.js";

const SITES = globalThis.RHQ_SITES;

async function settings() {
  const { appUrl = "", key = "" } = await chrome.storage.local.get(["appUrl", "key"]);
  if (!appUrl || !key) throw new Error("Open the helper's settings and add the Resale HQ address and a key first.");
  return { appUrl: appUrl.replace(/\/+$/, ""), key };
}

async function api(path, init = {}) {
  const { appUrl, key } = await settings();
  const res = await fetch(appUrl + path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `Resale HQ answered ${res.status}`);
  return body;
}

const jobKey = tabId => `job:${tabId}`;

async function startJob({ item_id, platform }) {
  const site = SITES[platform];
  if (!site) throw new Error(`The helper doesn't post to ${platform}.`);
  const detail = await api(`/api/assistant?item_id=${encodeURIComponent(item_id)}`);
  const copy = detail.listing_text && detail.listing_text[platform];
  if (!copy) throw new Error(`Resale HQ has no listing text for ${site.name} on this item.`);
  const it = detail.item;
  const job = {
    platform,
    item_id,
    title: copy.title,
    description: copy.description,
    price: copy.price,
    photos: (detail.photos || []).slice(0, 12),
    pick: { Category: it.category, Brand: it.brand, Size: it.size, Condition: it.condition },
    startedAt: Date.now(),
  };
  const tab = await chrome.tabs.create({ url: site.sellUrl, active: true });
  await chrome.storage.session.set({ [jobKey(tab.id)]: job });
  return { tabId: tab.id };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function fetchPhotos(urls) {
  const out = [];
  for (const [i, url] of urls.entries()) {
    const res = await fetch(url);
    if (!res.ok) continue;
    const blob = await res.blob();
    out.push({ name: `photo-${i + 1}.jpg`, type: blob.type || "image/jpeg", dataUrl: await blobToDataUrl(blob) });
  }
  return out;
}

async function record(tabId, { url = null, externalId = null }) {
  const { [jobKey(tabId)]: job } = await chrome.storage.session.get(jobKey(tabId));
  if (!job) throw new Error("This tab has no Resale HQ job anymore.");
  const r = await api("/api/assistant", {
    method: "POST",
    body: JSON.stringify({ action: "record_listing", item_id: job.item_id, platform: job.platform, url, price: job.price, external_id: externalId }),
  });
  await chrome.storage.session.remove(jobKey(tabId));
  return r;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  const run = async () => {
    switch (msg.type) {
      case "queue": return api("/api/assistant?post_queue=1");
      case "start": return startJob(msg);
      case "job": {
        const { [jobKey(tabId)]: job } = await chrome.storage.session.get(jobKey(tabId));
        return { job: job || null };
      }
      case "photos": return { photos: await fetchPhotos(msg.urls || []) };
      case "record": return record(tabId, msg);
      case "drop": await chrome.storage.session.remove(jobKey(tabId)); return { ok: true };
      default: throw new Error(`Unknown message ${msg.type}`);
    }
  };
  run().then(r => reply({ ok: true, ...r }), e => reply({ ok: false, error: String(e && e.message || e) }));
  return true; // async reply
});

chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove(jobKey(tabId)); });
