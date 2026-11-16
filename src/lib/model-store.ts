import { LocalStorage } from "@raycast/api";

const MODEL_CONFIG_STORAGE_KEY = "lite-ollama-independent-models-v1";

export interface SavedModelConfig {
  ocrModel: string;
  translateModel: string;
  askModel: string;
}

export interface InstalledModelInfo {
  name: string;
  label: string;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

function resolveModelsEndpoints(rawEndpoint: string): {
  ollamaTagsUrl?: string;
  openAiModelsUrl: string;
} {
  const cleaned = (rawEndpoint || "http://localhost:11434").trim().replace(/\/+$/, "");

  if (cleaned.endsWith("/chat/completions")) {
    const base = cleaned.slice(0, -"/chat/completions".length);
    return { openAiModelsUrl: `${base}/models` };
  }

  if (cleaned.endsWith("/v1") || cleaned.includes("/v1/")) {
    return { openAiModelsUrl: `${cleaned}/models` };
  }

  const root = cleaned.replace(/\/api(\/chat)?$/, "");
  return {
    ollamaTagsUrl: `${root}/api/tags`,
    openAiModelsUrl: `${root}/v1/models`,
  };
}

/**
 * Automatically fetches locally installed models from Ollama (`/api/tags`)
 * or an OpenAI-compatible `/v1/models` endpoint.
 */
export async function fetchInstalledModels(
  endpoint: string,
  apiKey?: string
): Promise<InstalledModelInfo[]> {
  const { ollamaTagsUrl, openAiModelsUrl } = resolveModelsEndpoints(endpoint);
  const headers: Record<string, string> = {};
  if (apiKey?.trim()) {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    if (ollamaTagsUrl) {
      try {
        const res = await fetch(ollamaTagsUrl, { headers, signal: controller.signal });
        if (res.ok) {
          const data = (await res.json()) as {
            models?: Array<{
              name?: string;
              size?: number;
              details?: {
                parameter_size?: string;
              };
            }>;
          };
          if (Array.isArray(data.models)) {
            return data.models
              .filter((m) => Boolean(m.name))
              .map((m) => {
                const name = String(m.name);
                const metaParts = [m.details?.parameter_size, formatBytes(m.size)].filter(Boolean);
                return {
                  name,
                  label: metaParts.length > 0 ? `${name}  (${metaParts.join(" · ")})` : name,
                };
              });
          }
        }
      } catch {
        // Fall through to OpenAI /v1/models
      }
    }

    const res = await fetch(openAiModelsUrl, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    if (Array.isArray(data.data)) {
      return data.data
        .filter((m) => Boolean(m.id))
        .map((m) => ({
          name: String(m.id),
          label: String(m.id),
        }));
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function loadModelConfig(): Promise<SavedModelConfig> {
  try {
    const raw = await LocalStorage.getItem<string>(MODEL_CONFIG_STORAGE_KEY);
    if (!raw) {
      return { ocrModel: "", translateModel: "", askModel: "" };
    }
    const parsed = JSON.parse(raw) as Partial<SavedModelConfig>;
    return {
      ocrModel: (parsed.ocrModel || "").trim(),
      translateModel: (parsed.translateModel || "").trim(),
      askModel: (parsed.askModel || "").trim(),
    };
  } catch {
    return { ocrModel: "", translateModel: "", askModel: "" };
  }
}

export async function saveModelConfig(config: SavedModelConfig): Promise<void> {
  await LocalStorage.setItem(
    MODEL_CONFIG_STORAGE_KEY,
    JSON.stringify({
      ocrModel: config.ocrModel.trim(),
      translateModel: config.translateModel.trim(),
      askModel: config.askModel.trim(),
    })
  );
}

export function guessVisionModel(models: InstalledModelInfo[]): string {
  const visionPattern = /vl|vision|ocr|llava|minicpm|moondream|pixtral|qwen3\.5|gemma3/i;
  return models.find((m) => visionPattern.test(m.name))?.name || "";
}

export function guessTextModel(models: InstalledModelInfo[]): string {
  const pureOcrPattern = /ocr/i;
  return models.find((m) => !pureOcrPattern.test(m.name))?.name || models[0]?.name || "";
}
