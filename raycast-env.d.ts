/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Endpoint - 本地 Ollama 地址（如 http://localhost:11434）或 OpenAI 兼容接口地址（如 http://localhost:4000/v1） */
  "endpoint": string,
  /** Model - 用于翻译和问答的模型名称（如 qwen2.5:7b、llama3.2、qwen3:8b） */
  "model": string,
  /** API Key (可选) - 本地 Ollama 无需填写；接入 LiteLLM 或远程兼容网关时可按需配置 */
  "apiKey"?: string,
  /** 默认 OCR 识别引擎 - 支持系统原生离线极速识别与视觉大模型识别，也可在 OCR 面板右上角随时切换 */
  "ocrEngine": "system" | "llm",
  /** OCR 视觉模型 (可选) - 使用大模型 OCR 时调用的视觉模型（如 qwen2.5vl、minicpm-v、glm-ocr、gemma3）；留空则复用主 Model */
  "ocrModel"?: string,
  /** 默认翻译方向 - 翻译命令的默认目标语言方向 */
  "targetLang": "auto_zh_en" | "zh" | "en" | "ja",
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

