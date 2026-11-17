// Mükellef Kasası — Beyannameler sayfası
// Bu sayfa eklentinin kendi sayfasıdır; IVD'ye doğrudan istek atmaz ve oturum anahtarını (token) hiç görmez.
// Her istek, IVD sekmesine yüklenmiş ivd.js'e mesajla iletilir; buraya yalnızca liste ve PDF içeriği gelir.
// Kurallar beyanname-kural.js'te, PDF'ten onay zamanı okuma pdfmetin.js'te, ZIP yazma zipwrite.js'te.

const $ = (id) => document.getElementById(id);
let ivdSekme = Number(new URLSearchParams(location.search).get("sekme")); // bağlı IVD sekmesi; yeniden bağlanınca değişir
const ISTEK_ARASI_MS = 250; // PDF'ler sırayla, kısa aralıklarla istenir (siteyi yormamak için)

const IKON = {
  goz: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  indir: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tik: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  uyari: '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/></svg>',
  asagi: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  yukari: '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

// ---------- Durum (yalnızca bellekte) ----------
let vkn = "";
let unvan = "";
let aralik = null;              // son listelenen { bas, bit }
let gruplar = new Map();        // tür kodu → Grup[]
let secilenTur = "";
const secim = new Set();        // "G:<anahtar>" = dönemin güncel sürümü, "S:<beyoid>" = belirli bir sürüm
const acik = new Set();         // sürümleri açılmış dönemler
const onaylar = new Map();      // beyoid → onay zamanı (ms) | null (PDF'te bulunamadı)
const pdfler = new Map();       // beyoid → Promise<Uint8Array>
const cozumler = new Map();     // anahtar → Promise (dönemin güncel sürümünü belirleme)
const durumlar = new Map();     // anahtar → "okunuyor" | "kesin" | "tahmini" | "hata"
let okumaNesli = 0;
let indiriliyor = false;
let durdur = false;
let baglanti = "bekliyor";      // "tamam" | "kopuk" | "oturum"

// ---------- Yardımcılar ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function toast(text) {
  const t = $("toast");
  t.textContent = text; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const zamanMetni = (ms) => new Date(ms).toLocaleString("tr-TR", {
  timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"
}).replace(",", "");
const boyutMetni = (b) => b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} MB`;
function base64Coz(s) {
  const ikili = atob(s);
  const u8 = new Uint8Array(ikili.length);
  for (let i = 0; i < ikili.length; i++) u8[i] = ikili.charCodeAt(i);
  return u8;
}
function blobIndir(blob, ad) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u; a.download = ad;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
const ayMetni = (x) => `${x.yil}-${String(x.ay).padStart(2, "0")}`;

// ---------- Bağlantı ----------
function seritGoster(tur) {
  baglanti = tur;
  const s = $("serit");
  if (tur === "oturum") {
    s.className = "strip err2";
    $("seritBaslik").textContent = "IVD oturumu sona ermiş.";
    $("seritMetin").textContent = "Süre dolmuş ya da başka yerden yeni bir IVD oturumu açılmış. Dijital Vergi Dairesi'nde İnternet Vergi Dairesi kartına yeniden tıklayın; yeni oturum açılınca bu sayfa kendiliğinden bağlanır ve kaldığı yerden devam eder.";
  } else {
    s.className = "strip";
    $("seritBaslik").textContent = "IVD sekmesiyle bağlantı koptu.";
    $("seritMetin").textContent = "Sekme kapanmış ya da yenilenmiş. İnternet Vergi Dairesi'ni yeniden açın; bu sayfa kendiliğinden bağlanır ve kaldığı yerden devam eder.";
  }
  $("oturumNokta").className = "dot off";
}

// IVD sekmesindeki ivd.js'e mesaj gönderir; yanıt yoksa null.
async function gonder(msg) {
  if (!Number.isInteger(ivdSekme)) return null;
  try { return (await chrome.tabs.sendMessage(ivdSekme, msg)) || null; } catch { return null; }
}

// Açık IVD sekmelerini (en son kullanılan önce) dener; oturumu geçerli olana ivd.js'i yükler.
// Sayfa yenilendiğinde ya da IVD sekmesi değiştiğinde bağlantı böyle kendiliğinden kurulur.
// Aynı tarayıcıda tek IVD oturumu açılabildiği için geçerli oturum tek sekmede olur.
async function ivdSekmesiniBul() {
  const sekmeler = (await chrome.tabs.query({ url: "https://intvrg.gib.gov.tr/intvrg_side/*" }))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const t of sekmeler) {
    try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["ivd.js"] }); } catch { continue; }
    let d = null;
    try { d = await chrome.tabs.sendMessage(t.id, { tip: "durum" }); } catch { /* yanıt yok */ }
    if (d?.ok && d.oturum) {
      ivdSekme = t.id;
      history.replaceState(null, "", `?sekme=${ivdSekme}`);
      return true;
    }
  }
  return false;
}

// IVD'ye istek: bağlantı koptuysa (ya da oturum düştüyse) önce yeniden bağlanmayı dener.
// Sekme yoksa ya da betik yanıt vermezse { ok:false, hata:"kopuk" }.
async function ivd(msg) {
  let c = await gonder(msg);
  if ((!c || (!c.ok && c.hata === "oturum")) && await baglan({ sessiz: true })) c = await gonder(msg);
  if (!c) { seritGoster("kopuk"); return { ok: false, hata: "kopuk" }; }
  if (!c.ok && c.hata === "oturum") seritGoster("oturum");
  return c;
}

chrome.tabs.onRemoved.addListener((id) => { if (id === ivdSekme) seritGoster("kopuk"); });

// ---------- Dönem seçimi ----------
function donemKutulari() {
  const simdi = new Date();
  for (const id of ["basAy", "bitAy"]) $(id).replaceChildren(...AYLAR.map((a, i) => new Option(a, i + 1)));
  for (const id of ["basYil", "bitYil"]) {
    const yillar = [];
    for (let y = simdi.getFullYear(); y >= 2010; y--) yillar.push(new Option(y, y));
    $(id).replaceChildren(...yillar);
  }
  hizli("buYil");
}
function donemAyarla(bas, bit) {
  $("basAy").value = bas.ay; $("basYil").value = bas.yil;
  $("bitAy").value = bit.ay; $("bitYil").value = bit.yil;
}
function hizli(tur) {
  const s = new Date();
  const y = s.getFullYear(), a = s.getMonth() + 1;
  if (tur === "buYil") donemAyarla({ yil: y, ay: 1 }, { yil: y, ay: a });
  if (tur === "gecenYil") donemAyarla({ yil: y - 1, ay: 1 }, { yil: y - 1, ay: 12 });
  if (tur === "son3") {
    const b = new Date(y, a - 3, 1);
    donemAyarla({ yil: b.getFullYear(), ay: b.getMonth() + 1 }, { yil: y, ay: a });
  }
}
document.querySelectorAll("[data-hizli]").forEach((b) => b.addEventListener("click", () => hizli(b.dataset.hizli)));

// ---------- Listeleme ----------
$("sorguForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (indiriliyor) return;
  $("hata").textContent = "";
  const bas = { yil: +$("basYil").value, ay: +$("basAy").value };
  const bit = { yil: +$("bitYil").value, ay: +$("bitAy").value };
  if (bas.yil * 12 + bas.ay > bit.yil * 12 + bit.ay) return ($("hata").textContent = "Başlangıç dönemi bitişten sonra olamaz.");
  if (!$("vknAlan").classList.contains("hidden")) {
    const v = $("vkn").value.replace(/\s+/g, "");
    if (!kimlikGecerli(v)) return ($("hata").textContent = "Geçerli bir VKN (10 hane) ya da TCKN (11 hane) yazın.");
    if (v !== vkn) {
      vkn = v; unvan = "";
      const k = await ivd({ tip: "kimlik", vkn: v }); // unvanı getirir; IVD sekmesi bu VKN'yi hatırlar
      if (k.ok) { vkn = k.vkn; unvan = k.unvan; }
      oturumCipi();
    }
  }
  if (!vkn) return ($("hata").textContent = "VKN/TCKN bulunamadı.");

  const btn = $("listeleBtn");
  btn.disabled = true;
  const eskiMetin = btn.lastChild.textContent;
  btn.lastChild.textContent = "Listeleniyor…";
  try {
    const tum = [];
    for (const p of yillaraBol(bas, bit)) {
      const c = await ivd({ tip: "sorgu", vkn, bas: p.bas, bit: p.bit });
      if (!c.ok) {
        if (c.hata === "vkn") $("hata").textContent = "VKN/TCKN biçimi hatalı.";
        else if (c.hata === "sunucu") $("hata").textContent = `IVD beklenmeyen bir yanıt verdi. ${c.mesaj || ""}`;
        else if (c.hata === "ag") $("hata").textContent = `IVD'ye ulaşılamadı: ${c.mesaj || ""}`;
        return;
      }
      tum.push(...c.kayitlar);
    }
    yeniListe(tum, { bas, bit });
  } finally {
    btn.disabled = false; btn.lastChild.textContent = eskiMetin;
  }
});

async function yeniListe(kayitlar, ara) {
  aralik = ara;
  gruplar = grupla(kayitlar);
  secim.clear(); acik.clear(); cozumler.clear(); durumlar.clear();
  // Varsayılan: her dönemin güncel sürümü seçili, önceki sürümler seçili değil.
  for (const liste of gruplar.values()) for (const g of liste) secim.add("G:" + g.anahtar);
  $("kaynak").textContent = `Kaynak: İnternet Vergi Dairesi · ${zamanMetni(Date.now()).slice(0, 16)}`;
  $("bitti").classList.add("hidden");

  const { sik, diger } = turListesi(gruplar);
  const sel = $("tur");
  sel.replaceChildren();
  const ekle = (grupEl, t) => {
    const duz = t.beyannameSayisi - t.donemSayisi;
    const o = new Option(`${t.kod} · ${t.ad} — ${t.var ? `${t.donemSayisi} dönem${duz ? ` · ${duz} düzeltme` : ""}` : "kayıt yok"}`, t.kod);
    o.disabled = !t.var;
    grupEl.append(o);
  };
  const og1 = document.createElement("optgroup"); og1.label = "Sık kullanılanlar";
  sik.forEach((t) => ekle(og1, t));
  sel.append(og1);
  if (diger.length) {
    const og2 = document.createElement("optgroup"); og2.label = "Bu dönemde gelen diğer türler";
    diger.forEach((t) => ekle(og2, t));
    sel.append(og2);
  }

  const bos = gruplar.size === 0;
  $("sonuc").classList.toggle("hidden", bos);
  $("bos").classList.toggle("hidden", !bos);
  if (bos) return;

  const { beyannameSonTur: son } = await chrome.storage.local.get("beyannameSonTur");
  const varOlan = [...sik, ...diger].filter((t) => t.var).map((t) => t.kod);
  turSec(varOlan.includes(son) ? son : varOlan[0]);
}

function turSec(kod) {
  secilenTur = kod;
  $("tur").value = kod;
  chrome.storage.local.set({ beyannameSonTur: kod }); // yalnızca tür kodu saklanır
  ciz();
  arkaPlandaOku();
}
$("tur").addEventListener("change", () => turSec($("tur").value));

// ---------- PDF ve onay zamanı ----------
let kuyruk = Promise.resolve();
function sirayla(is) {
  const p = kuyruk.then(is);
  kuyruk = p.catch(() => {}).then(() => bekle(ISTEK_ARASI_MS));
  return p;
}

function pdfGetir(beyoid) {
  if (!pdfler.has(beyoid)) {
    const p = sirayla(async () => {
      const c = await ivd({ tip: "pdf", beyoid });
      if (!c.ok) throw new Error(c.hata || "pdf");
      return base64Coz(c.base64);
    });
    pdfler.set(beyoid, p);
    p.catch(() => pdfler.delete(beyoid)); // başarısızsa sonra yeniden denenebilsin
  }
  return pdfler.get(beyoid);
}

async function onayOku(beyoid) {
  if (onaylar.has(beyoid)) return onaylar.get(beyoid);
  const u8 = await pdfGetir(beyoid);
  let ms = null;
  try { const r = await onayZamaniOku(u8); ms = r ? r.tarih.getTime() : null; } catch { ms = null; }
  onaylar.set(beyoid, ms);
  return ms;
}

// Birden fazla sürümü olan dönemde tüm sürümlerin onay zamanını okuyup güncel olanı belirler.
function grupCoz(g) {
  if (g.surumler.length < 2) return Promise.resolve();
  if (!cozumler.has(g.anahtar)) {
    durumlar.set(g.anahtar, "okunuyor");
    const p = (async () => {
      for (const s of g.surumler) await onayOku(s.beyoid);
      durumlar.set(g.anahtar, guncelSec(g, onaylar).kesin ? "kesin" : "tahmini");
    })();
    cozumler.set(g.anahtar, p);
    p.catch(() => { durumlar.set(g.anahtar, "hata"); cozumler.delete(g.anahtar); }).finally(() => { if (g.kod === secilenTur) ciz(); });
  }
  return cozumler.get(g.anahtar);
}

// Seçili türün düzeltmeli dönemlerini sırayla okur; tür değişirse durur.
async function arkaPlandaOku() {
  const nesil = ++okumaNesli;
  for (const g of gruplar.get(secilenTur) || []) {
    if (nesil !== okumaNesli) return;
    if (g.surumler.length < 2 || durumlar.get(g.anahtar) === "kesin" || durumlar.get(g.anahtar) === "tahmini") continue;
    try { await grupCoz(g); } catch (e) { if (e.message === "oturum" || e.message === "kopuk") return; }
  }
}

// ---------- Tablo ----------
function grupBilgisi(g) {
  const r = guncelSec(g, onaylar);
  const coklu = g.surumler.length > 1;
  const d = coklu ? durumlar.get(g.anahtar) || "okunuyor" : "kesin";
  return { ...r, coklu, durum: d };
}

function surumRozeti(s) {
  return s.aciklama ? el("span", "badge dz", "Düzeltme") : el("span", "badge asil", "Asıl");
}

function onayHucresi(td, beyoid, durum) {
  td.className = "oz";
  if (durum === "okunuyor") { td.append(el("span", "spin")); td.append("okunuyor…"); return; }
  if (durum === "hata") { td.classList.add("uyari"); td.textContent = "okunamadı (bağlantı)"; return; }
  const ms = onaylar.get(beyoid);
  if (typeof ms === "number") td.textContent = zamanMetni(ms);
  else { td.classList.add("uyari"); td.textContent = "okunamadı"; }
}

function islemHucresi(g, s, oncekiNo) {
  const td = el("td", "act");
  const goz = el("button", "ib"); goz.type = "button"; goz.title = "Görüntüle"; goz.innerHTML = IKON.goz;
  goz.addEventListener("click", () => goruntule(s.beyoid, goz));
  const ind = el("button", "ib dl"); ind.type = "button"; ind.title = "PDF indir"; ind.innerHTML = IKON.indir;
  ind.addEventListener("click", () => tekIndir(g, s, oncekiNo, ind));
  td.append(goz, ind);
  return td;
}

function kutu(anahtar, etiket) {
  const td = el("td", "ck");
  const c = document.createElement("input");
  c.type = "checkbox"; c.checked = secim.has(anahtar); c.setAttribute("aria-label", etiket);
  c.addEventListener("change", () => { c.checked ? secim.add(anahtar) : secim.delete(anahtar); sayaclar(); });
  td.append(c);
  return td;
}

function ciz() {
  const liste = gruplar.get(secilenTur) || [];
  const govde = $("govde");
  govde.replaceChildren();
  for (const g of liste) {
    const b = grupBilgisi(g);
    const metin = donemMetni(g.donem);
    const tr = el("tr", b.coklu ? (b.durum === "okunuyor" ? "dzrow read" : "dzrow") : "");
    const dn = el("td", "dn", metin); dn.title = metin;
    const oz = el("td", "oz");
    if (!b.coklu) oz.append(el("span", "na", "—"));            // tek sürüm: onay zamanı okunmaz
    else if (b.durum === "tahmini") { oz.classList.add("uyari"); oz.textContent = "okunamadı"; }
    else onayHucresi(oz, b.guncel.beyoid, b.durum);

    const du = el("td");
    du.append(surumRozeti(b.guncel));
    if (b.coklu && b.durum === "kesin") { const r = el("span", "badge guncel"); r.innerHTML = IKON.tik; r.append("Güncel"); du.append(r); }
    if (b.coklu && b.durum === "tahmini") {
      const r = el("span", "badge tah"); r.innerHTML = IKON.uyari; r.append("Tahmini");
      r.title = "PDF'te onay zamanı bulunamadı; seçiliyse ZIP'e tüm sürümler eklenir."; du.append(r);
    }
    if (b.coklu) {
      const t = el("button", "tog"); t.type = "button";
      t.append(`${g.surumler.length} sürüm`);
      t.insertAdjacentHTML("beforeend", acik.has(g.anahtar) ? IKON.yukari : IKON.asagi);
      t.addEventListener("click", () => { acik.has(g.anahtar) ? acik.delete(g.anahtar) : acik.add(g.anahtar); ciz(); });
      du.append(t);
    }
    const nd = el("td", "neden", b.guncel.aciklama); nd.title = b.guncel.aciklama;
    tr.append(kutu("G:" + g.anahtar, `${metin} güncel sürüm`), dn, oz, du, nd, islemHucresi(g, b.guncel, 0));
    govde.append(tr);

    if (b.coklu && acik.has(g.anahtar)) {
      b.digerleri.forEach((s, i) => {
        const ad = b.durum !== "kesin" ? "Diğer sürüm" : i === b.digerleri.length - 1 ? "İlk verilen" : "Önceki sürüm";
        const t2 = el("tr", "old");
        const oz2 = el("td");
        onayHucresi(oz2, s.beyoid, onaylar.has(s.beyoid) ? "kesin" : b.durum === "hata" ? "hata" : "okunuyor");
        const du2 = el("td"); du2.append(surumRozeti(s));
        const nd2 = el("td", "neden", s.aciklama); nd2.title = s.aciklama;
        t2.append(kutu("S:" + s.beyoid, `${metin} ${ad}`), el("td", "dn", ad), oz2, du2, nd2, islemHucresi(g, s, i + 1));
        govde.append(t2);
      });
    }
  }
  sayaclar();
}

// Seçili türde ZIP'e girecek sürümler (sırasıyla). Tahmini dönemde tüm sürümler girer.
function secilenler() {
  const isler = [];
  for (const g of gruplar.get(secilenTur) || []) {
    const b = grupBilgisi(g);
    const gSecili = secim.has("G:" + g.anahtar);
    const hepsi = gSecili && b.coklu && b.durum === "tahmini";
    if (gSecili) isler.push({ g, s: b.guncel, no: 0 });
    b.digerleri.forEach((s, i) => { if (hepsi || secim.has("S:" + s.beyoid)) isler.push({ g, s, no: i + 1 }); });
  }
  return isler;
}

function sayaclar() {
  const liste = gruplar.get(secilenTur) || [];
  const beyanname = liste.reduce((t, g) => t + g.surumler.length, 0);
  const duzeltmeli = liste.filter((g) => g.surumler.length > 1).length;
  const oz = $("ozet");
  oz.replaceChildren();
  const b = (n) => el("b", null, String(n));
  oz.append(b(liste.length), " dönem · ", b(beyanname), " beyanname");
  if (duzeltmeli) oz.append(" · ", b(duzeltmeli), " dönemde düzeltme");

  const anaSecili = liste.filter((g) => secim.has("G:" + g.anahtar)).length;
  const h = $("hepsi");
  h.checked = liste.length > 0 && anaSecili === liste.length;
  h.indeterminate = anaSecili > 0 && anaSecili < liste.length;

  const onceki = liste.flatMap((g) => grupBilgisi(g).digerleri);
  const oncekiSecili = onceki.filter((s) => secim.has("S:" + s.beyoid)).length;
  const ob = $("oncekiBtn");
  ob.classList.toggle("hidden", onceki.length === 0);
  ob.textContent = onceki.length && oncekiSecili === onceki.length ? "Önceki sürümleri bırak" : `Önceki sürümleri de seç (+${onceki.length - oncekiSecili})`;

  const n = secilenler().length;
  $("secSayi").textContent = n;
  $("indirBtn").disabled = indiriliyor || n === 0;
}

$("hepsi").addEventListener("change", () => {
  const liste = gruplar.get(secilenTur) || [];
  for (const g of liste) $("hepsi").checked ? secim.add("G:" + g.anahtar) : secim.delete("G:" + g.anahtar);
  ciz();
});

$("oncekiBtn").addEventListener("click", () => {
  const liste = gruplar.get(secilenTur) || [];
  const onceki = liste.flatMap((g) => grupBilgisi(g).digerleri);
  const hepsiSecili = onceki.every((s) => secim.has("S:" + s.beyoid));
  for (const s of onceki) hepsiSecili ? secim.delete("S:" + s.beyoid) : secim.add("S:" + s.beyoid);
  if (!hepsiSecili) for (const g of liste) if (g.surumler.length > 1) acik.add(g.anahtar); // eklenenler görünsün
  ciz();
});

// ---------- Görüntüle / tek indir ----------
async function goruntule(beyoid, btn) {
  btn.disabled = true;
  try {
    const u8 = await pdfGetir(beyoid);
    const url = URL.createObjectURL(new Blob([u8], { type: "application/pdf" }));
    await chrome.tabs.create({ url });
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  } catch (e) {
    if (e.message !== "oturum" && e.message !== "kopuk") toast("PDF alınamadı");
  } finally { btn.disabled = false; }
}

async function tekIndir(g, s, oncekiNo, btn) {
  btn.disabled = true;
  try {
    const u8 = await pdfGetir(s.beyoid);
    blobIndir(new Blob([u8], { type: "application/pdf" }), dosyaAdi(vkn, g.kod, g.donem, oncekiNo));
  } catch (e) {
    if (e.message !== "oturum" && e.message !== "kopuk") toast("PDF alınamadı");
  } finally { btn.disabled = false; }
}

// ---------- Seçilenleri indir (ZIP) ----------
function ilerleme(i, n, boyut, adim) {
  $("ilerCubuk").style.width = `${n ? Math.round((i / n) * 100) : 0}%`;
  $("ilerSayi").textContent = `${i} / ${n} PDF`;
  $("ilerBoyut").textContent = boyut ? boyutMetni(boyut) : "";
  $("ilerAdim").textContent = adim || "";
}

$("durdurBtn").addEventListener("click", () => { durdur = true; $("ilerAdim").textContent = "Durduruluyor…"; });
$("bittiKapat").addEventListener("click", () => $("bitti").classList.add("hidden"));

$("indirBtn").addEventListener("click", async () => {
  if (indiriliyor) return;
  const kod = secilenTur;
  const liste = gruplar.get(kod) || [];
  indiriliyor = true; durdur = false;
  $("indirBtn").disabled = true; $("listeleBtn").disabled = true; $("tur").disabled = true;
  $("bitti").classList.add("hidden");
  $("ilerleme").classList.remove("hidden");
  $("ilerBaslik").textContent = `ZIP hazırlanıyor · ${kod}`;
  const uyarilar = [];
  try {
    // 1) Seçili düzeltmeli dönemlerde güncel sürümü kesinleştir.
    const gerekli = liste.filter((g) => g.surumler.length > 1 &&
      (secim.has("G:" + g.anahtar) || g.surumler.some((s) => secim.has("S:" + s.beyoid))));
    for (let i = 0; i < gerekli.length && !durdur; i++) {
      ilerleme(0, secilenler().length, 0, `Onay zamanları okunuyor: ${donemMetni(gerekli[i].donem)}`);
      try { await grupCoz(gerekli[i]); } catch (e) { if (e.message === "oturum" || e.message === "kopuk") throw e; }
    }
    ciz();

    // 2) PDF'leri topla.
    const isler = secilenler();
    const dosyalar = [];
    const csv = [["Tür", "Dönem", "Durum", "Onay zamanı", "Düzeltme nedeni", "Dosya"]];
    let boyut = 0;
    for (let i = 0; i < isler.length; i++) {
      if (durdur) break;
      const { g, s, no } = isler[i];
      const b = grupBilgisi(g);
      ilerleme(i, isler.length, boyut, `${donemMetni(g.donem)}${no ? ` · önceki sürüm ${no}` : ""}`);
      let u8;
      try { u8 = await pdfGetir(s.beyoid); } catch (e) {
        if (e.message === "oturum" || e.message === "kopuk") throw e;
        uyarilar.push(`${donemMetni(g.donem)}: PDF alınamadı, ZIP'e eklenmedi.`);
        continue;
      }
      const ms = await onayOku(s.beyoid); // önbellekteki PDF'ten, yeni istek yok
      const ad = dosyaAdi(vkn, kod, g.donem, no);
      dosyalar.push({ ad, veri: u8 });
      boyut += u8.length;
      const durum = !b.coklu ? (s.aciklama ? "Düzeltme" : "Asıl")
        : no ? (b.durum === "tahmini" ? "Diğer sürüm (tahmini)" : "Önceki sürüm")
        : b.durum === "tahmini" ? "Güncel (tahmini)" : "Güncel";
      csv.push([kod, donemMetni(g.donem), durum, typeof ms === "number" ? zamanMetni(ms) : "", s.aciklama, ad]);
    }
    for (const g of liste) {
      if (secim.has("G:" + g.anahtar) && g.surumler.length > 1 && durumlar.get(g.anahtar) === "tahmini") {
        uyarilar.push(`${donemMetni(g.donem)}: onay zamanı okunamadığı için ${g.surumler.length} sürüm de eklendi.`);
      }
    }
    if (durdur) uyarilar.unshift("İndirme durduruldu; ZIP yalnızca o ana kadar alınan PDF'leri içeriyor.");
    ilerleme(isler.length, isler.length, boyut, "ZIP yazılıyor…");

    if (!dosyalar.length) { toast("İndirilecek PDF alınamadı"); return; }
    dosyalar.push({ ad: "ozet.csv", veri: new TextEncoder().encode(csvYaz(csv)) });
    const zipAd = `${vkn}_${kod}_${ayMetni(aralik.bas)}_${ayMetni(aralik.bit)}.zip`;
    const zip = zipYaz(dosyalar);
    blobIndir(zip, zipAd);

    $("bittiBaslik").textContent = `${dosyalar.length - 1} PDF indirildi · ${boyutMetni(zip.size)}`;
    $("bittiAd").textContent = zipAd;
    $("bitti").querySelector(".done").classList.toggle("uyari", uyarilar.length > 0);
    $("bittiUyari").replaceChildren(...uyarilar.map((u) => el("li", null, u)));
    $("bitti").classList.remove("hidden");
  } catch (e) {
    if (e.message !== "oturum" && e.message !== "kopuk") toast("İndirme tamamlanamadı");
  } finally {
    indiriliyor = false;
    $("ilerleme").classList.add("hidden");
    $("listeleBtn").disabled = false; $("tur").disabled = false;
    ciz();
  }
});

// ---------- Başlangıç ----------
function oturumCipi() {
  const m = $("oturumMetin");
  m.replaceChildren();
  if (unvan) { m.append(el("b", null, unvan), el("span", "sep", " | ")); }
  m.append(vkn ? `${vkn.length === 11 ? "TCKN" : "VKN"} ${vkn}` : "IVD bağlı");
}

// IVD sekmesine bağlanır: önce bilinen sekme, olmazsa açık IVD sekmesi aranır.
// Liste ve seçimler korunur; farklı bir mükellefin oturumuna bağlanılırsa liste temizlenir ve false döner.
let baglaniyor = null;
function baglan(ops = {}) {
  if (!baglaniyor) baglaniyor = baglanIc(ops).finally(() => { baglaniyor = null; });
  return baglaniyor;
}
async function baglanIc({ sessiz = false } = {}) {
  let d = await gonder({ tip: "durum" });
  if (!(d?.ok && d.oturum) && await ivdSekmesiniBul()) d = await gonder({ tip: "durum" });
  if (!d) { seritGoster("kopuk"); return false; }
  if (!d.ok || !d.oturum) { seritGoster("oturum"); return false; }
  const oncekiDurum = baglanti;
  baglanti = "tamam";
  $("serit").classList.add("hidden");
  $("oturumNokta").className = "dot on";
  let ayniMukellef = true;
  if (d.vkn) {
    if (vkn && d.vkn !== vkn && gruplar.size) {
      ayniMukellef = false;
      gruplar = new Map(); secim.clear(); acik.clear();
      $("sonuc").classList.add("hidden"); $("bos").classList.add("hidden");
      toast("Farklı bir mükellefin oturumu: liste temizlendi");
    }
    vkn = d.vkn; unvan = d.unvan || "";
    $("vknAlan").classList.add("hidden");
  } else if (!vkn) {
    // Oturumun kime ait olduğu bulunamadı: kullanıcı yazar (IVD sekmesi bunu hatırlar).
    $("vknAlan").classList.remove("hidden");
    $("vkn").value = d.adaylar?.[0] || "";
  }
  oturumCipi();
  if (ayniMukellef && oncekiDurum !== "tamam" && oncekiDurum !== "bekliyor" && gruplar.size) {
    ciz(); arkaPlandaOku();
    if (!sessiz) toast("IVD sekmesine yeniden bağlandı");
  }
  return ayniMukellef;
}

// Popup bir IVD sekmesinde açıldığında haber verir. Bağlantısı kopmuş sayfa (ya da zaten o sekmeye
// bağlı sayfa) bu sekmeye bağlanır ve kaldığı yerden devam eder.
chrome.runtime.onMessage.addListener((msg, sender, cevap) => {
  if (sender.id !== chrome.runtime.id || !(sender.url || "").startsWith(chrome.runtime.getURL("popup.html"))) return;
  if (msg?.tip !== "ivdHazir" || !Number.isInteger(msg.sekme)) return;
  if (baglanti === "tamam" && msg.sekme !== ivdSekme) return; // başka bir IVD sekmesiyle çalışıyor
  (async () => {
    const eski = ivdSekme;
    ivdSekme = msg.sekme;
    history.replaceState(null, "", `?sekme=${ivdSekme}`);
    const tamam = await baglan();
    if (!tamam && baglanti !== "tamam") { ivdSekme = eski; history.replaceState(null, "", `?sekme=${eski}`); }
    const ben = await chrome.tabs.getCurrent();
    cevap({ kabul: baglanti === "tamam", sayfa: ben?.id, pencere: ben?.windowId });
  })();
  return true;
});

// Bağlantı kopukken sayfaya dönülünce yeniden dene (IVD sekmesi kendiliğinden bulunur).
window.addEventListener("focus", () => { if (baglanti === "kopuk" || baglanti === "oturum") baglan(); });

// Şeritteki "Yeniden bağlan" düğmesi
$("seritBtn").addEventListener("click", async () => {
  if (!(await baglan()) && baglanti !== "tamam") toast("Oturumu açık bir İnternet Vergi Dairesi sekmesi bulunamadı");
});

async function baslat() {
  donemKutulari();
  await baglan();
}

baslat();
