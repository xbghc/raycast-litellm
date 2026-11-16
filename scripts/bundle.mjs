import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rayBin = path.join(rootDir, "node_modules", "@raycast", "api", "bin", "run.js");
const releaseDir = path.join(rootDir, "release");
const outFile = path.join(releaseDir, "raycast-litellm.rayext");

if (!fs.existsSync(rayBin)) {
  console.error("❌ 未找到 @raycast/api，请先执行 npm install");
  process.exit(1);
}

fs.mkdirSync(releaseDir, { recursive: true });
if (fs.existsSync(outFile)) {
  fs.unlinkSync(outFile);
}

console.log("📦 正在打包 .rayext 插件归档文件...");
const res = spawnSync(process.execPath, [rayBin, "bundle", "-o", outFile], {
  cwd: rootDir,
  stdio: "inherit",
});

if (res.status !== 0) {
  process.exit(res.status ?? 1);
}

const stat = fs.statSync(outFile);
const kb = (stat.size / 1024).toFixed(1);
console.log(`\n✅ 打包成功: ${outFile} (${kb} KB)`);
console.log("💡 分享说明: 接收方可将此 .rayext 解压到任意目录，在 Raycast 中运行 'Import Extension' 选中该目录即可。");
