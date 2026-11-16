import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { streamChat } from "./llm";
import { OcrEngineType } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Removes extra spaces inserted by Windows.Media.Ocr between adjacent CJK characters
 * while preserving normal spacing around Latin words and numbers.
 */
function normalizeCjkSpacing(text: string): string {
  const cjkRange = "\\u2E80-\\u2FFF\\u3000-\\u303F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF";
  const betweenCjk = new RegExp(`([${cjkRange}])[ \\t]+([${cjkRange}])`, "g");
  // Run twice to handle overlapping adjacent pairs ("你 好 世 界" -> "你好 世界" -> "你好世界")
  return text.replace(betweenCjk, "$1$2").replace(betweenCjk, "$1$2");
}

async function runWindowsNativeOcr(imagePath: string): Promise<string> {
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

# Prefer a CJK-capable recognizer if installed (handles both Chinese & English cleanly)
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
  foreach ($line in $result.Lines) {
    Write-Output $line.Text
  }
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

  return normalizeCjkSpacing(stdout.replace(/\r\n/g, "\n").trim());
}

async function runMacNativeOcr(imagePath: string): Promise<string> {
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
const lines = obs.map(o => {
  const top = o.topCandidates(1).js[0];
  return top ? top.string.js : '';
}).filter(Boolean);

lines.join('\\n');
`;

  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", jxa], {
    env: { ...process.env, OCR_IMAGE_PATH: imagePath },
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout.trim();
}

export async function runSystemOcr(imagePath: string): Promise<string> {
  if (process.platform === "win32") {
    return runWindowsNativeOcr(imagePath);
  }
  if (process.platform === "darwin") {
    return runMacNativeOcr(imagePath);
  }
  throw new Error(`当前平台 (${process.platform}) 暂不支持系统原生 OCR，请切换为视觉大模型 OCR`);
}

async function readImageForVisionLlm(
  imagePath: string,
  mimeType: string
): Promise<{ base64: string; mimeType: string }> {
  // Convert TIFF/HEIC on macOS to PNG so all vision models accept it reliably
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
  engine: OcrEngineType;
  endpoint: string;
  model: string;
  apiKey?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export async function runImageOcr(params: RunOcrParams): Promise<string> {
  if (params.engine === "system") {
    const text = await runSystemOcr(params.imagePath);
    params.onProgress?.(text);
    return text;
  }

  const imgData = await readImageForVisionLlm(params.imagePath, params.mimeType);
  const result = await streamChat({
    endpoint: params.endpoint,
    model: params.model,
    apiKey: params.apiKey,
    signal: params.signal,
    messages: [
      {
        role: "user",
        content:
          "请精确提取这张图片中的所有文字内容（OCR）。保持原有的段落、换行、代码块或表格层级结构。只输出识别出的原文内容，不要添加任何解释、前缀或总结；如果图片中完全没有文字，仅输出“[未检测到文字]”。",
        images: [imgData],
      },
    ],
    onProgress: (prog) => {
      if (prog.content) {
        params.onProgress?.(prog.content);
      } else if (prog.thinking) {
        params.onProgress?.(`> 💭 模型正在识别分析中...`);
      }
    },
  });

  return result.content.trim();
}
