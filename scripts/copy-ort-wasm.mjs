import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const srcDir = path.join(rootDir, "node_modules", "onnxruntime-web", "dist");
const destDir = path.join(rootDir, "assets", "ort");

const filesToCopy = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

if (!fs.existsSync(srcDir)) {
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

for (const file of filesToCopy) {
  const from = path.join(srcDir, file);
  const to = path.join(destDir, file);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, to);
  }
}
