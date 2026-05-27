import { formatArchiveLine } from "./services/archiveService.js";

export async function handleTextCommand({ text, from, archiveService, whatsapp }) {
  const input = String(text || "").trim();
  const [commandRaw, ...rest] = input.split(/\s+/);
  const command = commandRaw.toLowerCase().replace(/^\//, "");
  const args = rest.join(" ").trim();

  if (!command || ["help", "menu", "start"].includes(command)) {
    await whatsapp.sendText(from, helpText());
    return;
  }

  if (["cari", "search"].includes(command)) {
    if (!args) {
      await whatsapp.sendText(from, "Ketik: cari kata_kunci\nContoh: cari invoice januari");
      return;
    }

    const results = archiveService.search(args, 10);
    if (results.length === 0) {
      await whatsapp.sendText(from, `Tidak ada arsip lokal untuk: ${args}`);
      return;
    }

    await whatsapp.sendText(
      from,
      [`Hasil pencarian "${args}":`, ...results.map((item) => `- ${formatArchiveLine(item)}`)].join(
        "\n"
      )
    );
    return;
  }

  if (["ambil", "get", "download"].includes(command)) {
    if (!args) {
      await whatsapp.sendText(from, "Ketik: ambil KODE_ARSIP\nContoh: ambil ARS-20260527-0001");
      return;
    }

    const archive = archiveService.find(args);
    if (!archive) {
      await whatsapp.sendText(from, `Arsip tidak ditemukan: ${args}`);
      return;
    }

    await whatsapp.sendText(from, `Mengambil ${archive.id}, sebentar...`);
    await archiveService.sendArchiveFile(from, archive);
    return;
  }

  if (["list", "terbaru"].includes(command)) {
    const limit = Number.parseInt(args || "10", 10);
    const results = archiveService.recent(Number.isFinite(limit) ? Math.min(limit, 20) : 10);

    if (results.length === 0) {
      await whatsapp.sendText(from, "Belum ada arsip.");
      return;
    }

    await whatsapp.sendText(
      from,
      ["Arsip terbaru:", ...results.map((item) => `- ${formatArchiveLine(item)}`)].join("\n")
    );
    return;
  }

  if (["hapus", "delete", "del", "remove"].includes(command)) {
    if (!args) {
      await whatsapp.sendText(from, "Ketik: hapus KODE_ARSIP\nContoh: hapus ARS-20260527-0001");
      return;
    }

    const archive = await archiveService.deleteArchive(args);
    if (!archive) {
      await whatsapp.sendText(from, `Arsip tidak ditemukan: ${args}`);
      return;
    }

    await whatsapp.sendText(from, `Arsip dihapus dari Drive dan index:\n${formatArchiveLine(archive)}`);
    return;
  }

  if (["rename", "ubah"].includes(command)) {
    const [archiveId, ...nameParts] = rest;
    const newName = nameParts.join(" ").trim();

    if (!archiveId || !newName) {
      await whatsapp.sendText(
        from,
        "Ketik: rename KODE_ARSIP nama_baru.ext\nContoh: rename ARS-20260527-0001 invoice-januari.pdf"
      );
      return;
    }

    try {
      const archive = await archiveService.renameArchive(archiveId, newName);
      if (!archive) {
        await whatsapp.sendText(from, `Arsip tidak ditemukan: ${archiveId}`);
        return;
      }

      await whatsapp.sendText(from, `Nama arsip diperbarui:\n${formatArchiveLine(archive)}`);
    } catch (error) {
      await whatsapp.sendText(from, `Gagal rename: ${error.publicMessage || error.message}`);
    }
    return;
  }

  if (["share", "link", "bagikan"].includes(command)) {
    if (!args) {
      await whatsapp.sendText(from, "Ketik: share KODE_ARSIP\nContoh: share ARS-20260527-0001");
      return;
    }

    const result = await archiveService.shareArchive(args);
    if (!result) {
      await whatsapp.sendText(from, `Arsip tidak ditemukan: ${args}`);
      return;
    }

    await whatsapp.sendText(
      from,
      `Link arsip ${result.archive.id}:\n${result.link || "(link tidak tersedia)"}`,
      true
    );
    return;
  }

  if (["tag", "tags"].includes(command)) {
    const [archiveId, ...tagParts] = rest;
    if (!archiveId || tagParts.length === 0) {
      await whatsapp.sendText(from, "Ketik: tag KODE_ARSIP tag1 tag2\nContoh: tag ARS-20260527-0001 pajak invoice");
      return;
    }

    const archive = archiveService.addTags(archiveId, tagParts);
    if (!archive) {
      await whatsapp.sendText(from, `Arsip tidak ditemukan: ${archiveId}`);
      return;
    }

    await whatsapp.sendText(from, `Tag diperbarui:\n${formatArchiveLine(archive)}`);
    return;
  }

  await whatsapp.sendText(from, `Perintah belum dikenal: ${commandRaw}\n\n${helpText()}`);
}

export function helpText() {
  return [
    "Archive Manager Bot",
    "",
    "Kirim dokumen/foto/video/audio ke chat ini untuk otomatis diarsipkan ke Google Drive.",
    "",
    "Perintah:",
    "- cari kata_kunci",
    "- ambil KODE_ARSIP",
    "- list",
    "- tag KODE_ARSIP tag1 tag2",
    "- rename KODE_ARSIP nama_baru.ext",
    "- share KODE_ARSIP",
    "- hapus KODE_ARSIP",
    "- help",
    "",
    "Tips: saat kirim file, tulis caption dengan #tag, contoh: #invoice #pajak"
  ].join("\n");
}
