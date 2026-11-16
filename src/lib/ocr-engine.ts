import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  RegionTaskKind,
  mergeOverlappingText,
  needsSmartSlicing,
  sliceImageForOcr,
} from "./layout-slicer";
import { streamChat } from "./llm";
import { OcrEngineType } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Removes extra spaces inserted by Windows.Media.Ocr between adjacent CJK characters
 * while preserving normal spacing around Latin words and numbers.
 */
function normalizeCjkSpacing(text: string): string {
  const cjkRange =
    "\\u2E80-\\u2FFF\\u3000-\\u303F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF";
  const betweenCjk = new RegExp(`([${cjkRange}])[ \\t]+([${cjkRange}])`, "g");
  return text.replace(betweenCjk, "$1$2").replace(betweenCjk, "$1$2");
}

/**
 * Converts HTML `<table>...</table>` blocks emitted by GLM-OCR ("Table Recognition:")
 * into clean GitHub-Flavored Markdown tables for Raycast rendering and clipboard copying.
 */
export function convertHtmlTablesToMarkdown(input: string): string {
  if (!/<table[\s>]/i.test(input)) return input;

  return input.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi);
    if (!rowMatches || rowMatches.length === 0) return tableHtml;

    const rows: string[][] = [];
    let maxCols = 0;

    for (const tr of rowMatches) {
      const cellMatches = tr.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) || [];
      if (cellMatches.length === 0) continue;

      const cells: string[] = [];
      for (const cellHtml of cellMatches) {
        const colspanMatch = cellHtml.match(/colspan=["']?(\d+)["']?/i);
        const colspan = colspanMatch ? Math.max(1, Math.min(12, parseInt(colspanMatch[1], 10))) : 1;
        const inner = cellHtml
          .replace(/^<t[hd]\b[^>]*>/i, "")
          .replace(/<\/t[hd]>$/i, "")
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<\/p>\s*<p[^>]*>/gi, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/gi, " ")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">")
          .replace(/&amp;/gi, "&")
          .replace(/\|/g, "\\|")
          .replace(/\s+/g, " ")
          .trim();

        cells.push(inner);
        for (let c = 1; c < colspan; c++) {
          cells.push("");
        }
      }

      maxCols = Math.max(maxCols, cells.length);
      rows.push(cells);
    }

    if (rows.length === 0 || maxCols === 0) return tableHtml;

    const normalized = rows.map((r) => {
      const copy = [...r];
      while (copy.length < maxCols) copy.push("");
      return copy;
    });

    const header = `| ${normalized[0].join(" | ")} |`;
    const divider = `| ${normalized[0].map(() => "---").join(" | ")} |`;
    const body = normalized.slice(1).map((r) => `| ${r.join(" | ")} |`);

    return [header, divider, ...body].join("\n");
  });
}

function formatRecognizedRegion(raw: string, kind: RegionTaskKind): string {
  let cleaned = raw
    .replace(/^```(?:markdown|html|latex|tex)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  if (!cleaned || cleaned === "[未检测到文字]") return "";

  cleaned = convertHtmlTablesToMarkdown(cleaned);

  if (kind === "formula") {
    const stripped = cleaned
      .replace(/^\$\$\s*/, "")
      .replace(/\s*\$\$$/, "")
      .replace(/^\\\[\s*/, "")
      .replace(/\s*\\\]$/, "")
      .trim();
    if (stripped) {
      return `$$\n${stripped}\n$$`;
    }
  }

  return cleaned;
}

function buildOcrPromptForModel(model: string, kind: RegionTaskKind): string {
  const lower = model.toLowerCase();

  // Official Zhipu GLM-OCR two-stage prompts
  if (lower.includes("glm-ocr") || lower.includes("glm_ocr")) {
    switch (kind) {
      case "table":
        return "Table Recognition:";
      case "formula":
        return "Formula Recognition:";
      case "title":
      case "text":
      default:
        return "Text Recognition:";
    }
  }

  // DeepSeek-OCR prompt convention
  if (lower.includes("deepseek-ocr") || lower.includes("deepseek_ocr")) {
    return kind === "table"
      ? "Convert the table in this image to Markdown."
      : "Free OCR.";
  }

  // General multimodal vision models (Qwen2.5-VL, MiniCPM-V, Gemma3, Granite-Vision, etc.)
  switch (kind) {
    case "table":
      return "请将图片中的表格精确识别为 Markdown 表格格式，只输出表格本身，不要添加解释。";
    case "formula":
      return "请将图片中的数学公式精确识别为 LaTeX 公式，只输出公式内容，不要添加解释。";
    case "title":
    case "text":
    default:
      return "请精确提取这张图片中的所有文字内容（OCR），保持原有的段落、换行或代码层级结构。只输出原文内容，不要添加任何解释或前缀；若完全没有文字则留空。";
  }
}

interface NativeBoxLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  text: string;
}

async function runWindowsSingleSliceOcr(imagePath: string): Promise<string> {
  const psExe = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );

  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

$imgPath = $env:OCR_IMAGE_PATH
if (-not (Test-Path -LiteralPath $imgPath)) {
  throw "图片文件不存在: $imgPath"
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Foundation.IAsyncOperation\`1, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$awaiterMethod = [WindowsRuntimeSystemExtensions].GetMember('GetAwaiter') |
  Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } |
  Select-Object -First 1

function Await-WinRT($op, $type) {
  return $awaiterMethod.MakeGenericMethod($type).Invoke($null, @($op)).GetResult()
}

$langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
$preferred = $langs | Where-Object { $_.LanguageTag -match '^zh-Hans|^zh-CN|^zh' } | Select-Object -First 1
$engine = $null
if ($null -ne $preferred) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($preferred)
}
if ($null -eq $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine -and $langs.Count -gt 0) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langs[0])
}
if ($null -eq $engine) {
  throw "未检测到可用的 Windows OCR 语言包，请在系统设置 -> 语言中添加 OCR 支持，或切换为视觉大模型 OCR"
}

$file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imgPath)) ([Windows.Storage.StorageFile])
$stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $items = New-Object System.Collections.ArrayList
  foreach ($line in $result.Lines) {
    $words = $line.Words
    if ($words.Count -gt 0) {
      $minX = 1e9; $minY = 1e9; $maxX = 0.0; $maxY = 0.0
      foreach ($w in $words) {
        $r = $w.BoundingRect
        if ($r.X -lt $minX) { $minX = $r.X }
        if ($r.Y -lt $minY) { $minY = $r.Y }
        if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
        if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
      }
      [void]$items.Add(@{ x1 = $minX; y1 = $minY; x2 = $maxX; y2 = $maxY; text = $line.Text })
    }
  }
  ConvertTo-Json -InputObject @($items) -Compress
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
`;

  const { stdout } = await execFileAsync(
    psExe,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, OCR_IMAGE_PATH: imagePath },
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "null" || trimmed === "[]") return "";

  try {
    const parsed = JSON.parse(trimmed.replace(/^\uFEFF/, ""));
    const list: NativeBoxLine[] = Array.isArray(parsed) ? parsed : [parsed];
    list.sort((a, b) => (Math.abs(a.y1 - b.y1) > 10 ? a.y1 - b.y1 : a.x1 - b.x1));
    return normalizeCjkSpacing(list.map((l) => l.text).join("\n").trim());
  } catch {
    return normalizeCjkSpacing(trimmed);
  }
}

async function runMacSingleSliceOcr(imagePath: string): Promise<string> {
  const jxa = `
ObjC.import('Foundation');
ObjC.import('Vision');
ObjC.import('AppKit');

const imgPath = $.NSProcessInfo.processInfo.environment.objectForKey('OCR_IMAGE_PATH').js;
const url = $.NSURL.fileURLWithPath(imgPath);
const err = $();

const req = $.VNRecognizeTextRequest.alloc.init;
req.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
req.usesLanguageCorrection = true;
try {
  req.automaticallyDetectsLanguage = true;
} catch (e) {}
req.recognitionLanguages = $(['zh-Hans', 'zh-Hant', 'en-US', 'ja-JP'].map(l => $(l)));

const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
const ok = handler.performRequestsError($.NSArray.arrayWithObject(req), err);
if (!ok) {
  throw new Error(err.localizedDescription ? err.localizedDescription.js : 'macOS Vision OCR 执行失败');
}

const obs = req.results.js;
const items = obs.map(o => {
  const top = o.topCandidates(1).js[0];
  const box = o.boundingBox;
  // Vision normalized bottom-left origin -> convert to top-left relative 1000x1000 space
  const x1 = box.origin.x * 1000;
  const y1 = (1.0 - box.origin.y - box.size.height) * 1000;
  const x2 = (box.origin.x + box.size.width) * 1000;
  const y2 = (1.0 - box.origin.y) * 1000;
  return top ? { x1, y1, x2, y2, text: top.string.js } : null;
}).filter(Boolean);

JSON.stringify(items);
`;

  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", jxa], {
    env: { ...process.env, OCR_IMAGE_PATH: imagePath },
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "[]") return "";

  try {
    const list = JSON.parse(trimmed) as NativeBoxLine[];
    list.sort((a, b) => (Math.abs(a.y1 - b.y1) > 12 ? a.y1 - b.y1 : a.x1 - b.x1));
    return list.map((l) => l.text).join("\n").trim();
  } catch {
    return trimmed;
  }
}

async function runSingleSystemOcr(imagePath: string): Promise<string> {
  if (process.platform === "win32") {
    return runWindowsSingleSliceOcr(imagePath);
  }
  if (process.platform === "darwin") {
    return runMacSingleSliceOcr(imagePath);
  }
  throw new Error(`当前平台 (${process.platform}) 暂不支持系统原生 OCR，请切换为视觉大模型 OCR`);
}

export async function runSystemOcr(
  imagePath: string,
  opts?: { width?: number; height?: number; signal?: AbortSignal; onProgress?: (text: string) => void }
): Promise<string> {
  const w = opts?.width ?? 0;
  const h = opts?.height ?? 0;

  if (w > 0 && h > 0 && !needsSmartSlicing(w, h)) {
    const text = await runSingleSystemOcr(imagePath);
    opts?.onProgress?.(text);
    return text;
  }

  const { slices, cleanup } = await sliceImageForOcr(imagePath, {
    useLayoutModel: true,
    onStatus: opts?.onProgress,
  });

  try {
    if (slices.length === 1) {
      const text = await runSingleSystemOcr(slices[0].cropPath || imagePath);
      opts?.onProgress?.(text);
      return text;
    }

    let accumulated = "";
    for (let i = 0; i < slices.length; i++) {
      if (opts?.signal?.aborted) {
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      }
      const slice = slices[i];
      const headerHint = `> 🔍 *系统分块识别中 (${i + 1}/${slices.length})...*`;
      opts?.onProgress?.(accumulated ? `${accumulated}\n\n${headerHint}` : headerHint);

      const part = await runSingleSystemOcr(slice.cropPath || imagePath);
      if (part.trim()) {
        accumulated = mergeOverlappingText(accumulated, part, slice.hasOverlapWithPrev);
      }
    }

    opts?.onProgress?.(accumulated);
    return accumulated;
  } finally {
    cleanup();
  }
}

async function readImageForVisionLlm(
  imagePath: string,
  mimeType: string
): Promise<{ base64: string; mimeType: string }> {
  if (process.platform === "darwin" && (mimeType === "image/tiff" || mimeType === "image/heic")) {
    const tmpPng = path.join(os.tmpdir(), `raycast-ocr-${process.pid}-${Date.now()}.png`);
    try {
      await execFileAsync("/usr/bin/sips", ["-s", "format", "png", imagePath, "--out", tmpPng], {
        timeout: 5000,
      });
      if (fs.existsSync(tmpPng)) {
        const base64 = fs.readFileSync(tmpPng).toString("base64");
        return { base64, mimeType: "image/png" };
      }
    } catch {
      // Fallback to original buffer
    } finally {
      try {
        if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
      } catch {
        // ignore
      }
    }
  }

  const base64 = fs.readFileSync(imagePath).toString("base64");
  return { base64, mimeType: mimeType || "image/png" };
}

export interface RunOcrParams {
  imagePath: string;
  mimeType: string;
  width?: number;
  height?: number;
  engine: OcrEngineType;
  endpoint: string;
  model: string;
  apiKey?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export async function runImageOcr(params: RunOcrParams): Promise<string> {
  if (params.engine === "system") {
    return runSystemOcr(params.imagePath, {
      width: params.width,
      height: params.height,
      signal: params.signal,
      onProgress: params.onProgress,
    });
  }

  const w = params.width ?? 0;
  const h = params.height ?? 0;

  // Fast single-pass path for small crisp snips
  if (w > 0 && h > 0 && !needsSmartSlicing(w, h)) {
    const imgData = await readImageForVisionLlm(params.imagePath, params.mimeType);
    const prompt = buildOcrPromptForModel(params.model, "text");
    const res = await streamChat({
      endpoint: params.endpoint,
      model: params.model,
      apiKey: params.apiKey,
      options: { temperature: 0.1, num_ctx: 8192 },
      signal: params.signal,
      messages: [
        {
          role: "user",
          content: prompt,
          images: [imgData],
        },
      ],
      onProgress: (prog) => {
        if (prog.content) {
          params.onProgress?.(convertHtmlTablesToMarkdown(prog.content));
        } else if (prog.thinking) {
          params.onProgress?.(`> 💭 模型正在识别分析中...`);
        }
      },
    });
    return formatRecognizedRegion(res.content, "text");
  }

  // Two-stage industrial pipeline: PP-DocLayout-S + Valley-Splitting -> Region Cropping -> GLM-OCR / VLM
  params.onProgress?.(`> 📐 *正在运行版面分析与大图智能切片...*`);
  const { slices, cleanup } = await sliceImageForOcr(params.imagePath, {
    useLayoutModel: true,
    onStatus: params.onProgress,
  });

  try {
    let accumulated = "";

    for (let i = 0; i < slices.length; i++) {
      if (params.signal?.aborted) {
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      }

      const slice = slices[i];
      const cropFile = slice.cropPath || params.imagePath;
      const imgData = await readImageForVisionLlm(cropFile, "image/png");
      const prompt = buildOcrPromptForModel(params.model, slice.kind);

      const kindBadge =
        slice.kind === "table" ? "表格" : slice.kind === "formula" ? "公式" : "文本区块";
      const progressBanner =
        slices.length > 1
          ? `> 🔍 *正在识别第 ${i + 1}/${slices.length} 块 (${kindBadge})...*`
          : `> 🔍 *正在识别...*`;

      params.onProgress?.(accumulated ? `${accumulated}\n\n${progressBanner}` : progressBanner);

      const sliceRes = await streamChat({
        endpoint: params.endpoint,
        model: params.model,
        apiKey: params.apiKey,
        options: { temperature: 0.1, num_ctx: 8192 },
        signal: params.signal,
        messages: [
          {
            role: "user",
            content: prompt,
            images: [imgData],
          },
        ],
        onProgress: (prog) => {
          if (prog.content) {
            const liveBlock = convertHtmlTablesToMarkdown(prog.content);
            const mergedPreview = accumulated
              ? `${accumulated}\n\n${liveBlock}`
              : liveBlock;
            params.onProgress?.(
              slices.length > 1
                ? `${mergedPreview}\n\n> *(${i + 1}/${slices.length} 识别中...)*`
                : mergedPreview
            );
          }
        },
      });

      const formatted = formatRecognizedRegion(sliceRes.content, slice.kind);
      if (formatted) {
        accumulated = mergeOverlappingText(accumulated, formatted, slice.hasOverlapWithPrev);
      }
    }

    params.onProgress?.(accumulated);
    return accumulated.trim();
  } finally {
    cleanup();
  }
}
