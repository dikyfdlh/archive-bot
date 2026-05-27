import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { config, getMissingConfig } from "./config.js";
import { logger } from "./logger.js";
import { ArchiveStore } from "./storage/archiveStore.js";
import { GoogleDriveService } from "./services/googleDrive.js";
import { WhatsAppService } from "./services/whatsapp.js";
import { ArchiveService, formatArchiveLine } from "./services/archiveService.js";
import { handleTextCommand, helpText } from "./commands.js";
import { parseJsonBody, parseWhatsAppWebhook, summarizeWebhookEvents } from "./webhook.js";
import { handleAdminRequest } from "./admin.js";
import { EventTracker, buildDashboardState, renderDashboardHtml } from "./dashboard.js";

class RecentSet {
  constructor(limit) {
    this.limit = limit;
    this.items = new Set();
    this.queue = [];
  }

  has(value) {
    return this.items.has(value);
  }

  add(value) {
    if (this.items.has(value)) {
      return;
    }

    this.items.add(value);
    this.queue.push(value);

    while (this.queue.length > this.limit) {
      const oldValue = this.queue.shift();
      this.items.delete(oldValue);
    }
  }
}

const store = new ArchiveStore(config.archiveStoragePath);
store.init();

const whatsapp = new WhatsAppService(config.whatsapp);
const drive = new GoogleDriveService(config.googleDrive);
const archiveService = new ArchiveService({ store, drive, whatsapp, config });
const processedMessageIds = new RecentSet(1000);
const tracker = new EventTracker(20);

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomBytes(6).toString("hex");
  res.setHeader("X-Request-Id", requestId);

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (await handleAdminRequest(req, res, url, config)) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      const state = buildDashboardState({
        config,
        missingConfig: getMissingConfig(),
        tracker,
        archiveCount: store.all().length
      });

      if (wantsHtml(req)) {
        sendHtml(res, 200, renderDashboardHtml(state));
      } else {
        sendJson(res, 200, {
          ok: true,
          service: "archive-manager-bot",
          ready: state.ready,
          endpoints: {
            dashboard: "/",
            admin: "/admin",
            health: "/health",
            webhookHealth: "/webhook/health",
            webhookVerify: "GET /webhook",
            webhookReceive: "POST /webhook",
            webhookDebug: "POST /webhook/debug"
          },
          state
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "archive-manager-bot",
        webhook: {
          path: "/webhook",
          maxBodyBytes: config.webhookMaxBodyBytes,
          signatureCheck: Boolean(config.whatsapp.appSecret)
        },
        missingConfig: getMissingConfig()
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/webhook/health") {
      const missing = getMissingConfig();
      sendJson(res, missing.length === 0 ? 200 : 503, {
        ok: missing.length === 0,
        ready: missing.length === 0,
        webhook: {
          path: "/webhook",
          verifyTokenSet: Boolean(config.whatsapp.verifyToken),
          appSecretSet: Boolean(config.whatsapp.appSecret),
          phoneNumberIdSet: Boolean(config.whatsapp.phoneNumberId),
          accessTokenSet: Boolean(config.whatsapp.accessToken),
          authorizedNumbers: config.authorizedWaNumbers.length
        },
        drive: {
          authMode: config.googleDrive.authMode,
          folderIdSet: Boolean(config.googleDrive.folderId),
          serviceAccountEmailSet: Boolean(config.googleDrive.serviceAccountEmail),
          privateKeySet: Boolean(config.googleDrive.privateKey),
          impersonate: config.googleDrive.impersonateUser || null
        },
        missingConfig: missing,
        uptimeSec: Math.round(process.uptime())
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/webhook") {
      const challenge = whatsapp.verifyWebhook(url.searchParams);
      if (challenge !== null) {
        logger.info("Webhook verification ok", { requestId });
        sendText(res, 200, challenge);
      } else {
        logger.warn("Webhook verification failed", {
          requestId,
          mode: url.searchParams.get("hub.mode"),
          hasToken: Boolean(url.searchParams.get("hub.verify_token"))
        });
        sendText(res, 403, "Webhook verification failed");
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook/debug") {
      const rawBody = await readRawBody(req, config.webhookMaxBodyBytes);
      const payload = parseJsonBody(rawBody);
      const events = parseWhatsAppWebhook(payload);
      sendJson(res, 200, {
        ok: true,
        requestId,
        summary: summarizeWebhookEvents(events),
        events
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      const rawBody = await readRawBody(req, config.webhookMaxBodyBytes);
      const validSignature = whatsapp.isValidSignature(
        rawBody,
        req.headers["x-hub-signature-256"]
      );

      if (!validSignature) {
        logger.warn("Invalid webhook signature", { requestId, bytes: rawBody.length });
        sendText(res, 401, "Invalid signature");
        return;
      }

      // Meta retries any non-2xx within ~15s. ACK fast then process async.
      sendText(res, 200, "EVENT_RECEIVED");
      processWebhook(rawBody, requestId).catch((error) =>
        logger.error("Webhook processing failed", error, { requestId })
      );
      return;
    }

    sendJson(res, 404, {
      ok: false,
      requestId,
      error: "Not found"
    });
  } catch (error) {
    logger.error("Request failed", error, { requestId, method: req.method, url: req.url });
    sendJson(res, error.statusCode || 500, {
      ok: false,
      requestId,
      error: error.publicMessage || "Internal server error"
    });
  }
});

server.listen(config.port, () => {
  const missing = getMissingConfig();
  logger.info("Archive Manager Bot started", {
    port: config.port,
    storage: config.archiveStoragePath,
    missingConfig: missing
  });

  if (missing.length > 0) {
    logger.warn("Some configuration values are still empty", {
      missingConfig: missing
    });
  }
});

server.on("clientError", (error, socket) => {
  logger.warn("HTTP client error", { error: error?.message, code: error?.code });
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    logger.info("Shutdown signal received, draining", { signal });
    server.close(() => {
      logger.info("Server closed cleanly");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason instanceof Error ? reason : new Error(String(reason)));
});

async function processWebhook(rawBody, requestId) {
  const payload = parseJsonBody(rawBody);
  const events = parseWhatsAppWebhook(payload);
  const summary = summarizeWebhookEvents(events);

  logger.info("Webhook received", { requestId, summary });
  tracker.recordWebhook(summary);

  for (const event of events.statuses) {
    logger.info("WhatsApp message status", {
      requestId,
      id: event.status.id,
      recipientId: event.status.recipient_id,
      status: event.status.status,
      timestamp: event.status.timestamp
    });
  }

  for (const error of events.errors) {
    logger.warn("WhatsApp webhook error", { requestId, error });
  }

  for (const event of events.messages) {
    if (event.message.id && processedMessageIds.has(event.message.id)) {
      logger.info("Duplicate WhatsApp message skipped", {
        requestId,
        messageId: event.message.id
      });
      continue;
    }

    if (event.message.id) {
      processedMessageIds.add(event.message.id);
    }

    await processMessage(event.message, event.contactName, requestId);
  }
}

async function processMessage(message, contactName, requestId) {
  const from = message.from;
  const logContext = {
    requestId,
    from,
    messageId: message.id,
    type: message.type
  };

  if (!isAuthorized(from)) {
    logger.warn("Unauthorized WhatsApp sender ignored", logContext);
    await safeSendText(from, "Maaf, nomor ini belum terdaftar sebagai pengguna bot arsip.", logContext);
    return;
  }

  try {
    if (message.type === "text") {
      logger.info("Handling text command", { ...logContext, text: truncate(message.text?.body) });
      tracker.recordMessage({ from, type: "text" });
      await handleTextCommand({
        text: message.text?.body || "",
        from,
        archiveService,
        whatsapp
      });
      return;
    }

    if (archiveService.isSupportedMedia(message)) {
      logger.info("Archiving media", logContext);
      tracker.recordMessage({ from, type: message.type });
      await safeSendText(from, "File diterima. Sedang diarsipkan ke Google Drive...", logContext);
      const archive = await archiveService.archiveWhatsAppMedia({ from, contactName, message });
      logger.info("Archived ok", { ...logContext, archiveId: archive.id, driveFileId: archive.driveFileId });
      tracker.recordArchive({ archiveId: archive.id, from, type: message.type });
      await safeSendText(from, `Berhasil diarsipkan:\n${formatArchiveLine(archive)}`, logContext);
      return;
    }

    await safeSendText(from, `Tipe pesan belum didukung.\n\n${helpText()}`, logContext);
  } catch (error) {
    logger.error("Message handling failed", error, logContext);
    tracker.recordError({ from, error: truncate(error.publicMessage || error.message, 160) });
    await safeSendText(
      from,
      `Maaf, terjadi error saat memproses pesanmu.\nKode: ${requestId}\nDetail singkat: ${truncate(error.publicMessage || error.message, 240)}`,
      logContext
    );
  }
}

async function safeSendText(to, body, logContext) {
  try {
    await whatsapp.sendText(to, body);
  } catch (error) {
    logger.error("Failed to send WhatsApp reply", error, logContext);
  }
}

function truncate(value, max = 120) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function isAuthorized(from) {
  if (config.authorizedWaNumbers.length === 0) {
    return true;
  }

  return config.authorizedWaNumbers.includes(from);
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
      error.publicMessage = "Request body too large";
      throw error;
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(body);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || "");
  if (!accept) return false;
  if (accept.includes("application/json")) return false;
  return accept.includes("text/html") || accept.includes("*/*");
}
