# Lite Ollama (Raycast 轻量本地大模型插件)

同时兼容 **Windows** 与 **macOS** 版 Raycast 的超轻量本地 AI 插件（仅依赖 `@raycast/api`，无原生 C++ 编译依赖），提供 **剪贴板图片 OCR**、**快捷流式翻译** 与 **快捷问答（支持一键进入 Ollama 桌面端继续对话）** 3 个命令。

---

## ✨ 包含的 3 个命令

### 1. `OCR Clipboard Images` (`ocr`)
- 打开与 **Raycast Clipboard History** 布局一致的左右分栏面板：
  - **左侧**：严格筛选为**图片**的剪贴板项（显示缩略图与 `Image (宽×高)` 尺寸标题，按 `Pinned` / `Today` / `Earlier` 分组，支持直接按已识别文字模糊检索）。
  - **右侧**：实时显示当前焦点图片的 **OCR 识别结果** 与原图预览。
- **双引擎可随时切换**（插件设置默认配置，或面板右上角下拉框 / `Ctrl/⌘ + E` 即时切换）：
  1. **系统原生离线 OCR**：Windows 调用系统内置 `Windows.Media.Ocr`（自动优选支持中英混排的语言包并修复中文字符间距），macOS 调用原生 `Vision` 框架（`VNRecognizeTextRequest` Accurate 模式），毫秒级离线识别。
  2. **本地视觉大模型 OCR**：调用本地 Ollama 视觉模型（如 `qwen2.5vl`、`minicpm-v`、`glm-ocr`、`gemma3` 等）提取复杂排版、代码或表格。
- **联动操作**：`Enter` 复制识别文本，`Ctrl/⌘ + Enter` 粘贴到当前应用，`Ctrl/⌘ + T` 一键送入翻译，`Ctrl/⌘ + J` 一键送入问答。

### 2. `Translate` (`t ${text}`)
- 在 Raycast 输入 `t ${text}`（配置别名 `t` 后输入 `t` + `空格` + `文本`）即可实时流式翻译。
- 若未传文本参数，自动依次读取**当前选中文本**或**剪贴板文本**。
- 默认支持**中英智能互译**，也可按 `Ctrl/⌘ + L` 快速切换简体中文 / English / 日本語 / 한국어 / Français，按 `Ctrl/⌘ + M` 动态切换本地已下载模型。

### 3. `Quick Ask` (`q ${text}`)
- 在 Raycast 输入 `q ${text}`（配置别名 `q` 后输入 `q` + `空格` + `问题`）进行轻量流式问答，自动兼容推理模型（如 `qwen3`、`deepseek-r1`）的思考过程分离显示。
- **一键进入 Ollama 继续对话**：
  - 在问答结果界面直接按 **`Enter`（进入 Ollama 继续对话）**，插件会将当前完整问答上下文（含 `thinking` 思考链与 `model_name`）安全写入本地 **Ollama 桌面端数据库 (`db.sqlite`)**，并自动唤起/聚焦 **Ollama 桌面客户端**窗口，无缝衔接到 Ollama GUI 中继续多轮对话。
  - 若当前设备仅安装了 Ollama CLI 未安装桌面端，自动回退为打开终端运行 `ollama run <model>`。
  - 也支持按 `Ctrl/⌘ + N` 直接在当前 Raycast 面板内快速追问。

---

## 🚀 安装、分享与多端同步（免商店审核）

### 方式 A：Git 仓库克隆一键安装（推荐，完成后自动退出不挂后台）

在其他电脑克隆仓库后，直接运行内置的一键安装脚本（会自动安装依赖、注册导入到本机 Raycast、生成生产精简包并自动退出）：

- **通用命令**：
  ```bash
  npm install && npm run install:local
  ```
- **Windows 快捷脚本**：
  ```powershell
  .\install.ps1
  ```
- **macOS 快捷脚本**：
  ```bash
  bash install.sh
  ```
- *（开发调试如需实时热更新，再运行 `npm run dev`）*

### 方式 B：打包 `.rayext` 独立归档包分享

执行打包命令：

```bash
npm run bundle
```

将在 `release/raycast-litellm.rayext` 生成打包好的插件归档文件（约 95 KB）：
1. 把 `.rayext` 发给朋友或另一台设备，改后缀为 `.zip` 或直接解压到一个固定文件夹（确保目录根部有 `package.json`）；
2. 打开 Raycast 搜索运行 **`Import Extension`**，选中该文件夹即可导入（注：若需本机源码级更新仍推荐方式 A）。
3. 项目已内置 GitHub Actions（[.github/workflows/bundle.yml](.github/workflows/bundle.yml)），推送 `v*` 标签（如 `git tag v1.0.0 && git push --tags`）时会自动在 GitHub Releases 构建并上传 `.rayext` 包。

---

## ⌨️ 配置 `t ${text}` 与 `q ${text}` 快捷触发（仅需一次）

Raycast 原生通过 **Command Alias（命令别名）+ 空格** 实现前缀参数触发：

1. 打开 **Raycast Settings** → **Extensions** → 找到 **Lite Ollama**。
2. 在 **OCR Clipboard Images** 右侧 **Alias** 填入 `ocr`（可选，本身输入 `ocr` 也可直接匹配）。
3. 在 **Translate** 右侧 **Alias** 填入 **`t`**。
4. 在 **Quick Ask** 右侧 **Alias** 填入 **`q`**。

设置完成后，呼出 Raycast：
- 输入 `t `（`t` 加空格）→ 直接输入待翻译文本回车即可生成翻译；
- 输入 `q `（`q` 加空格）→ 直接输入问题回车即可问答，回答页回车即可跳入 Ollama 桌面端继续聊！

---

## ⚙️ 插件配置项说明

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| **Endpoint** | `http://localhost:11434` | 本地 Ollama 地址，也支持任意 OpenAI 兼容接口（如 LiteLLM `http://localhost:4000/v1`） |
| **Model** | `qwen2.5:7b` | 翻译与问答默认使用的模型名称（需先 `ollama pull` 下载） |
| **API Key** | 空 | 本地 Ollama 留空即可；连接远程或网关时选填 |
| **默认 OCR 识别引擎** | 系统原生离线 OCR | 可选「系统原生离线 OCR」或「本地视觉大模型 OCR」 |
| **OCR 视觉模型** | 空 | 使用大模型 OCR 时的视觉模型名（如 `qwen2.5vl:7b`），留空则复用主 Model |
| **默认翻译方向** | 智能互译 (中 ↔ 英) | 默认翻译目标语言策略 |
| **Ollama 桌面端路径** | 空 | 留空自动检测系统默认安装位置，特殊安装路径可手动指定 |
