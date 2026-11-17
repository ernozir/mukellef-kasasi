// Mükellef Kasası — beyanname listesi kuralları (saf fonksiyonlar, tarayıcı API'si yok).
// IVD yanıtındaki bir kayıt: { kaynak, aciklama, beyanname_turu: "KDV1_45", beyoid, donem: "202601202601" }
//  - beyanname_turu = tür kodu + "_" + form sürümü → gruplama tür koduyla yapılır.
//  - donem = başlangıç YYYYMM + bitiş YYYYMM.
//  - aciklama = Düzeltme Nedeni (asılda boş).

const AYLAR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

// Seçim kutusunda her zaman üstte, bu sırayla duran türler.
const SIK_TURLER = ["KDV1", "KDV2", "KGECICI", "KURUMLAR", "GELIR", "GGECICI"];

// Bilinmeyen kod gelirse kodun kendisi gösterilir.
const TUR_ADLARI = {
  KDV1: "KDV Beyannamesi (1 No'lu)",
  KDV2: "KDV Beyannamesi (2 No'lu)",
  KGECICI: "Kurumlar Vergisi Geçici",
  KURUMLAR: "Kurumlar Vergisi",
  GELIR: "Yıllık Gelir Vergisi",
  GGECICI: "Gelir Vergisi Geçici",
  MUHSGK: "Muhtasar ve Prim Hizmet",
  DAMGA: "Damga Vergisi",
  POSET: "Geri Kazanım Katılım Payı"
};

const turKodu = (beyannameTuru) => String(beyannameTuru || "").split("_")[0].toUpperCase() || "BILINMEYEN";
const turAdi = (kod) => TUR_ADLARI[kod] || kod;

// "202601202603" → { bas: {yil:2026, ay:1}, bit: {yil:2026, ay:3} }
function donemAyristir(d) {
  const m = /^(\d{4})(\d{2})(\d{4})(\d{2})$/.exec(String(d || ""));
  if (!m) return null;
  return { bas: { yil: +m[1], ay: +m[2] }, bit: { yil: +m[3], ay: +m[4] } };
}

// Ekranda: "Ocak 2026", "Ocak – Mart 2026", "Kasım 2025 – Ocak 2026"
function donemMetni(d) {
  const p = donemAyristir(d);
  if (!p) return String(d || "");
  const { bas, bit } = p;
  if (bas.yil === bit.yil && bas.ay === bit.ay) return `${AYLAR[bas.ay - 1]} ${bas.yil}`;
  if (bas.yil === bit.yil) return `${AYLAR[bas.ay - 1]} – ${AYLAR[bit.ay - 1]} ${bas.yil}`;
  return `${AYLAR[bas.ay - 1]} ${bas.yil} – ${AYLAR[bit.ay - 1]} ${bit.yil}`;
}

// Dosya adında: "2026-01" ya da "2026-01_2026-03"
function donemDosya(d) {
  const p = donemAyristir(d);
  if (!p) return String(d || "").replace(/[^\w-]/g, "");
  const a = `${p.bas.yil}-${String(p.bas.ay).padStart(2, "0")}`;
  const b = `${p.bit.yil}-${String(p.bit.ay).padStart(2, "0")}`;
  return a === b ? a : `${a}_${b}`;
}

// beyoid'in 3.–10. karakterleri, kaydın OLUŞTURULMA anının base36 milisaniyesidir (onay anı değil).
// Yalnızca onay zamanı okunamadığında sıralama için yedek olarak kullanılır.
function beyoidZamani(beyoid) {
  const s = String(beyoid || "");
  if (!/^[0-9a-z]{14}$/.test(s)) return null;
  const ms = parseInt(s.slice(2, 10), 36);
  return ms > 1e12 && ms < 4e12 ? ms : null;
}

// Yanıt kayıtlarını türe ve döneme göre gruplar.
// Dönüş: Map<turKodu, Grup[]>; Grup = { anahtar, kod, donem, surumler: Kayit[] (yanıttaki sırayla) }
function grupla(kayitlar) {
  const turler = new Map();
  const gorulen = new Set();
  for (const k of kayitlar) {
    if (!k || !k.beyoid || gorulen.has(k.beyoid)) continue;
    gorulen.add(k.beyoid);
    const kod = turKodu(k.beyanname_turu);
    const anahtar = kod + "|" + k.donem;
    if (!turler.has(kod)) turler.set(kod, new Map());
    const m = turler.get(kod);
    if (!m.has(anahtar)) m.set(anahtar, { anahtar, kod, donem: String(k.donem || ""), surumler: [] });
    m.get(anahtar).surumler.push({
      beyoid: String(k.beyoid),
      tur: String(k.beyanname_turu || ""),
      aciklama: String(k.aciklama || "").trim(),
      kaynak: String(k.kaynak || "")
    });
  }
  const sonuc = new Map();
  for (const [kod, m] of turler) sonuc.set(kod, [...m.values()].sort((a, b) => a.donem.localeCompare(b.donem)));
  return sonuc;
}

// Bir grubun güncel sürümünü seçer.
// onaylar: Map<beyoid, number(ms) | null>  (PDF'ten okunan Onay Zamanı)
// Dönüş: { guncel, digerleri (yeniden eskiye), kesin: bool }
//  - Tek sürüm → kesin.
//  - Hepsinin onay zamanı okunduysa → en yeni onay zamanı, kesin.
//  - Biri bile okunamadıysa → tahmini: beyoid zamanı (hepsi çözülebiliyorsa) ya da yanıttaki son kayıt.
function guncelSec(grup, onaylar) {
  const s = grup.surumler;
  if (s.length === 1) return { guncel: s[0], digerleri: [], kesin: true };
  const hepsiOkundu = s.every((x) => typeof onaylar.get(x.beyoid) === "number");
  let sirali;
  if (hepsiOkundu) {
    sirali = [...s].sort((a, b) => onaylar.get(b.beyoid) - onaylar.get(a.beyoid));
  } else if (s.every((x) => beyoidZamani(x.beyoid) !== null)) {
    sirali = [...s].sort((a, b) => beyoidZamani(b.beyoid) - beyoidZamani(a.beyoid));
  } else {
    sirali = [...s].reverse(); // yanıt, oluşturulma sırasıyla geliyor
  }
  return { guncel: sirali[0], digerleri: sirali.slice(1), kesin: hepsiOkundu };
}

// Seçim kutusunun içeriği: sık türler (kaydı yoksa var:false) + yanıttaki diğer türler (alfabetik).
function turListesi(gruplar) {
  const bilgi = (kod) => {
    const g = gruplar.get(kod) || [];
    return {
      kod, ad: turAdi(kod), var: g.length > 0, sik: SIK_TURLER.includes(kod),
      donemSayisi: g.length,
      beyannameSayisi: g.reduce((t, x) => t + x.surumler.length, 0),
      duzeltmeliDonem: g.filter((x) => x.surumler.length > 1).length
    };
  };
  const sik = SIK_TURLER.map(bilgi);
  const diger = [...gruplar.keys()].filter((k) => !SIK_TURLER.includes(k)).sort((a, b) => a.localeCompare(b, "tr")).map(bilgi);
  return { sik, diger };
}

// <VKN>_<TÜR>_<dönem>[_onceki-n].pdf
function dosyaAdi(vkn, kod, donem, oncekiNo = 0) {
  return `${vkn}_${kod}_${donemDosya(donem)}${oncekiNo ? `_onceki-${oncekiNo}` : ""}.pdf`;
}

// Excel'in Türkçe ayarlarıyla doğrudan açılan CSV: UTF-8 BOM, ";" ayırıcı, CRLF.
function csvYaz(satirlar) {
  const hucre = (v) => {
    const s = String(v ?? "");
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + satirlar.map((r) => r.map(hucre).join(";")).join("\r\n") + "\r\n";
}

// Sorgu aralığını takvim yıllarına böler (IVD'nin tek sorguda kabul ettiği aralık bilinmediği için).
// bas/bit: { yil, ay } → [{ bas: {yil, ay}, bit: {yil, ay} }, …]
function yillaraBol(bas, bit) {
  const parcalar = [];
  for (let y = bas.yil; y <= bit.yil; y++) {
    parcalar.push({ bas: { yil: y, ay: y === bas.yil ? bas.ay : 1 }, bit: { yil: y, ay: y === bit.yil ? bit.ay : 12 } });
  }
  return parcalar;
}

// VKN (10 hane) kontrol hanesi — GİB algoritması (vault.js'teki ile aynı)
function vknGecerli(v) {
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
function tcknGecerli(v) {
  if (!/^[1-9]\d{10}$/.test(v)) return false;
  const d = [...v].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  if ((((odd * 7 - even) % 10) + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}
const kimlikGecerli = (v) => vknGecerli(v) || tcknGecerli(v);

if (typeof module !== "undefined") {
  module.exports = {
    AYLAR, SIK_TURLER, TUR_ADLARI, turKodu, turAdi, donemAyristir, donemMetni, donemDosya, beyoidZamani,
    grupla, guncelSec, turListesi, dosyaAdi, csvYaz, yillaraBol, vknGecerli, tcknGecerli, kimlikGecerli
  };
}
