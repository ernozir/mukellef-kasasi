// Mükellef Kasası — Aktarım sayfası
// Excel/CSV'den toplu içe aktarma, şifreli yedek alma ve yedekten geri yükleme.
// Bu sayfa eklentinin kendi sayfasıdır (chrome-extension://…); internete hiçbir şey göndermez.

const $ = (id) => document.getElementById(id);
const TABS = ["excel", "yedek-al", "geri-yukle"];
const BACKUP_FORMAT = "mukellef-kasasi-yedek";

let hasVault = false;
let key = null;      // kasa anahtarı (kilit açıkken, yalnızca bellekte)
let entries = [];    // çözülmüş kayıtlar (yalnızca bellekte)

function toast(text) {
  const t = $("toast");
  t.textContent = text; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const fmtDate = (d) => new Date(d).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });

// ---------- Durum ve sekmeler ----------
function currentTab() {
  const t = location.hash.slice(1);
  return TABS.includes(t) ? t : "excel";
}

function render() {
  const tab = currentTab();
  document.querySelectorAll(".tab").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  const locked = hasVault && !key;
  const needVault = !hasVault && tab !== "geri-yukle";
  $("lockedCard").classList.toggle("hidden", !locked);
  $("noVaultCard").classList.toggle("hidden", !needVault);
  for (const t of TABS) $("pane-" + t).classList.toggle("hidden", t !== tab || locked || needVault);
  $("lockBtn").classList.toggle("hidden", !key);
  $("status").textContent = !hasVault ? "Bu bilgisayarda henüz kasa yok"
    : key ? `Kasa açık · ${entries.length} mükellef` : "Kasa kilitli";
  $("expCount").textContent = `${entries.length} mükellef`;
  $("restoreIntro").innerHTML = hasVault
    ? "Daha önce aldığınız <code>.mkasa</code> dosyasını seçin. Kasadaki kayıtlar silinmez; yedekteki mükellefler eklenir."
    : "Bu bilgisayarda henüz kasa yok. Yedeği açtığınızda kasa oluşturulur ve <b>yedeğin şifresi bu kasanın ana şifresi olur.</b>";
  if (locked) setTimeout(() => $("unlockPass").focus(), 30);
}
window.addEventListener("hashchange", render);

async function refresh() {
  hasVault = !!(await getVault());
  const s = hasVault ? await resumeSession() : null;
  if (s) ({ key, entries } = s);
  else { key = null; entries = []; }
  render();
}

// Kilitlenince ekrandaki tüm çözülmüş bilgiyi bellekten at.
function lockPage() {
  key = null; entries = [];
  xls.clear(); bak.clear();
  render();
}

$("lockBtn").addEventListener("click", async () => { await clearSession(); lockPage(); });

$("unlockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("unlockBtn");
  btn.disabled = true; btn.textContent = "Açılıyor…";
  try {
    ({ key, entries } = await unlockWithPassword($("unlockPass").value));
    $("unlockPass").value = ""; $("unlockErr").textContent = "";
    render();
  } catch (err) { $("unlockErr").textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = "Kilidi aç"; }
});

// Popup'tan kilitlenirse ya da kasa başka yerde değişirse bu sayfa da güncellensin.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "session" && changes.sessionKey && !changes.sessionKey.newValue && key) lockPage();
  // Kilit popup'tan açılırsa bu sayfa da kendiliğinden açılsın
  if (area === "session" && changes.sessionKey?.newValue && !changes.sessionKey.oldValue && !key) refresh();
  if (area === "local" && changes.vault) {
    hasVault = !!changes.vault.newValue;
    if (key && hasVault) { try { entries = await loadEntries(key); } catch (_) { lockPage(); } }
    render();
  }
});
// 10 dk işlem yapılmadıysa otomatik kilit (popup ile aynı kural)
setInterval(async () => {
  if (!key) return;
  const s = (await chrome.storage.session.get("sessionKey")).sessionKey;
  if (!s || Date.now() - s.lastActive >= AUTO_LOCK_MS) { await clearSession(); lockPage(); }
}, 20 * 1000);

// ---------- Dosya seçme alanı (tıkla ya da sürükle-bırak) ----------
function setupDrop(dropId, inputId, onFile) {
  const drop = $(dropId), input = $(inputId);
  input.addEventListener("change", () => { if (input.files[0]) onFile(input.files[0]); input.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
}

// ---------- Önizleme tablosu (Excel ve yedek için ortak) ----------
const STATUS = {
  new: ["Yeni", "c-new"], update: ["Güncellenecek", "c-update"],
  same: ["Aynı", "c-same"], error: ["Hatalı", "c-error"]
};

// opts: { title, fileName, rowLabel, plan, applyLabel(n, u), onApply(allowUpdate), onCancel, note }
function renderPreview(box, opts) {
  box.replaceChildren();
  const plan = opts.plan;
  const n = { new: 0, update: 0, same: 0, error: 0 };
  for (const r of plan) n[r.status]++;

  const card = el("div", "card preview");
  const h = el("h3");
  if (opts.step) h.append(el("span", "stepn", opts.step));
  h.append(opts.title + " ");
  if (opts.fileName) h.append(el("span", "fname", "· " + opts.fileName));
  card.append(h);

  const sum = el("div", "sum");
  if (n.new) sum.append(el("span", "chip c-new", `${n.new} yeni`));
  if (n.update) sum.append(el("span", "chip c-update", `${n.update} kasada var, bilgisi farklı`));
  if (n.same) sum.append(el("span", "chip c-same", `${n.same} kasada aynen var`));
  if (n.error) sum.append(el("span", "chip c-error", `${n.error} hatalı (aktarılmaz)`));
  const warned = plan.filter((r) => (r.status === "new" || r.status === "update") && r.warnings.length).length;
  if (warned) sum.append(el("span", "chip c-warn", `${warned} uyarılı (aktarılır, kontrol edin)`));
  card.append(sum);

  const wrap = el("div", "tbl");
  const t = el("table");
  const hr = el("tr");
  for (const c of [opts.rowLabel, "Durum", "Unvan / Ad Soyad", "VKN / TCKN", "Kullanıcı kodu", "Şifre", "Not", "Açıklama"]) hr.append(el("th", "", c));
  t.append(hr);
  for (const r of plan) {
    const tr = el("tr", r.status);
    tr.append(el("td", "", r.n));
    const st = el("td"); st.append(el("span", "chip " + STATUS[r.status][1], STATUS[r.status][0])); tr.append(st);
    tr.append(el("td", "nm", r.item.name), el("td", "mono", r.item.vkn), el("td", "mono", maskUser(r.item.userid)),
      el("td", "mono", r.item.sifre ? "••••••" : ""), el("td", "", r.item.note));
    const why = el("td", "why");
    for (const x of r.errors) why.append(el("span", "e", x));
    if (r.status === "update") why.append(el("span", "w", `Kasada var · farklı: ${r.diff.join(", ")}`));
    if (r.status === "same") why.append(el("span", "", "Kasada aynen var, atlanacak"));
    for (const x of r.warnings) why.append(el("span", "w", x));
    tr.append(why);
    t.append(tr);
  }
  wrap.append(t);
  card.append(wrap);

  const actions = el("div", "actions");
  const chk = el("label", "chk" + (n.update ? "" : " hidden"));
  const cb = el("input"); cb.type = "checkbox"; cb.disabled = !n.update;
  chk.append(cb, `Kasada olanların bilgisini dosyadakiyle güncelle (${n.update} kayıt)`);
  const btns = el("div", "btns");
  const cancel = el("button", "btn ghost", "Vazgeç"); cancel.type = "button";
  const apply = el("button", "btn primary"); apply.type = "button";
  const updateLabel = () => {
    const u = cb.checked ? n.update : 0;
    apply.disabled = n.new + u === 0;
    apply.textContent = apply.disabled ? "Eklenecek kayıt yok" : opts.applyLabel(n.new, u);
  };
  cb.addEventListener("change", updateLabel);
  updateLabel();
  cancel.addEventListener("click", opts.onCancel);
  apply.addEventListener("click", async () => {
    apply.disabled = true; cancel.disabled = true;
    try { await opts.onApply(cb.checked); }
    catch (err) { toast(err.message || "İşlem tamamlanamadı"); apply.disabled = false; cancel.disabled = false; }
  });
  btns.append(cancel, apply);
  actions.append(chk, btns);
  card.append(actions);

  if (opts.note) {
    const a = el("div", "alert");
    a.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3 2 21h20L12 3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v5M12 18v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const d = el("div"); d.innerHTML = opts.note; a.append(d);
    card.append(a);
  }
  box.append(card);
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDone(box, html) {
  box.replaceChildren();
  const d = el("div", "done"); d.innerHTML = html;
  box.append(d);
}

// Kaydetmeden hemen önce kasanın EN GÜNCEL hâlini okuyup birleştir
// (bu arada popup'tan kayıt eklenmiş olabilir).
async function mergeIntoVault(records, allowUpdate) {
  const latest = await loadEntries(key);
  const plan = planMerge(latest, records);
  const res = applyMerge(latest, plan, allowUpdate);
  await saveEntries(key, res.entries);
  entries = res.entries;
  render();
  return { ...res, skipped: plan.length - res.added - res.updated };
}

// ---------- 1) Excel / CSV ----------
const xls = {
  records: null, fileName: "",
  clear() {
    this.records = null; this.fileName = "";
    $("xlsPreview").replaceChildren(); $("xlsErr").textContent = "";
    $("xlsName").textContent = "Dosya seçmek için tıklayın ya da buraya sürükleyin";
    $("xlsInfo").textContent = "Excel'de \"Mükellefler\" sayfası varsa o, yoksa ilk sayfa okunur";
    $("xlsIcon").textContent = "XLSX"; $("xlsIcon").className = "fi";
  }
};

setupDrop("xlsDrop", "xlsFile", async (file) => {
  xls.clear();
  $("xlsName").textContent = file.name;
  const isCsv = !/\.xlsx$/i.test(file.name);
  $("xlsIcon").textContent = isCsv ? "CSV" : "XLSX"; $("xlsIcon").className = "fi" + (isCsv ? " csv" : "");
  try {
    const sheet = await readSpreadsheet(file);
    const { headerIdx, map, missing } = mapColumns(sheet.rows);
    if (headerIdx < 0 || missing.length) {
      throw new Error(`Şu sütun${missing.length > 1 ? "lar" : ""} bulunamadı: ${missing.join(", ")}. Başlık satırını şablondaki gibi yazın.`);
    }
    const records = rowsToRecords(sheet.rows, headerIdx, map);
    if (!records.length) throw new Error("Başlık satırının altında kayıt bulunamadı.");
    xls.records = records; xls.fileName = file.name;
    $("xlsInfo").textContent = `Sayfa: ${sheet.sheetName} · ${records.length} satır okundu · dosya bilgisayardan çıkmadı`;
    showXlsPreview();
  } catch (err) {
    $("xlsErr").textContent = err.message;
    $("xlsInfo").textContent = "Okunamadı";
  }
});

function showXlsPreview() {
  renderPreview($("xlsPreview"), {
    step: "3", title: "Önizleme ve kontrol", fileName: xls.fileName, rowLabel: "Excel satırı",
    plan: planMerge(entries, xls.records),
    applyLabel: (a, u) => (u ? `${a} ekle, ${u} güncelle` : `${a} mükellefi kasaya ekle`),
    onCancel: () => xls.clear(),
    onApply: async (allowUpdate) => {
      const r = await mergeIntoVault(xls.records, allowUpdate);
      const name = xls.fileName;
      xls.clear();
      renderDone($("xlsPreview"),
        `✓ <b>${r.added}</b> mükellef eklendi${r.updated ? `, <b>${r.updated}</b> güncellendi` : ""}${r.skipped ? `, ${r.skipped} satır atlandı` : ""}.<br>` +
        `Artık <b>${escapeHtml(name)}</b> dosyasını silebilirsiniz: içindeki şifreler açık metindir, kayıtlar kasada şifreli olarak duruyor.`);
      toast("Aktarım tamamlandı");
    },
    note: "<b>Aktarım bitince Excel dosyasını silebilirsiniz.</b> Dosyadaki şifreler açık metindir; kasaya alındıktan sonra o dosyaya ihtiyacınız yok."
  });
}

function escapeHtml(s) { const d = el("div"); d.textContent = s; return d.innerHTML; }

// ---------- 2) Şifreli yedek al ----------
// Yedek dosyasının başlığı şifrelenmez ama AES-GCM'e "ek doğrulanan veri" olarak verilir:
// biri dosyadaki tarihi, kayıt sayısını ya da ayarları değiştirirse çözme başarısız olur.
function backupAad(h) {
  return JSON.stringify([h.format, h.v, h.createdAt, h.count, h.kdf.name, h.kdf.salt, h.kdf.iter, h.cipher]);
}

document.querySelectorAll('input[name="expMode"]').forEach((r) => r.addEventListener("change", () => {
  const sep = document.querySelector('input[name="expMode"]:checked').value === "separate";
  $("expSeparate").classList.toggle("hidden", !sep);
  $("expPass1").required = $("expPass2").required = sep;
}));

$("exportForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sep = document.querySelector('input[name="expMode"]:checked').value === "separate";
  const master = $("expMaster").value, p1 = $("expPass1").value, p2 = $("expPass2").value;
  $("expErr").textContent = ""; $("expDone").classList.add("hidden");
  if (sep && p1.length < MIN_MASTER_LEN) return ($("expErr").textContent = "Yedek şifresi en az 8 karakter olmalı.");
  if (sep && p1 !== p2) return ($("expErr").textContent = "Yedek şifreleri aynı değil.");
  const btn = $("expBtn");
  btn.disabled = true; btn.textContent = "Şifreleniyor…";
  try {
    // Ana şifreyi yeniden sor: kilit açık bırakılmış bir bilgisayarda başkası tüm kasayı dışarı alamasın.
    const opened = await unlockWithPassword(master);
    ({ key, entries } = opened);
    if (!entries.length) throw new Error("Kasada yedeklenecek mükellef yok.");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const fileKey = await deriveKey(sep ? p1 : master, salt, KDF_ITERATIONS);
    const header = {
      format: BACKUP_FORMAT, v: 1, createdAt: new Date().toISOString(), count: entries.length,
      kdf: { name: "PBKDF2-SHA256", salt: b64(salt), iter: KDF_ITERATIONS }, cipher: "AES-256-GCM"
    };
    const { iv, ct } = await encryptJSON(fileKey, { entries }, backupAad(header));
    const d = new Date(), p2 = (x) => String(x).padStart(2, "0"); // dosya adı yerel tarihle
    const name = `mukellef-kasasi-yedek-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.mkasa`;
    download(name, JSON.stringify({ ...header, iv, ct }, null, 2));
    $("expMaster").value = $("expPass1").value = $("expPass2").value = "";
    $("expDone").innerHTML = `✓ <b>${entries.length}</b> mükellef <b>${escapeHtml(name)}</b> dosyasına şifreli olarak yazıldı (İndirilenler klasörü).<br>` +
      `Diğer bilgisayarda: Mükellef Kasası → Aktarım → <b>Yedekten geri yükle</b>. Açmak için ${sep ? "belirlediğiniz yedek şifresi" : "ana şifreniz"} gerekir.`;
    $("expDone").classList.remove("hidden");
    render();
  } catch (err) {
    $("expErr").textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = "⬇ Yedeği indir";
  }
});

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const a = el("a"); a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- 3) Yedekten geri yükle ----------
const bak = {
  file: null, records: null, password: "", fileName: "",
  clear() {
    this.file = this.records = null; this.password = ""; this.fileName = "";
    $("bakPreview").replaceChildren(); $("bakErr").textContent = "";
    $("restoreForm").classList.add("hidden"); $("bakPass").value = "";
    $("bakName").textContent = "Yedek dosyasını seçin ya da buraya sürükleyin";
    $("bakInfo").textContent = ".mkasa";
  }
};

function parseBackup(text) {
  let f;
  try { f = JSON.parse(text); } catch (_) { throw new Error("Bu bir Mükellef Kasası yedek dosyası değil."); }
  const ok = f && f.format === BACKUP_FORMAT && f.kdf && f.kdf.name === "PBKDF2-SHA256" && f.cipher === "AES-256-GCM" &&
    typeof f.iv === "string" && typeof f.ct === "string" && typeof f.kdf.salt === "string" &&
    Number.isInteger(f.kdf.iter) && f.kdf.iter >= 100000 && f.kdf.iter <= 5000000;
  if (!ok) throw new Error("Bu bir Mükellef Kasası yedek dosyası değil.");
  if (f.v !== 1) throw new Error("Bu yedek, eklentinin daha yeni bir sürümüyle alınmış. Önce eklentiyi güncelleyin.");
  return f;
}

setupDrop("bakDrop", "bakFile", async (file) => {
  bak.clear();
  $("bakName").textContent = file.name;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("Dosya beklenenden çok büyük.");
    bak.file = parseBackup(await file.text());
    bak.fileName = file.name;
    $("bakInfo").textContent = `${bak.file.count} kayıt · ${fmtDate(bak.file.createdAt)} tarihli · şifreli`;
    $("restoreForm").classList.remove("hidden");
    $("bakPass").focus();
  } catch (err) {
    $("bakErr").textContent = err.message;
    $("bakInfo").textContent = "Okunamadı";
  }
});

$("restoreForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("bakBtn"), pw = $("bakPass").value;
  $("bakErr").textContent = "";
  btn.disabled = true; btn.textContent = "Çözülüyor…";
  try {
    const f = bak.file;
    let payload;
    try {
      const k = await deriveKey(pw, unb64(f.kdf.salt), f.kdf.iter);
      payload = await decryptJSON(k, f.iv, f.ct, backupAad(f));
    } catch (_) { throw new Error("Şifre hatalı ya da dosya değiştirilmiş."); }
    if (!payload || !Array.isArray(payload.entries)) throw new Error("Yedeğin içeriği okunamadı.");
    bak.records = payload.entries.map((x, i) => ({ n: i + 1, raw: x && typeof x === "object" ? x : {} }));
    bak.password = pw;
    $("bakPass").value = "";
    $("restoreForm").classList.add("hidden");
    showBakPreview();
  } catch (err) {
    $("bakErr").textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = "Dosyayı çöz ve önizle";
  }
});

function showBakPreview() {
  const fresh = !hasVault;
  renderPreview($("bakPreview"), {
    title: "Yedeğin içeriği", fileName: bak.fileName, rowLabel: "Kayıt",
    plan: planMerge(fresh ? [] : entries, bak.records),
    applyLabel: (a, u) => fresh ? `Kasayı oluştur ve ${a} mükellefi yükle`
      : u ? `${a} ekle, ${u} güncelle` : `${a} mükellefi kasaya ekle`,
    onCancel: () => bak.clear(),
    onApply: async (allowUpdate) => {
      let r;
      if (fresh) {
        // Yeni bilgisayar: kasa yedeğin şifresiyle oluşturulur.
        if (await getVault()) throw new Error("Bu arada bir kasa oluşturulmuş; sayfayı yenileyip tekrar deneyin.");
        if (bak.password.length < MIN_MASTER_LEN) throw new Error("Ana şifre olacak yedek şifresi en az 8 karakter olmalı.");
        const res = applyMerge([], planMerge([], bak.records), false);
        key = await createVault(bak.password, res.entries);
        hasVault = true; entries = res.entries;
        r = { added: res.added, updated: 0, skipped: bak.records.length - res.added };
      } else {
        r = await mergeIntoVault(bak.records, allowUpdate);
      }
      bak.clear();
      render();
      renderDone($("bakPreview"),
        `✓ <b>${r.added}</b> mükellef eklendi${r.updated ? `, <b>${r.updated}</b> güncellendi` : ""}${r.skipped ? `, ${r.skipped} kayıt atlandı` : ""}.` +
        (fresh ? "<br>Kasa oluşturuldu. <b>Ana şifreniz, yedeğin şifresidir.</b> Eklenti simgesine tıklayarak kullanmaya başlayabilirsiniz." : ""));
      toast("Geri yükleme tamamlandı");
    },
    note: fresh ? "<b>Kasa bu yedeğin şifresiyle oluşturulacak.</b> Bu bilgisayarda ana şifreniz, yedeği açarken yazdığınız şifre olur." : ""
  });
}

// Sayfa kapanırken bellekteki çözülmüş bilgiyi bırak
window.addEventListener("pagehide", () => { key = null; entries = []; bak.password = ""; });

refresh();
