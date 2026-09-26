"use strict";
/* Vitalis Health Board — auth (user/admin) + per-user health data, localStorage persistence */

const $ = (id) => document.getElementById(id);
const LS_THEME = "phm_theme_v1";
const LS_LEGACY_PATIENT = "phm_patient_v1";
const LS_LEGACY_RECORDS = "phm_records_v1";
const LS_USERS = "vitalis_users_v1";
const LS_SESSION = "vitalis_session_v1";
const ADMIN_CODE = "VITALIS-ADMIN";

const patientFields = ["patientId", "fullName", "age", "sex", "dob", "contact", "address"];

/* ---------- state ---------- */
let editingPatient = false;
let patient = {};
let records = [];
let session = null; // { email, name, role }

/* ---------- storage helpers ---------- */
function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
  catch { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
function drop(key) { localStorage.removeItem(key); }
const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : null; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* per-user data keys — health data is isolated per login */
const emailKey = (email) => String(email || "").trim().toLowerCase();
const patientKey = () => `vitalis_patient_${emailKey(session?.email)}`;
const recordsKey = () => `vitalis_records_${emailKey(session?.email)}`;

/* ---------- password hashing (demo-grade, local only) ---------- */
async function hashPassword(pw) {
  try {
    if (crypto?.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("vitalis$" + pw));
      return "s256$" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch { /* fall through to local hash */ }
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57; // cyrb53 fallback (non-secure contexts)
  const s = "vitalis$" + pw;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return "c53$" + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/* ---------- users + session ---------- */
const getUsers = () => load(LS_USERS, []);
const saveUsers = (u) => save(LS_USERS, u);
const getSession = () => load(LS_SESSION, null);
const isAdmin = () => session?.role === "admin";

async function seedDemoAccounts() {
  const users = getUsers();
  if (users.length) return;
  saveUsers([
    { name: "Demo User", email: "user@vitalis.app", pass: await hashPassword("User123!"), role: "user", createdAt: Date.now() },
    { name: "Demo Admin", email: "admin@vitalis.app", pass: await hashPassword("Admin123!"), role: "admin", createdAt: Date.now() },
  ]);
}

function loadUserData() {
  patient = load(patientKey(), {});
  records = load(recordsKey(), []);
  // one-time migration of pre-auth global data into this account
  const legacyP = load(LS_LEGACY_PATIENT, null);
  const legacyR = load(LS_LEGACY_RECORDS, null);
  if ((legacyP && Object.keys(legacyP).length && !Object.keys(patient).length) ||
      (Array.isArray(legacyR) && legacyR.length && !records.length)) {
    if (!Object.keys(patient).length && legacyP) patient = legacyP;
    if (!records.length && Array.isArray(legacyR)) records = legacyR;
    save(patientKey(), patient); save(recordsKey(), records);
  }
}

function enterApp(s) {
  session = s;
  save(LS_SESSION, s);
  loadUserData();
  $("authOverlay").classList.add("hidden");
  document.body.classList.remove("locked");
  fillPatientForm();
  setPatientEditing(false);
  renderAll();
  renderAuthState();
}

function exitApp() {
  session = null;
  drop(LS_SESSION);
  patient = {}; records = []; editingPatient = false;
  renderAuthState();
  $("authOverlay").classList.remove("hidden");
  document.body.classList.add("locked");
}

function renderAuthState() {
  const logged = !!session;
  const admin = isAdmin();
  for (const id of ["userChip", "sideUser"]) $(id)?.classList.toggle("hidden", !logged);
  if (logged) {
    const initials = (session.name || session.email).split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    $("userAvatar").textContent = initials; $("sideUserAvatar").textContent = initials;
    $("userName").textContent = session.name || session.email;
    $("sideUserName").textContent = session.name || session.email;
    const roleBadge = $("userRole");
    roleBadge.textContent = admin ? "Admin" : "User";
    roleBadge.className = "badge " + (admin ? "warn" : "ok");
    $("sideUserRole").textContent = admin ? "Administrator" : "Standard user";
  }
  $("adminNavBtn")?.classList.toggle("hidden", !admin);
  $("section-admin")?.classList.toggle("hidden", !admin);
  if (admin) renderAdmin();
  // collapse mobile menu on auth change
  document.querySelector(".sidebar")?.classList.remove("open");
  $("menuToggle")?.setAttribute("aria-expanded", "false");
}

/* ---------- BMI ---------- */
function calcBMI(weightKg, heightCm) {
  if (!weightKg || !heightCm || weightKg <= 0 || heightCm <= 0) return null;
  const m = heightCm / 100;
  return weightKg / (m * m);
}
function bmiCategory(bmi) {
  if (bmi == null) return { label: "—", level: "" };
  if (bmi < 18.5) return { label: "Underweight", level: "warn" };
  if (bmi < 25) return { label: "Normal", level: "ok" };
  if (bmi < 30) return { label: "Overweight", level: "warn" };
  return { label: "Obese", level: "bad" };
}
function updateBmiPreview() {
  const bmi = calcBMI(num("weight"), num("height"));
  const cat = bmiCategory(bmi);
  $("bmiValue").textContent = bmi == null ? "—" : bmi.toFixed(2);
  const badge = $("bmiCategory");
  badge.textContent = cat.label;
  badge.className = "badge" + (cat.level ? " " + cat.level : "");
  positionBmiMarker(bmi);
}
function positionBmiMarker(bmi) {
  const m = $("bmiMarker");
  if (!m) return;
  if (bmi == null || !Number.isFinite(bmi)) { m.style.left = "0%"; m.style.opacity = "0"; return; }
  m.style.opacity = "1";
  const min = 14, max = 40;
  const pct = Math.min(100, Math.max(0, ((bmi - min) / (max - min)) * 100));
  m.style.left = pct + "%";
}

/* ---------- evaluators ---------- */
function evalHR(hr) {
  if (hr == null) return null;
  if (hr < 50 || hr > 120) return { label: hr < 50 ? "Critically low" : "Critically high", level: "bad" };
  if (hr < 60 || hr > 100) return { label: "Abnormal", level: "warn" };
  return { label: "Normal", level: "ok" };
}
function evalBP(sys, dia) {
  if (sys == null || dia == null) return null;
  if (sys > 180 || dia > 120) return { label: "Hypertensive crisis", level: "bad" };
  if (sys >= 140 || dia >= 90) return { label: "High — Stage 2", level: "bad" };
  if (sys >= 130 || dia >= 80) return { label: "High — Stage 1", level: "warn" };
  if (sys >= 120) return { label: "Elevated", level: "warn" };
  return { label: "Normal", level: "ok" };
}
function evalTemp(t) {
  if (t == null) return null;
  if (t < 35) return { label: "Hypothermia", level: "bad" };
  if (t < 36.1) return { label: "Low", level: "warn" };
  if (t <= 37.2) return { label: "Normal", level: "ok" };
  if (t <= 38) return { label: "Low-grade fever", level: "warn" };
  return { label: "Fever", level: "bad" };
}
function evalSpo2(s) {
  if (s == null) return null;
  if (s < 93) return { label: "Critically low", level: "bad" };
  if (s < 95) return { label: "Low", level: "warn" };
  return { label: "Normal", level: "ok" };
}
function evalSugar(v, type) {
  if (v == null) return null;
  if (v < 70) return { label: "Low", level: "bad" };
  if (type === "Fasting") {
    if (v <= 99) return { label: "Normal (fasting)", level: "ok" };
    if (v <= 125) return { label: "Elevated (prediabetes range)", level: "warn" };
    return { label: "High (diabetes range)", level: "bad" };
  }
  if (v < 140) return { label: "Normal", level: "ok" };
  if (v < 200) return { label: "Elevated", level: "warn" };
  return { label: "High", level: "bad" };
}
function overallOf(record) {
  const levels = [record.e.hr?.level, record.e.bp?.level, record.e.temp?.level,
    record.e.spo2?.level, record.e.sugar?.level, record.e.bmi?.level].filter(Boolean);
  if (!levels.length) return { label: "No data", level: "" };
  if (levels.includes("bad")) return { label: "Needs attention", level: "bad" };
  if (levels.includes("warn")) return { label: "Fair — monitor", level: "warn" };
  return { label: "Stable", level: "ok" };
}

/* ---------- patient form ---------- */
function fillPatientForm() {
  for (const f of patientFields) $(f).value = patient[f] ?? "";
}
function setPatientEditing(on) {
  editingPatient = on;
  for (const f of patientFields) $(f).disabled = !on;
  $("editPatientBtn").textContent = on ? "Save" : "Edit";
}
function collectPatient() {
  const p = {};
  for (const f of patientFields) p[f] = $(f).value.trim();
  return p;
}

/* ---------- dashboard ---------- */
function setCard(id, display, status) {
  const card = $(id);
  card.querySelector("[data-val]").textContent = display;
  const badge = card.querySelector(".vcard-status");
  badge.textContent = status ? status.label : "—";
  badge.className = "vcard-status badge" + (status?.level ? " " + status.level : "");
  card.dataset.level = status?.level || "";
}

function renderAll() {
  renderPatientSummary();
  renderDashboard();
  renderHistory();
}

function renderPatientSummary() {
  const name = patient.fullName || "No patient yet";
  $("summaryName").textContent = name;
  const meta = [patient.patientId && ("ID: " + patient.patientId),
    patient.age && (patient.age + " yrs"), patient.sex].filter(Boolean).join(" · ")
    || "Enter patient information to begin.";
  $("summaryMeta").textContent = meta;
  $("summaryContact").textContent = [patient.contact, patient.address].filter(Boolean).join(" · ");
  $("avatarInitials").textContent = patient.fullName
    ? patient.fullName.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() : "—";
}

function renderDashboard() {
  const r = records[0]; // newest first
  const overall = $("overallStatus");
  const countTxt = records.length ? `${records.length} record${records.length > 1 ? "s" : ""} saved` : "";
  $("recordCount").textContent = countTxt;
  const top = $("recordCountTop");
  if (top) top.textContent = countTxt || "no records yet";
  if (!r) {
    overall.textContent = "No data"; overall.className = "badge badge-large";
    for (const [id] of [["card-hr"],["card-bp"],["card-temp"],["card-spo2"],["card-weight"],["card-bmi"],["card-sugar"]])
      setCard(id, "—", null);
    $("latestMeta").textContent = "No records saved yet.";
    $("alertsList").innerHTML = "";
    return;
  }
  const ov = overallOf(r);
  overall.textContent = ov.label; overall.className = "badge badge-large " + ov.level;
  setCard("card-hr", r.hr ?? "—", r.e.hr);
  setCard("card-bp", r.sys != null ? `${r.sys} / ${r.dia}` : "—", r.e.bp);
  setCard("card-temp", r.temp ?? "—", r.e.temp);
  setCard("card-spo2", r.spo2 ?? "—", r.e.spo2);
  setCard("card-weight", r.weight ?? "—", null);
  $("card-weight").querySelector(".vcard-status").textContent = r.weight != null ? "Recorded" : "—";
  setCard("card-bmi", r.bmi != null ? r.bmi.toFixed(2) : "—", r.e.bmi);
  setCard("card-sugar", r.sugar != null ? `${r.sugar} (${r.sugarType})` : "—", r.e.sugar);

  $("latestMeta").textContent = `Latest: ${new Date(r.ts).toLocaleString()} · BMI ${r.bmi != null ? r.bmi.toFixed(2) : "—"}`;
  const alerts = [];
  const push = (label, status) => { if (status && status.level !== "ok") alerts.push({ label: `${label}: ${status.label}`, level: status.level }); };
  push("Heart rate", r.e.hr); push("Blood pressure", r.e.bp); push("Temperature", r.e.temp);
  push("Oxygen", r.e.spo2); push("BMI", r.e.bmi); push("Blood sugar", r.e.sugar);
  $("alertsList").innerHTML = alerts.length
    ? alerts.map((a) => `<div class="alert ${a.level}">${esc(a.label)}</div>`).join("")
    : `<div class="alert ok">All evaluated vitals are within normal range.</div>`;
}

function renderHistory() {
  const body = $("historyBody");
  if (!records.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="11">No records yet — enter vitals and press “Save record”.</td></tr>`;
    return;
  }
  body.innerHTML = records.map((r) => {
    const ov = overallOf(r);
    return `<tr>
      <td>${esc(new Date(r.ts).toLocaleString())}</td>
      <td>${r.hr ?? "—"}</td><td>${r.sys != null ? `${r.sys}/${r.dia}` : "—"}</td>
      <td>${r.temp ?? "—"}</td><td>${r.spo2 ?? "—"}</td><td>${r.weight ?? "—"}</td>
      <td>${r.height ?? "—"}</td><td>${r.bmi != null ? r.bmi.toFixed(2) : "—"}</td>
      <td>${r.sugar != null ? `${r.sugar} (${esc(r.sugarType)})` : "—"}</td>
      <td><span class="badge ${ov.level}">${esc(ov.label)}</span></td>
      <td><button class="row-btn" data-del="${r.ts}">Delete</button></td>
    </tr>`;
  }).join("");
  body.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      records = records.filter((r) => String(r.ts) !== b.dataset.del);
      save(recordsKey(), records); renderAll();
      if (isAdmin()) renderAdmin();
    }));
}

/* ---------- admin panel ---------- */
function userRecordCount(email) {
  try {
    const v = JSON.parse(localStorage.getItem(`vitalis_records_${emailKey(email)}`));
    return Array.isArray(v) ? v.length : 0;
  } catch { return 0; }
}
function renderAdmin() {
  const body = $("adminUsersBody");
  if (!body) return;
  const users = getUsers();
  const totalRecs = users.reduce((n, u) => n + userRecordCount(u.email), 0);
  $("adminStats").textContent = `${users.length} account${users.length === 1 ? "" : "s"} · ${totalRecs} record${totalRecs === 1 ? "" : "s"}`;
  if (!users.length) { body.innerHTML = `<tr class="empty-row"><td colspan="6">No accounts.</td></tr>`; return; }
  body.innerHTML = users.map((u) => {
    const me = emailKey(u.email) === emailKey(session?.email);
    return `<tr>
      <td>${esc(u.name)}${me ? ' <span class="badge">you</span>' : ""}</td>
      <td>${esc(u.email)}</td>
      <td><span class="badge ${u.role === "admin" ? "warn" : "ok"}">${esc(u.role)}</span></td>
      <td>${u.createdAt ? esc(new Date(u.createdAt).toLocaleDateString()) : "—"}</td>
      <td>${userRecordCount(u.email)}</td>
      <td style="white-space:nowrap">
        <button class="row-btn" data-role="${esc(u.email)}" ${me ? "disabled style='opacity:.4'" : ""}>${u.role === "admin" ? "Demote" : "Promote"}</button>
        <button class="row-btn" data-deluser="${esc(u.email)}" ${me ? "disabled style='opacity:.4'" : ""}>Remove</button>
      </td>
    </tr>`;
  }).join("");
  body.querySelectorAll("[data-role]").forEach((b) => b.addEventListener("click", () => {
    const users2 = getUsers();
    const u = users2.find((x) => emailKey(x.email) === emailKey(b.dataset.role));
    if (!u || emailKey(u.email) === emailKey(session?.email)) return;
    u.role = u.role === "admin" ? "user" : "admin";
    saveUsers(users2); renderAdmin(); renderAuthState();
  }));
  body.querySelectorAll("[data-deluser]").forEach((b) => b.addEventListener("click", () => {
    if (emailKey(b.dataset.deluser) === emailKey(session?.email)) return;
    if (!confirm(`Remove account ${b.dataset.deluser} and all its data?`)) return;
    saveUsers(getUsers().filter((x) => emailKey(x.email) !== emailKey(b.dataset.deluser)));
    drop(`vitalis_patient_${emailKey(b.dataset.deluser)}`);
    drop(`vitalis_records_${emailKey(b.dataset.deluser)}`);
    renderAdmin();
  }));
}

/* ---------- events ---------- */
function bindEvents() {
  // mobile menu
  $("menuToggle")?.addEventListener("click", () => {
    const side = document.querySelector(".sidebar");
    const open = side.classList.toggle("open");
    $("menuToggle").setAttribute("aria-expanded", String(open));
    $("menuToggle").setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });
  document.querySelectorAll("[data-scroll]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.classList.contains("nav-btn")) {
        document.querySelectorAll(".side-nav .nav-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      }
      document.querySelector(".sidebar")?.classList.remove("open");
      $("menuToggle")?.setAttribute("aria-expanded", "false");
      document.querySelector(b.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));

  // auth tabs
  const showTab = (which) => {
    const login = which === "login";
    $("authTabLogin").classList.toggle("active", login);
    $("authTabSignup").classList.toggle("active", !login);
    $("loginForm").classList.toggle("hidden", !login);
    $("signupForm").classList.toggle("hidden", login);
  };
  $("authTabLogin").addEventListener("click", () => showTab("login"));
  $("authTabSignup").addEventListener("click", () => showTab("signup"));
  $("signupRole").addEventListener("change", () => {
    $("adminCodeWrap").classList.toggle("hidden", $("signupRole").value !== "admin");
  });

  const authErr = (id, msg) => {
    const el = $(id);
    if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
    el.textContent = msg; el.classList.remove("hidden");
  };

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault(); authErr("loginError", "");
    const email = $("loginEmail").value.trim().toLowerCase();
    const pw = $("loginPassword").value;
    const u = getUsers().find((x) => emailKey(x.email) === emailKey(email));
    if (!u) return authErr("loginError", "No account found for this email. Try Sign up.");
    if ((await hashPassword(pw)) !== u.pass) return authErr("loginError", "Incorrect password.");
    enterApp({ email: u.email, name: u.name, role: u.role });
  });

  $("signupForm").addEventListener("submit", async (e) => {
    e.preventDefault(); authErr("signupError", "");
    const name = $("signupName").value.trim();
    const email = $("signupEmail").value.trim().toLowerCase();
    const pw = $("signupPassword").value;
    const role = $("signupRole").value;
    if (!name) return authErr("signupError", "Enter your full name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authErr("signupError", "Enter a valid email.");
    if (pw.length < 6) return authErr("signupError", "Password must be at least 6 characters.");
    if (role === "admin" && $("signupAdminCode").value.trim() !== ADMIN_CODE)
      return authErr("signupError", "Invalid admin invite code.");
    if (getUsers().some((x) => emailKey(x.email) === emailKey(email)))
      return authErr("signupError", "An account with this email already exists. Log in instead.");
    const users = getUsers();
    users.push({ name, email, pass: await hashPassword(pw), role, createdAt: Date.now() });
    saveUsers(users);
    enterApp({ email, name, role });
  });

  const doLogout = () => exitApp();
  $("logoutBtn")?.addEventListener("click", doLogout);
  $("logoutBtnSide")?.addEventListener("click", doLogout);

  $("editPatientBtn").addEventListener("click", () => {
    if (!editingPatient) { setPatientEditing(true); $("fullName").focus(); return; }
    patient = collectPatient();
    save(patientKey(), patient);
    setPatientEditing(false);
    renderPatientSummary();
    const n = $("patientSavedNote");
    n.classList.remove("hidden"); setTimeout(() => n.classList.add("hidden"), 2000);
  });

  // auto age from DOB
  $("dob").addEventListener("change", () => {
    const d = new Date($("dob").value);
    if (isNaN(d)) return;
    const today = new Date();
    let age = today.getFullYear() - d.getFullYear();
    if (today < new Date(today.getFullYear(), d.getMonth(), d.getDate())) age--;
    if (age >= 0 && age <= 150) $("age").value = age;
  });

  ["weight", "height"].forEach((id) => $(id).addEventListener("input", updateBmiPreview));
  $("fillSampleBtn").addEventListener("click", () => {
    $("heartRate").value = 72; $("systolic").value = 120; $("diastolic").value = 80;
    $("temperature").value = 36.7; $("oxygen").value = 98;
    $("weight").value = 65; $("height").value = 170;
    $("bloodSugar").value = 95; $("sugarType").value = "Fasting";
    if (!patient.fullName) {
      patient = { patientId: "P-001", fullName: "Juan Dela Cruz", age: "32", sex: "Male", dob: "", contact: "0917-000-0000", address: "Manila" };
      fillPatientForm(); save(patientKey(), patient); renderPatientSummary();
    }
    updateBmiPreview();
  });
  $("clearVitalsBtn").addEventListener("click", () => { $("vitalsForm").reset(); updateBmiPreview(); hideError(); });

  $("vitalsForm").addEventListener("submit", (e) => {
    e.preventDefault(); hideError();
    const hr = num("heartRate"), sys = num("systolic"), dia = num("diastolic"),
      temp = num("temperature"), spo2 = num("oxygen"),
      weight = num("weight"), height = num("height"),
      sugar = num("bloodSugar"), sugarType = $("sugarType").value;
    if ([hr, sys, dia, temp, spo2, weight, height, sugar].every((v) => v == null)) {
      return showError("Enter at least one measurement before saving.");
    }
    if ((sys != null) !== (dia != null)) return showError("Enter both systolic and diastolic pressure.");
    const bmi = (weight != null && height != null) ? calcBMI(weight, height) : null;
    const record = {
      ts: Date.now(), hr, sys, dia, temp, spo2, weight, height, bmi, sugar, sugarType,
      e: {
        hr: evalHR(hr), bp: evalBP(sys, dia), temp: evalTemp(temp),
        spo2: evalSpo2(spo2), sugar: evalSugar(sugar, sugarType),
        bmi: bmi != null ? bmiCategory(bmi) : null,
      },
    };
    records.unshift(record);
    save(recordsKey(), records);
    renderAll();
    if (isAdmin()) renderAdmin();
    document.getElementById("section-dashboard").scrollIntoView({ behavior: "smooth" });
  });

  $("exportCsvBtn").addEventListener("click", exportCSV);
  $("exportCsvBtn2").addEventListener("click", exportCSV);
  $("clearHistoryBtn").addEventListener("click", () => {
    if (!records.length || !confirm("Delete all health records?")) return;
    records = []; save(recordsKey(), records); renderAll();
    if (isAdmin()) renderAdmin();
  });
  $("clearAllBtn").addEventListener("click", () => {
    if (!confirm("Erase your patient info and history?")) return;
    patient = {}; records = [];
    save(patientKey(), patient); save(recordsKey(), records);
    fillPatientForm(); renderAll();
    if (isAdmin()) renderAdmin();
  });
  $("adminClearAllBtn")?.addEventListener("click", () => {
    if (!isAdmin()) return;
    if (!confirm("ERASE ALL users' patients + records on this device?")) return;
    for (const u of getUsers()) {
      drop(`vitalis_patient_${emailKey(u.email)}`);
      drop(`vitalis_records_${emailKey(u.email)}`);
    }
    loadUserData(); renderAll(); renderAdmin();
  });

  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next; save(LS_THEME, next);
  };
  $("themeToggle").addEventListener("click", toggleTheme);
  $("themeToggle2").addEventListener("click", toggleTheme);
}

function showError(msg) { const el = $("formError"); el.textContent = msg; el.classList.remove("hidden"); }
function hideError() { $("formError").classList.add("hidden"); }

function exportCSV() {
  if (!records.length) { alert("No records to export."); return; }
  const head = ["timestamp", "patientId", "name", "hr_bpm", "sys", "dia", "temp_c", "spo2_pct", "weight_kg", "height_cm", "bmi", "sugar_mgdl", "sugar_type", "overall"];
  const lines = [head.join(",")].concat([...records].reverse().map((r) =>
    [new Date(r.ts).toISOString(), patient.patientId || "", `"${(patient.fullName || "").replace(/"/g, '""')}"`,
      r.hr ?? "", r.sys ?? "", r.dia ?? "", r.temp ?? "", r.spo2 ?? "", r.weight ?? "", r.height ?? "",
      r.bmi != null ? r.bmi.toFixed(2) : "", r.sugar ?? "", r.sugarType || "", overallOf(r).label].join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "patient-health-records.csv"; a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- init ---------- */
(async function init() {
  document.documentElement.dataset.theme = load(LS_THEME, "light") || "light";
  await seedDemoAccounts();
  bindEvents();
  updateBmiPreview();
  const s = getSession();
  if (s && getUsers().some((x) => emailKey(x.email) === emailKey(s.email))) {
    const fresh = getUsers().find((x) => emailKey(x.email) === emailKey(s.email));
    enterApp({ email: fresh.email, name: fresh.name, role: fresh.role });
  } else {
    drop(LS_SESSION);
    session = null;
    renderAuthState();
    $("authOverlay").classList.remove("hidden");
    document.body.classList.add("locked");
  }
})();
