// Mükellef Kasası — ZIP yazıcı. Harici kütüphane yok.
// PDF'ler zaten sıkıştırılmış olduğu için dosyalar "store" (sıkıştırmasız) yöntemiyle eklenir;
// her dosyaya CRC-32 hesaplanır. Türkçe dosya adları için UTF-8 bayrağı (bit 11) açıktır.
// Bölüm 2'deki ZIP okuyucunun (spreadsheet.js) tersi.

const CRC_TABLO = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLO[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS saat/tarih alanları (yerel saat, 2 saniye çözünürlük)
function dosZamani(d) {
  const saat = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const tarih = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { saat, tarih };
}

// dosyalar: [{ ad: "x.pdf", veri: Uint8Array }] → Blob (application/zip)
function zipYaz(dosyalar, zaman = new Date()) {
  const enc = new TextEncoder();
  const { saat, tarih } = dosZamani(zaman);
  const parcalar = [];
  const merkez = [];
  let ofset = 0;

  for (const f of dosyalar) {
    const ad = enc.encode(f.ad);
    const veri = f.veri;
    const crc = crc32(veri);

    const yerel = new DataView(new ArrayBuffer(30));
    yerel.setUint32(0, 0x04034b50, true); // yerel dosya başlığı imzası
    yerel.setUint16(4, 20, true);          // açmak için gereken sürüm
    yerel.setUint16(6, 0x0800, true);      // bayrak: UTF-8 dosya adı
    yerel.setUint16(8, 0, true);           // yöntem: store
    yerel.setUint16(10, saat, true);
    yerel.setUint16(12, tarih, true);
    yerel.setUint32(14, crc, true);
    yerel.setUint32(18, veri.length, true);
    yerel.setUint32(22, veri.length, true);
    yerel.setUint16(26, ad.length, true);
    yerel.setUint16(28, 0, true);
    parcalar.push(yerel, ad, veri);

    const m = new DataView(new ArrayBuffer(46));
    m.setUint32(0, 0x02014b50, true);      // merkezi dizin kaydı imzası
    m.setUint16(4, 20, true);
    m.setUint16(6, 20, true);
    m.setUint16(8, 0x0800, true);
    m.setUint16(10, 0, true);
    m.setUint16(12, saat, true);
    m.setUint16(14, tarih, true);
    m.setUint32(16, crc, true);
    m.setUint32(20, veri.length, true);
    m.setUint32(24, veri.length, true);
    m.setUint16(28, ad.length, true);
    // 30–41: ek alan, yorum, disk, iç/dış öznitelikler = 0
    m.setUint32(42, ofset, true);
    merkez.push(m, ad);

    ofset += 30 + ad.length + veri.length;
  }

  const merkezBoyu = merkez.reduce((t, p) => t + p.byteLength, 0);
  const son = new DataView(new ArrayBuffer(22));
  son.setUint32(0, 0x06054b50, true);      // merkezi dizin sonu imzası
  son.setUint16(8, dosyalar.length, true);
  son.setUint16(10, dosyalar.length, true);
  son.setUint32(12, merkezBoyu, true);
  son.setUint32(16, ofset, true);

  return new Blob([...parcalar, ...merkez, son], { type: "application/zip" });
}

if (typeof module !== "undefined") module.exports = { zipYaz, crc32 };
