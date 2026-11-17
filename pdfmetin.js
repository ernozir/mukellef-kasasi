// Mükellef Kasası — beyanname PDF'inden "Onay Zamanı" okur. Harici kütüphane yok.
//
// GİB'de iki PDF biçimi var:
//  1) Eski (iText 1.02b + JasperReports): tek baytlık yazı tipleri, Türkçe harfler
//     windows-1254 konumlarında.   (Onay Zaman\xfd :)Tj … (01.10.2025 - 11:14:33)Tj
//  2) Yeni (OpenPDF): 2 baytlık glif kodları (Identity-H); harf karşılıkları
//     ToUnicode tablolarında.        "Onay Zamanı: 20/01/2026 17:35:07"
// İkisinde de içerik akışları FlateDecode ile sıkıştırılmış; tarayıcının kendi
// DecompressionStream'i açmaya yetiyor.

const ONAY_RE =
  /Onay\s*Zaman.\s*:\s*(\d{2})[./](\d{2})[./](\d{4})\s*-?\s*(\d{2}):(\d{2}):(\d{2})/;

const cp1254 = new TextDecoder("windows-1254");

function latin1(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return s;
}

// zlib akışını açar; sondaki satır sonu gibi fazlalıklar hata verse de açılan kısım korunur.
async function inflate(bytes) {
  const reader = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream("deflate")).getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); total += value.length;
    }
  } catch { /* sondaki fazlalık */ }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// PDF'teki tüm akışları (açılmış hâlde, latin1 metin olarak) döndürür.
async function akislar(u8, s) {
  const out = [];
  const re = />>\s*stream\r?\n/g; // sözlüğü izleyen "stream" — "endstream" ile karışmasın
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const dict = s.slice(s.lastIndexOf(" obj", m.index), m.index);
    if (/\/FlateDecode/.test(dict)) out.push(latin1(await inflate(u8.subarray(start, end))));
    else if (!/\/Filter/.test(dict)) out.push(s.slice(start, end));
    re.lastIndex = end + 9;
  }
  return out;
}

function hexBytes(h) {
  h = h.replace(/\s+/g, "");
  if (h.length % 2) h += "0";
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  return b;
}
const utf16 = (h) => new TextDecoder("utf-16be").decode(hexBytes(h));

// ToUnicode tablolarını (bfchar / bfrange) tek bir koda→harf haritasında birleştirir.
function cmapOku(text, map) {
  for (const [, blk] of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, k, v] of blk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(k, 16), utf16(v));
    }
  }
  for (const [, blk] of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    for (const [, a, z, u, dizi] of blk.matchAll(re)) {
      const lo = parseInt(a, 16), hi = parseInt(z, 16);
      if (u !== undefined) {
        const taban = parseInt(u, 16);
        for (let k = lo; k <= hi; k++) map.set(k, String.fromCodePoint(taban + k - lo));
      } else {
        const hedefler = [...dizi.matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
        for (let k = lo; k <= hi && k - lo < hedefler.length; k++) map.set(k, hedefler[k - lo]);
      }
    }
  }
}

// İçerik akışındaki metin dizgelerini sırasıyla verir; ET (metin bloğu sonu) yerine null.
function* dizgeler(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "(") {
      const buf = [];
      let depth = 1, j = i + 1;
      while (j < n) {
        const ch = s.charCodeAt(j);
        if (ch === 0x5c) { // ters bölü kaçışı
          const nx = s[j + 1];
          if (nx >= "0" && nx <= "7") {
            let k = j + 1, o = "";
            while (k < n && k < j + 4 && s[k] >= "0" && s[k] <= "7") o += s[k++];
            buf.push(parseInt(o, 8) & 255); j = k; continue;
          }
          if (nx === "\r" || nx === "\n") { j += nx === "\r" && s[j + 2] === "\n" ? 3 : 2; continue; }
          const esc = { n: 10, r: 13, t: 9, b: 8, f: 12 }[nx];
          buf.push(esc ?? s.charCodeAt(j + 1)); j += 2; continue;
        }
        if (ch === 0x28) depth++;
        else if (ch === 0x29 && --depth === 0) break;
        buf.push(ch); j++;
      }
      yield Uint8Array.from(buf);
      i = j + 1; continue;
    }
    if (c === "<") {
      if (s[i + 1] === "<") { i += 2; continue; } // sözlük
      const j = s.indexOf(">", i);
      if (j < 0) break;
      yield hexBytes(s.slice(i + 1, j));
      i = j + 1; continue;
    }
    if (c === "E" && s[i + 1] === "T" && /\s/.test(s[i - 1] || " ") && /\s/.test(s[i + 2] || " ")) {
      yield null;
    }
    i++;
  }
}

function dizgeCoz(b, map) {
  if (map.size && b.length && b.length % 2 === 0) {
    let t = "", tamam = true;
    for (let i = 0; i < b.length; i += 2) {
      const ch = map.get((b[i] << 8) | b[i + 1]);
      if (ch === undefined) { tamam = false; break; }
      t += ch;
    }
    if (tamam) return t;
  }
  return cp1254.decode(b);
}

// PDF'in görünen metnini (metin blokları satır satır) döndürür.
async function pdfMetni(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const s = latin1(u8);
  if (!s.startsWith("%PDF-")) throw new Error("PDF değil");
  const hepsi = await akislar(u8, s);
  const map = new Map();
  for (const a of hepsi) if (a.includes("begincmap")) cmapOku(a, map);
  const satirlar = [];
  for (const a of hepsi) {
    if (!/T[jJ*'"]?\s/.test(a) || !a.includes("BT")) continue; // içerik akışı değil
    let satir = "";
    for (const d of dizgeler(a)) {
      if (d === null) { if (satir) satirlar.push(satir); satir = ""; }
      else satir += dizgeCoz(d, map);
    }
    if (satir) satirlar.push(satir);
  }
  return satirlar.join("\n");
}

// Bulursa { tarih: Date, metin: "01.10.2025 11:14:33" }, yoksa null.
async function onayZamaniOku(buf) {
  const r = ONAY_RE.exec(await pdfMetni(buf));
  if (!r) return null;
  const [, gg, aa, yyyy, sa, dk, sn] = r;
  return {
    tarih: new Date(`${yyyy}-${aa}-${gg}T${sa}:${dk}:${sn}+03:00`),
    metin: `${gg}.${aa}.${yyyy} ${sa}:${dk}:${sn}`
  };
}

if (typeof module !== "undefined") module.exports = { onayZamaniOku, pdfMetni };
