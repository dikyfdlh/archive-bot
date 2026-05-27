import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

loadDotEnv();

function loadDotEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

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

    value = value.replaceAll("\\n", "\n");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function list(name) {
  return (process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  port: int("PORT", 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  webhookMaxBodyBytes: int("WEBHOOK_MAX_BODY_BYTES", 10_485_760),
  adminToken: process.env.ADMIN_TOKEN || "",
  archiveStoragePath: process.env.ARCHIVE_STORAGE_PATH || "./data/archive-index.json",
  sendFilesDirectly: bool("SEND_FILES_DIRECTLY", true),
  maxSendFileBytes: int("MAX_SEND_FILE_BYTES", 95_000_000),
  authorizedWaNumbers: list("AUTHORIZED_WA_NUMBERS"),
  whatsapp: {
    apiVersion: process.env.WHATSAPP_API_VERSION || "v23.0",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    appSecret: process.env.WHATSAPP_APP_SECRET || ""
  },
  googleDrive: {
    authMode: process.env.GOOGLE_DRIVE_AUTH_MODE || "service_account",
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || "",
    scope: process.env.GOOGLE_DRIVE_SCOPE || "https://www.googleapis.com/auth/drive",
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
    privateKey: process.env.GOOGLE_PRIVATE_KEY || "",
    impersonateUser: process.env.GOOGLE_DRIVE_IMPERSONATE_USER || "",
    oauthAccessToken: process.env.GOOGLE_OAUTH_ACCESS_TOKEN || ""
  }
};

export function getMissingConfig() {
  const missing = [];

  if (!config.whatsapp.verifyToken) missing.push("WHATSAPP_VERIFY_TOKEN");
  if (!config.whatsapp.accessToken) missing.push("WHATSAPP_ACCESS_TOKEN");
  if (!config.whatsapp.phoneNumberId) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!config.googleDrive.folderId) missing.push("GOOGLE_DRIVE_FOLDER_ID");

  if (config.googleDrive.authMode === "service_account") {
    if (!config.googleDrive.serviceAccountEmail) missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    if (!config.googleDrive.privateKey) missing.push("GOOGLE_PRIVATE_KEY");
  }

  if (config.googleDrive.authMode === "oauth_access_token" && !config.googleDrive.oauthAccessToken) {
    missing.push("GOOGLE_OAUTH_ACCESS_TOKEN");
  }

  return missing;
}
