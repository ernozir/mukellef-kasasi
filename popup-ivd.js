// Mükellef Kasası — popup: İnternet Vergi Dairesi ekranı
// Simgeye IVD sekmesindeyken basıldıysa popup kasa yerine IVD işlemlerini gösterir.
// ivd.js bu sekmeye ancak popup ya da beyanname sayfası açıldığında yüklenir; sayfaya kendiliğinden
// çalışan bir betik konmaz (manifest'te intvrg için content_scripts yok).

const IVD_ADRES = "https://intvrg.gib.gov.tr/intvrg_side/";

async function ivdSekmesi() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && typeof tab.url === "string" && tab.url.startsWith(IVD_ADRES) ? tab : null;
}

function ivdKimlikHarfleri(unvan) {
  const h = unvan.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toLocaleUpperCase("tr")).join("");
  return h || "IVD";
}

function ivdOturumYok(baslik, aciklama) {
  $("ivdAv").textContent = "!";
  $("ivdAv").classList.add("uyari");
  $("ivdAd").textContent = "IVD oturumu bulunamadı";
  $("ivdDot").className = "dot off";
  $("ivdAlt").textContent = "Bu sekmedeki oturum kullanılamıyor";
  const u = $("ivdUyari");
  u.replaceChildren();
  const b = document.createElement("b"); b.textContent = baslik;
  u.append(b, aciklama);
  u.classList.remove("hidden");
  $("ivdBeyanname").disabled = true;
  $("ivdBeyAlt").textContent = "Oturum açılınca kullanılabilir";
}

// IVD sekmesindeyse ekranı gösterir ve true döner; değilse false (kasa ekranı açılır).
async function ivdEkrani() {
  const tab = await ivdSekmesi();
  if (!tab) return false;
  show("viewIvd");
  let acikSayfa = null; // bu sekmeye bağlanan, zaten açık beyanname sayfası
  $("ivdBeyanname").onclick = async () => {
    if (acikSayfa?.sayfa != null) {
      await chrome.tabs.update(acikSayfa.sayfa, { active: true });
      if (acikSayfa.pencere != null) await chrome.windows.update(acikSayfa.pencere, { focused: true });
    } else {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`beyanname.html?sekme=${tab.id}`) });
    }
    window.close();
  };

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["ivd.js"] });
  } catch {
    ivdOturumYok("Sayfaya erişilemedi.", "Sekmeyi yenileyip eklenti simgesine yeniden basın.");
    return true;
  }
  // durum: oturum var mı, kime ait (kimlik bilgileri sorgusu). Oturum düşmüşse burada anlaşılır.
  const durum = await chrome.tabs.sendMessage(tab.id, { tip: "durum" }).catch(() => null);
  if (!durum?.ok || !durum.oturum) {
    ivdOturumYok("Oturum süresi dolmuş ya da başka yerden yeni bir IVD oturumu açılmış.",
      "Dijital Vergi Dairesi'nde İnternet Vergi Dairesi kartına yeniden tıklayın; açılan sekmede eklenti simgesine basın.");
    return true;
  }

  // Bağlantısı kopmuş bir beyanname sayfası açıksa bu sekmeye bağlansın; kaldığı yerden devam eder.
  acikSayfa = await chrome.runtime.sendMessage({ tip: "ivdHazir", sekme: tab.id }).catch(() => null);
  if (!acikSayfa?.kabul) acikSayfa = null;

  const vkn = durum.vkn || "";
  $("ivdAv").textContent = ivdKimlikHarfleri(durum.unvan || "");
  $("ivdAd").textContent = durum.unvan || "İnternet Vergi Dairesi";
  $("ivdDot").className = "dot on";
  $("ivdAlt").textContent = vkn
    ? `${vkn.length === 11 ? "TCKN" : "VKN"} ${vkn} · bu sekmede açık`
    : "Bu sekmede açık · VKN'yi beyanname sayfasında yazabilirsiniz";
  if (acikSayfa) $("ivdBeyAlt").textContent = "Açık beyanname sayfası bu sekmeye bağlandı";
  return true;
}
