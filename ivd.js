// Mükellef Kasası — İnternet Vergi Dairesi sekmesindeki betik.
// Popup (eklenti simgesine basılınca) ya da beyanname sayfası (açıkken bağlantı kurmak için) bu betiği
// IVD sekmesine yükler. Sayfaya kendiliğinden çalışan bir betik konmaz.
//
// Görevi dar tutuldu:
//  - Oturum anahtarını (token) sayfanın kendi adresinden okur; token bu sekmeden hiç çıkmaz.
//  - Yalnızca okuma yapar: oturumun kime ait olduğu (oturum / kimlik bilgileri), beyanname listesi
//    ve bir beyannamenin PDF'i.
//  - Yalnızca eklentinin kendi sayfalarından (popup, beyanname sayfası) gelen mesajları dinler.
// Beyanname gönderme, iptal, ödeme gibi hiçbir komut burada yok.

(() => {
  if (globalThis.__mukellefKasasiIvd) return; // popup her açıldığında yeniden yüklenmesin
  globalThis.__mukellefKasasiIvd = true;
  if (location.origin !== "https://intvrg.gib.gov.tr") return;

  const DISPATCH = "https://intvrg.gib.gov.tr/intvrg_server/dispatch";
  const GORUNTULEME = "https://intvrg.gib.gov.tr/intvrg_server/goruntuleme";
  const IZINLI_SAYFALAR = [chrome.runtime.getURL("popup.html"), chrome.runtime.getURL("beyanname.html")];
  const ZAMAN_ASIMI = 30000;

  // IVD'nin kendi istek numarasına benzer: rastgele önek + sıra.
  const onek = [...crypto.getRandomValues(new Uint8Array(7))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 13);
  let sira = 0;

  function token() {
    const t = new URLSearchParams(location.search).get("token") || "";
    return /^[0-9a-f]{32,256}$/i.test(t) ? t : "";
  }

  // Sayfada geçen VKN/TCKN adayları (kontrol hanesi tutanlar). Önce görünen metin, sonra sayfa kaynağı
  // (gömülü betikler, gizli alanlar) taranır; aynı kökenli çerçeveler de dahil.
  function kimlikAdaylari() {
    const gorunen = [], kaynak = [];
    const tara = (doc) => {
      try {
        if (doc?.body) gorunen.push(doc.body.innerText || "");
        if (doc?.documentElement) kaynak.push(doc.documentElement.outerHTML || "");
        for (const f of doc.querySelectorAll("iframe, frame")) tara(f.contentDocument);
      } catch { /* başka kökenli çerçeve */ }
    };
    tara(document);
    const bul = (metin) => {
      const sayac = new Map();
      // Harf/rakam bitişiğindeki sayılar alınmaz (ör. token içindeki rakam dizileri).
      for (const m of metin.replace(/token=[0-9a-f]+/gi, "").matchAll(/(?<![0-9A-Za-z])(\d{10,11})(?![0-9A-Za-z])/g)) {
        const v = m[1];
        if (vknGecerli(v) || tcknGecerli(v)) sayac.set(v, (sayac.get(v) || 0) + 1);
      }
      return [...sayac.entries()].sort((x, y) => y[1] - x[1]).map(([v]) => v);
    };
    const g = bul(gorunen.join("\n"));
    return g.length ? g : bul(kaynak.join("\n"));
  }

  // VKN'nin geçtiği kısa bir öğede unvan da yazıyorsa onu alır; bulamazsa boş döner.
  function unvanBul(vkn) {
    if (!vkn) return "";
    const yuruyucu = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = yuruyucu.nextNode())) {
      if (!n.nodeValue.includes(vkn)) continue;
      const metin = (n.parentElement?.innerText || "").replace(/\s+/g, " ").trim();
      if (metin.length > 160) continue;
      const u = metin.replace(vkn, "").replace(/\b(VKN|TCKN|T\.?C\.?\s*Kimlik\s*No|Vergi\s*Kimlik\s*No)\b\s*:?/gi, "")
        .replace(/^[\s\-|·:,()]+|[\s\-|·:,()]+$/g, "");
      if (u.length >= 3 && /\p{L}/u.test(u)) return u.slice(0, 120);
    }
    return "";
  }

  function oturumHatasiMi(metin) {
    return /oturum|session|token|yetki|giri[sş]\s*yap|zaman a[sş]/i.test(metin || "");
  }

  // IVD'nin kendi arayüzünün kullandığı istek biçimi: form gövdesinde cmd, callid, token, jp (JSON).
  // Yalnızca üç okuma komutu çağrılır: oturum bilgisi, kimlik bilgileri, beyanname sorgusu.
  async function dispatch(cmd, jp) {
    const t = token();
    if (!t) return { ok: false, hata: "oturum" };
    const govde = new URLSearchParams({ cmd, callid: `${onek}-${++sira}`, token: t, jp: JSON.stringify(jp) });
    let r;
    try {
      r = await fetch(DISPATCH, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "application/json, text/javascript, */*; q=0.01" },
        body: govde,
        signal: AbortSignal.timeout(ZAMAN_ASIMI)
      });
    } catch (e) {
      return { ok: false, hata: "ag", mesaj: String(e?.message || e) };
    }
    const metin = await r.text();
    let json = null;
    try { json = JSON.parse(metin); } catch { /* JSON değil */ }
    if (!r.ok || !json) return { ok: false, hata: oturumHatasiMi(metin) ? "oturum" : "sunucu", mesaj: `HTTP ${r.status}` };
    if (json.data && typeof json.data === "object" && !json.error) return { ok: true, data: json.data };
    // Hata yanıtının yapısı kesin bilinmiyor: içindeki tüm metinleri toplayıp gösteriyoruz.
    const metinler = [];
    const topla = (x) => {
      if (typeof x === "string" && x.trim() && isNaN(Number(x))) metinler.push(x.trim());
      else if (x && typeof x === "object") Object.values(x).forEach(topla);
    };
    topla(json);
    const mesaj = (metinler.join(" · ") || JSON.stringify(json)).slice(0, 300);
    return { ok: false, hata: oturumHatasiMi(mesaj) ? "oturum" : "sunucu", mesaj };
  }

  async function beyannameSorgula(vkn, bas, bit) {
    if (!/^\d{10,11}$/.test(vkn)) return { ok: false, hata: "vkn" };
    const ay = (x) => String(x.ay).padStart(2, "0");
    const c = await dispatch("beyannameIslemleri_beyannameSorgulaSorgu",
      { vkn: { vkn }, basDonem: { ay: ay(bas), yil: String(bas.yil) }, bitDonem: { ay: ay(bit), yil: String(bit.yil) } });
    if (!c.ok) return c;
    let liste = c.data.beyanname?.beyanname ?? [];
    if (!Array.isArray(liste)) liste = [liste]; // tek kayıtta dizi yerine nesne gelebilir
    return {
      ok: true,
      kayitlar: liste.map((k) => ({
        kaynak: String(k.kaynak ?? ""), aciklama: String(k.aciklama ?? ""),
        beyanname_turu: String(k.beyanname_turu ?? ""), beyoid: String(k.beyoid ?? ""), donem: String(k.donem ?? "")
      }))
    };
  }

  // Kimlik bilgileri sorgusu (IVD > Kimlik Bilgileri). Yanıtta adres, telefon vb. de var;
  // buradan yalnızca VKN/TCKN ve unvan alınır, gerisi bu betikten çıkmaz.
  async function kimlikSorgula(vkn) {
    const c = await dispatch("kimlikBilgileriIslemleri_kimlikBilgileriSorgula", { vkn });
    if (!c.ok) return c;
    const v = String(c.data.vkn || c.data.tckn || "").trim();
    if (!vknGecerli(v) && !tcknGecerli(v)) return { ok: false, hata: "bulunamadi" };
    return { ok: true, vkn: v, unvan: String(c.data.adsoyadunvan || "").replace(/\s+/g, " ").trim().slice(0, 160) };
  }

  // IVD'nin açılışta kendisinin yaptığı oturum bilgisi sorgusu. Yanıtta e-posta, IP vb. de var;
  // buradan yalnızca VKN/TCKN ve unvan alınır, gerisi bu betikten çıkmaz.
  async function oturumBilgisi() {
    const c = await dispatch("userSessionService_getUserSessionInfo", { token: token(), rfDataInfo: [] });
    if (!c.ok) return c;
    const d = c.data;
    const v = [d.GMSIVERGINO, d.KVKN, d.GMSITCKIMLIKNO, d.KTCKN].map((x) => String(x || "").trim())
      .find((x) => vknGecerli(x) || tcknGecerli(x));
    if (!v) return { ok: false, hata: "bulunamadi" };
    const ad = [d.KUNVAN, d.GMSIKUNVAN, d.ad, [d.GMSIAD, d.KSOYAD].filter(Boolean).join(" ")]
      .map((x) => String(x || "").replace(/\s+/g, " ").trim()).find(Boolean) || "";
    return { ok: true, vkn: v, unvan: ad.slice(0, 160) };
  }

  // Oturumun kime ait olduğunu bulur. Her çağrıda oturum bilgisi sorgulanır; böylece oturumun
  // hâlâ geçerli olduğu da anlaşılır. Sonuç yalnızca bu betiğin belleğinde tutulur.
  let kimlik = null;
  async function kimlikBul() {
    // 1) Oturum bilgisi (IVD'nin kendi açılış sorgusu)
    const o = await oturumBilgisi();
    if (o.ok) return (kimlik = { vkn: o.vkn, unvan: o.unvan });
    if (o.hata === "oturum") return { hata: "oturum" };
    if (kimlik) return kimlik; // daha önce bulunduysa ya da kullanıcı yazdıysa
    // 2) Sayfada tek VKN adayı varsa: kimlik bilgileri sorgusuyla doğrula, unvanı al.
    const adaylar = kimlikAdaylari();
    if (adaylar.length === 1) {
      const k = await kimlikSorgula(adaylar[0]);
      if (k.ok) return (kimlik = { vkn: k.vkn, unvan: k.unvan });
      if (k.hata === "oturum") return { hata: "oturum" };
      return { vkn: adaylar[0], unvan: unvanBul(adaylar[0]) };
    }
    // 3) VKN'siz kimlik bilgileri sorgusu; olmazsa kullanıcı yazar.
    const k = await kimlikSorgula("");
    if (k.ok) return (kimlik = { vkn: k.vkn, unvan: k.unvan });
    if (k.hata === "oturum") return { hata: "oturum" };
    return { vkn: "", unvan: "", adaylar };
  }

  // PDF'i alır; mesajla taşınabilmesi için base64 döner.
  async function pdfAl(beyoid) {
    const t = token();
    if (!t) return { ok: false, hata: "oturum" };
    if (typeof beyoid !== "string" || !beyoid || beyoid.length > 64) return { ok: false, hata: "istek" };
    // beyoid'de %, &, ½, Türkçe harf olabiliyor; IVD'nin kendi arayüzü gibi encodeURIComponent (UTF-8).
    const url = `${GORUNTULEME}?cmd=IMAJ&subcmd=BEYANNAMEGORUNTULE&beyannameOid=${encodeURIComponent(beyoid)}` +
      `&USERID=&inline=true&goruntuTip=1&token=${encodeURIComponent(t)}`;
    let r;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(ZAMAN_ASIMI) });
    } catch (e) {
      return { ok: false, hata: "ag", mesaj: String(e?.message || e) };
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    const bas = String.fromCharCode(...buf.subarray(0, 5));
    if (!r.ok || bas !== "%PDF-") {
      const metin = new TextDecoder().decode(buf.subarray(0, 4000));
      return { ok: false, hata: oturumHatasiMi(metin) ? "oturum" : "pdf-degil", mesaj: `HTTP ${r.status}` };
    }
    let ikili = "";
    for (let i = 0; i < buf.length; i += 0x8000) ikili += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { ok: true, base64: btoa(ikili), boyut: buf.length };
  }

  chrome.runtime.onMessage.addListener((msg, sender, cevap) => {
    if (sender.id !== chrome.runtime.id) return;
    if (!IZINLI_SAYFALAR.some((u) => (sender.url || "").startsWith(u))) return;
    if (!msg || typeof msg !== "object") return;

    if (msg.tip === "durum") {
      if (!token()) { cevap({ ok: true, oturum: false }); return; }
      kimlikBul().then((k) => cevap(k.hata === "oturum"
        ? { ok: true, oturum: false }
        : { ok: true, oturum: true, vkn: k.vkn, unvan: k.unvan, adaylar: k.adaylar || [] }));
      return true;
    }
    if (msg.tip === "kimlik" && /^\d{10,11}$/.test(String(msg.vkn || ""))) {
      // Kullanıcının yazdığı VKN'yi doğrular, unvanı getirir.
      kimlikSorgula(String(msg.vkn)).then((k) => {
        if (k.ok) kimlik = { vkn: k.vkn, unvan: k.unvan };
        else if (k.hata !== "oturum") kimlik = { vkn: String(msg.vkn), unvan: "" }; // bir daha sorulmasın
        cevap(k);
      });
      return true;
    }
    if (msg.tip === "sorgu") {
      beyannameSorgula(String(msg.vkn || ""), msg.bas || {}, msg.bit || {}).then(cevap);
      return true;
    }
    if (msg.tip === "pdf") {
      pdfAl(msg.beyoid).then(cevap);
      return true;
    }
  });

  // --- VKN / TCKN kontrol haneleri (beyanname-kural.js ile aynı) ---
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
})();
