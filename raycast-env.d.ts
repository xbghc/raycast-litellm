/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** 默认 Endpoint - 全局默认模型服务地址（如本地 Ollama http://localhost:11434）；各命令若未单独填写独立 Endpoint，则自动使用此处地址 */
  "endpoint": string,
  /** 默认 OCR 识别引擎 - 支持系统原生离线极速识别与本地视觉大模型识别 */
  "ocrEngine": "system" | "llm",
  /** 默认翻译方向 - 翻译命令的默认目标语言方向 */
  "targetLang": "auto_zh_en" | "zh" | "en" | "ja" | "ko" | "fr",
  /** 默认 API Key (可选) - 全局默认 API Key；本地 Ollama 无需填写，接入远程网关时可按需配置 */
  "apiKey"?: string,
  /** Ollama 桌面端路径 (可选) - 自定义 Ollama 桌面客户端可执行文件路径；留空则自动按系统默认路径检测 */
  "ollamaAppPath"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `ocr` command */
  export type Ocr = ExtensionPreferences & {
  /** OCR 独立 Endpoint (可选) - 仅用于视觉大模型 OCR 的服务地址；留空则使用全局默认 Endpoint */
  "customEndpoint"?: string,
  /** OCR 独立 API Key (可选) - 仅用于视觉大模型 OCR 的 API Key；留空且未更换跨域地址时回退使用全局默认 API Key */
  "customApiKey"?: string
}
  /** Preferences accessible in the `translate` command */
  export type Translate = ExtensionPreferences & {
  /** 翻译独立 Endpoint (可选) - 仅用于翻译命令的服务地址（如本地 Ollama 或兼容 /v1 接口）；留空则使用全局默认 Endpoint */
  "customEndpoint"?: string,
  /** 翻译独立 API Key (可选) - 仅用于翻译命令的 API Key；留空且未更换跨域地址时回退使用全局默认 API Key */
  "customApiKey"?: string
}
  /** Preferences accessible in the `ask` command */
  export type Ask = ExtensionPreferences & {
  /** 问答独立 Endpoint (可选) - 仅用于问答命令的服务地址（如 acp2api http://127.0.0.1:8787/v1）；留空则使用全局默认 Endpoint */
  "customEndpoint"?: string,
  /** 问答独立 API Key (可选) - 仅用于问答命令的 API Key；留空且未更换跨域地址时回退使用全局默认 API Key */
  "customApiKey"?: string
}
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

