const list = document.getElementById("list");
const send = msg => new Promise(resolve => chrome.runtime.sendMessage(msg, r => resolve(r || { ok: false, error: chrome.runtime.lastError?.message })));
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

(async () => {
  const r = await send({ type: "queue" });
  if (!r.ok) { list.innerHTML = `<span class="err">${esc(r.error)}</span>`; return; }
  if (!r.queue.length) { list.textContent = "Nothing waiting. Flip a Mercari, Poshmark or Facebook switch on an item in Resale HQ."; return; }
  list.innerHTML = "";
  for (const q of r.queue) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<b>${esc(q.item_name)}</b><span class="muted">${esc(q.platform_name)}</span><br>`;
    const b = document.createElement("button");
    b.textContent = `Fill it in on ${q.platform_name}`;
    b.onclick = async () => {
      b.disabled = true;
      const s = await send({ type: "start", item_id: q.item_id, platform: q.platform });
      if (!s.ok) { b.disabled = false; row.insertAdjacentHTML("beforeend", `<div class="err">${esc(s.error)}</div>`); }
      else window.close();
    };
    row.appendChild(b);
    list.appendChild(row);
  }
})();
