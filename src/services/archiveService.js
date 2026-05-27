const SUPPORTED_MEDIA_TYPES = new Set(["document", "image", "audio", "video"]);

export class ArchiveService {
  constructor({ store, drive, whatsapp, config }) {
    this.store = store;
    this.drive = drive;
    this.whatsapp = whatsapp;
    this.config = config;
  }

  isSupportedMedia(message) {
    return SUPPORTED_MEDIA_TYPES.has(message.type) && message[message.type]?.id;
  }

  async archiveWhatsAppMedia({ from, contactName, message }) {
    const media = message[message.type];
    const archiveId = this.store.nextArchiveId();
    const originalFileName = getOriginalFilename(message.type, media, archiveId);
    const driveFileName = `${archiveId} - ${originalFileName}`;
    const caption = media.caption || "";
    const tags = extractTags(caption);

    const mediaMeta = await this.whatsapp.getMediaMetadata(media.id);
    const downloaded = await this.whatsapp.downloadMedia(mediaMeta.url);
    const mimeType = media.mime_type || mediaMeta.mime_type || downloaded.mimeType;

    const driveFile = await this.drive.uploadFile({
      buffer: downloaded.buffer,
      filename: driveFileName,
      mimeType,
      description: `Archived from WhatsApp by ${from}. Message ID: ${message.id}`,
      appProperties: {
        archiveId,
        source: "whatsapp",
        sender: from,
        whatsappMessageId: message.id || ""
      }
    });

    return this.store.add({
      id: archiveId,
      driveFileId: driveFile.id,
      driveFileName: driveFile.name,
      originalFileName,
      mimeType,
      size: String(downloaded.buffer.length),
      sourceType: message.type,
      sender: from,
      senderName: contactName || "",
      whatsappMessageId: message.id || "",
      caption,
      tags,
      webViewLink: driveFile.webViewLink || "",
      createdAt: new Date().toISOString()
    });
  }

  search(keyword, limit = 10) {
    return this.store.search(keyword, limit);
  }

  recent(limit = 10) {
    return this.store.recent(limit);
  }

  find(value) {
    return this.store.find(value);
  }

  addTags(id, tags) {
    return this.store.addTags(id, tags);
  }

  async deleteArchive(id) {
    const archive = this.store.find(id);
    if (!archive) return null;

    try {
      await this.drive.deleteFile(archive.driveFileId);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }

    return this.store.remove(archive.id);
  }

  async renameArchive(id, newName) {
    const archive = this.store.find(id);
    if (!archive) return null;

    const cleanName = String(newName || "").trim();
    if (!cleanName) {
      const error = new Error("Nama baru tidak boleh kosong.");
      error.publicMessage = error.message;
      throw error;
    }

    const driveName = `${archive.id} - ${cleanName}`;
    await this.drive.renameFile(archive.driveFileId, driveName);
    return this.store.rename(archive.id, cleanName);
  }

  async shareArchive(id) {
    const archive = this.store.find(id);
    if (!archive) return null;

    await this.drive.ensureAnyoneWithLinkReader(archive.driveFileId);
    const metadata = await this.drive.getFileMetadata(archive.driveFileId);
    const link = metadata.webViewLink || archive.webViewLink || "";

    if (link) {
      this.store.setWebViewLink(archive.id, link);
    }

    return { archive, link };
  }

  async sendArchiveFile(to, archive) {
    const metadata = await this.drive.getFileMetadata(archive.driveFileId);
    const size = Number(metadata.size || archive.size || 0);

    if (!this.config.sendFilesDirectly || size > this.config.maxSendFileBytes) {
      const link = metadata.webViewLink || archive.webViewLink || "(link tidak tersedia)";
      await this.whatsapp.sendText(
        to,
        `Arsip ditemukan:\n${formatArchiveLine(archive)}\n\nLink Drive:\n${link}`,
        true
      );
      return;
    }

    const file = await this.drive.downloadFile(archive.driveFileId);
    const uploaded = await this.whatsapp.uploadMedia({
      buffer: file.buffer,
      mimeType: archive.mimeType || file.mimeType,
      filename: archive.originalFileName
    });

    await this.whatsapp.sendDocumentByMediaId({
      to,
      mediaId: uploaded.id,
      filename: archive.originalFileName,
      caption: `${archive.id} - ${archive.originalFileName}`
    });
  }
}

export function formatArchiveLine(archive) {
  const tags = archive.tags?.length ? ` #${archive.tags.join(" #")}` : "";
  return `${archive.id} | ${archive.originalFileName}${tags}`;
}

function getOriginalFilename(type, media, archiveId) {
  if (media.filename) {
    return media.filename;
  }

  const extension = extensionFromMime(media.mime_type);
  return `${archiveId}-${type}${extension}`;
}

function extensionFromMime(mimeType = "") {
  const known = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg"
  };

  return known[mimeType] || "";
}

function extractTags(text) {
  return [...String(text || "").matchAll(/#([a-zA-Z0-9_-]+)/g)]
    .map((match) => match[1].toLowerCase())
    .filter(Boolean);
}
