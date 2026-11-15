// Mükellef Kasası — şifreleme yardımcıları (yalnızca tarayıcının yerleşik Web Crypto API'si)
// Ana şifre → PBKDF2-SHA256 (600.000 tur) → AES-256-GCM anahtarı.
// Ana şifre hiçbir yerde saklanmaz; yalnızca şifreli kasa saklanır.

const KDF_ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(password, salt, iterations = KDF_ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    true, // oturum içinde kilitsiz tutabilmek için dışa aktarılabilir
    ["encrypt", "decrypt"]
  );
}

async function encryptJSON(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // her kayıtta yeni IV
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  return { iv: b64(iv), ct: b64(ct) };
}

async function decryptJSON(key, iv, ct) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(dec.decode(pt));
}

async function exportKey(key) { return b64(await crypto.subtle.exportKey("raw", key)); }
async function importKey(raw) {
  return crypto.subtle.importKey("raw", unb64(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}
