import crypto from "node:crypto";
import { withRetry, annotateHttpError } from "../utils/retry.js";
import { logger } from "../logger.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export class GoogleDriveService {
  constructor(config) {
    this.config = config;
    this.tokenCache = null;
  }

  async uploadFile({ buffer, filename, mimeType, description, appProperties }) {
    return withRetry(
      async () => {
        const token = await this.getAccessToken();
        const boundary = `archive_bot_${crypto.randomBytes(12).toString("hex")}`;
        const metadata = {
          name: filename,
          parents: [this.config.folderId],
          description,
          appProperties
        };

        const body = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\n` +
              "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
              `${JSON.stringify(metadata)}\r\n` +
              `--${boundary}\r\n` +
              `Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`
          ),
          buffer,
          Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);

        const response = await fetch(
          `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,parents`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": `multipart/related; boundary=${boundary}`,
              "Content-Length": String(body.length)
            },
            body
          }
        );

        return readJsonResponse(response, "Google Drive upload failed");
      },
      { label: "drive.uploadFile", onRetry: logRetry }
    );
  }

  async listFiles(keyword, pageSize = 10) {
    return withRetry(
      async () => {
        const token = await this.getAccessToken();
        const escaped = escapeDriveQuery(keyword);
        const q = [
          `'${escapeDriveQuery(this.config.folderId)}' in parents`,
          "trashed = false",
          `(name contains '${escaped}' or fullText contains '${escaped}')`
        ].join(" and ");

        const url = new URL(`${DRIVE_API}/files`);
        url.searchParams.set("q", q);
        url.searchParams.set("pageSize", String(pageSize));
        url.searchParams.set(
          "fields",
          "files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,appProperties)"
        );

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` }
        });

        const result = await readJsonResponse(response, "Google Drive search failed");
        return result.files || [];
      },
      { label: "drive.listFiles", onRetry: logRetry }
    );
  }

  async getFileMetadata(fileId) {
    return withRetry(
      async () => {
        const token = await this.getAccessToken();
        const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
        url.searchParams.set("fields", "id,name,mimeType,size,webViewLink,webContentLink");

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` }
        });

        return readJsonResponse(response, "Google Drive metadata failed");
      },
      { label: "drive.getFileMetadata", onRetry: logRetry }
    );
  }

  async downloadFile(fileId) {
    return withRetry(
      async () => {
        const token = await this.getAccessToken();
        const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (!response.ok) {
          const text = await response.text();
          const error = new Error(
            `Google Drive download failed: ${response.status} ${text.slice(0, 200)}`
          );
          throw annotateHttpError(error, response);
        }

        return {
          buffer: Buffer.from(await response.arrayBuffer()),
          mimeType: response.headers.get("content-type") || "application/octet-stream"
        };
      },
      { label: "drive.downloadFile", onRetry: logRetry }
    );
  }

  async renameFile(fileId, newName) {
    return withRetry(
      async () => {
        const token = await this.getAccessToken();
        const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
        url.searchParams.set("fields", "id,name,mimeType,size,webViewLink,webContentLink");

        const response = await fetch(url, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: newName })
        });

        return readJsonResponse(response, "Google Drive rename failed");
      },
      { label: "drive.renameFile", onRetry: logRetry }
    );
  }

  async deleteFile(fileId) {
    return withRetry(
      async () => {
        const token = await this.getAccessToken();
        const response = await fetch(
          `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` }
          }
        );

        if (response.status === 204) return { id: fileId, deleted: true };
        if (response.status === 404) return { id: fileId, deleted: false, notFound: true };

        const text = await response.text();
        const error = new Error(
          `Google Drive delete failed: ${response.status} ${text.slice(0, 200)}`
        );
        throw annotateHttpError(error, response);
      },
      { label: "drive.deleteFile", onRetry: logRetry }
    );
  }

  async ensureAnyoneWithLinkReader(fileId) {
    return withRetry(
      async () => {
        const token = await this.getAccessToken();
        const response = await fetch(
          `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?fields=id,type,role`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ role: "reader", type: "anyone", allowFileDiscovery: false })
          }
        );

        if (response.status === 409 || response.status === 400) {
          return { alreadyShared: true };
        }

        return readJsonResponse(response, "Google Drive share failed");
      },
      { label: "drive.ensureAnyoneWithLinkReader", onRetry: logRetry }
    );
  }

  async getAccessToken() {
    if (this.config.authMode === "oauth_access_token") {
      return this.config.oauthAccessToken;
    }

    const now = Math.floor(Date.now() / 1000);
    if (this.tokenCache && this.tokenCache.expiresAt - 60 > now) {
      return this.tokenCache.accessToken;
    }

    const assertion = this.createJwtAssertion(now);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    });

    const token = await withRetry(
      async () => {
        const response = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body
        });

        return readJsonResponse(response, "Google token request failed");
      },
      { label: "drive.getAccessToken", onRetry: logRetry }
    );

    this.tokenCache = {
      accessToken: token.access_token,
      expiresAt: now + Number(token.expires_in || 3600)
    };

    return this.tokenCache.accessToken;
  }

  createJwtAssertion(now) {
    const header = { alg: "RS256", typ: "JWT" };

    const claim = {
      iss: this.config.serviceAccountEmail,
      scope: this.config.scope,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600
    };

    if (this.config.impersonateUser) {
      claim.sub = this.config.impersonateUser;
    }

    const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
    const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(this.config.privateKey);
    return `${unsigned}.${base64Url(signature)}`;
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

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function escapeDriveQuery(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}
