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

export type ThinkingEffort = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const THINKING_EFFORT_OPTIONS: Array<{
  value: ThinkingEffort;
  title: string;
  shortLabel: string;
}> = [
  { value: "default", title: "默认 (跟随模型/服务端默认配置)", shortLabel: "默认" },
  { value: "none", title: "关闭思考 (none / think: false)", shortLabel: "关闭" },
  { value: "minimal", title: "极低 (minimal)", shortLabel: "极低" },
  { value: "low", title: "低 (low)", shortLabel: "低" },
  { value: "medium", title: "中 (medium)", shortLabel: "中" },
  { value: "high", title: "高 (high)", shortLabel: "高" },
  { value: "xhigh", title: "极高 (xhigh)", shortLabel: "极高" },
];

export function isValidThinkingEffort(val: unknown): val is ThinkingEffort {
  return (
    typeof val === "string" &&
    THINKING_EFFORT_OPTIONS.some((opt) => opt.value === val)
  );
}

export function getThinkingEffortShortLabel(effort?: ThinkingEffort): string {
  const found = THINKING_EFFORT_OPTIONS.find((opt) => opt.value === (effort || "default"));
  return found ? found.shortLabel : "默认";
}

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
