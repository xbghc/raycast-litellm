/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Endpoint - 本地 Ollama 地址（如 http://localhost:11434）；OCR / 翻译 / 问答三个独立模型会自动从该地址获取已安装列表供下拉选择 */
  "endpoint": string,
  /** 默认 OCR 识别引擎 - 支持系统原生离线极速识别与本地视觉大模型识别 */
  "ocrEngine": "system" | "llm",
  /** 默认翻译方向 - 翻译命令的默认目标语言方向 */
  "targetLang": "auto_zh_en" | "zh" | "en" | "ja",
  /** API Key (可选) - 本地 Ollama 无需填写；接入 LiteLLM 或远程兼容网关时可按需配置 */
  "apiKey"?: string,
  /** Ollama 桌面端路径 (可选) - 自定义 Ollama 桌面客户端可执行文件路径；留空则自动按系统默认路径检测 */
  "ollamaAppPath"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `ocr` command */
  export type Ocr = ExtensionPreferences & {}
  /** Preferences accessible in the `translate` command */
  export type Translate = ExtensionPreferences & {}
  /** Preferences accessible in the `ask` command */
  export type Ask = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `ocr` command */
  export type Ocr = {}
  /** Arguments passed to the `translate` command */
  export type Translate = {
  /** 输入待翻译文本（留空读取选中文本或剪贴板） */
  "text": string
}
  /** Arguments passed to the `ask` command */
  export type Ask = {
  /** 输入你的问题... */
  "text": string
}
}

