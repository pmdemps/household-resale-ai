// Runs on Mercari, Poshmark and Facebook Marketplace pages. If this tab has a Resale HQ job, it fills in the
// sell form (title, description, price, photos) and shows a panel listing what's left to pick by hand.
// It NEVER presses the site's Post/List/Publish button: the person reviews and taps it. Once the site shows
// the new listing, the job is recorded in Resale HQ.
(() => {
  if (window.top !== window) return; // not inside iframes
  const SITES = globalThis.RHQ_SITES;
  const platform = Object.keys(SITES).find(p => location.host === SITES[p].host);
  if (!platform) return;
  const site = SITES[platform];

  const send = msg => new Promise(resolve => chrome.runtime.sendMessage(msg, r => resolve(r || { ok: false, error: chrome.runtime.lastError?.message })));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let job = null;
  let panel = null;
  let recorded = false;

  // ---------- panel ----------
  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement("div");
    panel.id = "rhq-helper-panel";
    panel.style.cssText = [
      "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647", "width:320px", "max-height:70vh", "overflow:auto",
      "background:#111", "color:#f5f5f5", "font:14px/1.4 -apple-system,system-ui,sans-serif", "border:2px solid #d4a017",
      "border-radius:12px", "padding:14px", "box-shadow:0 8px 30px rgba(0,0,0,.4)",
    ].join(";");
    document.body.appendChild(panel);
    return panel;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function render({ status, filled = [], missed = [], extra = [] }) {
    const p = ensurePanel();
    const pick = Object.entries(job?.pick || {}).filter(([k, v]) => v && site.pickByHand.some(h => h.startsWith(k)));
    p.innerHTML = `
      <div style="font-weight:700;font-size:15px;margin-bottom:6px">Resale HQ helper · ${esc(site.name)}</div>
      <div style="margin-bottom:8px">${esc(status)}</div>
      ${filled.length ? `<div style="color:#8fd18f">Filled: ${esc(filled.join(", "))}</div>` : ""}
      ${missed.length ? `<div style="color:#f0a0a0">Couldn't fill, do by hand: ${esc(missed.join(", "))}</div>` : ""}
      ${pick.length ? `<div style="margin-top:8px"><b>Pick these yourself:</b><ul style="margin:4px 0 0 18px;padding:0">${pick.map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join("")}</ul></div>` : ""}
      ${site.pickByHand.length ? `<div style="margin-top:6px;color:#bbb">Also check: ${esc(site.pickByHand.join(", "))}</div>` : ""}
      ${(site.rules || []).map(r => `<div style="margin-top:8px;color:#ffd166;font-weight:700">⚠ ${esc(r)}</div>`).join("")}
      ${extra.map(x => `<div style="margin-top:6px">${esc(x)}</div>`).join("")}
      <div style="margin-top:10px;color:#bbb">Review everything, then tap <b>${esc(site.postButtonText)}</b> on the page yourself.</div>
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
        <button data-a="fill" style="${btn}">Fill again</button>
        <button data-a="posted" style="${btn}">I posted it</button>
        <button data-a="stop" style="${btn}">Stop helping</button>
      </div>`;
    p.querySelector('[data-a="fill"]').onclick = () => fillAll();
    p.querySelector('[data-a="posted"]').onclick = () => finish(null);
    p.querySelector('[data-a="stop"]').onclick = async () => { await send({ type: "drop" }); p.remove(); job = null; };
  }
  const btn = "background:#d4a017;color:#111;border:0;border-radius:8px;padding:6px 10px;font-weight:700;cursor:pointer";

  // ---------- filling ----------
  function find(selectors) {
    for (const sel of selectors) {
      const el = [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null && !e.disabled && !e.readOnly);
      if (el) return el;
    }
    return null;
  }

  // React-controlled inputs ignore a plain .value assignment; use the native setter, then fire events.
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  }

  async function waitForForm(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (find(site.fields.title) || find(site.fields.price)) return true;
      await sleep(500);
    }
    return false;
  }

  async function attachPhotos() {
    if (!job.photos.length) return "no photos on the item";
    const input = [...document.querySelectorAll('input[type="file"]')].find(i => !i.accept || /image/.test(i.accept));
    if (!input) return null;
    const r = await send({ type: "photos", urls: job.photos });
    if (!r.ok || !r.photos?.length) return null;
    const dt = new DataTransfer();
    for (const ph of r.photos) {
      const blob = await (await fetch(ph.dataUrl)).blob();
      dt.items.add(new File([blob], ph.name, { type: ph.type }));
    }
    input.files = input.multiple ? dt.files : (() => { const one = new DataTransfer(); one.items.add(dt.files[0]); return one.files; })();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.multiple ? `${dt.files.length} photos` : "1 photo (add the rest by hand)";
  }

  // Facebook house rule: Hide from friends must be ON. Try to switch it on; the panel warns either way.
  function hideFromFriends() {
    const label = [...document.querySelectorAll("span, div")].find(e => e.childElementCount === 0 && /hide from friends/i.test(e.textContent || ""));
    if (!label) return "Hide from friends: not visible yet (it's usually under More details). Turn it ON yourself.";
    let row = label;
    for (let i = 0; i < 8 && row; i++, row = row.parentElement) {
      const sw = row.querySelector('[role="switch"], input[type="checkbox"]');
      if (sw) {
        const on = sw.getAttribute("aria-checked") === "true" || sw.checked === true;
        if (!on) sw.click();
        const now = sw.getAttribute("aria-checked") === "true" || sw.checked === true;
        return now ? "Hide from friends: ON ✔ (double-check it)" : "Hide from friends: couldn't switch it. Turn it ON yourself.";
      }
    }
    return "Hide from friends: couldn't find the switch. Turn it ON yourself.";
  }

  async function fillAll() {
    if (!job) return;
    render({ status: "Waiting for the form to load…" });
    if (!(await waitForForm())) {
      render({ status: "The sell form didn't show up. Make sure you're logged in, then press Fill again." });
      return;
    }
    const filled = [];
    const missed = [];
    const extra = [];
    for (const [field, value] of [["title", job.title], ["description", job.description], ["price", job.price]]) {
      const el = find(site.fields[field]);
      if (el && value !== null && value !== undefined && value !== "") { setValue(el, value); filled.push(field); } else missed.push(field);
    }
    const photos = await attachPhotos().catch(() => null);
    if (photos) filled.push(photos); else missed.push("photos");
    if (platform === "facebook") extra.push(hideFromFriends());
    render({ status: "Filled in what I could.", filled, missed, extra });
  }

  // ---------- finishing ----------
  async function finish(listing) {
    if (!job || recorded) return;
    recorded = true;
    const r = await send({ type: "record", url: listing?.url ?? null, externalId: listing?.externalId ?? null });
    const p = ensurePanel();
    p.innerHTML = r.ok
      ? `<div style="font-weight:700">Recorded in Resale HQ ✔</div><div style="margin-top:6px">${esc(r.say || "Saved.")}</div>`
      : `<div style="font-weight:700;color:#f0a0a0">Couldn't record it</div><div style="margin-top:6px">${esc(r.error)}</div>`;
    if (!r.ok) recorded = false;
    else job = null;
    setTimeout(() => p.remove(), 8000);
  }

  let lastHref = "";
  async function onUrl() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const url = new URL(location.href);
    const listing = site.listingFromUrl(url);
    if (listing) return finish(listing);
    if (site.isSellPage(url)) return fillAll();
  }

  (async () => {
    const r = await send({ type: "job" });
    if (!r.ok || !r.job || r.job.platform !== platform) return;
    job = r.job;
    await onUrl();
    // These sites are single-page apps: watch for the address changing after Post.
    setInterval(() => { if (job) onUrl(); }, 1000);
  })();
})();
