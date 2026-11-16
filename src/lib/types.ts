import { Keyboard } from "@raycast/api";

export type OcrEngineType = "system" | "llm";

export function crossShortcut(
  key: Keyboard.KeyEquivalent,
  extra?: Array<"shift" | "opt">
): Keyboard.Shortcut {
  const macMods: Keyboard.KeyModifier[] = ["cmd", ...(extra || [])];
  const winMods: Keyboard.KeyModifier[] = ["ctrl", ...(extra || [])];
  return {
    macOS: { modifiers: macMods, key },
    Windows: { modifiers: winMods, key },
  };
}

export type TargetLanguage = "auto_zh_en" | "zh" | "en" | "ja" | "ko" | "fr";

export interface ChatTurn {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  thinking?: string;
  images?: Array<{
    base64: string;
    mimeType: string;
  }>;
  createdAt: number;
}

export interface ClipboardImageItem {
  /** SHA-256 content hash */
  id: string;
  /** Persistent local file path inside extension supportPath */
  cachedPath: string;
  /** Raycast Clipboard style title, e.g. "Image (1920×1080)" */
  title: string;
  /** Optional source filename if copied from an external image file */
  sourceName?: string;
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
  copiedAt: number;
  pinned?: boolean;
  /** Cached OCR results keyed by engine ("system" | "llm:<model>") */
  ocrCache?: Record<string, string>;
}

export interface StreamProgress {
  content: string;
  thinking: string;
}
