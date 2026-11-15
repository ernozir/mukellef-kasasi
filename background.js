// Mükellef Kasası — arka plan servisi
// Görevi: "Bağlan" denince giriş sayfasını yeni sekmede açmak ve o sekmeye ait
// giriş bilgisini yalnızca bir kez, kısa süreliğine içerik betiğine teslim etmek.

const LOGIN_URL = "https://dijital.gib.gov.tr/portal/login";
const PENDING_TTL_MS = 60 * 1000; // Bilgiler en fazla 60 sn bekler, sonra silinir.

// Oturum depolaması yalnızca bellekte tutulur ve tarayıcı kapanınca silinir.
// İçerik betikleri (web sayfası tarafı) bu alana doğrudan erişemez.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 1) Popup'tan gelen "Bağlan" isteği
  if (msg && msg.type === "connect" && sender.id === chrome.runtime.id &&
      typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL("popup.html"))) {
    (async () => {
      const tab = await chrome.tabs.create({ url: LOGIN_URL, active: true });
      await chrome.storage.session.set({
        ["pending_" + tab.id]: {
          userid: String(msg.userid || ""),
          sifre: String(msg.sifre || ""),
          createdAt: Date.now()
        }
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  // 2) Giriş sayfasındaki içerik betiğinin bilgi talebi
  if (msg && msg.type === "getCreds" && sender.tab && sender.tab.id != null) {
    (async () => {
      const okOrigin = typeof sender.url === "string" &&
        sender.url.startsWith("https://dijital.gib.gov.tr/portal/login");
      const key = "pending_" + sender.tab.id;
      const data = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.remove(key); // tek kullanımlık
      if (!okOrigin || !data || Date.now() - data.createdAt > PENDING_TTL_MS) {
        sendResponse({ ok: false });
        return;
      }
      sendResponse({ ok: true, userid: data.userid, sifre: data.sifre });
    })();
    return true;
  }
});

// Sekme kapanırsa bekleyen bilgi de silinsin.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove("pending_" + tabId);
});
