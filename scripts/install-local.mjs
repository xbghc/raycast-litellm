import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rayBin = path.join(rootDir, "node_modules", "@raycast", "api", "bin", "run.js");

if (!fs.existsSync(rayBin)) {
  console.error("❌ 未找到 @raycast/api，请先执行 npm install");
  process.exit(1);
}

console.log("🚀 正在编译并向本地 Raycast 注册插件...");

let raycastNotRunning = false;

await new Promise((resolve, reject) => {
  const devProc = spawn(process.execPath, [rayBin, "develop", "--non-interactive"], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let settled = false;
  let outputBuffer = "";

  const finish = (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    try {
      devProc.kill();
    } catch {
      // ignore
    }
    if (err) reject(err);
    else resolve();
  };

  const timeoutTimer = setTimeout(() => {
    finish(new Error("等待 Raycast 编译注册超时（30s），请确认 Raycast 客户端已启动后重试。"));
  }, 30000);

  const onChunk = (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
    outputBuffer += text;

    if (text.includes("Raycast is not running")) {
      raycastNotRunning = true;
    }

    if (outputBuffer.includes("built extension successfully")) {
      // Give Raycast ~1.2s to process the raycast://cli/.../build-success registration event
      setTimeout(() => finish(null), 1200);
    }
  };

  devProc.stdout.on("data", onChunk);
  devProc.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (text.includes("Raycast is not running")) {
      raycastNotRunning = true;
    }
    process.stderr.write(text);
  });

  devProc.on("error", (err) => finish(err));
  devProc.on("exit", (code) => {
    if (!settled) {
      if (code === 0 || outputBuffer.includes("built extension successfully")) {
        finish(null);
      } else {
        finish(new Error(`ray develop 异常退出 (code ${code})`));
      }
    }
  });
});

// Replace dev build with minified dist build for optimal daily performance
console.log("\n📦 正在生成精简生产构建 (dist)...");
const distRes = spawnSync(process.execPath, [rayBin, "build", "-e", "dist"], {
  cwd: rootDir,
  stdio: "inherit",
});

if (distRes.status !== 0) {
  process.exit(distRes.status ?? 1);
}

// Wait briefly on Windows so the transient `raycast://cli/...` protocol forwarder process
// spawned by `ray build` finishes DLL init and exits cleanly before parent job teardown.
if (process.platform === "win32") {
  await new Promise((resolve) => setTimeout(resolve, 1800));
}

if (raycastNotRunning) {
  console.log(
    "\n⚠️ 编译已完成，但检测到当前 Raycast 未运行，尚未完成客户端注册。\n👉 请先启动 Raycast，然后再次执行 `npm run install:local`（或在 Raycast 中运行 Import Extension 选中本目录）。"
  );
} else {
  console.log("\n✅ 安装完成！插件已永久导入你的本地 Raycast，现在可以直接关闭终端使用。");
}
