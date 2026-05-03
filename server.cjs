const http = require("http");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(__dirname);

/** Load ROOT/.env into process.env (does not override variables already set). */
function loadSynthiqDotEnv() {
  try {
    const envPath = path.join(ROOT, ".env");
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, "utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      if (!k || k.includes(" ")) continue;
      let v = line.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) {
    console.warn("SynthIQ: could not read .env:", e.message || e);
  }
}

loadSynthiqDotEnv();

/** Optional: Firebase Admin JSON key (never commit). Writes `users/{uid}` with admin privileges. */
const SERVICE_ACCOUNT_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(ROOT, "serviceAccountKey.json");

let adminSdk = null;

/** Ensure service-account JSON will sign JWTs correctly (common Railway paste issues). */
function assertFirebaseServiceAccountJson(cred, sourceLabel) {
  if (!cred || typeof cred !== "object") {
    throw new Error("Service account JSON is not an object (" + sourceLabel + ").");
  }
  const pk = cred.private_key;
  if (typeof pk !== "string" || !pk.trim()) {
    throw new Error("Service account JSON missing private_key (" + sourceLabel + ").");
  }
  if (pk.indexOf("BEGIN PRIVATE KEY") === -1) {
    throw new Error(
      "Service account private_key looks corrupted — must include PEM header BEGIN PRIVATE KEY. Re-paste full JSON from Firebase (minify with jq -c . key.json) (" +
        sourceLabel +
        ").",
    );
  }
  if (typeof cred.client_email !== "string" || !cred.client_email.includes("@")) {
    throw new Error("Service account JSON missing client_email (" + sourceLabel + ").");
  }
  if (typeof cred.project_id !== "string" || !cred.project_id.trim()) {
    throw new Error("Service account JSON missing project_id (" + sourceLabel + ").");
  }
}

/** Prefer JSON key file; otherwise Application Default Credentials (gcloud / GOOGLE_APPLICATION_CREDENTIALS). */
function getFirebaseAdmin() {
  if (adminSdk === false) return null;
  if (adminSdk) return adminSdk;
  let admin;
  try {
    admin = require("firebase-admin");
  } catch (e) {
    console.warn("SynthIQ: firebase-admin package missing:", e.message || e);
    adminSdk = false;
    return null;
  }

  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    "cardify-4ee15";

  try {
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (jsonEnv && String(jsonEnv).trim()) {
      let cred;
      try {
        cred = JSON.parse(String(jsonEnv).trim());
      } catch (e) {
        throw new Error(
          "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Use the full file from Firebase (Service accounts → Generate new private key). On Railway, paste minified JSON: jq -c . your-key.json",
        );
      }
      assertFirebaseServiceAccountJson(cred, "FIREBASE_SERVICE_ACCOUNT_JSON");
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(cred),
          projectId: cred.project_id || projectId,
        });
      }
      console.log(
        "SynthIQ: Firestore Admin ENABLED (FIREBASE_SERVICE_ACCOUNT_JSON). project_id=",
        cred.project_id,
        "client_email=",
        cred.client_email,
      );
    } else if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
      const raw = fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8");
      const cred = JSON.parse(raw);
      assertFirebaseServiceAccountJson(cred, "service account file");
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(cred),
          projectId: cred.project_id || projectId,
        });
      }
      console.log("SynthIQ: Firestore Admin ENABLED (service account JSON file).");
    } else if (process.env.SYNTHIQ_FIREBASE_USE_ADC === "1") {
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
          projectId,
        });
      }
      console.log(
        "SynthIQ: Firestore Admin ENABLED (Application Default Credentials; SYNTHIQ_FIREBASE_USE_ADC=1). Project:",
        projectId,
      );
    } else {
      console.warn(
        "SynthIQ: Firestore Admin OFF — no credentials found. Use one of: (1) serviceAccountKey.json in the project folder (same folder as server.cjs), (2) GOOGLE_APPLICATION_CREDENTIALS=/full/path/to/key.json in .env, (3) FIREBASE_SERVICE_ACCOUNT_JSON= entire JSON object on one line. Separate client_email/private_key env vars are not used — the file must be full JSON.",
      );
      adminSdk = false;
      return null;
    }
    adminSdk = admin;
    return adminSdk;
  } catch (e) {
    console.warn(
      "SynthIQ: Firestore Admin init failed — check serviceAccountKey.json / FIREBASE_SERVICE_ACCOUNT_JSON, or SYNTHIQ_FIREBASE_USE_ADC=1 with valid ADC:",
      e.message || e,
    );
    adminSdk = false;
    return null;
  }
}

function corsJsonHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function pickNullableString(v) {
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}

/** Free AI assistant replies per user (server-enforced). */
const AI_MESSAGE_QUOTA = 8;

/** When Firebase Admin is off: per-uid quota in RAM (dev only; lost on restart). */
const memoryAiQuotaByUid = new Map();

function memoryAiQuotaRow(uid) {
  let row = memoryAiQuotaByUid.get(uid);
  if (!row) {
    row = { remaining: AI_MESSAGE_QUOTA, resetAtMs: null };
    memoryAiQuotaByUid.set(uid, row);
  }
  if (row.remaining <= 0 && row.resetAtMs != null && Date.now() >= row.resetAtMs) {
    row.remaining = AI_MESSAGE_QUOTA;
    row.resetAtMs = null;
  }
  return row;
}

function synthiqUseMemoryAiQuota() {
  const v = process.env.SYNTHIQ_USE_MEMORY_AI_QUOTA;
  return v === "1" || String(v).toLowerCase() === "true";
}

/** Public Web API key (same as client firebaseConfig); override with FIREBASE_WEB_API_KEY. */
function synthiqFirebaseWebApiKey() {
  const k =
    (process.env.FIREBASE_WEB_API_KEY && String(process.env.FIREBASE_WEB_API_KEY).trim()) ||
    (process.env.FIREBASE_API_KEY && String(process.env.FIREBASE_API_KEY).trim()) ||
    "";
  if (k) return k;
  return "AIzaSyBffpkUGb2z8J1o2xp8IsnFDDt1X0yxdPI";
}

async function verifyFirebaseIdTokenRest(idToken) {
  const apiKey = synthiqFirebaseWebApiKey();
  if (!apiKey) return null;
  try {
    const r = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      }
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.users || !data.users.length) return null;
    const u = data.users[0];
    const uid = u.localId || u.uid;
    if (!uid) return null;
    return { uid };
  } catch {
    return null;
  }
}

async function handleSyncUserProfile(req, res) {
  const admin = getFirebaseAdmin();
  if (!admin) {
    res.writeHead(503, corsJsonHeaders());
    res.end(
      JSON.stringify({
        ok: false,
        configured: false,
        hint:
          "Set env FIREBASE_SERVICE_ACCOUNT_JSON to your service-account JSON, or save serviceAccountKey.json next to server.cjs, or set GOOGLE_APPLICATION_CREDENTIALS.",
      })
    );
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, corsJsonHeaders());
    res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
    return;
  }

  const idToken = typeof body.idToken === "string" ? body.idToken.trim() : "";
  const profile = body.profile && typeof body.profile === "object" ? body.profile : {};

  if (!idToken) {
    res.writeHead(400, corsJsonHeaders());
    res.end(JSON.stringify({ ok: false, error: "idToken required" }));
    return;
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const db = admin.firestore();
    const ref = db.collection("users").doc(uid);
    const snap = await ref.get();

    const payload = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const email = pickNullableString(decoded.email || profile.email);
    if (email !== null) payload.email = email;

    if (profile && typeof profile === "object") {
      if ("fullName" in profile) payload.fullName = pickNullableString(profile.fullName);
      if ("username" in profile) payload.username = pickNullableString(profile.username);
      if ("phone" in profile) payload.phone = pickNullableString(profile.phone);
      if ("phoneCountry" in profile) payload.phoneCountry = pickNullableString(profile.phoneCountry);
    }

    Object.keys(payload).forEach((k) => {
      if (payload[k] === undefined) delete payload[k];
    });

    const updates = Object.assign({}, payload);
    if (!snap.exists) {
      updates.createdAt = admin.firestore.FieldValue.serverTimestamp();
      updates.aiMessagesRemaining = AI_MESSAGE_QUOTA;
    } else {
      const existing = snap.data() || {};
      if (existing.aiMessagesRemaining === undefined || existing.aiMessagesRemaining === null) {
        updates.aiMessagesRemaining = AI_MESSAGE_QUOTA;
      }
    }

    await ref.set(updates, { merge: true });

    res.writeHead(200, corsJsonHeaders());
    res.end(JSON.stringify({ ok: true, uid }));
  } catch (e) {
    res.writeHead(401, corsJsonHeaders());
    res.end(
      JSON.stringify({
        ok: false,
        error: e.message || "verify or write failed",
        code: e.code || undefined,
      })
    );
  }
}

const FIREBASE_WEB_API_KEY =
  process.env.FIREBASE_WEB_API_KEY || "AIzaSyBffpkUGb2z8J1o2xp8IsnFDDt1X0yxdPI";
const RESEND_API_KEY =
  process.env.RESEND_API_KEY || "re_hKAS8Kwe_FQzriA1rFh9v1TWJBftteVR2";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function pathnameOnly(reqUrl) {
  try {
    let p = new URL(reqUrl || "/", "http://localhost").pathname;
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p;
  } catch {
    return "/";
  }
}

function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const relative = decoded === "/" ? "index.html" : path.normalize(decoded.slice(1));
  if (relative.includes("..")) return null;
  const full = path.resolve(root, relative);
  if (!full.startsWith(root)) return null;
  return full;
}

/** If `signup/` is missing but assets sit at repo root, serve `/signup/x` from `/x`. */
function signupFlatFallbackPath(root, primaryPath, reqUrl) {
  try {
    const st = fs.statSync(primaryPath);
    if (st.isFile()) return primaryPath;
  } catch (_) {}
  const p = pathnameOnly(reqUrl);
  if (!p || p === "/") return null;
  if (!p.startsWith("/signup/")) return null;
  const base = path.basename(p);
  if (!base || base === "." || base === ".." || base.includes("..")) return null;
  const alt = path.join(root, base);
  try {
    const st2 = fs.statSync(alt);
    if (st2.isFile()) return alt;
  } catch (_) {}
  return null;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Localhost-only: launches Windows File Explorer (dev workflow with node server). */
function isLocalSynthIQHost(hostHeader) {
  if (!hostHeader) return false;
  const h = String(hostHeader).split(":")[0].toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

async function handleOpenExplorer(req, res) {
  if (!isLocalSynthIQHost(req.headers.host)) {
    sendJson(res, 403, {
      ok: false,
      error: "Open in Explorer is only allowed when using SynthIQ on localhost.",
    });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const raw = typeof body.path === "string" ? body.path.trim() : "";
  if (!raw || raw.length > 4096 || raw.includes("\0")) {
    sendJson(res, 400, { ok: false, error: "Invalid path." });
    return;
  }

  let resolved;
  try {
    resolved = path.resolve(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid path." });
    return;
  }

  if (!fs.existsSync(resolved)) {
    sendJson(res, 404, { ok: false, error: "That path was not found on this computer." });
    return;
  }

  try {
    spawnRevealPath(resolved);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || "Could not open file manager." });
    return;
  }

  sendJson(res, 200, { ok: true });
}

/** Localhost + Windows: native folder dialog; returns absolute path or "". */
function runWindowsFolderPickerScript() {
  return new Promise(function (resolve, reject) {
    const scriptPath = path.join(os.tmpdir(), "synthiq-pick-" + process.pid + "-" + Date.now() + ".ps1");
    const script =
      "Add-Type -AssemblyName System.Windows.Forms\n" +
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog\n" +
      "$d.Description = 'Select the folder that contains your imported files'\n" +
      "$d.ShowNewFolderButton = $false\n" +
      "$r = $d.ShowDialog()\n" +
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) {\n" +
      "  [Console]::Out.Write($d.SelectedPath)\n" +
      "}\n";

    fsPromises
      .writeFile(scriptPath, script, "utf8")
      .then(function () {
        const chunks = [];
        const proc = spawn(
          "powershell.exe",
          ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
          { windowsHide: true },
        );
        proc.stdout.on("data", function (d) {
          chunks.push(d);
        });
        proc.on("error", function (e) {
          fsPromises.unlink(scriptPath).catch(function () {});
          reject(e);
        });
        proc.on("close", function () {
          fsPromises.unlink(scriptPath).catch(function () {});
          resolve(Buffer.concat(chunks).toString("utf8").trim());
        });
      })
      .catch(reject);
  });
}

async function handlePickFolder(req, res) {
  if (!isLocalSynthIQHost(req.headers.host)) {
    sendJson(res, 403, {
      ok: false,
      error: "Pick folder is only allowed when using SynthIQ on localhost.",
    });
    return;
  }

  if (process.platform !== "win32") {
    sendJson(res, 501, {
      ok: false,
      cancelled: true,
      error: "Folder picker is only implemented on Windows.",
    });
    return;
  }

  let body = {};
  try {
    const raw = await readBody(req);
    if (raw && String(raw).trim()) body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const openExplorer = body.openExplorer !== false;

  let selected;
  try {
    selected = await runWindowsFolderPickerScript();
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || "Folder picker failed to start." });
    return;
  }

  if (!selected) {
    sendJson(res, 200, { ok: false, cancelled: true });
    return;
  }

  let resolved;
  try {
    resolved = path.resolve(selected);
  } catch {
    sendJson(res, 200, { ok: false, cancelled: true, error: "Invalid path." });
    return;
  }

  if (!fs.existsSync(resolved)) {
    sendJson(res, 200, { ok: false, cancelled: true, error: "That folder was not found." });
    return;
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    sendJson(res, 200, { ok: false, cancelled: true, error: e.message || "Cannot read folder." });
    return;
  }

  if (!stat.isDirectory()) {
    sendJson(res, 200, { ok: false, cancelled: true, error: "Selection must be a folder." });
    return;
  }

  if (openExplorer) {
    try {
      spawnRevealPath(resolved);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || "Could not open File Explorer." });
      return;
    }
  }

  sendJson(res, 200, { ok: true, path: resolved });
}

/** Localhost + Windows: Save File dialog; returns full path or "". */
function runWindowsSaveFileDialogScript(suggestedFileName) {
  const base = sanitizeDownloadFilename(suggestedFileName || "SynthIQ-WorkFiles.txt");
  const defaultFn = /\.[a-z0-9]{1,10}$/i.test(base) ? base : base + ".txt";
  const psSafe = defaultFn.replace(/'/g, "''");

  return new Promise(function (resolve, reject) {
    const scriptPath = path.join(os.tmpdir(), "synthiq-save-" + process.pid + "-" + Date.now() + ".ps1");
    const script =
      "Add-Type -AssemblyName System.Windows.Forms\n" +
      "$s = New-Object System.Windows.Forms.SaveFileDialog\n" +
      "$s.Title = 'Choose where to save this Work Files session'\n" +
      "$s.FileName = '" +
      psSafe +
      "'\n" +
      "$s.Filter = 'Text files (*.txt)|*.txt|All files (*.*)|*.*'\n" +
      "$s.DefaultExt = 'txt'\n" +
      "$s.AddExtension = $true\n" +
      "$r = $s.ShowDialog()\n" +
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) {\n" +
      "  [Console]::Out.Write($s.FileName)\n" +
      "}\n";

    fsPromises
      .writeFile(scriptPath, script, "utf8")
      .then(function () {
        const chunks = [];
        const stderrChunks = [];
        const proc = spawn(
          "powershell.exe",
          ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
          { windowsHide: true },
        );
        proc.stdout.on("data", function (d) {
          chunks.push(d);
        });
        proc.stderr.on("data", function (d) {
          stderrChunks.push(d);
        });
        proc.on("error", function (e) {
          fsPromises.unlink(scriptPath).catch(function () {});
          reject(e);
        });
        proc.on("close", function (code) {
          fsPromises.unlink(scriptPath).catch(function () {});
          const out = Buffer.concat(chunks).toString("utf8").trim();
          if (!out && code !== 0) {
            const errTxt = Buffer.concat(stderrChunks).toString("utf8").trim();
            reject(
              new Error(
                errTxt
                  ? errTxt.slice(0, 400)
                  : "Save dialog failed (exit " + code + "). Try running from an interactive desktop session.",
              ),
            );
            return;
          }
          resolve(out);
        });
      })
      .catch(reject);
  });
}

const MAX_WORK_SESSION_EXPORT_CHARS = 2 * 1024 * 1024;

async function handleSaveSessionAsFile(req, res) {
  if (!isLocalSynthIQHost(req.headers.host)) {
    sendJson(res, 403, {
      ok: false,
      error: "Saving a session file is only allowed when using SynthIQ on localhost.",
    });
    return;
  }

  if (process.platform !== "win32") {
    sendJson(res, 501, {
      ok: false,
      cancelled: true,
      error: "Windows Save dialog is not available on this platform.",
    });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const content = typeof body.content === "string" ? body.content : "";
  if (content.length > MAX_WORK_SESSION_EXPORT_CHARS) {
    sendJson(res, 413, {
      ok: false,
      error: "Session export is too large (max about " + Math.floor(MAX_WORK_SESSION_EXPORT_CHARS / 1024 / 1024) + " MB of text).",
    });
    return;
  }

  const defaultFileName = sanitizeDownloadFilename(body.defaultFileName || "SynthIQ-WorkFiles.txt");
  const revealInExplorer = body.revealInExplorer !== false;

  let selectedPath;
  try {
    selectedPath = await runWindowsSaveFileDialogScript(defaultFileName);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || "Save dialog failed to start." });
    return;
  }

  if (!selectedPath) {
    sendJson(res, 200, { ok: false, cancelled: true });
    return;
  }

  let resolved;
  try {
    resolved = path.resolve(selectedPath);
  } catch {
    sendJson(res, 200, { ok: false, cancelled: true, error: "Invalid path." });
    return;
  }

  const parentDir = path.dirname(resolved);
  try {
    await fsPromises.mkdir(parentDir, { recursive: true });
    await fsPromises.writeFile(resolved, content, "utf8");
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || "Could not write file." });
    return;
  }

  if (revealInExplorer) {
    try {
      spawnRevealPath(resolved);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || "Saved but could not open File Explorer." });
      return;
    }
  }

  sendJson(res, 200, { ok: true, path: resolved });
}

/** Open OS file manager at a path (folder opens folder; file highlights file). */
function spawnRevealPath(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return;
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return;
  }
  try {
    if (process.platform === "win32") {
      if (stat.isDirectory()) {
        spawn("explorer.exe", [absPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      } else {
        spawn("explorer.exe", ["/select," + absPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      }
    } else if (process.platform === "darwin") {
      spawn("open", [absPath], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [absPath], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (_) {}
}

const MAX_SAVE_DOWNLOAD_HTTP_BYTES = 80 * 1024 * 1024;
const MAX_SAVE_DOWNLOAD_DATAURL_BYTES = 28 * 1024 * 1024;

function sanitizeDownloadFilename(name) {
  let base = path.basename(String(name || "download").replace(/\\/g, "/"));
  base = base.replace(/[/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
  base = base.replace(/[^\w.\-()+\[\] &'`,;@#!~]+/gi, "_").slice(0, 180);
  return base || "download";
}

function uniqueDownloadsDest(downloadsDir, filename) {
  let dest = path.join(downloadsDir, filename);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  for (let i = 1; i < 500; i++) {
    const nextName = stem + " (" + i + ")" + ext;
    dest = path.join(downloadsDir, nextName);
    if (!fs.existsSync(dest)) return dest;
  }
  return path.join(downloadsDir, stem + "-" + Date.now() + ext);
}

function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Bad data URL.");
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  let buf;
  if (/;base64/i.test(meta)) {
    buf = Buffer.from(payload.replace(/\s/g, ""), "base64");
  } else {
    buf = Buffer.from(decodeURIComponent(payload.replace(/\+/g, " ")), "utf8");
  }
  return buf;
}

async function handleSaveToDownloads(req, res) {
  if (!isLocalSynthIQHost(req.headers.host)) {
    sendJson(res, 403, {
      ok: false,
      error: "Saving to Downloads is only allowed when SynthIQ runs on localhost.",
    });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const filename = sanitizeDownloadFilename(body.filename || "download");
  const downloadsDir = path.join(os.homedir(), "Downloads");

  try {
    await fsPromises.mkdir(downloadsDir, { recursive: true });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || "Cannot access Downloads." });
    return;
  }

  const dest = uniqueDownloadsDest(downloadsDir, filename);

  try {
    if (typeof body.url === "string" && /^https?:\/\//i.test(body.url.trim())) {
      const u = body.url.trim();
      if (typeof fetch !== "function") {
        sendJson(res, 501, {
          ok: false,
          error: "Node.js fetch is required (Node 18+).",
        });
        return;
      }
      const response = await fetch(u, {
        redirect: "follow",
        headers: { "User-Agent": "SynthIQ-local-save/1.0" },
      });
      if (!response.ok) throw new Error("Remote URL returned " + response.status);
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > MAX_SAVE_DOWNLOAD_HTTP_BYTES) {
        throw new Error("File is too large to save via localhost helper.");
      }
      await fsPromises.writeFile(dest, buf);
    } else if (typeof body.dataUrl === "string" && /^data:/i.test(body.dataUrl.trim())) {
      const buf = dataUrlToBuffer(body.dataUrl.trim());
      if (buf.length > MAX_SAVE_DOWNLOAD_DATAURL_BYTES) {
        throw new Error("Embedded file is too large for this save path.");
      }
      await fsPromises.writeFile(dest, buf);
    } else {
      sendJson(res, 400, {
        ok: false,
        error: "Send a JSON body with either url (http/https) or dataUrl (data:…).",
      });
      return;
    }
  } catch (e) {
    sendJson(res, 502, { ok: false, error: e.message || "Could not save file." });
    return;
  }

  sendJson(res, 200, { ok: true, savedAs: path.basename(dest) });
}

async function handleListMyTeams(req, res) {
  const admin = getFirebaseAdmin();
  if (!admin) {
    sendJson(res, 503, {
      ok: false,
      configured: false,
      hint: "Add serviceAccountKey.json next to server.cjs so Admin can list teams when client rules fail.",
    });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const idToken = typeof body.idToken === "string" ? body.idToken.trim() : "";
  if (!idToken) {
    sendJson(res, 400, { ok: false, error: "idToken required" });
    return;
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const db = admin.firestore();
    const byId = {};

    const [memberSnap, creatorSnap] = await Promise.all([
      db.collection("teams").where("memberUids", "array-contains", uid).get(),
      db.collection("teams").where("createdByUid", "==", uid).get(),
    ]);

    memberSnap.docs.forEach(function (d) {
      byId[d.id] = d.data();
    });
    creatorSnap.docs.forEach(function (d) {
      byId[d.id] = d.data();
    });

    try {
      const userSnap = await db.collection("users").doc(uid).get();
      const joined = userSnap.exists ? userSnap.data().joinedTeamIds : null;
      if (Array.isArray(joined)) {
        for (let i = 0; i < joined.length; i++) {
          const tid = joined[i];
          if (!tid || typeof tid !== "string" || byId[tid]) continue;
          try {
            const ts = await db.collection("teams").doc(tid).get();
            if (ts.exists) byId[tid] = ts.data();
          } catch (_) {}
        }
      }
    } catch (_) {}

    const teams = Object.keys(byId).map(function (id) {
      const data = byId[id];
      let createdAtMs = 0;
      const ca = data.createdAt;
      if (ca && typeof ca.toMillis === "function") createdAtMs = ca.toMillis();
      return {
        id,
        name: typeof data.name === "string" ? data.name : "",
        createdByUid: data.createdByUid != null ? String(data.createdByUid) : "",
        createdAtMs,
      };
    });
    teams.sort(function (a, b) {
      return b.createdAtMs - a.createdAtMs;
    });

    sendJson(res, 200, { ok: true, teams });
  } catch (e) {
    sendJson(res, 401, {
      ok: false,
      error: e.message || "verify or query failed",
      code: e.code || undefined,
    });
  }
}

async function handleDeleteTeam(req, res) {
  const admin = getFirebaseAdmin();
  if (!admin) {
    sendJson(res, 503, {
      ok: false,
      configured: false,
      hint: "Add serviceAccountKey.json for recursive team delete; otherwise the client deletes only the team document.",
    });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const idToken = typeof body.idToken === "string" ? body.idToken.trim() : "";
  const teamId = typeof body.teamId === "string" ? body.teamId.trim() : "";
  if (!idToken || !teamId || teamId.length > 200 || /\//.test(teamId)) {
    sendJson(res, 400, { ok: false, error: "idToken and valid teamId required" });
    return;
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const db = admin.firestore();
    const teamRef = db.collection("teams").doc(teamId);
    const snap = await teamRef.get();
    if (!snap.exists) {
      sendJson(res, 404, { ok: false, error: "Team not found" });
      return;
    }
    const data = snap.data() || {};
    const creator = data.createdByUid != null ? String(data.createdByUid) : "";
    if (!creator || creator !== uid) {
      sendJson(res, 403, { ok: false, error: "Only the team creator can delete this team." });
      return;
    }
    try {
      await db.recursiveDelete(teamRef);
      sendJson(res, 200, { ok: true, recursive: true });
      return;
    } catch (delErr) {
      console.warn("SynthIQ delete-team: recursiveDelete failed, trying doc delete only:", delErr.message || delErr);
      try {
        await teamRef.delete();
        sendJson(res, 200, { ok: true, recursive: false });
        return;
      } catch (del2) {
        sendJson(res, 500, {
          ok: false,
          error:
            (delErr && delErr.message) ||
            (del2 && del2.message) ||
            "Could not delete team (server).",
          code: del2.code || delErr.code,
        });
        return;
      }
    }
  } catch (e) {
    const msg = e.message || String(e);
    const looksLikeAuth =
      /auth\/|Firebase ID token|DECODER_|invalid/i.test(msg) ||
      e.code === "auth/argument-error" ||
      e.code === "auth/id-token-expired";
    sendJson(res, looksLikeAuth ? 401 : 500, {
      ok: false,
      error: msg || "verify or delete failed",
      code: e.code || undefined,
    });
  }
}

async function handleSendResetEmail(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const email = (body.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendJson(res, 400, { error: "Valid email required" });
    return;
  }

  const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;

  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "SynthIQ <onboarding@resend.dev>",
        to: [email],
        subject: "SynthIQ — password reset",
        html: `<div style="font-family:system-ui,sans-serif;max-width:520px;line-height:1.5;color:#111">
          <h2 style="margin:0 0 12px">Password reset</h2>
          <p>We received a request to reset the password for <strong>${email}</strong> on SynthIQ.</p>
          <p>You will get a <strong>second email</strong> from Firebase with a secure link to choose a new password. Check spam if you don’t see it.</p>
          <p style="margin-top:20px;font-size:14px;color:#555">If you didn’t ask for this, you can ignore both messages.</p>
          <p style="margin-top:24px"><a href="${origin}/" style="color:#4f46e5">Open SynthIQ</a></p>
        </div>`,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      sendJson(res, 502, { error: "Resend email failed", detail: errText.slice(0, 400) });
      return;
    }

    const fbRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestType: "PASSWORD_RESET",
          email,
        }),
      }
    );

    const fbJson = await fbRes.json().catch(() => ({}));
    if (!fbRes.ok) {
      sendJson(res, 502, {
        error: fbJson.error?.message || "Firebase could not send reset link",
        code: fbJson.error?.code,
      });
      return;
    }

    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: e.message || "Server error" });
  }
}

/** Convert client chat history (system + user + assistant) to Anthropic Messages API shape. */
function synthiqMessagesToAnthropicBody(rawList) {
  const systemParts = [];
  const conv = [];
  for (let i = 0; i < rawList.length; i++) {
    const m = rawList[i];
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    const content = typeof m.content === "string" ? m.content : "";
    if (role === "system") {
      if (content) systemParts.push(content);
      continue;
    }
    if (role === "user" || role === "assistant") {
      conv.push({ role, content });
    }
  }
  const merged = [];
  for (let i = 0; i < conv.length; i++) {
    const m = conv[i];
    if (!merged.length) {
      merged.push({ role: m.role, content: m.content });
      continue;
    }
    const last = merged[merged.length - 1];
    if (last.role === m.role) {
      last.content = (last.content + "\n\n" + m.content).trim();
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  while (merged.length && merged[0].role === "assistant") {
    merged.shift();
  }
  if (!merged.length) {
    return { error: "No user or assistant messages to send." };
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: merged,
  };
}

function anthropicMessagesExtractReplyText(data) {
  const blocks = data && data.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function anthropicErrorMessage(data, raw) {
  const rawStr = raw != null ? String(raw) : "";
  if (!data || typeof data !== "object") return (rawStr && rawStr.slice(0, 400)) || "Anthropic request failed";
  const e = data.error;
  if (e && typeof e.message === "string") return e.message;
  if (typeof e === "string") return e;
  if (data.message && typeof data.message === "string") return data.message;
  return (rawStr && rawStr.slice(0, 400)) || "Anthropic request failed";
}

const AI_MESSAGE_COOLDOWN_MS = 86400000;

function msFromFirestoreTs(ts) {
  if (!ts) return null;
  try {
    if (typeof ts.toMillis === "function") return ts.toMillis();
  } catch (_) {}
  if (typeof ts === "object" && typeof ts.seconds === "number") return ts.seconds * 1000;
  return null;
}

function coerceAiMessagesRemaining(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (typeof v === "string" && String(v).trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return null;
}

function aiMessagesRemainingFromUserData(userData) {
  const d = userData && typeof userData === "object" ? userData : {};
  const n = coerceAiMessagesRemaining(d.aiMessagesRemaining);
  return n !== null ? n : AI_MESSAGE_QUOTA;
}

/** Proxy Anthropic Messages API — idToken required; 8 free assistant replies per account. */
async function handleAnthropicChat(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !String(key).trim()) {
    sendJson(res, 503, {
      ok: false,
      error: "Anthropic API not configured on this server.",
      hint:
        'Set ANTHROPIC_API_KEY and restart (e.g. PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..." ; node server.cjs)',
    });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const idToken = typeof body.idToken === "string" ? body.idToken.trim() : "";
  if (!idToken) {
    sendJson(res, 401, { ok: false, error: "Sign in to use SynthIQ AI." });
    return;
  }

  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > 40) {
    sendJson(res, 400, { ok: false, error: "messages must be a non-empty array (max 40 entries)" });
    return;
  }

  const validated = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    const content = typeof m.content === "string" ? m.content : "";
    if (!["system", "user", "assistant"].includes(role)) {
      sendJson(res, 400, { ok: false, error: "Each message needs role system, user, or assistant." });
      return;
    }
    if (content.length > 12000) {
      sendJson(res, 400, { ok: false, error: "A message is too long (max 12000 characters)." });
      return;
    }
    validated.push({ role, content });
  }

  if (!validated.length) {
    sendJson(res, 400, { ok: false, error: "No valid messages." });
    return;
  }

  const admin = getFirebaseAdmin();
  const useMemoryQuota = !admin && synthiqUseMemoryAiQuota();
  if (!admin && !useMemoryQuota) {
    sendJson(res, 503, {
      ok: false,
      error: "SynthIQ server needs Firebase Admin to enforce the AI message limit.",
      hint:
        "Add serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT_JSON. For local dev without Admin, set SYNTHIQ_USE_MEMORY_AI_QUOTA=1 in .env (quota resets when the server restarts).",
    });
    return;
  }

  let uid;
  if (admin) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      sendJson(res, 401, { ok: false, error: "Invalid or expired session." });
      return;
    }
  } else {
    const got = await verifyFirebaseIdTokenRest(idToken);
    if (!got) {
      sendJson(res, 401, { ok: false, error: "Invalid or expired session." });
      return;
    }
    uid = got.uid;
  }

  let preRemaining;
  let userData = {};
  const db = admin ? admin.firestore() : null;
  const userRef = db ? db.collection("users").doc(uid) : null;

  if (admin) {
    const userSnap = await userRef.get();
    userData = userSnap.exists ? userSnap.data() || {} : {};
    preRemaining = aiMessagesRemainingFromUserData(userData);
    let resetMs = msFromFirestoreTs(userData.aiMessagesResetAt);

    if (preRemaining <= 0 && resetMs !== null && Date.now() >= resetMs) {
      await userRef.set(
        {
          aiMessagesRemaining: AI_MESSAGE_QUOTA,
          aiMessagesResetAt: admin.firestore.FieldValue.delete(),
        },
        { merge: true }
      );
      preRemaining = AI_MESSAGE_QUOTA;
      userData = Object.assign({}, userData, {
        aiMessagesRemaining: AI_MESSAGE_QUOTA,
        aiMessagesResetAt: undefined,
      });
    }

    if (preRemaining <= 0) {
      let resetAtMillis = msFromFirestoreTs(userData.aiMessagesResetAt);
      if (resetAtMillis === null || resetAtMillis < Date.now()) {
        resetAtMillis = Date.now() + AI_MESSAGE_COOLDOWN_MS;
        await userRef.set(
          { aiMessagesResetAt: admin.firestore.Timestamp.fromMillis(resetAtMillis) },
          { merge: true }
        );
      }
      sendJson(res, 402, {
        ok: false,
        upgrade: true,
        error: "Chat limit reached.",
        messagesLeft: 0,
        resetAtMillis,
      });
      return;
    }
  } else {
    const row = memoryAiQuotaRow(uid);
    preRemaining = row.remaining;
    if (preRemaining <= 0) {
      if (row.resetAtMs == null || row.resetAtMs < Date.now()) {
        row.resetAtMs = Date.now() + AI_MESSAGE_COOLDOWN_MS;
      }
      sendJson(res, 402, {
        ok: false,
        upgrade: true,
        error: "Chat limit reached.",
        messagesLeft: 0,
        resetAtMillis: row.resetAtMs,
      });
      return;
    }
  }

  const anth = synthiqMessagesToAnthropicBody(validated);
  if (anth.error) {
    sendJson(res, 400, { ok: false, error: anth.error });
    return;
  }

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  const apiPayload = {
    model,
    max_tokens: 1024,
    messages: anth.messages,
  };
  if (anth.system) apiPayload.system = anth.system;

  let reply = "";
  try {
    const acRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": String(key).trim(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(apiPayload),
    });

    const rawText = await acRes.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      sendJson(res, 502, {
        ok: false,
        error: "Anthropic returned non-JSON (HTTP " + acRes.status + ").",
      });
      return;
    }
    if (!acRes.ok) {
      sendJson(res, 502, {
        ok: false,
        error: anthropicErrorMessage(data, rawText),
      });
      return;
    }

    reply = anthropicMessagesExtractReplyText(data);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || "Server error" });
    return;
  }

  let finalRemaining = preRemaining;
  if (admin) {
    try {
      await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);
        const d = snap.exists ? snap.data() || {} : {};
        let remaining = coerceAiMessagesRemaining(d.aiMessagesRemaining);
        if (remaining === null) remaining = AI_MESSAGE_QUOTA;
        remaining = Math.max(0, remaining - 1);
        finalRemaining = remaining;
        const patch = { aiMessagesRemaining: remaining };
        if (remaining === 0) {
          patch.aiMessagesResetAt = admin.firestore.Timestamp.fromMillis(
            Date.now() + AI_MESSAGE_COOLDOWN_MS
          );
        } else {
          patch.aiMessagesResetAt = admin.firestore.FieldValue.delete();
        }
        t.set(userRef, patch, { merge: true });
      });
    } catch (e) {
      console.warn("SynthIQ aiMessagesRemaining transaction:", e.message || e);
      sendJson(res, 500, { ok: false, error: "Could not update AI message quota." });
      return;
    }
  } else {
    const row = memoryAiQuotaByUid.get(uid);
    if (row) {
      row.remaining = Math.max(0, row.remaining - 1);
      finalRemaining = row.remaining;
      if (row.remaining === 0) {
        row.resetAtMs = Date.now() + AI_MESSAGE_COOLDOWN_MS;
      } else {
        row.resetAtMs = null;
      }
    }
  }

  sendJson(res, 200, {
    ok: true,
    reply,
    messagesLeft: finalRemaining,
  });
}

/** One-time Checkout amounts (USD cents) — keep in sync with pricing.html */
const STRIPE_CHECKOUT_PLANS = {
  standard_pro: { unitAmount: 1000, productName: "SynthIQ Standard Pro" },
  teams: { unitAmount: 2500, productName: "SynthIQ Teams" },
  teams_pro: { unitAmount: 6000, productName: "SynthIQ Teams Pro" },
};

function synthiqNormalizePublicOrigin(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.host) return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function stripeCreateCheckoutSession(secret, params) {
  const body = new URLSearchParams(params);
  const ac = new AbortController();
  const t = setTimeout(function () {
    ac.abort();
  }, 20000);
  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secret.trim(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2023-10-16",
      },
      body: body.toString(),
      signal: ac.signal,
    });
    const text = await r.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { ok: r.ok, status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

async function handleCreateCheckoutSession(req, res) {
  const secret = process.env.STRIPE_SECRET_KEY && String(process.env.STRIPE_SECRET_KEY).trim();
  if (!secret) {
    sendJson(res, 503, {
      ok: false,
      error: "Payments are not configured. Add STRIPE_SECRET_KEY to your server .env and restart.",
    });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const plan = typeof body.plan === "string" ? body.plan.trim() : "";
  const def = STRIPE_CHECKOUT_PLANS[plan];
  if (!def) {
    sendJson(res, 400, { ok: false, error: "Unknown plan." });
    return;
  }

  let origin = synthiqNormalizePublicOrigin(body.baseUrl);
  if (!origin) {
    try {
      const ref = req.headers.referer && String(req.headers.referer);
      if (ref) origin = synthiqNormalizePublicOrigin(ref);
    } catch {}
  }
  if (!origin) {
    origin = "http://127.0.0.1:" + PORT;
  }

  const successUrl = origin + "/pricing.html?checkout=success";
  const cancelUrl = origin + "/pricing.html?checkout=cancel";

  const params = {
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: plan,
    "metadata[plan]": plan,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(def.unitAmount),
    "line_items[0][price_data][product_data][name]": def.productName,
  };

  const { ok, status, data } = await stripeCreateCheckoutSession(secret, params);
  if (!ok || !data || !data.id) {
    const msg =
      (data && data.error && data.error.message) ||
      (typeof data === "object" && data.raw) ||
      "Could not start Checkout (" + status + ").";
    sendJson(res, 502, { ok: false, error: String(msg) });
    return;
  }
  if (!data.url) {
    sendJson(res, 502, { ok: false, error: "Stripe did not return a checkout URL." });
    return;
  }

  sendJson(res, 200, { ok: true, url: data.url });
}

async function synthiqRequestListener(req, res) {
  const pathname = pathnameOnly(req.url);

  if (
    req.method === "OPTIONS" &&
    (pathname === "/api/send-reset-email" ||
      pathname === "/api/sync-user-profile" ||
      pathname === "/api/list-my-teams" ||
      pathname === "/api/delete-team" ||
      pathname === "/api/open-explorer" ||
      pathname === "/api/save-to-downloads" ||
      pathname === "/api/pick-folder" ||
      pathname === "/api/save-session-as-file" ||
      pathname === "/api/anthropic-chat" ||
      pathname === "/api/create-checkout-session")
  ) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  if (req.method === "POST" && pathname === "/api/send-reset-email") {
    await handleSendResetEmail(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/sync-user-profile") {
    await handleSyncUserProfile(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/list-my-teams") {
    await handleListMyTeams(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/delete-team") {
    await handleDeleteTeam(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/open-explorer") {
    await handleOpenExplorer(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/save-to-downloads") {
    await handleSaveToDownloads(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/pick-folder") {
    await handlePickFolder(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/save-session-as-file") {
    await handleSaveSessionAsFile(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/create-checkout-session") {
    await handleCreateCheckoutSession(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/anthropic-chat") {
    await handleAnthropicChat(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD, POST, OPTIONS" });
    res.end();
    return;
  }

  const filePath = safeJoin(ROOT, req.url || "/");
  if (!filePath) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  const resolvedPath = signupFlatFallbackPath(ROOT, filePath, req.url || "/") || filePath;

  fs.stat(resolvedPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    fs.createReadStream(resolvedPath).pipe(res);
  });
}

const server = http.createServer(synthiqRequestListener);

function synthiqListenCallback() {
  console.log(`SynthIQ listening on http://localhost:${PORT}`);
  try {
    const inSignup = path.join(ROOT, "signup", "synthiq-1.html");
    const flat = path.join(ROOT, "synthiq-1.html");
    const fb = path.join(ROOT, "signup", "signup-firebase.js");
    const flatFb = path.join(ROOT, "signup-firebase.js");
    if (fs.existsSync(inSignup) || fs.existsSync(flat)) {
      console.log("SynthIQ: sign-up page found (signup/ or flat root).");
    } else {
      console.warn("SynthIQ: NO sign-up entry — add signup/synthiq-1.html (or synthiq-1.html at repo root).");
    }
    if (fs.existsSync(fb) || fs.existsSync(flatFb)) {
      console.log("SynthIQ: signup-firebase.js found.");
    } else {
      console.warn("SynthIQ: NO signup-firebase.js — login will not work.");
    }
  } catch (e) {
    console.warn("SynthIQ: could not check signup files:", e.message || e);
  }
  if (process.env.ANTHROPIC_API_KEY && String(process.env.ANTHROPIC_API_KEY).trim()) {
    console.log(
      "SynthIQ: Anthropic proxy enabled (/api/anthropic-chat). Model:",
      process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    );
  } else {
    console.log(
      "SynthIQ: Anthropic disabled — set ANTHROPIC_API_KEY and restart for Chat with AI.",
    );
  }
  if (process.env.STRIPE_SECRET_KEY && String(process.env.STRIPE_SECRET_KEY).trim()) {
    console.log("SynthIQ: Stripe Checkout enabled (/api/create-checkout-session).");
  } else {
    console.log(
      "SynthIQ: Stripe Checkout disabled — set STRIPE_SECRET_KEY in .env for plan purchases.",
    );
  }
  const fbAdminReady = getFirebaseAdmin();
  if (!fbAdminReady && synthiqUseMemoryAiQuota()) {
    console.log(
      "SynthIQ: AI chat uses in-memory quota (SYNTHIQ_USE_MEMORY_AI_QUOTA). Quota resets when the server restarts; add Firebase Admin for persistent limits + /api/sync-user-profile.",
    );
  }
}

if (require.main === module) {
  server.listen(PORT, synthiqListenCallback);
}

module.exports = { synthiqRequestListener };
