export class EventTracker {
  constructor(limit = 20) {
    this.limit = limit;
    this.events = [];
    this.counters = {
      webhookReceived: 0,
      messagesProcessed: 0,
      archivesCreated: 0,
      errors: 0
    };
    this.startedAt = new Date();
    this.lastWebhookAt = null;
  }

  record(event) {
    this.events.unshift({ time: new Date().toISOString(), ...event });
    if (this.events.length > this.limit) {
      this.events.length = this.limit;
    }
  }

  recordWebhook(summary) {
    this.counters.webhookReceived += 1;
    this.lastWebhookAt = new Date().toISOString();
    this.record({
      kind: "webhook",
      summary
    });
  }

  recordMessage(detail) {
    this.counters.messagesProcessed += 1;
    this.record({ kind: "message", ...detail });
  }

  recordArchive(detail) {
    this.counters.archivesCreated += 1;
    this.record({ kind: "archive", ...detail });
  }

  recordError(detail) {
    this.counters.errors += 1;
    this.record({ kind: "error", ...detail });
  }

  snapshot() {
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      lastWebhookAt: this.lastWebhookAt,
      counters: { ...this.counters },
      recent: [...this.events]
    };
  }
}

export function buildDashboardState({ config, missingConfig, tracker, archiveCount }) {
  const webhookUrl = config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/$/, "")}/webhook`
    : "(set PUBLIC_BASE_URL untuk melihat URL webhook publik)";

  return {
    service: "archive-manager-bot",
    ready: missingConfig.length === 0,
    missingConfig,
    webhookUrl,
    verifyTokenSet: Boolean(config.whatsapp.verifyToken),
    appSecretSet: Boolean(config.whatsapp.appSecret),
    phoneNumberIdSet: Boolean(config.whatsapp.phoneNumberId),
    accessTokenSet: Boolean(config.whatsapp.accessToken),
    authorizedNumbers: config.authorizedWaNumbers.length,
    driveAuthMode: config.googleDrive.authMode,
    driveFolderIdSet: Boolean(config.googleDrive.folderId),
    driveServiceAccountSet: Boolean(config.googleDrive.serviceAccountEmail),
    drivePrivateKeySet: Boolean(config.googleDrive.privateKey),
    driveImpersonate: config.googleDrive.impersonateUser || null,
    archiveCount,
    nodeVersion: process.version,
    ...tracker.snapshot()
  };
}

export function renderDashboardHtml(state) {
  const statusPill = state.ready
    ? `<span class="pill ok">READY</span>`
    : `<span class="pill warn">NOT READY (${state.missingConfig.length} field kosong)</span>`;

  const missingPills = state.missingConfig.length
    ? state.missingConfig.map((item) => `<span class="pill warn">${escape(item)}</span>`).join("")
    : `<span class="pill ok">Semua field wajib terisi</span>`;

  const impersonateWarning =
    state.driveImpersonate && /@gmail\.com$/i.test(state.driveImpersonate)
      ? `<div class="warn-box">⚠ <code>GOOGLE_DRIVE_IMPERSONATE_USER</code> berisi alamat @gmail.com. Impersonation hanya jalan di Google Workspace dengan domain-wide delegation. Kosongkan field ini di .env atau panel admin.</div>`
      : "";

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <title>Archive Bot - Status</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0b1220;
      --panel: #131c2e;
      --panel-2: #1a2540;
      --text: #e6ecf5;
      --muted: #94a3b8;
      --line: #243049;
      --accent: #4c8dff;
      --accent-2: #7aa8ff;
      --ok: #10b981;
      --warn: #f59e0b;
      --err: #ef4444;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f4f6fb;
        --panel: #ffffff;
        --panel-2: #f6f8fc;
        --text: #0f172a;
        --muted: #64748b;
        --line: #e2e8f0;
        --accent: #1d4ed8;
        --accent-2: #2563eb;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      font-family: ui-sans-serif, system-ui, "Segoe UI", Inter, Arial, sans-serif;
      background:
        radial-gradient(1200px 600px at 90% -10%, rgba(76,141,255,.15), transparent 60%),
        radial-gradient(900px 500px at -10% 30%, rgba(16,185,129,.10), transparent 60%),
        var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.45;
    }
    .wrap { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 56px; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 22px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo {
      width: 38px; height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--accent), #22d3ee);
      display: grid; place-items: center;
      box-shadow: 0 6px 20px rgba(76,141,255,.35);
      font-weight: 800;
      color: white;
      font-size: 18px;
    }
    h1 { font-size: 22px; margin: 0; letter-spacing: .2px; }
    .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
    .badges { display: flex; gap: 8px; flex-wrap: wrap; }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 16px;
    }
    .card {
      grid-column: span 12;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 18px 18px 16px;
    }
    @media (min-width: 760px) {
      .col-4 { grid-column: span 4; }
      .col-6 { grid-column: span 6; }
      .col-8 { grid-column: span 8; }
    }
    h2 {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin: 0 0 12px;
      color: var(--muted);
      font-weight: 700;
    }
    .row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px dashed var(--line); }
    .row:last-child { border-bottom: 0; }
    .row b { font-weight: 650; }
    .mono { font-family: ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace; font-size: 13px; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 650;
      letter-spacing: .3px;
    }
    .pill.ok { background: rgba(16,185,129,.12); color: var(--ok); border: 1px solid rgba(16,185,129,.35); }
    .pill.warn { background: rgba(245,158,11,.12); color: var(--warn); border: 1px solid rgba(245,158,11,.4); }
    .pill.err { background: rgba(239,68,68,.12); color: var(--err); border: 1px solid rgba(239,68,68,.4); }
    .pill.muted { background: rgba(148,163,184,.12); color: var(--muted); border: 1px solid var(--line); }
    .pill.ok::before, .pill.warn::before, .pill.err::before, .pill.muted::before {
      content: "";
      width: 6px; height: 6px; border-radius: 50%;
      background: currentColor;
    }
    .url-row {
      display: flex; gap: 8px; align-items: stretch;
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 4px;
    }
    .url-row code {
      flex: 1;
      padding: 9px 12px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--accent-2);
    }
    .btn {
      cursor: pointer;
      border: 0;
      padding: 8px 14px;
      border-radius: 8px;
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      background: var(--accent);
      color: white;
      transition: filter .15s ease;
    }
    .btn:hover { filter: brightness(1.1); }
    .btn.ghost { background: transparent; border: 1px solid var(--line); color: var(--text); }
    .stat {
      display: flex;
      gap: 12px;
      align-items: baseline;
    }
    .stat .num {
      font-size: 30px;
      font-weight: 700;
      letter-spacing: -.5px;
    }
    .stat .lbl {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    @media (min-width: 760px) { .stats { grid-template-columns: repeat(4, 1fr); } }
    .stat-card {
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px 16px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
    th { color: var(--muted); font-weight: 600; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }
    tr:last-child td { border-bottom: 0; }
    .empty {
      padding: 18px;
      color: var(--muted);
      text-align: center;
      border: 1px dashed var(--line);
      border-radius: 10px;
      font-size: 13px;
    }
    .warn-box {
      background: rgba(245,158,11,.10);
      border: 1px solid rgba(245,158,11,.4);
      color: var(--warn);
      padding: 12px 14px;
      border-radius: 10px;
      margin-bottom: 16px;
      font-size: 13px;
    }
    .warn-box code { background: rgba(0,0,0,.18); padding: 1px 5px; border-radius: 4px; }
    .endpoints code { background: var(--panel-2); padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }
    .footnote { color: var(--muted); font-size: 12px; margin-top: 18px; text-align: center; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; }
    a { color: var(--accent-2); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .copy-flash { color: var(--ok); font-size: 12px; opacity: 0; transition: opacity .2s; }
    .copy-flash.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">
        <div class="logo">A</div>
        <div>
          <h1>Archive Manager Bot</h1>
          <div class="sub">WhatsApp → Google Drive · auto-refresh 10s</div>
        </div>
      </div>
      <div class="badges">
        ${statusPill}
        <span class="pill muted">uptime ${formatUptime(state.uptimeSec)}</span>
        <span class="pill muted">node ${escape(state.nodeVersion)}</span>
      </div>
    </header>

    ${impersonateWarning}

    <div class="grid">
      <section class="card col-8">
        <h2>Webhook URL</h2>
        <div class="url-row">
          <code id="webhookUrl" class="mono">${escape(state.webhookUrl)}</code>
          <button class="btn" id="copyBtn" type="button">Copy</button>
        </div>
        <div class="footnote" style="text-align:left;margin-top:8px;">
          <span id="copyFlash" class="copy-flash">URL disalin ke clipboard</span>
          Daftarkan URL ini di Meta Developers → WhatsApp → Configuration.
          Verify token harus sama dengan <code class="mono">WHATSAPP_VERIFY_TOKEN</code>.
        </div>
      </section>

      <section class="card col-4">
        <h2>Status WhatsApp</h2>
        <div class="row"><span>Verify token</span>${flag(state.verifyTokenSet)}</div>
        <div class="row"><span>Access token</span>${flag(state.accessTokenSet)}</div>
        <div class="row"><span>Phone Number ID</span>${flag(state.phoneNumberIdSet)}</div>
        <div class="row"><span>App secret</span>${flag(state.appSecretSet)}</div>
        <div class="row"><span>Authorized numbers</span><b>${state.authorizedNumbers}</b></div>
      </section>

      <section class="card col-12">
        <h2>Live activity</h2>
        <div class="stats">
          <div class="stat-card">
            <div class="stat"><div class="num">${state.counters.webhookReceived}</div><div class="lbl">Webhooks</div></div>
          </div>
          <div class="stat-card">
            <div class="stat"><div class="num">${state.counters.messagesProcessed}</div><div class="lbl">Pesan diproses</div></div>
          </div>
          <div class="stat-card">
            <div class="stat"><div class="num">${state.counters.archivesCreated}</div><div class="lbl">Arsip dibuat</div></div>
          </div>
          <div class="stat-card">
            <div class="stat"><div class="num">${state.archiveCount}</div><div class="lbl">Total di index</div></div>
          </div>
        </div>
      </section>

      <section class="card col-6">
        <h2>Status Google Drive</h2>
        <div class="row"><span>Auth mode</span><b class="mono">${escape(state.driveAuthMode)}</b></div>
        <div class="row"><span>Folder ID</span>${flag(state.driveFolderIdSet)}</div>
        <div class="row"><span>Service account email</span>${flag(state.driveServiceAccountSet)}</div>
        <div class="row"><span>Private key</span>${flag(state.drivePrivateKeySet)}</div>
        <div class="row"><span>Impersonate</span><span class="mono">${state.driveImpersonate ? escape(state.driveImpersonate) : "(none)"}</span></div>
      </section>

      <section class="card col-6">
        <h2>Endpoint</h2>
        <div class="row endpoints"><span>Webhook receiver</span><code class="mono">POST /webhook</code></div>
        <div class="row endpoints"><span>Webhook verify</span><code class="mono">GET /webhook</code></div>
        <div class="row endpoints"><span>Webhook debug</span><code class="mono">POST /webhook/debug</code></div>
        <div class="row endpoints"><span>Health</span><code class="mono">GET /webhook/health</code></div>
        <div class="row endpoints">
          <span>Admin panel</span>
          <span class="links"><a href="/admin">/admin</a></span>
        </div>
      </section>

      <section class="card col-12">
        <h2>Config status</h2>
        <div class="badges">${missingPills}</div>
      </section>

      <section class="card col-12">
        <h2>Event terbaru</h2>
        ${renderEventTable(state.recent)}
      </section>
    </div>

    <div class="footnote">
      Last webhook: ${state.lastWebhookAt ? escape(state.lastWebhookAt) : "belum ada"} ·
      Started: ${escape(state.startedAt)}
    </div>
  </div>

  <script>
    const copyBtn = document.querySelector("#copyBtn");
    const url = document.querySelector("#webhookUrl").textContent.trim();
    const flash = document.querySelector("#copyFlash");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        flash.classList.add("show");
        setTimeout(() => flash.classList.remove("show"), 1500);
      } catch (e) {
        flash.textContent = "Gagal copy: " + e.message;
        flash.classList.add("show");
      }
    });
  </script>
</body>
</html>`;
}

function renderEventTable(events) {
  if (!events.length) {
    return `<div class="empty">Belum ada event. Kirim pesan ke nomor bot atau lakukan tes via POST /webhook/debug.</div>`;
  }

  const rows = events
    .map((event) => {
      const time = formatTime(event.time);
      const kind = renderKindPill(event.kind);
      const detail = renderEventDetail(event);
      return `<tr>
        <td class="mono">${escape(time)}</td>
        <td>${kind}</td>
        <td class="mono">${detail}</td>
      </tr>`;
    })
    .join("");

  return `<table>
    <thead><tr><th>Waktu</th><th>Jenis</th><th>Detail</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderKindPill(kind) {
  const map = {
    webhook: ["muted", "WEBHOOK"],
    message: ["ok", "MESSAGE"],
    archive: ["ok", "ARCHIVE"],
    error: ["err", "ERROR"]
  };
  const [tone, label] = map[kind] || ["muted", String(kind || "?").toUpperCase()];
  return `<span class="pill ${tone}">${label}</span>`;
}

function renderEventDetail(event) {
  if (event.kind === "webhook") {
    const s = event.summary || {};
    return escape(`msg=${s.messages || 0} status=${s.statuses || 0} err=${s.errors || 0}`);
  }
  if (event.kind === "message") {
    return escape(`from=${event.from || "?"} type=${event.type || "?"}`);
  }
  if (event.kind === "archive") {
    return escape(`${event.archiveId || "?"} ← ${event.from || "?"} (${event.type || "?"})`);
  }
  if (event.kind === "error") {
    return escape(event.error || event.detail || "error");
  }
  return escape(JSON.stringify(event));
}

function flag(value) {
  return value
    ? `<span class="pill ok">SET</span>`
    : `<span class="pill warn">EMPTY</span>`;
}

function formatUptime(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatTime(iso) {
  try {
    const date = new Date(iso);
    return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return iso;
  }
}

function escape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
