import crypto from "node:crypto";
import { withRetry, annotateHttpError } from "../utils/retry.js";
import { logger } from "../logger.js";

export class WhatsAppService {
  constructor(config) {
    this.config = config;
    this.baseUrl = `https://graph.facebook.com/${config.apiVersion}`;
  }

  verifyWebhook(query) {
    const mode = query.get("hub.mode");
    const token = query.get("hub.verify_token");
    const challenge = query.get("hub.challenge");

    if (mode === "subscribe" && token && token === this.config.verifyToken) {
      return challenge || "";
    }

    return null;
  }

  isValidSignature(rawBody, signatureHeader) {
    if (!this.config.appSecret) {
      return true;
    }

    if (!signatureHeader?.startsWith("sha256=")) {
      return false;
    }

    const expected = `sha256=${crypto
      .createHmac("sha256", this.config.appSecret)
      .update(rawBody)
      .digest("hex")}`;

    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(signatureHeader);

    return (
      expectedBuffer.length === actualBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }

  async sendText(to, body, previewUrl = false) {
    return this.graphRequest(`/${this.config.phoneNumberId}/messages`, {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: previewUrl,
          body
        }
      }
    });
  }

  async markRead(messageId) {
    if (!messageId) return null;
    return this.graphRequest(`/${this.config.phoneNumberId}/messages`, {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId
      }
    });
  }

  async getMediaMetadata(mediaId) {
    return this.graphRequest(`/${mediaId}`, {
      method: "GET"
    });
  }

  async downloadMedia(mediaUrl) {
    return withRetry(
      async () => {
        const response = await fetch(mediaUrl, {
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`
          }
        });

        if (!response.ok) {
          const text = await response.text();
          const error = new Error(
            `WhatsApp media download failed: ${response.status} ${text.slice(0, 200)}`
          );
          throw annotateHttpError(error, response);
        }

        return {
          buffer: Buffer.from(await response.arrayBuffer()),
          mimeType: response.headers.get("content-type") || "application/octet-stream"
        };
      },
      { label: "wa.downloadMedia", onRetry: logRetry }
    );
  }

  async uploadMedia({ buffer, mimeType, filename }) {
    return withRetry(
      async () => {
        const boundary = `archive_bot_${crypto.randomBytes(12).toString("hex")}`;
        const body = Buffer.concat([
          formField(boundary, "messaging_product", "whatsapp"),
          formField(boundary, "type", mimeType || "application/octet-stream"),
          Buffer.from(
            `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="file"; filename="${escapeFilename(filename)}"\r\n` +
              `Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`
          ),
          buffer,
          Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);

        const response = await fetch(`${this.baseUrl}/${this.config.phoneNumberId}/media`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(body.length)
          },
          body
        });

        return readJsonResponse(response, "WhatsApp media upload failed");
      },
      { label: "wa.uploadMedia", onRetry: logRetry }
    );
  }

  async sendDocumentByMediaId({ to, mediaId, filename, caption }) {
    return this.graphRequest(`/${this.config.phoneNumberId}/messages`, {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "document",
        document: {
          id: mediaId,
          filename,
          caption
        }
      }
    });
  }

  async graphRequest(path, options) {
    return withRetry(
      async () => {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: options.method || "GET",
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            "Content-Type": "application/json"
          },
          body: options.body ? JSON.stringify(options.body) : undefined
        });

        return readJsonResponse(response, `WhatsApp API ${options.method || "GET"} ${path}`);
      },
      { label: `wa.${options.method || "GET"} ${path}`, onRetry: logRetry }
    );
  }
}

async function readJsonResponse(response, errorMessage) {
  const text = await response.text();
  let json = {};

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(`${errorMessage}: ${response.status} ${JSON.stringify(json).slice(0, 400)}`);
    annotateHttpError(error, response);
    error.responseBody = json;
    throw error;
  }

  return json;
}

function logRetry({ attempt, attempts, delay, label, error }) {
  logger.warn("Retrying request", {
    label,
    attempt,
    attempts,
    delayMs: delay,
    error: error?.message
  });
}

function formField(boundary, name, value) {
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
  );
}

function escapeFilename(filename) {
  return String(filename || "file").replaceAll('"', "'");
}
