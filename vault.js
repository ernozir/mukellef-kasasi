// Mükellef Kasası — kasa, oturum ve kayıt kuralları
// Açılır pencere (popup) ve Aktarım sayfası bu dosyayı ortak kullanır.
// chrome.storage.local   → yalnızca ŞİFRELİ kasa: { v, salt, iter, iv, ct }
// chrome.storage.session → kilit açıkken anahtar (bellekte; tarayıcı kapanınca silinir)
// Çözülmüş kayıt: { id, name, vkn, userid, sifre, note, createdAt }

const AUTO_LOCK_MS = 10 * 60 * 1000; // 10 dk işlem yapılmazsa kilitlenir
const MIN_MASTER_LEN = 8;

// ---------- Depolama ve oturum ----------
async function getVault() { return (await chrome.storage.local.get("vault")).vault || null; }

async function touchSession(key) {
  await chrome.storage.session.set({ sessionKey: { raw: await exportKey(key), lastActive: Date.now() } });
}
async function clearSession() { await chrome.storage.session.remove("sessionKey"); }

// Oturum hâlâ geçerliyse kasayı anahtarla açar: { key, entries } ya da null.
async function resumeSession() {
  const vault = await getVault();
  if (!vault) return null;
  const s = (await chrome.storage.session.get("sessionKey")).sessionKey;
  if (!s || Date.now() - s.lastActive >= AUTO_LOCK_MS) return null;
  try {
    const key = await importKey(s.raw);
    const entries = await decryptJSON(key, vault.iv, vault.ct);
    await touchSession(key);
    return { key, entries };
  } catch (_) { return null; }
}

// Ana şifreyle açar. Hatalı denemelerde artan bekleme uygular; hata mesajını Error olarak fırlatır.
async function unlockWithPassword(password) {
  const fails = (await chrome.storage.session.get("fails")).fails || { n: 0, until: 0 };
  if (Date.now() < fails.until) {
    throw new Error(`Çok fazla hatalı deneme. ${Math.ceil((fails.until - Date.now()) / 1000)} sn bekleyin.`);
  }
  const vault = await getVault();
  try {
    const key = await deriveKey(password, unb64(vault.salt), vault.iter);
    const entries = await decryptJSON(key, vault.iv, vault.ct); // yanlış şifrede burada hata fırlar
    await chrome.storage.session.remove("fails");
    await touchSession(key);
    return { key, entries };
  } catch (_) {
    const n = fails.n + 1;
    const wait = n >= 5 ? Math.min(300, 15 * 2 ** (n - 5)) * 1000 : 0;
    await chrome.storage.session.set({ fails: { n, until: Date.now() + wait } });
    throw new Error("Ana şifre hatalı.");
  }
}

async function createVault(password, entries = []) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  const { iv, ct } = await encryptJSON(key, entries);
  await chrome.storage.local.set({ vault: { v: 1, salt: b64(salt), iter: KDF_ITERATIONS, iv, ct } });
  await touchSession(key);
  return key;
}

async function loadEntries(key) {
  const vault = await getVault();
  return decryptJSON(key, vault.iv, vault.ct);
}

async function saveEntries(key, entries) {
  const vault = await getVault();
  const { iv, ct } = await encryptJSON(key, entries);
  await chrome.storage.local.set({ vault: { ...vault, iv, ct } });
  await touchSession(key);
}

// ---------- Kayıt kuralları ----------
const LIMITS = { name: 120, userid: 40, sifre: 64, note: 120 };

// VKN (10 hane) kontrol hanesi — GİB algoritması
function isValidVkn(v) {
  if (!/^\d{10}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const t = (Number(v[i]) + 9 - i) % 10;
    let p = (t * 2 ** (9 - i)) % 9;
    if (t !== 0 && p === 0) p = 9;
    sum += p;
  }
  return (10 - (sum % 10)) % 10 === Number(v[9]);
}

// TCKN (11 hane) kontrol haneleri
function isValidTckn(v) {
  if (!/^[1-9]\d{10}$/.test(v)) return false;
  const d = [...v].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  if ((((odd * 7 - even) % 10) + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}

// Ham bilgiyi temizler ve denetler → { item, errors[], warnings[] }
function normalizeEntry(raw) {
  const item = {
    name: String(raw.name ?? "").trim(),
    vkn: String(raw.vkn ?? "").replace(/\s+/g, ""),
    userid: String(raw.userid ?? "").trim(),
    sifre: String(raw.sifre ?? ""),
    note: String(raw.note ?? "").trim()
  };
  const errors = [], warnings = [];
  const missing = [];
  if (!item.name) missing.push("unvan");
  if (!item.userid) missing.push("kullanıcı kodu");
  if (!item.sifre) missing.push("şifre");
  if (missing.length) errors.push(`Boş: ${missing.join(", ")}`);
  for (const [f, label] of [["name", "Unvan"], ["userid", "Kullanıcı kodu"], ["sifre", "Şifre"], ["note", "Not"]]) {
    if (item[f].length > LIMITS[f]) errors.push(`${label} en fazla ${LIMITS[f]} karakter olabilir`);
  }
  if (item.vkn) {
    if (!/^\d{10,11}$/.test(item.vkn)) errors.push("VKN 10, TCKN 11 haneli olmalı");
    else if (item.vkn.length === 10 && !isValidVkn(item.vkn)) warnings.push("VKN'nin son hanesi doğrulama kuralına uymuyor; yazım hatası olabilir. Kayıt yine de eklenir.");
    else if (item.vkn.length === 11 && !isValidTckn(item.vkn)) warnings.push("TCKN'nin son iki hanesi doğrulama kuralına uymuyor; yazım hatası olabilir. Kayıt yine de eklenir.");
  }
  return { item, errors, warnings };
}

// ---------- Birleştirme (Excel ve yedek için ortak) ----------
// Eşleştirme kullanıcı koduna göre yapılır. Hiçbir kayıt silinmez.
// incoming: [{ n, raw, warnings? }] → [{ n, item, status, errors, warnings, diff, targetId }]
// status: "new" | "update" | "same" | "error"
function planMerge(existing, incoming) {
  const byUser = new Map();
  for (const e of existing) if (!byUser.has(e.userid)) byUser.set(e.userid, e);
  const seen = new Map();
  return incoming.map(({ n, raw, warnings: extra = [] }) => {
    const { item, errors, warnings } = normalizeEntry(raw);
    if (Number.isFinite(raw.createdAt)) item.createdAt = raw.createdAt; // yedekten gelen eklenme tarihi korunur
    warnings.unshift(...extra);
    if (!errors.length && seen.has(item.userid)) errors.push(`Aynı kullanıcı kodu ${seen.get(item.userid)}. satırda da var`);
    if (errors.length) return { n, item, status: "error", errors, warnings, diff: [] };
    seen.set(item.userid, n);
    const ex = byUser.get(item.userid);
    if (!ex) return { n, item, status: "new", errors, warnings, diff: [] };
    // Boş VKN ve not, kasadaki değeri silmez; yalnızca doluysa karşılaştırılır.
    const diff = [];
    if (item.name !== ex.name) diff.push("unvan");
    if (item.vkn && item.vkn !== (ex.vkn || "")) diff.push("VKN/TCKN");
    if (item.sifre !== ex.sifre) diff.push("şifre");
    if (item.note && item.note !== (ex.note || "")) diff.push("not");
    return { n, item, status: diff.length ? "update" : "same", errors, warnings, diff, targetId: ex.id };
  });
}

function applyMerge(existing, rows, allowUpdate) {
  const entries = existing.slice();
  let added = 0, updated = 0;
  for (const r of rows) {
    const { name, vkn, userid, sifre, note } = r.item;
    if (r.status === "new") {
      entries.push({ id: crypto.randomUUID(), name, vkn, userid, sifre, note, createdAt: r.item.createdAt || Date.now() });
      added++;
    } else if (r.status === "update" && allowUpdate) {
      const i = entries.findIndex((e) => e.id === r.targetId);
      if (i < 0) continue;
      entries[i] = { ...entries[i], name, sifre, ...(vkn ? { vkn } : {}), ...(note ? { note } : {}) };
      updated++;
    }
  }
  return { entries, added, updated };
}

// ---------- Görünüm yardımcıları ----------
function maskUser(u) { return u.length <= 4 ? u : u.slice(0, 4) + "•".repeat(Math.min(6, u.length - 4)); }
