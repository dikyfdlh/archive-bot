import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { getMissingConfig } from "./config.js";

const ENV_PATH = resolve(process.cwd(), ".env");
const MAX_ADMIN_BODY_BYTES = 1_048_576;

const ENV_FIELDS = [
  {
    title: "Server",
    fields: [
      field("PORT", "Port server", "number", "3000"),
      field("PUBLIC_BASE_URL", "Public base URL", "url", "https://domain-kamu.com"),
      field("WEBHOOK_MAX_BODY_BYTES", "Maksimum body webhook", "number", "10485760"),
      field("ADMIN_TOKEN", "Token panel admin", "password", "", true)
    ]
  },
  {
    title: "WhatsApp Cloud API",
    fields: [
      field("WHATSAPP_API_VERSION", "API version", "text", "v23.0"),
      field("WHATSAPP_VERIFY_TOKEN", "Verify token webhook", "password", "", true),
      field("WHATSAPP_ACCESS_TOKEN", "Access token", "textarea", "", true),
      field("WHATSAPP_PHONE_NUMBER_ID", "Phone number ID", "text"),
      field("WHATSAPP_APP_SECRET", "App secret", "password", "", true),
      field("AUTHORIZED_WA_NUMBERS", "Nomor pengguna diizinkan", "textarea", "6281234567890")
    ]
  },
  {
    title: "Google Drive",
    fields: [
      field("GOOGLE_DRIVE_AUTH_MODE", "Auth mode", "select", "service_account", false, [
        "service_account",
        "oauth_access_token"
      ]),
      field("GOOGLE_DRIVE_FOLDER_ID", "Folder ID Google Drive", "text"),
      field("GOOGLE_DRIVE_SCOPE", "Scope Google Drive", "text", "https://www.googleapis.com/auth/drive"),
      field("GOOGLE_SERVICE_ACCOUNT_EMAIL", "Service account email", "email"),
      field("GOOGLE_PRIVATE_KEY", "Private key", "textarea", "", true),
      field("GOOGLE_DRIVE_IMPERSONATE_USER", "Impersonate user", "email"),
      field("GOOGLE_OAUTH_ACCESS_TOKEN", "OAuth access token", "textarea", "", true)
    ]
  },
  {
    title: "Archive Bot",
    fields: [
      field("ARCHIVE_STORAGE_PATH", "Path metadata arsip", "text", "./data/archive-index.json"),
      field("SEND_FILES_DIRECTLY", "Kirim file langsung ke WhatsApp", "select", "true", false, [
        "true",
        "false"
      ]),
      field("MAX_SEND_FILE_BYTES", "Maksimum ukuran kirim file", "number", "95000000")
    ]
  }
];

const ORDERED_KEYS = ENV_FIELDS.flatMap((group) => group.fields.map((item) => item.key));

export async function handleAdminRequest(req, res, url, config) {
  if (req.method === "GET" && url.pathname === "/admin") {
    if (!config.adminToken) {
      if (isLocalRequest(req)) {
        sendHtml(res, 200, renderAdminHtml(config));
      } else {
        sendHtml(res, 503, renderSetupRequiredHtml());
      }
      return true;
    }

    if (isAuthorized(req, url, config)) {
      sendHtml(res, 200, renderAdminHtml(config));
    } else {
      sendHtml(res, 200, renderLoginHtml());
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/admin/login") {
    const rawBody = await readRawBody(req, MAX_ADMIN_BODY_BYTES);
    const payload = parseJsonBody(rawBody);
    const provided = String(payload.password || "").trim();

    if (!config.adminToken) {
      sendJson(res, 401, {
        ok: false,
        error: "ADMIN_TOKEN belum diset di server. Isi field ADMIN_TOKEN di .env lalu restart bot."
      });
      return true;
    }

    if (!provided) {
      await sleep(400);
      sendJson(res, 401, { ok: false, error: "Password wajib diisi." });
      return true;
    }

    const expectedBuffer = Buffer.from(config.adminToken);
    const providedBuffer = Buffer.from(provided);

    const valid =
      expectedBuffer.length === providedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, providedBuffer);

    if (!valid) {
      await sleep(400);
      sendJson(res, 401, { ok: false, error: "Password salah." });
      return true;
    }

    const secure = isHttpsRequest(req) ? " Secure;" : "";
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `admin_token=${encodeURIComponent(provided)}; Path=/;${secure} HttpOnly; SameSite=Strict; Max-Age=86400`
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/admin/logout") {
    const secure = isHttpsRequest(req) ? " Secure;" : "";
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `admin_token=; Path=/;${secure} HttpOnly; SameSite=Strict; Max-Age=0`
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (url.pathname === "/api/admin/env") {
    if (!isAuthorized(req, url, config)) {
      sendJson(res, 401, {
        ok: false,
        error: config.adminToken
          ? "Admin token salah atau belum dikirim."
          : "ADMIN_TOKEN masih kosong. Akses tanpa token hanya boleh dari localhost."
      });
      return true;
    }

    if (req.method === "GET") {
      const env = readEnvFile();
      sendJson(res, 200, {
        ok: true,
        schema: ENV_FIELDS,
        values: pickKnownValues(env),
        missingConfig: getMissingConfig(),
        envPath: ENV_PATH,
        restartRequired: false
      });
      return true;
    }

    if (req.method === "POST") {
      const rawBody = await readRawBody(req, MAX_ADMIN_BODY_BYTES);
      const payload = parseJsonBody(rawBody);
      const nextValues = normalizeEnvValues(payload.values || {});
      const validation = validateEnvValues(nextValues);

      if (validation.errors.length > 0) {
        sendJson(res, 400, {
          ok: false,
          errors: validation.errors
        });
        return true;
      }

      const current = readEnvFile();
      const merged = {
        ...current,
        ...nextValues
      };

      writeEnvFile(merged);

      sendJson(res, 200, {
        ok: true,
        message: "Konfigurasi .env tersimpan. Restart server agar semua perubahan aktif.",
        restartRequired: true
      });
      return true;
    }

    sendJson(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
    return true;
  }

  return false;
}

function field(key, label, type = "text", placeholder = "", secret = false, options = []) {
  return { key, label, type, placeholder, secret, options };
}

function isAuthorized(req, url, config) {
  const expected = config.adminToken;
  const provided = getProvidedToken(req, url);

  if (!expected) {
    return isLocalRequest(req);
  }

  if (!provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function getProvidedToken(req, url) {
  const authorization = req.headers.authorization || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return (
    req.headers["x-admin-token"] ||
    url.searchParams.get("token") ||
    parseCookie(req.headers.cookie || "").admin_token ||
    ""
  );
}

function isLocalRequest(req) {
  const address = req.socket.remoteAddress || "";
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

function isHttpsRequest(req) {
  if (req.socket?.encrypted) return true;
  const forwarded = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return forwarded.split(",")[0].trim() === "https";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnvFile() {
  if (!existsSync(ENV_PATH)) {
    return {};
  }

  const env = {};
  const lines = readFileSync(ENV_PATH, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsAt).trim();
    let value = trimmed.slice(equalsAt + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value.replaceAll("\\n", "\n");
  }

  return env;
}

function writeEnvFile(values) {
  const unknownKeys = Object.keys(values)
    .filter((key) => !ORDERED_KEYS.includes(key))
    .sort();

  const lines = [];
  lines.push("# Managed by Archive Manager Bot admin panel");
  lines.push("# Restart server after saving changes.");

  for (const group of ENV_FIELDS) {
    lines.push("");
    lines.push(`# ${group.title}`);

    for (const item of group.fields) {
      lines.push(`${item.key}=${formatEnvValue(values[item.key] || "")}`);
    }
  }

  if (unknownKeys.length > 0) {
    lines.push("");
    lines.push("# Other");

    for (const key of unknownKeys) {
      lines.push(`${key}=${formatEnvValue(values[key] || "")}`);
    }
  }

  writeFileSync(ENV_PATH, `${lines.join("\n")}\n`);
}

function formatEnvValue(value) {
  const text = String(value || "");
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');

  if (!text || /[\s#"'\\\n]/.test(text)) {
    return `"${escaped}"`;
  }

  return escaped;
}

function pickKnownValues(env) {
  const values = {};

  for (const key of ORDERED_KEYS) {
    values[key] = env[key] || "";
  }

  return values;
}

function normalizeEnvValues(values) {
  const normalized = {};

  for (const key of ORDERED_KEYS) {
    normalized[key] = String(values[key] ?? "").trim();
  }

  normalized.GOOGLE_PRIVATE_KEY = String(values.GOOGLE_PRIVATE_KEY ?? "")
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\\n/g, "\n");
  normalized.WHATSAPP_ACCESS_TOKEN = String(values.WHATSAPP_ACCESS_TOKEN ?? "").trim();
  normalized.GOOGLE_OAUTH_ACCESS_TOKEN = String(values.GOOGLE_OAUTH_ACCESS_TOKEN ?? "").trim();
  normalized.AUTHORIZED_WA_NUMBERS = String(values.AUTHORIZED_WA_NUMBERS ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(",");

  return normalized;
}

function validateEnvValues(values) {
  const errors = [];

  if (values.PORT && !isPositiveInteger(values.PORT)) {
    errors.push("PORT harus angka positif.");
  }

  if (values.WEBHOOK_MAX_BODY_BYTES && !isPositiveInteger(values.WEBHOOK_MAX_BODY_BYTES)) {
    errors.push("WEBHOOK_MAX_BODY_BYTES harus angka positif.");
  }

  if (values.MAX_SEND_FILE_BYTES && !isPositiveInteger(values.MAX_SEND_FILE_BYTES)) {
    errors.push("MAX_SEND_FILE_BYTES harus angka positif.");
  }

  if (!["service_account", "oauth_access_token"].includes(values.GOOGLE_DRIVE_AUTH_MODE)) {
    errors.push("GOOGLE_DRIVE_AUTH_MODE harus service_account atau oauth_access_token.");
  }

  if (!["true", "false"].includes(values.SEND_FILES_DIRECTLY)) {
    errors.push("SEND_FILES_DIRECTLY harus true atau false.");
  }

  if (values.GOOGLE_PRIVATE_KEY && !values.GOOGLE_PRIVATE_KEY.includes("BEGIN PRIVATE KEY")) {
    errors.push("GOOGLE_PRIVATE_KEY terlihat belum valid.");
  }

  return { errors };
}

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

async function readRawBody(req, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;

    if (total > maxBytes) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function parseJsonBody(rawBody) {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    return {};
  }
}

function parseCookie(cookie) {
  const result = {};

  for (const part of cookie.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key) {
      result[key] = decodeURIComponent(valueParts.join("=") || "");
    }
  }

  return result;
}

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function renderAdminHtml(config) {
  const needsToken = Boolean(config.adminToken);

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Archive Bot Config</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #667085;
      --line: #d9dee7;
      --primary: #1769e0;
      --primary-dark: #0f56bd;
      --danger: #b42318;
      --ok: #067647;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, Segoe UI, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      padding: 18px 24px;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    .wrap {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
    }
    .top {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
    }
    h1 {
      font-size: 20px;
      line-height: 1.2;
      margin: 0;
      letter-spacing: 0;
    }
    .sub {
      color: var(--muted);
      font-size: 13px;
      margin-top: 4px;
    }
    main { padding: 24px 0 40px; }
    .auth, .notice, .group {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .notice {
      display: none;
      font-size: 14px;
      line-height: 1.45;
    }
    .notice.show { display: block; }
    .notice.ok { border-color: #8ed7b0; color: var(--ok); background: #f0fdf4; }
    .notice.err { border-color: #f4a29b; color: var(--danger); background: #fff3f1; }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .full { grid-column: 1 / -1; }
    label {
      display: block;
      font-size: 13px;
      font-weight: 650;
      margin-bottom: 7px;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--text);
      padding: 10px 11px;
      font: inherit;
      font-size: 14px;
      outline: none;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(23, 105, 224, .12);
    }
    textarea {
      min-height: 90px;
      resize: vertical;
      font-family: Consolas, Menlo, monospace;
      line-height: 1.4;
    }
    .secret-row {
      display: flex;
      gap: 8px;
      align-items: stretch;
    }
    .secret-row input, .secret-row textarea { flex: 1; }
    button {
      border: 0;
      border-radius: 7px;
      padding: 10px 13px;
      font: inherit;
      font-size: 14px;
      font-weight: 650;
      cursor: pointer;
      background: var(--primary);
      color: white;
      white-space: nowrap;
    }
    button:hover { background: var(--primary-dark); }
    button.secondary {
      background: #eef2f7;
      color: #283544;
      border: 1px solid var(--line);
    }
    button.secondary:hover { background: #e4e9f1; }
    .actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      position: sticky;
      bottom: 0;
      background: rgba(246,247,249,.94);
      border-top: 1px solid var(--line);
      padding: 14px 0;
      backdrop-filter: blur(8px);
    }
    h2 {
      font-size: 16px;
      margin: 0 0 14px;
      letter-spacing: 0;
    }
    .hint {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
      line-height: 1.35;
    }
    .missing {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .pill {
      background: #fff7ed;
      color: #9a3412;
      border: 1px solid #fed7aa;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
    }
    @media (max-width: 760px) {
      header { padding: 14px 16px; }
      .top { align-items: flex-start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      .actions { justify-content: stretch; }
      .actions button { flex: 1; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap top">
      <div>
        <h1>Archive Manager Bot Config</h1>
        <div class="sub">Edit file .env dari browser. Simpan lalu restart server.</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="secondary" id="reloadBtn" type="button">Reload</button>
        <button class="secondary" id="logoutBtn" type="button">Logout</button>
      </div>
    </div>
  </header>
  <main class="wrap">
    <section class="auth">
      <div>
        <label>Status konfigurasi</label>
        <div id="missing" class="missing"></div>
      </div>
    </section>
    <div id="notice" class="notice"></div>
    <form id="envForm"></form>
    <div class="actions">
      <button class="secondary" id="copyWebhookBtn" type="button">Copy Webhook URL</button>
      <button id="saveBtn" type="button">Simpan .env</button>
    </div>
  </main>
  <script>
    const form = document.querySelector("#envForm");
    const notice = document.querySelector("#notice");
    const missing = document.querySelector("#missing");
    const reloadBtn = document.querySelector("#reloadBtn");
    const saveBtn = document.querySelector("#saveBtn");
    const copyWebhookBtn = document.querySelector("#copyWebhookBtn");
    const logoutBtn = document.querySelector("#logoutBtn");
    let schema = [];

    // Auth via HttpOnly cookie - browser kirim otomatis di same-origin fetch.
    function headers() { return {}; }

    function show(message, type = "ok") {
      notice.textContent = message;
      notice.className = "notice show " + type;
    }

    function renderMissing(items) {
      missing.innerHTML = "";
      if (!items || items.length === 0) {
        const span = document.createElement("span");
        span.className = "hint";
        span.textContent = "Tidak ada field wajib yang kosong.";
        missing.appendChild(span);
        return;
      }
      for (const item of items) {
        const pill = document.createElement("span");
        pill.className = "pill";
        pill.textContent = item;
        missing.appendChild(pill);
      }
    }

    function renderForm(values) {
      form.innerHTML = "";
      for (const group of schema) {
        const section = document.createElement("section");
        section.className = "group";
        const title = document.createElement("h2");
        title.textContent = group.title;
        section.appendChild(title);

        const grid = document.createElement("div");
        grid.className = "grid";
        section.appendChild(grid);

        for (const field of group.fields) {
          const wrap = document.createElement("div");
          const isLong = field.type === "textarea" || field.key.includes("TOKEN") || field.key.includes("PRIVATE_KEY") || field.key === "AUTHORIZED_WA_NUMBERS";
          if (isLong) wrap.className = "full";

          const label = document.createElement("label");
          label.htmlFor = field.key;
          label.textContent = field.label + " (" + field.key + ")";
          wrap.appendChild(label);

          const input = createInput(field, values[field.key] || "");
          wrap.appendChild(input);

          const hint = document.createElement("div");
          hint.className = "hint";
          hint.textContent = hintFor(field.key);
          if (hint.textContent) wrap.appendChild(hint);

          grid.appendChild(wrap);
        }

        form.appendChild(section);
      }
    }

    function createInput(field, value) {
      let input;
      if (field.type === "textarea") {
        input = document.createElement("textarea");
      } else if (field.type === "select") {
        input = document.createElement("select");
        for (const optionValue of field.options) {
          const option = document.createElement("option");
          option.value = optionValue;
          option.textContent = optionValue;
          input.appendChild(option);
        }
      } else {
        input = document.createElement("input");
        input.type = field.type === "password" ? "password" : field.type;
      }
      input.id = field.key;
      input.name = field.key;
      input.placeholder = field.placeholder || "";
      input.value = value;
      return input;
    }

    function hintFor(key) {
      const hints = {
        PUBLIC_BASE_URL: "Domain HTTPS publik, contoh https://arsip.domain.com",
        ADMIN_TOKEN: "Isi token panjang dan acak sebelum membuka panel ini dari internet.",
        AUTHORIZED_WA_NUMBERS: "Pisahkan nomor dengan koma atau baris baru, format tanpa tanda +.",
        WHATSAPP_VERIFY_TOKEN: "Harus sama dengan verify token di dashboard Meta.",
        WHATSAPP_APP_SECRET: "Opsional, tetapi disarankan untuk validasi signature webhook.",
        GOOGLE_DRIVE_FOLDER_ID: "Ambil dari URL folder Google Drive.",
        GOOGLE_PRIVATE_KEY: "Tempel isi private_key dari JSON service account.",
        GOOGLE_OAUTH_ACCESS_TOKEN: "Hanya dipakai jika auth mode oauth_access_token.",
        ARCHIVE_STORAGE_PATH: "Metadata lokal akan disimpan di path ini.",
        MAX_SEND_FILE_BYTES: "Jika file lebih besar, bot mengirim link Drive."
      };
      return hints[key] || "";
    }

    function handleUnauthorized() {
      // cookie expired / hilang -> kembali ke login page
      location.href = "/admin";
    }

    async function loadConfig() {
      const response = await fetch("/api/admin/env", { credentials: "same-origin" });
      if (response.status === 401) { handleUnauthorized(); return; }
      const data = await response.json();
      if (!response.ok) {
        show(data.error || "Gagal memuat konfigurasi.", "err");
        return;
      }
      schema = data.schema;
      renderMissing(data.missingConfig);
      renderForm(data.values);
      show("Konfigurasi dimuat dari .env.", "ok");
    }

    async function saveConfig() {
      const values = {};
      for (const element of form.elements) {
        if (element.name) values[element.name] = element.value;
      }
      const response = await fetch("/api/admin/env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ values })
      });
      if (response.status === 401) { handleUnauthorized(); return; }
      const data = await response.json();
      if (!response.ok) {
        show((data.errors || [data.error || "Gagal menyimpan .env."]).join("\\n"), "err");
        return;
      }
      show(data.message || "Tersimpan.", "ok");
    }

    async function logout() {
      try {
        await fetch("/admin/logout", { method: "POST", credentials: "same-origin" });
      } catch (e) { /* ignore */ }
      location.href = "/admin";
    }

    reloadBtn.addEventListener("click", loadConfig);
    saveBtn.addEventListener("click", saveConfig);
    logoutBtn.addEventListener("click", logout);
    copyWebhookBtn.addEventListener("click", async () => {
      const base = document.querySelector("[name=PUBLIC_BASE_URL]")?.value || location.origin;
      const webhook = base.replace(/\\/$/, "") + "/webhook";
      await navigator.clipboard.writeText(webhook);
      show("Webhook URL disalin: " + webhook, "ok");
    });

    loadConfig();
  </script>
</body>
</html>`;
}

function renderLoginHtml() {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login - Archive Bot Admin</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0b1220;
      --panel: #131c2e;
      --text: #e6ecf5;
      --muted: #94a3b8;
      --line: #243049;
      --accent: #4c8dff;
      --accent-2: #7aa8ff;
      --err: #ef4444;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f4f6fb;
        --panel: #ffffff;
        --text: #0f172a;
        --muted: #64748b;
        --line: #e2e8f0;
        --accent: #1d4ed8;
        --accent-2: #2563eb;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; }
    body {
      font-family: ui-sans-serif, system-ui, "Segoe UI", Inter, Arial, sans-serif;
      background:
        radial-gradient(900px 500px at 90% -10%, rgba(76,141,255,.18), transparent 60%),
        radial-gradient(700px 400px at -10% 110%, rgba(16,185,129,.10), transparent 60%),
        var(--bg);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(420px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 28px;
      box-shadow: 0 20px 60px rgba(0,0,0,.35);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 18px;
    }
    .logo {
      width: 40px; height: 40px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--accent), #22d3ee);
      display: grid; place-items: center;
      color: white; font-weight: 800; font-size: 18px;
      box-shadow: 0 6px 20px rgba(76,141,255,.4);
    }
    h1 { font-size: 18px; margin: 0; }
    .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
    label {
      display: block;
      font-size: 13px;
      font-weight: 650;
      margin: 14px 0 6px;
    }
    input[type=password] {
      width: 100%;
      padding: 11px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,.04);
      color: var(--text);
      font: inherit;
      font-size: 14px;
      outline: none;
    }
    input[type=password]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(76,141,255,.18);
    }
    button {
      margin-top: 16px;
      width: 100%;
      padding: 12px 14px;
      border: 0;
      border-radius: 8px;
      background: var(--accent);
      color: white;
      font: inherit;
      font-size: 14px;
      font-weight: 650;
      cursor: pointer;
      transition: filter .15s ease;
    }
    button:hover:not(:disabled) { filter: brightness(1.1); }
    button:disabled { opacity: .6; cursor: progress; }
    .err {
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(239,68,68,.10);
      border: 1px solid rgba(239,68,68,.4);
      color: var(--err);
      font-size: 13px;
      display: none;
    }
    .err.show { display: block; }
    .hint {
      margin-top: 16px;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }
    a { color: var(--accent-2); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <form class="card" id="loginForm" autocomplete="on">
    <div class="brand">
      <div class="logo">A</div>
      <div>
        <h1>Archive Bot Admin</h1>
        <div class="sub">Masukkan password untuk lanjut</div>
      </div>
    </div>

    <label for="password">Password admin</label>
    <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>

    <button type="submit" id="submitBtn">Masuk</button>
    <div class="err" id="err"></div>

    <div class="hint"><a href="/">← kembali ke dashboard</a></div>
  </form>
  <script>
    const form = document.querySelector("#loginForm");
    const password = document.querySelector("#password");
    const btn = document.querySelector("#submitBtn");
    const err = document.querySelector("#err");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      err.classList.remove("show");
      btn.disabled = true;
      btn.textContent = "Memeriksa...";

      try {
        const response = await fetch("/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ password: password.value })
        });
        const data = await response.json();

        if (response.ok && data.ok) {
          location.href = "/admin";
          return;
        }

        err.textContent = data.error || "Login gagal.";
        err.classList.add("show");
        password.select();
      } catch (e) {
        err.textContent = "Network error: " + e.message;
        err.classList.add("show");
      } finally {
        btn.disabled = false;
        btn.textContent = "Masuk";
      }
    });
  </script>
</body>
</html>`;
}

function renderSetupRequiredHtml() {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Setup Required - Archive Bot</title>
  <style>
    body {
      font-family: ui-sans-serif, system-ui, "Segoe UI", Inter, Arial, sans-serif;
      background: #0b1220;
      color: #e6ecf5;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      margin: 0;
    }
    .card {
      max-width: 520px;
      background: #131c2e;
      border: 1px solid #243049;
      border-radius: 14px;
      padding: 28px;
      line-height: 1.55;
    }
    h1 { margin: 0 0 12px; font-size: 18px; color: #f59e0b; }
    code { background: rgba(255,255,255,.06); padding: 2px 6px; border-radius: 4px; }
    pre { background: rgba(0,0,0,.35); padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠ ADMIN_TOKEN belum diset</h1>
    <p>Panel admin tidak bisa diakses dari internet sebelum kamu mengisi <code>ADMIN_TOKEN</code> di file <code>.env</code>.</p>
    <p>Generate token random di terminal VPS:</p>
    <pre>openssl rand -hex 32</pre>
    <p>Tempel hasilnya ke field <code>ADMIN_TOKEN</code> di <code>/opt/archive-manager-bot/.env</code>, lalu restart:</p>
    <pre>sudo systemctl restart archive-bot</pre>
    <p>Setelah itu refresh halaman ini, kamu akan dapat form login.</p>
  </div>
</body>
</html>`;
}
