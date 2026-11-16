// Mükellef Kasası — açılır pencere mantığı
// Kasa, oturum ve kayıt kuralları vault.js'te; şifreleme crypto.js'te.

const $ = (id) => document.getElementById(id);

let key = null;       // AES-GCM anahtarı (yalnızca bellekte)
let entries = [];     // çözülmüş liste (yalnızca bellekte)
let shown = [];       // aramaya göre görünen kayıtlar
let selIdx = -1;      // klavyeyle seçili satır (Enter = Bağlan)
let editingId = null;

// ---------- Görünüm yönetimi ----------
function show(view) {
  closeMenu();
  for (const v of ["viewSetup", "viewUnlock", "viewList", "viewForm"]) $(v).classList.toggle("hidden", v !== view);
  const open = view === "viewList" || view === "viewForm";
  $("lockBtn").classList.toggle("hidden", !open);
  $("transferBtn").classList.toggle("hidden", !open);
  if (view === "viewList") setTimeout(() => $("search").focus(), 30);
}
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2200);
}

async function lock() {
  key = null; entries = []; shown = [];
  $("toast").classList.add("hidden");
  await clearSession();
  $("unlockPass").value = "";
  show("viewUnlock");
  setTimeout(() => $("unlockPass").focus(), 50);
}

// Aktarım sayfası ayrı sekmede açılır: dosya seçme penceresi popup'ı kapatacağı için
// ve önizleme tablosu geniş bir ekran istediği için.
async function openTransfer(tab) {
  await chrome.tabs.create({ url: chrome.runtime.getURL("aktar.html#" + tab) });
  window.close();
}

// ---------- Başlangıç ----------
async function init() {
  if (!(await getVault())) { show("viewSetup"); $("setupPass").focus(); return; }
  const s = await resumeSession();
  if (s) { ({ key, entries } = s); renderList(); show("viewList"); return; }
  await lock();
}

// ---------- Kurulum ----------
$("setupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p1 = $("setupPass").value, p2 = $("setupPass2").value;
  if (p1.length < MIN_MASTER_LEN) return ($("setupErr").textContent = "Ana şifre en az 8 karakter olmalı.");
  if (p1 !== p2) return ($("setupErr").textContent = "Şifreler aynı değil.");
  key = await createVault(p1);
  entries = [];
  $("setupPass").value = $("setupPass2").value = "";
  renderList(); show("viewList");
  toast("Kasa oluşturuldu");
});
$("restoreLink").addEventListener("click", () => openTransfer("geri-yukle"));

// ---------- Kilit açma ----------
$("unlockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("unlockBtn");
  btn.disabled = true; btn.textContent = "Açılıyor…";
  try {
    ({ key, entries } = await unlockWithPassword($("unlockPass").value));
    $("unlockPass").value = ""; $("unlockErr").textContent = "";
    renderList(); show("viewList");
  } catch (err) {
    $("unlockErr").textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = "Kilidi aç";
  }
});

$("lockBtn").addEventListener("click", lock);
$("transferBtn").addEventListener("click", () => openTransfer("excel"));
$("importLink").addEventListener("click", () => openTransfer("excel"));

// ---------- Liste ----------
const COLORS = ["#0ea5e9", "#14b8a6", "#6366f1", "#f59e0b", "#ec4899", "#22c55e", "#8b5cf6", "#ef4444"];
function colorFor(text) { let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
function initials(name) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toLocaleUpperCase("tr")).join("") || "?";
}
const ICON_CONNECT = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderList() {
  closeMenu();
  const q = $("search").value.trim().toLocaleLowerCase("tr");
  const list = $("list");
  list.replaceChildren();
  shown = entries
    .filter((e) => !q || [e.name, e.vkn, e.userid, e.note].join(" ").toLocaleLowerCase("tr").includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));
  // Arama yazıldıysa ilk sonuç seçili gelir; Enter ona bağlanır.
  selIdx = q && shown.length ? 0 : -1;

  $("empty").classList.toggle("hidden", entries.length !== 0);
  const count = $("count");
  count.replaceChildren();
  if (entries.length) {
    count.append(`${shown.length} / ${entries.length} mükellef`);
    if (q && shown.length) {
      const k = document.createElement("span"); k.className = "kbd"; k.textContent = "Enter";
      count.append(" · ", k, " = Bağlan");
    }
  }

  shown.forEach((e, i) => {
    const li = document.createElement("li");
    li.className = "item";
    li.classList.toggle("sel", i === selIdx);

    const av = document.createElement("div");
    av.className = "avatar"; av.style.background = colorFor(e.name); av.textContent = initials(e.name);

    const meta = document.createElement("div");
    meta.className = "meta";
    const nm = document.createElement("div"); nm.className = "name"; nm.textContent = e.name; nm.title = e.name;
    const sb = document.createElement("div"); sb.className = "sub";
    sb.textContent = (e.vkn ? `${e.vkn.length === 11 ? "TCKN" : "VKN"} ${e.vkn} · ` : "") + `Kod ${maskUser(e.userid)}` + (e.note ? ` · ${e.note}` : "");
    meta.append(nm, sb);

    const connect = document.createElement("button");
    connect.className = "connect";
    connect.innerHTML = ICON_CONNECT;
    connect.append("Bağlan");
    connect.addEventListener("click", () => connectTo(e));

    const more = document.createElement("button");
    more.className = "more"; more.textContent = "⋮"; more.title = "Diğer işlemler";
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", (ev) => { ev.stopPropagation(); openMenu(more, e); });

    li.append(av, meta, connect, more);
    list.append(li);
  });
}

function setSel(i) {
  if (!shown.length) return;
  selIdx = Math.max(0, Math.min(shown.length - 1, i));
  [...$("list").children].forEach((li, j) => li.classList.toggle("sel", j === selIdx));
  $("list").children[selIdx].scrollIntoView({ block: "nearest" });
}

$("search").addEventListener("input", renderList);
$("search").addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown") { ev.preventDefault(); setSel(selIdx + 1); }
  else if (ev.key === "ArrowUp") { ev.preventDefault(); setSel(selIdx - 1); }
  else if (ev.key === "Enter" && selIdx >= 0 && shown[selIdx]) { ev.preventDefault(); connectTo(shown[selIdx]); }
});

// ---------- ⋮ menüsü ----------
// Menü <body>'ye eklenir ve "position: fixed" ile düğmenin yanına konur.
// Altta yer yoksa yukarı doğru açılır; böylece listenin kaydırma alanı onu asla kesmez.
const ICONS = {
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m11 12 8-8m-3 3 2 2m-4 0 1.5 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
};
let menuEl = null, menuBtn = null;

function closeMenu() {
  if (menuEl) menuEl.remove();
  if (menuBtn) menuBtn.classList.remove("on");
  menuEl = menuBtn = null;
}

function menuItem(icon, text, onClick, cls = "") {
  const b = document.createElement("button");
  b.type = "button"; b.className = cls; b.setAttribute("role", "menuitem");
  b.innerHTML = ICONS[icon];
  const label = document.createElement("span"); label.textContent = text;
  b.append(label);
  b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(b, label); });
  return b;
}

function openMenu(btn, e) {
  if (menuBtn === btn) return closeMenu(); // aynı düğmeye ikinci tıklama kapatır
  closeMenu();
  const m = document.createElement("div");
  m.className = "menu"; m.setAttribute("role", "menu");
  m.append(
    menuItem("edit", "Düzenle", () => openForm(e)),
    menuItem("copy", "Kodu kopyala", async () => {
      await navigator.clipboard.writeText(e.userid);
      closeMenu(); toast("Kullanıcı kodu kopyalandı");
    }),
    menuItem("key", "Şifreyi kopyala", async () => {
      await navigator.clipboard.writeText(e.sifre);
      await touchSession(key);
      closeMenu(); toast("Şifre kopyalandı");
    }),
    document.createElement("hr"),
    menuItem("del", "Sil", async (b, label) => {
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; label.textContent = "Emin misiniz? Sil"; return; }
      entries = entries.filter((x) => x.id !== e.id);
      await saveEntries(key, entries); renderList(); toast("Mükellef silindi");
    }, "danger")
  );
  document.body.append(m);
  const r = btn.getBoundingClientRect(), mh = m.offsetHeight, mw = m.offsetWidth;
  const below = r.bottom + 4 + mh <= window.innerHeight - 6;
  m.style.top = `${below ? r.bottom + 4 : Math.max(6, r.top - mh - 4)}px`;
  m.style.left = `${Math.max(6, r.right - mw)}px`;
  menuEl = m; menuBtn = btn; btn.classList.add("on");
  m.querySelector("button").focus();
}

document.addEventListener("click", closeMenu);
document.addEventListener("keydown", (ev) => {
  if (!menuEl) return;
  const items = [...menuEl.querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  if (ev.key === "Escape") { ev.preventDefault(); const b = menuBtn; closeMenu(); b?.focus(); }
  else if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
$("list").addEventListener("scroll", closeMenu);

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
  const { item, errors } = normalizeEntry({
    name: $("fName").value, vkn: $("fVkn").value, userid: $("fUser").value, sifre: $("fPass").value, note: $("fNote").value
  });
  if (errors.length) return ($("formErr").textContent = errors.some((x) => x.startsWith("Boş")) ? "Yıldızlı alanlar zorunludur." : errors[0] + ".");
  const dup = entries.find((x) => x.userid === item.userid && x.id !== editingId);
  if (dup) return ($("formErr").textContent = `Bu kullanıcı kodu zaten kasada: ${dup.name}`);
  if (editingId) {
    entries = entries.map((x) => (x.id === editingId ? { ...x, ...item } : x));
  } else {
    entries.push({ id: crypto.randomUUID(), createdAt: Date.now(), ...item });
  }
  await saveEntries(key, entries);
  renderList(); show("viewList");
  toast(editingId ? "Değişiklikler kaydedildi" : "Mükellef eklendi");
});

// ---------- Bağlan ----------
async function connectTo(e) {
  await touchSession(key);
  await chrome.runtime.sendMessage({ type: "connect", userid: e.userid, sifre: e.sifre });
  window.close();
}

init();
