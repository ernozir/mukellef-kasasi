// Mükellef Kasası — giriş sayfası betiği
// Yalnızca https://dijital.gib.gov.tr/portal/login adresinde çalışır.
// Kullanıcı kodu ve şifreyi yazar, güvenlik kodu alanına odaklanır.
// "Giriş Yap" butonuna ASLA basmaz; güvenlik kodunu kullanıcı girer.

(() => {
  const SEL = { user: "#userid", pass: "#sifre", code: "#dk" };

  // React tabanlı formlarda değerin "görülmesi" için yerel setter + input olayı gerekir.
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function waitFor(selector, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  function toast(text) {
    const box = document.createElement("div");
    box.textContent = text;
    Object.assign(box.style, {
      position: "fixed", top: "18px", left: "50%", transform: "translateX(-50%)",
      zIndex: 2147483647, background: "#0f2a44", color: "#fff",
      padding: "12px 18px", borderRadius: "10px", font: "600 14px system-ui, sans-serif",
      boxShadow: "0 10px 30px rgba(0,0,0,.25)", borderLeft: "4px solid #2dd4bf"
    });
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 6000);
  }

  chrome.runtime.sendMessage({ type: "getCreds" }, async (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) return; // Bu sekme için bekleyen bilgi yok.
    const user = await waitFor(SEL.user);
    const pass = await waitFor(SEL.pass);
    if (!user || !pass) { toast("Mükellef Kasası: giriş alanları bulunamadı."); return; }
    setNativeValue(user, res.userid);
    setNativeValue(pass, res.sifre);
    const code = document.querySelector(SEL.code);
    if (code) code.focus();
    toast("Bilgiler dolduruldu — güvenlik kodunu girip Giriş Yap'a basın.");
  });
})();
