// Mükellef Kasası — kütüphanesiz Excel (.xlsx) ve CSV okuyucu
// .xlsx aslında bir ZIP arşividir; içindeki XML dosyalarını tarayıcının yerleşik
// DecompressionStream (ZIP açma) ve DOMParser (XML okuma) araçlarıyla okuyoruz.
// Dosya bilgisayardan hiçbir yere gönderilmez.

const MAX_FILE_BYTES = 5 * 1024 * 1024;     // 5 MB yeter de artar
const MAX_UNZIPPED_BYTES = 30 * 1024 * 1024; // "ZIP bombası"na karşı açılmış boyut sınırı

// ---------- ZIP ----------
function openZip(buf) {
  const dv = new DataView(buf);
  // Arşivin sonundaki "merkezi dizin sonu" kaydını bul
  let eocd = -1;
  for (let i = buf.byteLength - 22, min = Math.max(0, buf.byteLength - 65557); i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Dosya okunamadı: geçerli bir .xlsx değil.");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.byteLength || dv.getUint32(off, true) !== 0x02014b50) throw new Error("Excel dosyası bozuk.");
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const usize = dv.getUint32(off + 24, true);
    const nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nlen)).replace(/\\/g, "/");
    files.set(name.toLowerCase(), { method, csize, usize, lho });
    off += 46 + nlen + elen + clen;
  }
  return {
    async text(path) {
      const f = files.get(path.replace(/^\//, "").toLowerCase());
      if (!f) return null;
      if (f.usize > MAX_UNZIPPED_BYTES) throw new Error("Excel dosyası beklenenden çok büyük.");
      if (dv.getUint32(f.lho, true) !== 0x04034b50) throw new Error("Excel dosyası bozuk.");
      const start = f.lho + 30 + dv.getUint16(f.lho + 26, true) + dv.getUint16(f.lho + 28, true);
      const data = new Uint8Array(buf, start, f.csize);
      let out;
      if (f.method === 0) out = data;
      else if (f.method === 8) {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        out = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error("Bu Excel dosyasının sıkıştırma biçimi desteklenmiyor.");
      return new TextDecoder().decode(out);
    }
  };
}

// ---------- XLSX ----------
const parseXml = (s) => {
  const d = new DOMParser().parseFromString(s, "application/xml");
  if (d.getElementsByTagName("parsererror").length) throw new Error("Excel içeriği çözümlenemedi.");
  return d;
};
const byTag = (node, tag) => Array.from(node.getElementsByTagNameNS("*", tag));
const kids = (node, tag) => Array.from(node.children).filter((e) => e.localName === tag);

// Zengin metin hücrelerinde <t> parçalarını birleştir (Japonca okunuş <rPh> hariç)
function cellText(node) {
  return byTag(node, "t").filter((t) => t.parentNode.localName !== "rPh").map((t) => t.textContent).join("");
}

function colIndex(ref) {
  const m = /^[A-Z]+/i.exec(ref || "");
  if (!m) return -1;
  let n = 0;
  for (const ch of m[0].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

// Excel sayıları "1.2345E10" gibi saklayabilir; tam sayıysa düz rakama çevir.
function numberText(s) {
  if (/^-?\d+$/.test(s)) return s;
  const n = Number(s);
  return Number.isFinite(n) && Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(0) : s;
}

async function readXlsx(buf) {
  const zip = openZip(buf);
  const wbXml = await zip.text("xl/workbook.xml");
  if (!wbXml) throw new Error("Bu dosya geçerli bir .xlsx değil.");

  const rels = {};
  const relsXml = await zip.text("xl/_rels/workbook.xml.rels");
  if (relsXml) for (const r of byTag(parseXml(relsXml), "Relationship")) rels[r.getAttribute("Id")] = r.getAttribute("Target");

  const shared = [];
  const ssXml = await zip.text("xl/sharedStrings.xml");
  if (ssXml) for (const si of byTag(parseXml(ssXml), "si")) shared.push(cellText(si));

  // Hücre biçimi "0000000000" gibiyse Excel baştaki sıfırları yalnızca gösterir, saklamaz.
  // Biçimdeki sıfır sayısı kadar soldan sıfır ekleyerek görünen değeri geri kuruyoruz.
  const padByStyle = [];
  const stXml = await zip.text("xl/styles.xml");
  if (stXml) {
    const d = parseXml(stXml);
    const fmts = {};
    for (const f of byTag(d, "numFmt")) fmts[f.getAttribute("numFmtId")] = f.getAttribute("formatCode") || "";
    const xfs = byTag(d, "cellXfs")[0];
    if (xfs) for (const xf of kids(xfs, "xf")) {
      const code = (fmts[xf.getAttribute("numFmtId")] || "").split(";")[0].replace(/"[^"]*"|\\./g, "");
      padByStyle.push(/^0{2,}$/.test(code) ? code.length : 0);
    }
  }

  // "Mükellefler" adlı sayfa varsa onu, yoksa ilk sayfayı oku
  const sheets = byTag(parseXml(wbXml), "sheet");
  if (!sheets.length) throw new Error("Excel dosyasında sayfa bulunamadı.");
  const sheet = sheets.find((s) => /m[üu]kellef/i.test(s.getAttribute("name") || "")) || sheets[0];
  const rid = sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const target = rels[rid] || "worksheets/sheet1.xml";
  const path = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  const xml = await zip.text(path);
  if (!xml) throw new Error("Excel sayfası okunamadı.");

  const rows = [];
  let lastRow = 0;
  for (const row of byTag(parseXml(xml), "row")) {
    const rn = parseInt(row.getAttribute("r"), 10) || lastRow + 1;
    lastRow = rn;
    const cells = [];
    let col = 0;
    for (const c of kids(row, "c")) {
      if (c.getAttribute("r")) col = colIndex(c.getAttribute("r"));
      const t = c.getAttribute("t") || "n";
      const v = kids(c, "v")[0];
      let text = "", numeric = false;
      if (t === "s") text = v ? shared[parseInt(v.textContent, 10)] || "" : "";
      else if (t === "inlineStr") text = kids(c, "is")[0] ? cellText(kids(c, "is")[0]) : "";
      else if (t === "str" || t === "e") text = v ? v.textContent : "";
      else if (t === "b") text = v && v.textContent === "1" ? "DOĞRU" : "YANLIŞ";
      else if (v) {
        text = numberText(v.textContent.trim());
        numeric = true;
        const pad = padByStyle[parseInt(c.getAttribute("s"), 10) || 0] || 0;
        if (pad && /^\d+$/.test(text) && text.length < pad) text = text.padStart(pad, "0");
      }
      if (col >= 0 && col < 100) cells[col] = { text: text.trim(), numeric };
      col++;
    }
    for (let i = 0; i < cells.length; i++) if (!cells[i]) cells[i] = { text: "", numeric: false };
    if (cells.some((x) => x.text)) rows.push({ n: rn, cells });
  }
  return { sheetName: sheet.getAttribute("name") || "Sayfa 1", rows };
}

// ---------- CSV ----------
// Türkçe Excel CSV'yi çoğu zaman Windows-1254 ile ve ";" ayırıcıyla kaydeder.
function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder("utf-8").decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder("utf-16le").decode(u8.subarray(2));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); }
  catch (_) { return new TextDecoder("windows-1254").decode(u8); }
}

function readCsv(text) {
  let delim = null;
  const sep = /^sep=(.)\r?\n/i.exec(text);
  if (sep) { delim = sep[1]; text = text.slice(sep[0].length); }
  if (!delim) {
    const first = text.split(/\r?\n/).find((l) => l.trim()) || "";
    delim = [";", ",", "\t"].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = [];
  let row = [], field = "", quoted = false, line = 1, rowStart = 1;
  const endRow = () => {
    row.push(field); field = "";
    const cells = row.map((t) => ({ text: t.trim(), numeric: false }));
    if (cells.some((c) => c.text)) rows.push({ n: rowStart, cells });
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else { if (ch === "\n") line++; field += ch; }
    } else if (ch === '"' && field.trim() === "") { quoted = true; field = ""; }
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\r") continue;
    else if (ch === "\n") { endRow(); line++; rowStart = line; }
    else field += ch;
  }
  if (field !== "" || row.length) endRow();
  return { sheetName: "CSV", rows };
}

async function readSpreadsheet(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error("Dosya 5 MB'tan büyük; mükellef listesi için beklenmedik bir boyut.");
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (isZip) return readXlsx(buf);
  if (/\.xlsx?$/i.test(file.name)) {
    throw new Error('Eski .xls biçimi desteklenmiyor. Excel\'de "Farklı Kaydet → Excel Çalışma Kitabı (.xlsx)" ile kaydedip tekrar deneyin.');
  }
  return readCsv(decodeText(buf));
}

// ---------- Sütun eşleştirme ----------
// Başlıklar şablondakiyle birebir aynı olmasa da tanınır: "Ünvan", "Kullanıcı Adı", "Parola"...
const norm = (s) => String(s || "").toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD")
  .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const HEADER_WORDS = [ // sıra önemli: "kullanıcı şifresi" önce şifre sayılmalı
  ["sifre", ["sifre", "sifresi", "parola", "password"]],
  ["userid", ["kullanici kodu", "kullanici kod", "kullanici adi", "kullanici", "kod"]],
  ["vkn", ["vkn", "tckn", "vergi no", "vergi kimlik", "vergi numarasi", "tc kimlik", "tc no", "kimlik no"]],
  ["name", ["unvan", "unvani", "ad soyad", "adi soyadi", "mukellef", "firma", "isim"]],
  ["note", ["not", "notlar", "aciklama"]]
];
const FIELD_LABELS = { name: "Unvan / Ad Soyad", vkn: "VKN / TCKN", userid: "Kullanıcı Kodu", sifre: "Şifre", note: "Not" };

function matchField(header) {
  const h = " " + norm(header) + " ";
  if (h.trim() === "") return null;
  for (const [field, words] of HEADER_WORDS) if (words.some((w) => h.includes(" " + w + " "))) return field;
  return null;
}

// İlk 10 satırda başlık satırını arar → { headerIdx, map: {alan: sütun}, missing: [etiket] }
function mapColumns(rows) {
  let best = { headerIdx: -1, map: {}, score: 0 };
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const map = {};
    rows[i].cells.forEach((c, col) => {
      const f = matchField(c.text);
      if (f && map[f] === undefined) map[f] = col;
    });
    const score = Object.keys(map).length;
    if (score > best.score) best = { headerIdx: i, map, score };
  }
  const missing = ["name", "userid", "sifre"].filter((f) => best.map[f] === undefined).map((f) => FIELD_LABELS[f]);
  return { headerIdx: best.headerIdx, map: best.map, missing };
}

// Başlıktan sonraki satırları kayıt adayına çevirir → [{ n, raw, warnings }]
function rowsToRecords(rows, headerIdx, map) {
  const out = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const raw = {}, warnings = [];
    for (const [f, col] of Object.entries(map)) raw[f] = r.cells[col]?.text || "";
    if (!Object.values(raw).some(Boolean)) continue;
    // Sayı olarak girilmiş 9 haneli VKN: Excel baştaki sıfırı silmiş olabilir
    const vc = r.cells[map.vkn];
    if (vc?.numeric && /^\d{9}$/.test(raw.vkn)) {
      raw.vkn = "0" + raw.vkn;
      warnings.push("VKN Excel'de sayı olarak 9 hane kalmış; başına 0 eklendi.");
    }
    out.push({ n: r.n, raw, warnings });
  }
  return out;
}
