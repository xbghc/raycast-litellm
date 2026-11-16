import { environment } from "@raycast/api";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as ort from "onnxruntime-web/wasm";

const execFileAsync = promisify(execFile);

const LAYOUT_MODEL_FILENAME = "pp_doclayout_s.onnx";
const LAYOUT_MODEL_SHA256 = "33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8";
const LAYOUT_MODEL_URLS = [
  "https://hf-mirror.com/stefanj0/PP-DocLayout-S-ONNX/resolve/main/pp_doclayout_s.onnx",
  "https://huggingface.co/stefanj0/PP-DocLayout-S-ONNX/resolve/main/pp_doclayout_s.onnx",
];

const LAYOUT_INPUT_SIZE = 480;
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

/**
 * 23 classes of PaddlePaddle/PP-DocLayout-S in exact `inference.yml` index order.
 */
const PP_DOCLAYOUT_S_LABELS = [
  "paragraph_title", // 0
  "image",           // 1
  "text",            // 2
  "number",          // 3
  "abstract",        // 4
  "content",         // 5
  "figure_title",    // 6
  "formula",         // 7
  "table",           // 8
  "table_title",     // 9
  "reference",       // 10
  "doc_title",       // 11
  "footnote",        // 12
  "header",          // 13
  "algorithm",       // 14
  "footer",          // 15
  "seal",            // 16
  "chart_title",     // 17
  "chart",           // 18
  "formula_number",  // 19
  "header_image",    // 20
  "footer_image",    // 21
  "aside_text",      // 22
] as const;

export type RegionTaskKind = "text" | "title" | "table" | "formula";

export interface PlannedSlice {
  index: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: RegionTaskKind;
  hasOverlapWithPrev?: boolean;
  cropPath?: string;
}

interface RawLayoutBox {
  label: string;
  kind: RegionTaskKind | "skip_visual";
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface MacroStripMeta {
  index: number;
  y1: number;
  y2: number;
  rgbPath: string;
}

interface NativePrepResult {
  width: number;
  height: number;
  rowEnergies: number[];
  macroStrips: MacroStripMeta[];
}

let cachedSessionPromise: Promise<ort.InferenceSession> | null = null;
let downloadingPromise: Promise<string> | null = null;

function getModelsCacheDir(): string {
  const base = environment?.supportPath || path.join(os.tmpdir(), "raycast-litellm-cache");
  const dir = path.join(base, "models");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function resolveOrtWasmDir(): string {
  const candidates = [
    environment?.assetsPath ? path.join(environment.assetsPath, "ort") : "",
    path.resolve(__dirname, "assets", "ort"),
    path.resolve(__dirname, "..", "assets", "ort"),
    path.resolve(process.cwd(), "node_modules", "onnxruntime-web", "dist"),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "ort-wasm-simd-threaded.wasm"))) {
      return dir;
    }
  }
  throw new Error("未找到 ONNX Runtime WASM 运行时文件，请重新执行 npm run build");
}

export async function ensureDocLayoutModel(onStatus?: (msg: string) => void): Promise<string> {
  const modelPath = path.join(getModelsCacheDir(), LAYOUT_MODEL_FILENAME);
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 4_500_000) {
    return modelPath;
  }

  if (downloadingPromise) {
    return downloadingPromise;
  }

  downloadingPromise = (async () => {
    onStatus?.("> ⬇️ 首次使用大图智能版面切分，正在下载轻量版面分析小模型 `PP-DocLayout-S` (4.7 MB)...");
    let lastErr: unknown = null;

    for (const url of LAYOUT_MODEL_URLS) {
      const tmpPath = `${modelPath}.${process.pid}.tmp`;
      try {
        const res = await fetch(url);
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const hash = createHash("sha256").update(buf).digest("hex");
        if (hash !== LAYOUT_MODEL_SHA256) {
          throw new Error(`模型校验和不匹配 (${hash.slice(0, 12)})`);
        }
        fs.writeFileSync(tmpPath, buf);
        fs.renameSync(tmpPath, modelPath);
        return modelPath;
      } catch (err) {
        lastErr = err;
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
    }

    throw new Error(
      `下载版面小模型 PP-DocLayout-S 失败: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
  })().finally(() => {
    downloadingPromise = null;
  });

  return downloadingPromise;
}

async function getLayoutSession(onStatus?: (msg: string) => void): Promise<ort.InferenceSession> {
  if (!cachedSessionPromise) {
    cachedSessionPromise = (async () => {
      const modelPath = await ensureDocLayoutModel(onStatus);
      const ortDir = resolveOrtWasmDir();

      ort.env.logLevel = "error";
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = pathToFileURL(ortDir + path.sep).href;
      ort.env.wasm.wasmBinary = fs.readFileSync(path.join(ortDir, "ort-wasm-simd-threaded.wasm"));

      const modelBuf = fs.readFileSync(modelPath);
      return ort.InferenceSession.create(new Uint8Array(modelBuf), {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
        logSeverityLevel: 3,
      });
    })().catch((err) => {
      cachedSessionPromise = null;
      throw err;
    });
  }
  return cachedSessionPromise;
}

function mapLabelToKind(label: string): RegionTaskKind | "skip_visual" {
  switch (label) {
    case "table":
      return "table";
    case "formula":
      return "formula";
    case "doc_title":
    case "paragraph_title":
    case "table_title":
    case "figure_title":
    case "chart_title":
      return "title";
    case "image":
    case "seal":
    case "header_image":
    case "footer_image":
      return "skip_visual";
    default:
      return "text";
  }
}

/**
 * Finds horizontal whitespace valleys in `rowEnergies[yStart..yEnd]` to split tall regions
 * without slicing through characters.
 */
function splitRangeByValleys(
  rowEnergies: number[],
  yStart: number,
  yEnd: number,
  targetHeight: number,
  overlapFallbackPx: number
): Array<{ y1: number; y2: number; overlapped: boolean }> {
  const totalH = yEnd - yStart;
  if (totalH <= targetHeight * 1.25) {
    return [{ y1: yStart, y2: yEnd, overlapped: false }];
  }

  const slices: Array<{ y1: number; y2: number; overlapped: boolean }> = [];
  let curY = yStart;

  while (curY < yEnd) {
    if (yEnd - curY <= targetHeight * 1.28) {
      slices.push({
        y1: curY,
        y2: yEnd,
        overlapped: slices.length > 0 && curY < slices[slices.length - 1].y2,
      });
      break;
    }

    const idealCut = curY + targetHeight;
    const winStart = Math.max(curY + Math.floor(targetHeight * 0.55), idealCut - 260);
    const winEnd = Math.min(yEnd - 180, idealCut + 220);

    // Smooth energy over a 5-row window to find true blank inter-line gaps
    let bestY = idealCut;
    let minEnergy = Number.POSITIVE_INFINITY;

    for (let y = winStart; y <= winEnd; y++) {
      let windowSum = 0;
      let count = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const idx = y + dy;
        if (idx >= 0 && idx < rowEnergies.length) {
          windowSum += rowEnergies[idx];
          count++;
        }
      }
      const avg = count > 0 ? windowSum / count : 999;
      // Slight tie-breaker favoring cuts closer to idealCut
      const score = avg + Math.abs(y - idealCut) * 0.0005;
      if (score < minEnergy) {
        minEnergy = score;
        bestY = y;
      }
    }

    const rawValleyEnergy = rowEnergies[bestY] ?? 999;
    const isCleanBlankLine = rawValleyEnergy <= 2.2;
    const prevOverlapped = slices.length > 0 && curY < slices[slices.length - 1].y2;

    slices.push({
      y1: curY,
      y2: bestY,
      overlapped: prevOverlapped,
    });

    curY = isCleanBlankLine ? bestY : Math.max(curY + 200, bestY - overlapFallbackPx);
  }

  return slices;
}

async function prepareImageNative(imagePath: string, workDir: string): Promise<NativePrepResult> {
  const metaOutPath = path.join(workDir, "prep-meta.json");

  if (process.platform === "win32") {
    const psExe = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );

    const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not ("FastLayoutImgHelper" -as [type])) {
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;

public static class FastLayoutImgHelper {
  public static double[] ComputeRowEnergies(Bitmap bmp) {
    int w = bmp.Width;
    int h = bmp.Height;
    double[] energies = new double[h];
    Rectangle rect = new Rectangle(0, 0, w, h);
    BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    try {
      int stride = data.Stride;
      byte[] raw = new byte[Math.Abs(stride) * h];
      System.Runtime.InteropServices.Marshal.Copy(data.Scan0, raw, 0, raw.Length);
      int stepX = Math.Max(1, w / 320);
      for (int y = 0; y < h; y++) {
        int rowOffset = y * stride;
        long diffSum = 0;
        int samples = 0;
        for (int x = stepX; x < w; x += stepX) {
          int i1 = rowOffset + x * 3;
          int i0 = rowOffset + (x - stepX) * 3;
          int db = Math.Abs(raw[i1] - raw[i0]);
          int dg = Math.Abs(raw[i1 + 1] - raw[i0 + 1]);
          int dr = Math.Abs(raw[i1 + 2] - raw[i0 + 2]);
          diffSum += (dr + dg + db);
          samples++;
        }
        energies[y] = samples > 0 ? Math.Round((double)diffSum / (samples * 3.0), 2) : 0.0;
      }
    } finally {
      bmp.UnlockBits(data);
    }
    return energies;
  }

  public static void SaveRgb480(Bitmap src, int y1, int y2, string outPath) {
    int sh = Math.Max(1, y2 - y1);
    using (Bitmap resized = new Bitmap(480, 480, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(resized)) {
        g.InterpolationMode = InterpolationMode.Bilinear;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(src, new Rectangle(0, 0, 480, 480), new Rectangle(0, y1, src.Width, sh), GraphicsUnit.Pixel);
      }
      BitmapData bd = resized.LockBits(new Rectangle(0, 0, 480, 480), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
      try {
        int stride = bd.Stride;
        byte[] bgr = new byte[Math.Abs(stride) * 480];
        System.Runtime.InteropServices.Marshal.Copy(bd.Scan0, bgr, 0, bgr.Length);
        byte[] rgb = new byte[480 * 480 * 3];
        int dst = 0;
        for (int y = 0; y < 480; y++) {
          int row = y * stride;
          for (int x = 0; x < 480; x++) {
            int p = row + x * 3;
            rgb[dst++] = bgr[p + 2]; // R
            rgb[dst++] = bgr[p + 1]; // G
            rgb[dst++] = bgr[p];     // B
          }
        }
        File.WriteAllBytes(outPath, rgb);
      } finally {
        resized.UnlockBits(bd);
      }
    }
  }
}
"@
}

$imgPath = $env:SLICE_IMG_PATH
$workDir = $env:SLICE_WORK_DIR
$metaOut = $env:SLICE_META_OUT

$bmp = [System.Drawing.Bitmap]::new($imgPath)
try {
  $w = $bmp.Width
  $h = $bmp.Height
  $energies = [FastLayoutImgHelper]::ComputeRowEnergies($bmp)

  # Build macro-strips if ultra-tall scrolling capture
  $strips = New-Object System.Collections.ArrayList
  if ($h -gt 2000 -and $h -gt ($w * 1.85)) {
    $curY = 0
    $idx = 0
    while ($curY -lt $h) {
      if (($h - $curY) -le 1900) {
        $rgbPath = Join-Path $workDir "macro_$idx.rgb"
        [FastLayoutImgHelper]::SaveRgb480($bmp, $curY, $h, $rgbPath)
        [void]$strips.Add(@{ index = $idx; y1 = $curY; y2 = $h; rgbPath = $rgbPath })
        break
      }
      $ideal = $curY + 1500
      $ws = [Math]::Max($curY + 850, $ideal - 280)
      $we = [Math]::Min($h - 200, $ideal + 240)
      $bestY = $ideal
      $minE = 1e9
      for ($y = $ws; $y -le $we; $y++) {
        $e = $energies[$y]
        if ($e -lt $minE) { $minE = $e; $bestY = $y }
      }
      $rgbPath = Join-Path $workDir "macro_$idx.rgb"
      [FastLayoutImgHelper]::SaveRgb480($bmp, $curY, $bestY, $rgbPath)
      [void]$strips.Add(@{ index = $idx; y1 = $curY; y2 = $bestY; rgbPath = $rgbPath })
      $curY = if ($minE -le 2.2) { $bestY } else { [Math]::Max($curY + 300, $bestY - 60) }
      $idx++
    }
  } else {
    $rgbPath = Join-Path $workDir "macro_0.rgb"
    [FastLayoutImgHelper]::SaveRgb480($bmp, 0, $h, $rgbPath)
    [void]$strips.Add(@{ index = 0; y1 = 0; y2 = $h; rgbPath = $rgbPath })
  }

  $payload = @{
    width = $w
    height = $h
    rowEnergies = @($energies)
    macroStrips = @($strips)
  } | ConvertTo-Json -Depth 5 -Compress

  [System.IO.File]::WriteAllText($metaOut, $payload, [System.Text.UTF8Encoding]::new($false))
} finally {
  $bmp.Dispose()
}
`;

    await execFileAsync(psExe, ["-NoProfile", "-NonInteractive", "-Command", psScript], {
      env: {
        ...process.env,
        SLICE_IMG_PATH: imagePath,
        SLICE_WORK_DIR: workDir,
        SLICE_META_OUT: metaOutPath,
      },
      timeout: 15000,
      windowsHide: true,
    });

    return JSON.parse(fs.readFileSync(metaOutPath, "utf8").replace(/^\uFEFF/, "")) as NativePrepResult;
  }

  // macOS path via JXA + CoreGraphics/AppKit
  const jxa = `
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

const env = $.NSProcessInfo.processInfo.environment;
const imgPath = env.objectForKey('SLICE_IMG_PATH').js;
const workDir = env.objectForKey('SLICE_WORK_DIR').js;
const metaOut = env.objectForKey('SLICE_META_OUT').js;

const data = $.NSData.dataWithContentsOfFile(imgPath);
const rep = $.NSBitmapImageRep.imageRepWithData(data);
if (!rep || rep.isNil()) throw new Error('无法解码图片: ' + imgPath);

const w = rep.pixelsWide;
const h = rep.pixelsHigh;

// Render full RGBA buffer to compute row energies
const colorSpace = $.CGColorSpaceCreateDeviceRGB();
const rawData = $.NSMutableData.dataWithLength(w * h * 4);
const ctx = $.CGBitmapContextCreate(rawData.mutableBytes, w, h, 8, w * 4, colorSpace, 1); // kCGImageAlphaPremultipliedLast
$.CGContextDrawImage(ctx, $.CGRectMake(0, 0, w, h), rep.CGImage);

const ptr = new Uint8Array(Interop.bufferFromPointer(rawData.mutableBytes, w * h * 4));
const energies = new Array(h);
const stepX = Math.max(1, Math.floor(w / 320));
for (let y = 0; y < h; y++) {
  const rowOff = y * w * 4;
  let diff = 0, samples = 0;
  for (let x = stepX; x < w; x += stepX) {
    const i1 = rowOff + x * 4;
    const i0 = rowOff + (x - stepX) * 4;
    diff += Math.abs(ptr[i1] - ptr[i0]) + Math.abs(ptr[i1+1] - ptr[i0+1]) + Math.abs(ptr[i1+2] - ptr[i0+2]);
    samples++;
  }
  energies[y] = samples > 0 ? Math.round((diff / (samples * 3)) * 100) / 100 : 0;
}

function saveRgb480(y1, y2, outPath) {
  const sh = Math.max(1, y2 - y1);
  // CoreGraphics Y origin is bottom-left for CGImageCreateWithImageInRect? Actually CGImageCreateWithImageInRect uses top-left pixel coords!
  const subImg = $.CGImageCreateWithImageInRect(rep.CGImage, $.CGRectMake(0, y1, w, sh));
  const buf480 = $.NSMutableData.dataWithLength(480 * 480 * 4);
  const c480 = $.CGBitmapContextCreate(buf480.mutableBytes, 480, 480, 8, 480 * 4, colorSpace, 1);
  $.CGContextSetInterpolationQuality(c480, 2);
  $.CGContextDrawImage(c480, $.CGRectMake(0, 0, 480, 480), subImg);
  const rgba = new Uint8Array(Interop.bufferFromPointer(buf480.mutableBytes, 480 * 480 * 4));
  const rgb = new Uint8Array(480 * 480 * 3);
  let dst = 0;
  for (let i = 0; i < 480 * 480; i++) {
    rgb[dst++] = rgba[i * 4];
    rgb[dst++] = rgba[i * 4 + 1];
    rgb[dst++] = rgba[i * 4 + 2];
  }
  const outNs = $.NSData.dataWithBytesLength(rgb, rgb.byteLength);
  outNs.writeToFileAtomically(outPath, true);
}

const strips = [];
if (h > 2000 && h > w * 1.85) {
  let curY = 0, idx = 0;
  while (curY < h) {
    if (h - curY <= 1900) {
      const p = workDir + '/macro_' + idx + '.rgb';
      saveRgb480(curY, h, p);
      strips.push({ index: idx, y1: curY, y2: h, rgbPath: p });
      break;
    }
    const ideal = curY + 1500;
    const ws = Math.max(curY + 850, ideal - 280);
    const we = Math.min(h - 200, ideal + 240);
    let bestY = ideal, minE = 1e9;
    for (let y = ws; y <= we; y++) {
      if (energies[y] < minE) { minE = energies[y]; bestY = y; }
    }
    const p = workDir + '/macro_' + idx + '.rgb';
    saveRgb480(curY, bestY, p);
    strips.push({ index: idx, y1: curY, y2: bestY, rgbPath: p });
    curY = minE <= 2.2 ? bestY : Math.max(curY + 300, bestY - 60);
    idx++;
  }
} else {
  const p = workDir + '/macro_0.rgb';
  saveRgb480(0, h, p);
  strips.push({ index: 0, y1: 0, y2: h, rgbPath: p });
}

const jsonStr = JSON.stringify({ width: w, height: h, rowEnergies: energies, macroStrips: strips });
$.NSString.alloc.initWithUTF8String(jsonStr).writeToFileAtomicallyEncodingError(metaOut, true, $.NSUTF8StringEncoding, null);
`;

  await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", jxa], {
    env: {
      ...process.env,
      SLICE_IMG_PATH: imagePath,
      SLICE_WORK_DIR: workDir,
      SLICE_META_OUT: metaOutPath,
    },
    timeout: 15000,
  });

  return JSON.parse(fs.readFileSync(metaOutPath, "utf8")) as NativePrepResult;
}

async function detectBoxesOnStrip(
  sess: ort.InferenceSession,
  rgbPath: string,
  stripW: number,
  stripH: number,
  globalYOffset: number
): Promise<RawLayoutBox[]> {
  const rgbBuf = fs.readFileSync(rgbPath);
  const planeSize = LAYOUT_INPUT_SIZE * LAYOUT_INPUT_SIZE;
  const chw = new Float32Array(3 * planeSize);

  for (let i = 0; i < planeSize; i++) {
    const r = rgbBuf[i * 3] / 255.0;
    const g = rgbBuf[i * 3 + 1] / 255.0;
    const b = rgbBuf[i * 3 + 2] / 255.0;
    chw[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    chw[planeSize + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    chw[2 * planeSize + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }

  const sf = new Float32Array([LAYOUT_INPUT_SIZE / stripH, LAYOUT_INPUT_SIZE / stripW]);
  const imgTensor = new ort.Tensor("float32", chw, [1, 3, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE]);
  const sfTensor = new ort.Tensor("float32", sf, [1, 2]);

  try {
    const out = await sess.run({
      image: imgTensor,
      scale_factor: sfTensor,
    });

    const detTensor = out[sess.outputNames[0]];
    const numTensor = out[sess.outputNames[1]];
    const data = detTensor.data as Float32Array;
    const validCount = numTensor ? Number(numTensor.data[0]) : detTensor.dims[0];
    const cols = detTensor.dims[1] || 6;

    const raw: RawLayoutBox[] = [];
    for (let i = 0; i < validCount; i++) {
      const off = i * cols;
      const clsId = Math.round(data[off]);
      const score = data[off + 1];
      if (score < 0.34) continue;

      const x1 = Math.max(0, Math.min(stripW, data[off + 2]));
      const y1 = Math.max(0, Math.min(stripH, data[off + 3])) + globalYOffset;
      const x2 = Math.max(0, Math.min(stripW, data[off + 4]));
      const y2 = Math.max(0, Math.min(stripH, data[off + 5])) + globalYOffset;

      if (x2 - x1 < 10 || y2 - y1 < 8) continue;

      const label = PP_DOCLAYOUT_S_LABELS[clsId] || "text";
      raw.push({
        label,
        kind: mapLabelToKind(label),
        score,
        x1,
        y1,
        x2,
        y2,
      });
    }

    return postprocessBoxes(raw);
  } finally {
    imgTensor.dispose();
    sfTensor.dispose();
  }
}

function computeIoU(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter <= 0) return 0;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter);
}

function computeIoMin(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter <= 0) return 0;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / Math.min(areaA, areaB);
}

function postprocessBoxes(boxes: RawLayoutBox[]): RawLayoutBox[] {
  // Prefer high-confidence & structured boxes (table/formula) during NMS
  const sorted = [...boxes].sort((a, b) => {
    const bonusA = a.kind === "table" || a.kind === "formula" ? 0.08 : 0;
    const bonusB = b.kind === "table" || b.kind === "formula" ? 0.08 : 0;
    return b.score + bonusB - (a.score + bonusA);
  });

  const suppressed = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      if (suppressed.has(j)) continue;
      // Suppress smaller box contained inside a table/same-kind box
      if (
        (sorted[i].kind === "table" || sorted[i].kind === sorted[j].kind) &&
        computeIoMin(sorted[i], sorted[j]) > 0.65
      ) {
        const areaI = (sorted[i].x2 - sorted[i].x1) * (sorted[i].y2 - sorted[i].y1);
        const areaJ = (sorted[j].x2 - sorted[j].x1) * (sorted[j].y2 - sorted[j].y1);
        if (areaI >= areaJ) {
          suppressed.add(j);
        } else if (sorted[i].kind === sorted[j].kind) {
          suppressed.add(i);
          break;
        }
      } else if (computeIoU(sorted[i], sorted[j]) > 0.75) {
        suppressed.add(j);
      }
    }
  }

  return sorted.filter((_, idx) => !suppressed.has(idx));
}

/**
 * Classical Recursive XY-Cut algorithm to establish natural multi-column & top-to-bottom
 * human reading order from bounding boxes.
 */
export function sortBoxesByXYCut<T extends { x1: number; y1: number; x2: number; y2: number }>(
  boxes: T[],
  depth = 0
): T[] {
  if (boxes.length <= 1 || depth > 12) return boxes;

  // 1. Try horizontal cut (top-to-bottom bands separated by full-width Y gap)
  const byY = [...boxes].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  let maxEndY = byY[0].y2;
  for (let i = 1; i < byY.length; i++) {
    if (byY[i].y1 >= maxEndY - 4) {
      const topGroup = byY.slice(0, i);
      const bottomGroup = byY.slice(i);
      return [...sortBoxesByXYCut(topGroup, depth + 1), ...sortBoxesByXYCut(bottomGroup, depth + 1)];
    }
    maxEndY = Math.max(maxEndY, byY[i].y2);
  }

  // 2. Try vertical gutter cut (left-to-right columns separated by clear X gutter >= 16px)
  const byX = [...boxes].sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1);
  let maxEndX = byX[0].x2;
  let bestSplitIdx = -1;
  let largestGutter = 14;

  for (let i = 1; i < byX.length; i++) {
    const gutter = byX[i].x1 - maxEndX;
    if (gutter > largestGutter) {
      largestGutter = gutter;
      bestSplitIdx = i;
    }
    maxEndX = Math.max(maxEndX, byX[i].x2);
  }

  if (bestSplitIdx !== -1) {
    const leftCol = byX.slice(0, bestSplitIdx);
    const rightCol = byX.slice(bestSplitIdx);
    return [...sortBoxesByXYCut(leftCol, depth + 1), ...sortBoxesByXYCut(rightCol, depth + 1)];
  }

  return byY;
}

/**
 * Coalesces adjacent same-column text paragraphs into compact medium crops (<= 920px tall)
 * to minimize Ollama round-trip overhead while keeping tables and standalone formulas isolated.
 */
function coalesceOrderedBoxes(
  boxes: Array<{ x1: number; y1: number; x2: number; y2: number; kind: RegionTaskKind }>
): Array<{ x1: number; y1: number; x2: number; y2: number; kind: RegionTaskKind }> {
  if (boxes.length <= 1) return boxes;

  const result: Array<{ x1: number; y1: number; x2: number; y2: number; kind: RegionTaskKind }> = [];

  for (const box of boxes) {
    const prev = result[result.length - 1];
    if (!prev) {
      result.push({ ...box });
      continue;
    }

    const bothTextLike =
      (prev.kind === "text" || prev.kind === "title") && box.kind === "text";
    const vGap = box.y1 - prev.y2;
    const xOverlap =
      Math.min(prev.x2, box.x2) - Math.max(prev.x1, box.x1);
    const minWidth = Math.min(prev.x2 - prev.x1, box.x2 - box.x1);
    const sameColumn = minWidth > 0 && xOverlap / minWidth >= 0.45;

    const mergedX1 = Math.min(prev.x1, box.x1);
    const mergedY1 = Math.min(prev.y1, box.y1);
    const mergedX2 = Math.max(prev.x2, box.x2);
    const mergedY2 = Math.max(prev.y2, box.y2);

    if (
      bothTextLike &&
      sameColumn &&
      vGap >= -15 &&
      vGap <= 95 &&
      mergedY2 - mergedY1 <= 920 &&
      mergedX2 - mergedX1 <= 1850
    ) {
      prev.x1 = mergedX1;
      prev.y1 = mergedY1;
      prev.x2 = mergedX2;
      prev.y2 = mergedY2;
      prev.kind = "text";
    } else {
      result.push({ ...box });
    }
  }

  return result;
}

async function cropSlicesBatchNative(
  imagePath: string,
  imgW: number,
  imgH: number,
  slices: PlannedSlice[],
  workDir: string
): Promise<PlannedSlice[]> {
  const padded = slices.map((s, idx) => {
    const padX = Math.min(12, Math.round((s.x2 - s.x1) * 0.02) + 6);
    const padY = Math.min(10, Math.round((s.y2 - s.y1) * 0.03) + 5);
    const x1 = Math.max(0, Math.floor(s.x1 - padX));
    const y1 = Math.max(0, Math.floor(s.y1 - padY));
    const x2 = Math.min(imgW, Math.ceil(s.x2 + padX));
    const y2 = Math.min(imgH, Math.ceil(s.y2 + padY));
    const outFile = path.join(workDir, `crop_${idx}.png`);
    return {
      ...s,
      index: idx,
      cropRect: { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) },
      cropPath: outFile,
    };
  });

  const specPath = path.join(workDir, "crop-spec.json");
  fs.writeFileSync(
    specPath,
    JSON.stringify(padded.map((p) => ({ out: p.cropPath, ...p.cropRect }))),
    "utf8"
  );

  if (process.platform === "win32") {
    const psExe = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );

    const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$imgPath = $env:CROP_IMG_PATH
$specJson = [System.IO.File]::ReadAllText($env:CROP_SPEC_PATH, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

$src = [System.Drawing.Bitmap]::new($imgPath)
try {
  foreach ($item in $specJson) {
    $cw = [int]$item.w
    $ch = [int]$item.h
    $tw = $cw
    $th = $ch
    if ($tw -gt 1800) {
      $scale = 1800.0 / $tw
      $tw = 1800
      $th = [Math]::Max(1, [int][Math]::Round($th * $scale))
    }
    $canvasH = [Math]::Max(40, $th)
    $padTop = [int][Math]::Floor(($canvasH - $th) / 2.0)

    $dst = New-Object System.Drawing.Bitmap($tw, $canvasH)
    try {
      $g = [System.Drawing.Graphics]::FromImage($dst)
      try {
        $g.Clear([System.Drawing.Color]::White)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $srcRect = New-Object System.Drawing.Rectangle([int]$item.x, [int]$item.y, $cw, $ch)
        $dstRect = New-Object System.Drawing.Rectangle(0, $padTop, $tw, $th)
        $g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
      } finally {
        $g.Dispose()
      }
      $dst.Save([string]$item.out, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $dst.Dispose()
    }
  }
} finally {
  $src.Dispose()
}
`;

    await execFileAsync(psExe, ["-NoProfile", "-NonInteractive", "-Command", psScript], {
      env: {
        ...process.env,
        CROP_IMG_PATH: imagePath,
        CROP_SPEC_PATH: specPath,
      },
      timeout: 20000,
      windowsHide: true,
    });
  } else {
    const jxa = `
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

const env = $.NSProcessInfo.processInfo.environment;
const imgPath = env.objectForKey('CROP_IMG_PATH').js;
const specPath = env.objectForKey('CROP_SPEC_PATH').js;
const specStr = $.NSString.stringWithContentsOfFileEncodingError(specPath, $.NSUTF8StringEncoding, null).js;
const items = JSON.parse(specStr);

const data = $.NSData.dataWithContentsOfFile(imgPath);
const rep = $.NSBitmapImageRep.imageRepWithData(data);
const colorSpace = $.CGColorSpaceCreateDeviceRGB();

for (const item of items) {
  const sub = $.CGImageCreateWithImageInRect(rep.CGImage, $.CGRectMake(item.x, item.y, item.w, item.h));
  let tw = item.w, th = item.h;
  if (tw > 1800) {
    const s = 1800 / tw;
    tw = 1800;
    th = Math.max(1, Math.round(th * s));
  }
  const canvasH = Math.max(40, th);
  const ctx = $.CGBitmapContextCreate(null, tw, canvasH, 8, tw * 4, colorSpace, 1);
  $.CGContextSetRGBFillColor(ctx, 1, 1, 1, 1);
  $.CGContextFillRect(ctx, $.CGRectMake(0, 0, tw, canvasH));
  $.CGContextSetInterpolationQuality(ctx, 3);
  $.CGContextDrawImage(ctx, $.CGRectMake(0, Math.floor((canvasH - th) / 2), tw, th), sub);
  const outCg = $.CGBitmapContextCreateImage(ctx);
  const outRep = $.NSBitmapImageRep.alloc.initWithCGImage(outCg);
  const pngData = outRep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  pngData.writeToFileAtomically(item.out, true);
}
`;

    await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", jxa], {
      env: {
        ...process.env,
        CROP_IMG_PATH: imagePath,
        CROP_SPEC_PATH: specPath,
      },
      timeout: 20000,
    });
  }

  return padded;
}

/**
 * Decides whether an image is small enough to be recognized in a single direct pass,
 * or should go through the two-stage PP-DocLayout-S + Valley-Splitting pipeline.
 */
export function needsSmartSlicing(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return true;
  if (width > 1250 || height > 750) return true;
  if (width * height > 650_000) return true;
  return false;
}

/**
 * Executes Stage 1 of the industrial OCR pipeline:
 * 1) Macro valley-splitting for ultra-tall scrolling screenshots
 * 2) PP-DocLayout-S (4.7MB ONNX WASM) semantic layout detection (paragraphs, titles, tables, formulas)
 * 3) Automatic fallback to whitespace-valley strips for dark-theme UI/code/terminal screenshots
 * 4) Recursive XY-Cut multi-column reading-order sorting & same-column coalescing
 * 5) Batch native high-res region cropping
 */
export async function sliceImageForOcr(
  imagePath: string,
  options?: {
    useLayoutModel?: boolean;
    onStatus?: (msg: string) => void;
  }
): Promise<{
  slices: PlannedSlice[];
  cleanup: () => void;
}> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "raycast-ocr-slices-"));
  const cleanup = () => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  try {
    const prep = await prepareImageNative(imagePath, workDir);
    const { width: imgW, height: imgH, rowEnergies, macroStrips } = prep;

    if (!needsSmartSlicing(imgW, imgH)) {
      cleanup();
      return {
        slices: [
          {
            index: 0,
            x1: 0,
            y1: 0,
            x2: imgW,
            y2: imgH,
            kind: "text",
            cropPath: imagePath,
          },
        ],
        cleanup: () => {},
      };
    }

    const useLayout = options?.useLayoutModel !== false;
    let sess: ort.InferenceSession | null = null;
    if (useLayout) {
      try {
        sess = await getLayoutSession(options?.onStatus);
      } catch {
        // Gracefully degrade to pure valley-splitting if offline on first run before model download
        sess = null;
      }
    }

    const finalRegions: PlannedSlice[] = [];

    for (const strip of macroStrips) {
      const stripH = strip.y2 - strip.y1;
      let stripRegions: Array<{ x1: number; y1: number; x2: number; y2: number; kind: RegionTaskKind }> = [];

      if (sess) {
        const detected = await detectBoxesOnStrip(sess, strip.rgbPath, imgW, stripH, strip.y1);
        const textBoxes = detected.filter((b) => b.kind !== "skip_visual") as Array<{
          x1: number;
          y1: number;
          x2: number;
          y2: number;
          kind: RegionTaskKind;
        }>;

        // Calculate bounding coverage vs actual non-blank rows to catch dark-mode terminal/UI screenshots
        const coveredArea = textBoxes.reduce(
          (acc, b) => acc + Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1),
          0
        );
        const activeRows = rowEnergies
          .slice(strip.y1, strip.y2)
          .filter((e) => e > 2.5).length;
        const activeRatio = stripH > 0 ? activeRows / stripH : 0;
        const boxCoverageRatio = imgW * stripH > 0 ? coveredArea / (imgW * stripH) : 0;

        if (textBoxes.length > 0 && !(activeRatio > 0.25 && boxCoverageRatio < 0.06)) {
          const ordered = sortBoxesByXYCut(textBoxes);
          stripRegions = coalesceOrderedBoxes(ordered);
        }
      }

      if (stripRegions.length === 0) {
        // Valley-splitting fallback (ideal for dark-theme IDE/terminal/chat or plain scrolling captures)
        const valleySlices = splitRangeByValleys(rowEnergies, strip.y1, strip.y2, 1050, 65);
        for (const vs of valleySlices) {
          finalRegions.push({
            index: finalRegions.length,
            x1: 0,
            y1: vs.y1,
            x2: imgW,
            y2: vs.y2,
            kind: "text",
            hasOverlapWithPrev: vs.overlapped,
          });
        }
      } else {
        // Sub-slice any single oversized region (> 1200px tall) along whitespace valleys
        for (const reg of stripRegions) {
          if (reg.y2 - reg.y1 > 1200 && reg.kind !== "table") {
            const sub = splitRangeByValleys(rowEnergies, Math.floor(reg.y1), Math.ceil(reg.y2), 950, 55);
            for (const s of sub) {
              finalRegions.push({
                index: finalRegions.length,
                x1: reg.x1,
                y1: s.y1,
                x2: reg.x2,
                y2: s.y2,
                kind: reg.kind,
                hasOverlapWithPrev: s.overlapped,
              });
            }
          } else {
            finalRegions.push({
              index: finalRegions.length,
              x1: reg.x1,
              y1: reg.y1,
              x2: reg.x2,
              y2: reg.y2,
              kind: reg.kind,
              hasOverlapWithPrev: false,
            });
          }
        }
      }
    }

    // If after layout analysis there's just 1 full-image normal-sized box, avoid redundant crop if small
    const cropped = await cropSlicesBatchNative(imagePath, imgW, imgH, finalRegions, workDir);
    return { slices: cropped, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Deduplicates repeated boundary lines when two consecutive slices were cut with vertical overlap.
 */
export function mergeOverlappingText(prevText: string, nextText: string, hasOverlap?: boolean): string {
  const a = prevText.trimEnd();
  const b = nextText.trimStart();
  if (!a) return b;
  if (!b) return a;
  if (!hasOverlap) return `${a}\n\n${b}`;

  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const maxCheck = Math.min(4, aLines.length, bLines.length);

  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

  let dropCount = 0;
  for (let k = maxCheck; k >= 1; k--) {
    let allMatch = true;
    for (let i = 0; i < k; i++) {
      const tailLine = norm(aLines[aLines.length - k + i]);
      const headLine = norm(bLines[i]);
      if (!tailLine || !headLine) {
        allMatch = false;
        break;
      }
      if (tailLine !== headLine && !tailLine.includes(headLine) && !headLine.includes(tailLine)) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      dropCount = k;
      break;
    }
  }

  const keptNext = bLines.slice(dropCount).join("\n").trimStart();
  return keptNext ? `${a}\n${keptNext}` : a;
}
