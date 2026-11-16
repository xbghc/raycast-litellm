import { Clipboard, LocalStorage, environment } from "@raycast/api";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ClipboardImageItem } from "./types";

const execFileAsync = promisify(execFile);

const STORAGE_KEY = "ocr-clipboard-image-history-v1";
const MAX_UNPINNED_ITEMS = 50;
const CLIPBOARD_OFFSETS = [0, 1, 2, 3, 4, 5];

interface ParsedImageMeta {
  width: number;
  height: number;
  mimeType: string;
  ext: string;
}

function getCacheDir(): string {
  const dir = path.join(environment.supportPath, "clipboard-images");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Parses image format and pixel dimensions directly from file header bytes
 * without external binary dependencies.
 */
export function parseImageBuffer(buf: Buffer): ParsedImageMeta | null {
  if (buf.length < 16) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a &&
    buf.length >= 24
  ) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      mimeType: "image/png",
      ext: "png",
    };
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return { width, height, mimeType: "image/jpeg", ext: "jpg" };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      if (offset + 4 >= buf.length) break;
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
    return { width: 0, height: 0, mimeType: "image/jpeg", ext: "jpg" };
  }

  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return {
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
      mimeType: "image/gif",
      ext: "gif",
    };
  }

  // BMP: BM
  if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length >= 26) {
    return {
      width: Math.abs(buf.readInt32LE(18)),
      height: Math.abs(buf.readInt32LE(22)),
      mimeType: "image/bmp",
      ext: "bmp",
    };
  }

  // WebP: RIFF....WEBP
  if (
    buf.length >= 30 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunkType = buf.toString("ascii", 12, 16);
    let width = 0;
    let height = 0;
    if (chunkType === "VP8X") {
      width = 1 + buf.readUIntLE(24, 3);
      height = 1 + buf.readUIntLE(27, 3);
    } else if (chunkType === "VP8 " && buf.length >= 30) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunkType === "VP8L" && buf.length >= 25) {
      const b0 = buf[21];
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    }
    return { width, height, mimeType: "image/webp", ext: "webp" };
  }

  // TIFF: II*\0 or MM\0*
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return { width: 0, height: 0, mimeType: "image/tiff", ext: "tiff" };
  }

  // HEIC/AVIF: ....ftyp(heic|heix|mif1|avif)
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (["heic", "heix", "mif1", "msf1"].includes(brand)) {
      return { width: 0, height: 0, mimeType: "image/heic", ext: "heic" };
    }
    if (brand === "avif") {
      return { width: 0, height: 0, mimeType: "image/avif", ext: "avif" };
    }
  }

  return null;
}

function normalizeFilePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      const stripped = decodeURIComponent(trimmed.replace(/^file:\/\/\/?/, ""));
      return process.platform === "win32" ? stripped : `/${stripped}`;
    }
  }

  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return null;
}

function isTempClipboardPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  return (
    lower.startsWith(tmp) ||
    lower.includes("clipboard") ||
    lower.includes("raycast") ||
    lower.includes("var/folders") ||
    lower.includes("appdata\\local\\temp") ||
    lower.includes("appdata/local/temp")
  );
}

function formatImageTitle(width: number, height: number): string {
  if (width > 0 && height > 0) {
    return `Image (${width}×${height})`;
  }
  return "Image";
}

function ingestImageBuffer(buf: Buffer, sourceFilePath?: string, copiedAt = Date.now()): ClipboardImageItem | null {
  const meta = parseImageBuffer(buf);
  if (!meta) return null;

  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 24);
  const cacheDir = getCacheDir();
  const cachedPath = path.join(cacheDir, `${hash}.${meta.ext}`);

  if (!fs.existsSync(cachedPath)) {
    fs.writeFileSync(cachedPath, buf);
  }

  const sourceName =
    sourceFilePath && !isTempClipboardPath(sourceFilePath) ? path.basename(sourceFilePath) : undefined;

  return {
    id: hash,
    cachedPath,
    title: formatImageTitle(meta.width, meta.height),
    sourceName,
    width: meta.width,
    height: meta.height,
    mimeType: meta.mimeType,
    sizeBytes: buf.length,
    copiedAt,
    ocrCache: {},
  };
}

function ingestImageFile(filePath: string, copiedAt = Date.now()): ClipboardImageItem | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 50 * 1024 * 1024) return null;
    const buf = fs.readFileSync(filePath);
    return ingestImageBuffer(buf, filePath, copiedAt);
  } catch {
    return null;
  }
}

function extractHtmlImage(html: string, copiedAt = Date.now()): ClipboardImageItem | null {
  const dataMatch = html.match(/src=["']data:image\/[a-zA-Z0-9+.-]+;base64,([A-Za-z0-9+/=]+)["']/i);
  if (dataMatch?.[1]) {
    try {
      const buf = Buffer.from(dataMatch[1], "base64");
      return ingestImageBuffer(buf, undefined, copiedAt);
    } catch {
      return null;
    }
  }

  const fileMatch = html.match(/src=["'](file:\/\/[^"']+)["']/i);
  if (fileMatch?.[1]) {
    const resolved = normalizeFilePath(fileMatch[1]);
    if (resolved) return ingestImageFile(resolved, copiedAt);
  }
  return null;
}

/**
 * Fallback for raw system clipboard bitmaps (e.g. Win+Shift+S screenshot or macOS Cmd+Ctrl+Shift+4)
 * when `Clipboard.read({ offset: 0 })` does not expose a backing file path.
 */
async function captureSystemClipboardImage(): Promise<ClipboardImageItem | null> {
  const tempOut = path.join(os.tmpdir(), `raycast-litellm-clip-${process.pid}-${Date.now()}.png`);

  try {
    if (process.platform === "win32") {
      const psExe = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$out = $env:CLIP_TEMP_OUT
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  if ($null -ne $img) {
    $img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $img.Dispose()
    Write-Output "SAVED:$out"
    exit 0
  }
}
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
  if ($files.Count -gt 0) {
    Write-Output "FILE:$($files[0])"
  }
}
`;
      const { stdout } = await execFileAsync(
        psExe,
        ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
        {
          env: { ...process.env, CLIP_TEMP_OUT: tempOut },
          timeout: 4000,
          windowsHide: true,
        }
      );
      const line = stdout.trim().split(/\r?\n/).find(Boolean) || "";
      if (line.startsWith("SAVED:") && fs.existsSync(tempOut)) {
        return ingestImageFile(tempOut, Date.now());
      }
      if (line.startsWith("FILE:")) {
        return ingestImageFile(line.slice(5).trim(), Date.now());
      }
    } else if (process.platform === "darwin") {
      const jxa = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const out = $.NSProcessInfo.processInfo.environment.objectForKey('CLIP_TEMP_OUT').js;
const pb = $.NSPasteboard.generalPasteboard;
let data = pb.dataForType($.NSPasteboardTypePNG);
if (!data || data.isNil()) {
  const tiff = pb.dataForType($.NSPasteboardTypeTIFF);
  if (tiff && !tiff.isNil()) {
    const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (rep && !rep.isNil()) {
      data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    }
  }
}
if (data && !data.isNil()) {
  data.writeToFileAtomically(out, true);
  "SAVED";
} else {
  "NONE";
}
`;
      const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", jxa], {
        env: { ...process.env, CLIP_TEMP_OUT: tempOut },
        timeout: 4000,
      });
      if (stdout.trim() === "SAVED" && fs.existsSync(tempOut)) {
        return ingestImageFile(tempOut, Date.now());
      }
    }
  } catch {
    // Ignore raw clipboard probe failures
  } finally {
    try {
      if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
    } catch {
      // ignore cleanup error
    }
  }

  return null;
}

export async function loadCachedImageHistory(): Promise<ClipboardImageItem[]> {
  try {
    const raw = await LocalStorage.getItem<string>(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ClipboardImageItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && item.cachedPath && fs.existsSync(item.cachedPath));
  } catch {
    return [];
  }
}

export async function saveImageHistory(items: ClipboardImageItem[]): Promise<void> {
  const pinned = items.filter((i) => i.pinned);
  const unpinned = items.filter((i) => !i.pinned);
  const keptUnpinned = unpinned.slice(0, MAX_UNPINNED_ITEMS);
  const removed = unpinned.slice(MAX_UNPINNED_ITEMS);

  for (const old of removed) {
    try {
      if (fs.existsSync(old.cachedPath)) {
        fs.unlinkSync(old.cachedPath);
      }
    } catch {
      // ignore
    }
  }

  const finalItems = [...pinned, ...keptUnpinned];
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(finalItems));
}

/**
 * Syncs recent Raycast Clipboard History items (offsets 0..5) + raw system clipboard image
 * with persistent image history, strictly filtering to images only.
 */
export async function syncClipboardImages(): Promise<ClipboardImageItem[]> {
  const existing = await loadCachedImageHistory();
  const existingById = new Map(existing.map((item) => [item.id, item]));

  const now = Date.now();
  const discovered: ClipboardImageItem[] = [];
  const seenIds = new Set<string>();

  const offsetReads = await Promise.all(
    CLIPBOARD_OFFSETS.map(async (offset) => {
      try {
        const content = await Clipboard.read({ offset });
        return { offset, content };
      } catch {
        return { offset, content: null };
      }
    })
  );

  for (const { offset, content } of offsetReads) {
    let candidate: ClipboardImageItem | null = null;
    const itemTime = now - offset * 1000;

    if (content?.file) {
      const resolved = normalizeFilePath(content.file);
      if (resolved) {
        candidate = ingestImageFile(resolved, itemTime);
      }
    }

    if (!candidate && content?.html) {
      candidate = extractHtmlImage(content.html, itemTime);
    }

    // If the active clipboard slot (offset 0) had no file/html image, check raw OS bitmap clipboard
    if (!candidate && offset === 0 && !content?.text) {
      candidate = await captureSystemClipboardImage();
    }

    if (candidate && !seenIds.has(candidate.id)) {
      seenIds.add(candidate.id);
      const prev = existingById.get(candidate.id);
      if (prev) {
        discovered.push({
          ...prev,
          title: candidate.title,
          width: candidate.width || prev.width,
          height: candidate.height || prev.height,
          sourceName: candidate.sourceName || prev.sourceName,
          // Keep original timestamp unless it is the newly active top clipboard item
          copiedAt: offset === 0 && existing[0]?.id !== candidate.id ? now : prev.copiedAt,
        });
      } else {
        discovered.push(candidate);
      }
    }
  }

  // Also check raw OS clipboard if offset 0 had text metadata alongside an image (e.g. rich copy)
  if (discovered.length === 0) {
    const rawClip = await captureSystemClipboardImage();
    if (rawClip && !seenIds.has(rawClip.id)) {
      seenIds.add(rawClip.id);
      const prev = existingById.get(rawClip.id);
      discovered.push(prev ? { ...prev } : rawClip);
    }
  }

  // Merge: active clipboard images in exact offset order first, followed by older cached history
  const remaining = existing.filter((item) => !seenIds.has(item.id));
  const merged = [...discovered, ...remaining].sort((a, b) => b.copiedAt - a.copiedAt);

  // Ensure the very latest active clipboard image (offset 0) stays at the top of unpinned recents
  if (discovered.length > 0) {
    const topDiscovered = discovered[0];
    const idx = merged.findIndex((i) => i.id === topDiscovered.id);
    if (idx > 0) {
      const [item] = merged.splice(idx, 1);
      merged.unshift(item);
    }
  }

  await saveImageHistory(merged);
  return merged;
}

export function toFileMarkdownUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}

export function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 15) return "刚刚";
  if (diffSec < 60) return `${diffSec}秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

export function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}
