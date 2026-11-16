import { ChatTurn, StreamProgress } from "./types";

export interface LlmRequestOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
    images?: Array<{ base64: string; mimeType: string }>;
  }>;
  signal?: AbortSignal;
  onProgress?: (progress: StreamProgress) => void;
}

interface ResolvedEndpoint {
  mode: "ollama" | "openai";
  chatUrl: string;
  fallbackOpenAiUrl?: string;
}

export function resolveEndpoint(rawEndpoint: string): ResolvedEndpoint {
  const cleaned = (rawEndpoint || "http://localhost:11434").trim().replace(/\/+$/, "");

  if (cleaned.endsWith("/chat/completions")) {
    return {
      mode: "openai",
      chatUrl: cleaned,
    };
  }

  if (cleaned.endsWith("/v1") || cleaned.includes("/v1/")) {
    const v1Base = cleaned.replace(/\/+$/, "");
    return {
      mode: "openai",
      chatUrl: `${v1Base}/chat/completions`,
    };
  }

  if (cleaned.endsWith("/api/chat")) {
    const root = cleaned.slice(0, -"/api/chat".length);
    return {
      mode: "ollama",
      chatUrl: cleaned,
      fallbackOpenAiUrl: `${root}/v1/chat/completions`,
    };
  }

  if (cleaned.endsWith("/api")) {
    const root = cleaned.slice(0, -"/api".length);
    return {
      mode: "ollama",
      chatUrl: `${cleaned}/chat`,
      fallbackOpenAiUrl: `${root}/v1/chat/completions`,
    };
  }

  return {
    mode: "ollama",
    chatUrl: `${cleaned}/api/chat`,
    fallbackOpenAiUrl: `${cleaned}/v1/chat/completions`,
  };
}

/**
 * Splits inline `<think>...</think>` reasoning blocks from final visible content,
 * merging with any explicit `thinking` field returned by Ollama/OpenAI APIs.
 */
export function splitThinkingAndContent(rawContent: string, explicitThinking: string): StreamProgress {
  let thinking = explicitThinking || "";
  let content = rawContent || "";

  const trimmedStart = content.trimStart();
  if (trimmedStart.startsWith("<think>")) {
    const afterOpen = trimmedStart.slice("<think>".length);
    const closeIdx = afterOpen.indexOf("</think>");
    if (closeIdx === -1) {
      thinking = [thinking, afterOpen].filter(Boolean).join("\n").trim();
      content = "";
    } else {
      const inlineThought = afterOpen.slice(0, closeIdx).trim();
      thinking = [thinking, inlineThought].filter(Boolean).join("\n").trim();
      content = afterOpen.slice(closeIdx + "</think>".length).trimStart();
    }
  }

  return { content, thinking };
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey && apiKey.trim()) {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

async function streamOllamaChat(url: string, opts: LlmRequestOptions): Promise<StreamProgress | "FALLBACK_OPENAI"> {
  const payload = {
    model: opts.model.trim(),
    stream: true,
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.images && m.images.length > 0 ? { images: m.images.map((img) => img.base64) } : {}),
    })),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(opts.apiKey),
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  if ((res.status === 404 || res.status === 405) && opts.endpoint) {
    const errText = await res.text().catch(() => "");
    if (!errText.toLowerCase().includes("model") && !errText.toLowerCase().includes("ollama")) {
      return "FALLBACK_OPENAI";
    }
    throw new Error(parseApiError(res.status, errText, opts.model));
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(parseApiError(res.status, errText, opts.model));
  }

  if (!res.body) {
    throw new Error("模型服务未返回流式响应内容");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let rawContent = "";
  let explicitThinking = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        if (parsed.error) {
          throw new Error(String(parsed.error));
        }
        if (parsed.message) {
          if (typeof parsed.message.thinking === "string") {
            explicitThinking += parsed.message.thinking;
          }
          if (typeof parsed.message.content === "string") {
            rawContent += parsed.message.content;
          }
          opts.onProgress?.(splitThinkingAndContent(rawContent, explicitThinking));
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }

  if (buffer.trim()) {
    try {
      const parsed = JSON.parse(buffer.trim());
      if (parsed.error) throw new Error(String(parsed.error));
      if (parsed.message?.thinking) explicitThinking += parsed.message.thinking;
      if (parsed.message?.content) rawContent += parsed.message.content;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }

  const finalResult = splitThinkingAndContent(rawContent, explicitThinking);
  opts.onProgress?.(finalResult);
  return finalResult;
}

async function streamOpenAiChat(url: string, opts: LlmRequestOptions): Promise<StreamProgress> {
  const payload = {
    model: opts.model.trim(),
    stream: true,
    messages: opts.messages.map((m) => {
      if (m.images && m.images.length > 0) {
        return {
          role: m.role,
          content: [
            { type: "text", text: m.content },
            ...m.images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
          ],
        };
      }
      return {
        role: m.role,
        content: m.content,
      };
    }),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(opts.apiKey),
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(parseApiError(res.status, errText, opts.model));
  }

  if (!res.body) {
    throw new Error("模型服务未返回响应流");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let rawContent = "";
  let explicitThinking = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line || !line.startsWith("data:")) continue;

      const dataStr = line.slice(5).trim();
      if (dataStr === "[DONE]") break;

      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.error) {
          throw new Error(parsed.error.message || JSON.stringify(parsed.error));
        }
        const delta = parsed.choices?.[0]?.delta;
        if (delta) {
          if (typeof delta.reasoning_content === "string") {
            explicitThinking += delta.reasoning_content;
          } else if (typeof delta.reasoning === "string") {
            explicitThinking += delta.reasoning;
          }
          if (typeof delta.content === "string") {
            rawContent += delta.content;
          }
          opts.onProgress?.(splitThinkingAndContent(rawContent, explicitThinking));
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }

  const finalResult = splitThinkingAndContent(rawContent, explicitThinking);
  opts.onProgress?.(finalResult);
  return finalResult;
}

function parseApiError(status: number, bodyText: string, model: string): string {
  try {
    const json = JSON.parse(bodyText);
    const msg = json?.error?.message || json?.error || json?.message;
    if (typeof msg === "string" && msg.trim()) {
      if (msg.toLowerCase().includes("not found") && msg.toLowerCase().includes("model")) {
        return `未找到模型 "${model}"，请确认已执行 ollama pull ${model}（原始信息: ${msg}）`;
      }
      return `请求失败 (${status}): ${msg}`;
    }
  } catch {
    // ignore JSON parse error
  }
  return `请求失败 (HTTP ${status})${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`;
}

export async function streamChat(opts: LlmRequestOptions): Promise<StreamProgress> {
  if (!opts.model || !opts.model.trim()) {
    throw new Error("未配置对应命令的模型名称，请在插件偏好设置中填写");
  }

  const resolved = resolveEndpoint(opts.endpoint);

  try {
    if (resolved.mode === "ollama") {
      const res = await streamOllamaChat(resolved.chatUrl, opts);
      if (res === "FALLBACK_OPENAI" && resolved.fallbackOpenAiUrl) {
        return await streamOpenAiChat(resolved.fallbackOpenAiUrl, opts);
      }
      if (res !== "FALLBACK_OPENAI") {
        return res;
      }
    }
    return await streamOpenAiChat(resolved.chatUrl, opts);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
      throw new Error(`无法连接到 ${opts.endpoint}，请确认本地 Ollama 服务正在运行`);
    }
    throw err;
  }
}

export function turnsToMessages(turns: ChatTurn[]) {
  return turns.map((t) => ({
    role: t.role,
    content: t.content,
    images: t.images,
  }));
}
