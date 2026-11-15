// Mükellef Kasası — açılır pencere mantığı
// Veri modeli (çözülmüş hali): [{ id, name, vkn, userid, sifre, note, createdAt }]
// chrome.storage.local  → yalnızca ŞİFRELİ kasa: { v, salt, iter, iv, ct }
// chrome.storage.session → kilit açıkken anahtar (bellekte; tarayıcı kapanınca silinir)

const AUTO_LOCK_MS = 10 * 60 * 1000; // 10 dk işlem yapılmazsa kilitlenir
const $ = (id) => document.getElementById(id);

let key = null;       // AES-GCM anahtarı (yalnızca bellekte)
let entries = [];     // çözülmüş liste (yalnızca bellekte)
let editingId = null;

// ---------- Görünüm yönetimi ----------
function show(view) {
  for (const v of ["viewSetup", "viewUnlock", "viewList", "viewForm"]) $(v).classList.toggle("hidden", v !== view);
  $("lockBtn").classList.toggle("hidden", !(view === "viewList" || view === "viewForm"));
}
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2200);
}

// ---------- Depolama ----------
async function getVault() { return (await chrome.storage.local.get("vault")).vault || null; }

async function saveVault() {
  const vault = await getVault();
  const { iv, ct } = await encryptJSON(key, entries);
  await chrome.storage.local.set({ vault: { ...vault, iv, ct } });
  await touchSession();
}

async function touchSession() {
  await chrome.storage.session.set({ sessionKey: { raw: await exportKey(key), lastActive: Date.now() } });
}

async function lock() {
  key = null; entries = [];
  $("toast").classList.add("hidden");
  await chrome.storage.session.remove("sessionKey");
  $("unlockPass").value = "";
  show("viewUnlock");
  setTimeout(() => $("unlockPass").focus(), 50);
}

// ---------- Başlangıç ----------
async function init() {
  const vault = await getVault();
  if (!vault) { show("viewSetup"); $("setupPass").focus(); return; }

  const s = (await chrome.storage.session.get("sessionKey")).sessionKey;
  if (s && Date.now() - s.lastActive < AUTO_LOCK_MS) {
    try {
      key = await importKey(s.raw);
      entries = await decryptJSON(key, vault.iv, vault.ct);
      await touchSession();
      renderList(); show("viewList");
      return;
    } catch (_) { /* geçersiz oturum → kilit ekranı */ }
  }
  await lock();
}

// ---------- Kurulum ----------
$("setupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p1 = $("setupPass").value, p2 = $("setupPass2").value;
  if (p1.length < 8) return ($("setupErr").textContent = "Ana şifre en az 8 karakter olmalı.");
  if (p1 !== p2) return ($("setupErr").textContent = "Şifreler aynı değil.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  key = await deriveKey(p1, salt, KDF_ITERATIONS);
  entries = [];
  const { iv, ct } = await encryptJSON(key, entries);
  await chrome.storage.local.set({ vault: { v: 1, salt: b64(salt), iter: KDF_ITERATIONS, iv, ct } });
  await touchSession();
  $("setupPass").value = $("setupPass2").value = "";
  renderList(); show("viewList");
  toast("Kasa oluşturuldu");
});

// ---------- Kilit açma (yanlış denemelerde artan bekleme) ----------
$("unlockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("unlockBtn");
  const fails = (await chrome.storage.session.get("fails")).fails || { n: 0, until: 0 };
  if (Date.now() < fails.until) {
    $("unlockErr").textContent = `Çok fazla hatalı deneme. ${Math.ceil((fails.until - Date.now()) / 1000)} sn bekleyin.`;
    return;
  }
  btn.disabled = true; btn.textContent = "Açılıyor…";
  const vault = await getVault();
  try {
    const k = await deriveKey($("unlockPass").value, unb64(vault.salt), vault.iter);
    entries = await decryptJSON(k, vault.iv, vault.ct); // yanlış şifrede burada hata fırlar
    key = k;
    await chrome.storage.session.remove("fails");
    await touchSession();
    $("unlockPass").value = ""; $("unlockErr").textContent = "";
    renderList(); show("viewList");
  } catch (_) {
    const n = fails.n + 1;
    const wait = n >= 5 ? Math.min(300, 15 * 2 ** (n - 5)) * 1000 : 0;
    await chrome.storage.session.set({ fails: { n, until: Date.now() + wait } });
    $("unlockErr").textContent = "Ana şifre hatalı.";
  } finally {
    btn.disabled = false; btn.textContent = "Kilidi aç";
  }
});

$("lockBtn").addEventListener("click", lock);

// ---------- Liste ----------
const COLORS = ["#0ea5e9", "#14b8a6", "#6366f1", "#f59e0b", "#ec4899", "#22c55e", "#8b5cf6", "#ef4444"];
function colorFor(text) { let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
function initials(name) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toLocaleUpperCase("tr")).join("") || "?";
}
function maskUser(u) { return u.length <= 4 ? u : u.slice(0, 4) + "•".repeat(Math.min(6, u.length - 4)); }

function renderList() {
  const q = $("search").value.trim().toLocaleLowerCase("tr");
  const list = $("list");
  list.replaceChildren();
  const filtered = entries
    .filter((e) => !q || [e.name, e.vkn, e.userid, e.note].join(" ").toLocaleLowerCase("tr").includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));

  $("empty").classList.toggle("hidden", entries.length !== 0);
  $("count").textContent = entries.length ? `${filtered.length} / ${entries.length} mükellef` : "";

  for (const e of filtered) {
    const li = document.createElement("li");
    li.className = "item";

    const av = document.createElement("div");
    av.className = "avatar"; av.style.background = colorFor(e.name); av.textContent = initials(e.name);

    const meta = document.createElement("div");
    meta.className = "meta";
    const nm = document.createElement("div"); nm.className = "name"; nm.textContent = e.name;
    const sb = document.createElement("div"); sb.className = "sub";
    sb.textContent = (e.vkn ? `VKN ${e.vkn} · ` : "") + `Kod ${maskUser(e.userid)}` + (e.note ? ` · ${e.note}` : "");
    meta.append(nm, sb);

    const connect = document.createElement("button");
    connect.className = "connect";
    connect.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    connect.append("Bağlan");
    connect.addEventListener("click", () => connectTo(e));

    const more = document.createElement("button");
    more.className = "more"; more.textContent = "⋮"; more.title = "Diğer";
    more.addEventListener("click", (ev) => { ev.stopPropagation(); openMenu(li, e); });

    li.append(av, meta, connect, more);
    list.append(li);
  }
}

function closeMenus() { document.querySelectorAll(".menu").forEach((m) => m.remove()); }
document.addEventListener("click", closeMenus);

function openMenu(li, e) {
  closeMenus();
  const m = document.createElement("div");
  m.className = "menu";
  const edit = document.createElement("button"); edit.textContent = "Düzenle";
  edit.addEventListener("click", () => openForm(e));
  const del = document.createElement("button"); del.textContent = "Sil"; del.className = "danger";
  del.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (del.dataset.confirm !== "1") { del.dataset.confirm = "1"; del.textContent = "Emin misiniz? Sil"; return; }
    entries = entries.filter((x) => x.id !== e.id);
    await saveVault(); renderList(); toast("Mükellef silindi");
  });
  m.append(edit, del);
  li.append(m);
}

$("search").addEventListener("input", renderList);

// ---------- Ekle / Düzenle ----------
function openForm(e = null) {
  editingId = e ? e.id : null;
  $("formTitle").textContent = e ? "Mükellefi düzenle" : "Yeni mükellef";
  $("fName").value = e?.name || ""; $("fVkn").value = e?.vkn || "";
  $("fUser").value = e?.userid || ""; $("fPass").value = e?.sifre || ""; $("fNote").value = e?.note || "";
  $("fPass").type = "password"; $("formErr").textContent = "";
  show("viewForm"); $("fName").focus();
}
$("addBtn").addEventListener("click", () => openForm());
$("cancelBtn").addEventListener("click", () => { show("viewList"); });
$("togglePw").addEventListener("click", () => { const f = $("fPass"); f.type = f.type === "password" ? "text" : "password"; });

$("entryForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const item = {
    name: $("fName").value.trim(), vkn: $("fVkn").value.trim(),
    userid: $("fUser").value.trim(), sifre: $("fPass").value, note: $("fNote").value.trim()
  };
  if (!item.name || !item.userid || !item.sifre) return ($("formErr").textContent = "Yıldızlı alanlar zorunludur.");
  if (item.vkn && !/^\d{10,11}$/.test(item.vkn)) return ($("formErr").textContent = "VKN 10, TCKN 11 haneli olmalıdır.");
  if (editingId) {
    entries = entries.map((x) => (x.id === editingId ? { ...x, ...item } : x));
  } else {
    entries.push({ id: crypto.randomUUID(), createdAt: Date.now(), ...item });
  }
  await saveVault();
  renderList(); show("viewList");
  toast(editingId ? "Değişiklikler kaydedildi" : "Mükellef eklendi");
});

// ---------- Bağlan ----------
async function connectTo(e) {
  await touchSession();
  await chrome.runtime.sendMessage({ type: "connect", userid: e.userid, sifre: e.sifre });
  window.close();
}

init();
