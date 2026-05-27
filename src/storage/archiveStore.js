import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export class ArchiveStore {
  constructor(path) {
    this.path = resolve(process.cwd(), path);
    this.data = {
      lastSequenceDate: "",
      lastSequence: 0,
      archives: []
    };
  }

  init() {
    mkdirSync(dirname(this.path), { recursive: true });

    if (existsSync(this.path)) {
      this.data = JSON.parse(readFileSync(this.path, "utf8"));
    } else {
      this.save();
    }
  }

  save() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  nextArchiveId(now = new Date()) {
    const datePart = now.toISOString().slice(0, 10).replaceAll("-", "");

    if (this.data.lastSequenceDate !== datePart) {
      this.data.lastSequenceDate = datePart;
      this.data.lastSequence = 0;
    }

    this.data.lastSequence += 1;
    return `ARS-${datePart}-${String(this.data.lastSequence).padStart(4, "0")}`;
  }

  add(archive) {
    this.data.archives.unshift(archive);
    this.save();
    return archive;
  }

  all() {
    return [...this.data.archives];
  }

  recent(limit = 10) {
    return this.data.archives.slice(0, limit);
  }

  find(value) {
    const needle = normalize(value);

    return this.data.archives.find((archive) => {
      return (
        normalize(archive.id) === needle ||
        normalize(archive.driveFileId) === needle ||
        normalize(archive.originalFileName) === needle ||
        normalize(archive.driveFileName) === needle
      );
    });
  }

  search(keyword, limit = 10) {
    const terms = normalize(keyword).split(/\s+/).filter(Boolean);

    if (terms.length === 0) {
      return [];
    }

    return this.data.archives
      .map((archive) => {
        const haystack = normalize(
          [
            archive.id,
            archive.originalFileName,
            archive.driveFileName,
            archive.caption,
            archive.sender,
            archive.senderName,
            ...(archive.tags || [])
          ].join(" ")
        );

        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { archive, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.archive.createdAt.localeCompare(a.archive.createdAt))
      .slice(0, limit)
      .map((item) => item.archive);
  }

  addTags(id, tags) {
    const archive = this.find(id);
    if (!archive) {
      return null;
    }

    const existing = new Set(archive.tags || []);
    for (const tag of tags.map(cleanTag).filter(Boolean)) {
      existing.add(tag);
    }

    archive.tags = [...existing].sort();
    this.save();
    return archive;
  }

  remove(id) {
    const archive = this.find(id);
    if (!archive) {
      return null;
    }

    this.data.archives = this.data.archives.filter((item) => item !== archive);
    this.save();
    return archive;
  }

  rename(id, newOriginalName) {
    const archive = this.find(id);
    if (!archive) {
      return null;
    }

    archive.originalFileName = newOriginalName;
    archive.driveFileName = `${archive.id} - ${newOriginalName}`;
    this.save();
    return archive;
  }

  setWebViewLink(id, link) {
    const archive = this.find(id);
    if (!archive) {
      return null;
    }

    archive.webViewLink = link || "";
    this.save();
    return archive;
  }
}

function normalize(value) {
  return String(value || "").toLowerCase().trim();
}

function cleanTag(value) {
  return String(value || "")
    .replace(/^#/, "")
    .trim()
    .toLowerCase();
}
