const API = window.MOCKSTA_API_BASE || "";

const feedEl = document.getElementById("feed");
const promptEl = document.getElementById("prompt");
const refEl = document.getElementById("ref");
const genBtn = document.getElementById("genBtn");
const statusEl = document.getElementById("status");

const setRefBtn = document.getElementById("setRefBtn");
const clearRefBtn = document.getElementById("clearRefBtn");
const refStatusEl = document.getElementById("refStatus");

const fileNameEl = document.getElementById("fileName");

const LS_KEY = "mocksta_default_refs_v1";
// defaultRefs: [{ name, type, dataUrl }]
let defaultRefs = [];

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmt(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return ""; }
}

function card(p) {
  const likes = p?.stats?.likes ?? 0;
  const comments = p?.stats?.comments ?? 0;
  return `
  <article class="post">
    <div class="postHeader">
      <div class="avatar" aria-hidden="true"></div>
      <div>
        <div class="handle">${esc(p.user?.handle ?? "mocksta_ai")}</div>
        <div class="meta">${fmt(p.createdAt)}</div>
      </div>
    </div>
    <img class="postImg" src="${esc(p.imageUrl)}" alt="post" loading="lazy" />
    <div class="postBody">
      <div class="caption">${esc(p.caption || "")}</div>
      <div class="stats"><div>❤ ${likes}</div><div>💬 ${comments}</div></div>
    </div>
  </article>`;
}

async function load() {
  const r = await fetch(API + "/api/posts");
  const j = await r.json();
  feedEl.innerHTML = (j.posts || []).map(card).join("");
}

function setRefStatusText() {
  if (!refStatusEl) return;
  if (!defaultRefs.length) refStatusEl.textContent = "Default references: none";
  else refStatusEl.textContent = `Default references: ${defaultRefs.length} image(s)`;
}

function updateSelectedFileLabel() {
  const files = refEl?.files ? Array.from(refEl.files) : [];
  if (!fileNameEl) return;
  if (!files.length) fileNameEl.textContent = "none";
  else if (files.length === 1) fileNameEl.textContent = files[0].name;
  else fileNameEl.textContent = `${files.length} selected`;
}

refEl?.addEventListener("change", updateSelectedFileLabel);

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl) {
  const parts = String(dataUrl).split(",");
  const meta = parts[0] || "";
  const b64 = parts[1] || "";
  const mime = meta.match(/data:(.*);base64/)?.[1] || "application/octet-stream";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function loadDefaults() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) defaultRefs = arr.filter((x) => x?.dataUrl);
  } catch {
    defaultRefs = [];
  }
  setRefStatusText();
}

function saveDefaults() {
  if (!defaultRefs.length) localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, JSON.stringify(defaultRefs));
}

function getDefaultRefsAsFormDataParts() {
  return defaultRefs.map((r, idx) => {
    const blob = dataUrlToBlob(r.dataUrl);
    const filename = r.name || `ref_${idx + 1}.png`;
    return { blob, filename };
  });
}

async function gen(prompt, chosenFiles) {
  let r;

  const files = (chosenFiles && chosenFiles.length) ? chosenFiles : null;
  const useDefaults = (!files || !files.length) && defaultRefs.length;

  if (files || useDefaults) {
    const fd = new FormData();
    fd.append("prompt", prompt); // can be empty; server auto-generates

    if (files) {
      for (const f of files) fd.append("ref", f);
    } else {
      for (const part of getDefaultRefsAsFormDataParts()) {
        fd.append("ref", part.blob, part.filename);
      }
    }

    r = await fetch(API + "/api/generate-post", { method: "POST", body: fd });
  } else {
    r = await fetch(API + "/api/generate-post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });
  }

  if (!r.ok) {
    let msg;
    try {
      const j = await r.json();
      msg = j.error || JSON.stringify(j);
    } catch {
      msg = await r.text();
    }
    throw new Error(msg || `HTTP ${r.status}`);
  }

  return (await r.json()).post;
}

genBtn.addEventListener("click", async () => {
  const prompt = (promptEl?.value || "").trim(); // can be empty => server auto prompt
  const selected = refEl?.files ? Array.from(refEl.files) : [];
  const usingDefaults = (!selected.length && defaultRefs.length);

  genBtn.disabled = true;
  statusEl.textContent =
    selected.length ? `Generating (with ${selected.length} selected ref(s))...` :
    usingDefaults ? `Generating (with ${defaultRefs.length} default ref(s))...` :
    "Generating...";

  try {
    const post = await gen(prompt, selected);
    feedEl.insertAdjacentHTML("afterbegin", card(post));
    if (promptEl) promptEl.value = "";
    if (refEl) refEl.value = "";
    updateSelectedFileLabel();
    statusEl.textContent = "Done.";
  } catch (e) {
    console.error(e);
    statusEl.innerHTML = "<b style='color:#ff6b6b'>Generation failed:</b><br>" + esc(e.message);
  } finally {
    genBtn.disabled = false;
  }
});

setRefBtn?.addEventListener("click", async () => {
  const selected = refEl?.files ? Array.from(refEl.files) : [];
  if (!selected.length) {
    statusEl.textContent = "Error: select 1–8 reference images first";
    return;
  }

  try {
    statusEl.textContent = `Saving ${selected.length} default reference(s)...`;

    const out = [];
    for (const f of selected.slice(0, 8)) {
      const dataUrl = await fileToDataUrl(f);
      out.push({ name: f.name, type: f.type, dataUrl });
    }

    defaultRefs = out;
    saveDefaults();
    setRefStatusText();
    statusEl.textContent = "Default references saved.";
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
});

clearRefBtn?.addEventListener("click", () => {
  defaultRefs = [];
  saveDefaults();
  setRefStatusText();
  statusEl.textContent = "Default references cleared.";
});

// init
loadDefaults();
setRefStatusText();
updateSelectedFileLabel();
load();
