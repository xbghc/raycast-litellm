import { LocalStorage } from "@raycast/api";
import { ThinkingEffort, isValidThinkingEffort } from "./types";

const MODEL_CONFIG_STORAGE_KEY = "lite-ollama-independent-models-v1";

export type CommandKind = "ocr" | "translate" | "ask";

export interface CommandModelMap {
  ocrModel?: string;
  translateModel?: string;
  askModel?: string;
  ocrThinking?: ThinkingEffort;
  translateThinking?: ThinkingEffort;
  askThinking?: ThinkingEffort;
}

export interface SavedModelConfig {
  ocrModel: string;
  translateModel: string;
  askModel: string;
  ocrThinking?: ThinkingEffort;
  translateThinking?: ThinkingEffort;
  askThinking?: ThinkingEffort;
  /** Stores per-endpoint model and thinking effort selections */
  byEndpoint?: Record<string, CommandModelMap>;
}

export interface InstalledModelInfo {
  name: string;
  label: string;
}

export interface ResolvedProviderConfig {
  endpoint: string;
  apiKey?: string;
  isCustomEndpoint: boolean;
  isCustomApiKey: boolean;
  globalEndpoint: string;
}

const COMMAND_MODEL_FIELD_MAP: Record<CommandKind, "ocrModel" | "translateModel" | "askModel"> = {
  ocr: "ocrModel",
  translate: "translateModel",
  ask: "askModel",
};

const COMMAND_THINKING_FIELD_MAP: Record<
  CommandKind,
  "ocrThinking" | "translateThinking" | "askThinking"
> = {
  ocr: "ocrThinking",
  translate: "translateThinking",
  ask: "askThinking",
};

export function normalizeEndpointKey(rawEndpoint?: string): string {
  return (rawEndpoint || "http://localhost:11434").trim().replace(/\/+$/, "") || "http://localhost:11434";
}

function hasSameOrigin(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).origin.toLowerCase() === new URL(urlB).origin.toLowerCase();
  } catch {
    return normalizeEndpointKey(urlA) === normalizeEndpointKey(urlB);
  }
}

export function formatEndpointHost(rawEndpoint: string): string {
  try {
    return new URL(rawEndpoint).host;
  } catch {
    return rawEndpoint;
  }
}

/**
 * Resolves the effective Provider (`endpoint` + `apiKey`) for a specific command,
 * falling back cleanly to the global extension preferences when command overrides are empty.
 */
export function resolveCommandProvider(prefs: {
  endpoint: string;
  apiKey?: string;
  customEndpoint?: string;
  customApiKey?: string;
}): ResolvedProviderConfig {
  const globalEndpoint = normalizeEndpointKey(prefs.endpoint);
  const cleanedCustomEndpoint = (prefs.customEndpoint || "").trim().replace(/\/+$/, "");
  const endpoint = cleanedCustomEndpoint || globalEndpoint;
  const isCustomEndpoint = Boolean(cleanedCustomEndpoint && cleanedCustomEndpoint !== globalEndpoint);

  const cleanedCustomKey = (prefs.customApiKey || "").trim();
  const cleanedGlobalKey = (prefs.apiKey || "").trim();

  let apiKey: string | undefined;
  let isCustomApiKey = false;

  if (cleanedCustomKey) {
    apiKey = cleanedCustomKey;
    isCustomApiKey = true;
  } else if (!cleanedCustomEndpoint || hasSameOrigin(cleanedCustomEndpoint, globalEndpoint)) {
    apiKey = cleanedGlobalKey || undefined;
  }

  return {
    endpoint,
    apiKey,
    isCustomEndpoint,
    isCustomApiKey,
    globalEndpoint,
  };
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
  const cleaned = normalizeEndpointKey(rawEndpoint);

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
 * Automatically fetches available models from Ollama (`/api/tags`)
 * or an OpenAI-compatible `/v1/models` endpoint (such as LiteLLM or acp2api).
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
  const timer = setTimeout(() => controller.abort(), 6000);

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
    const rawJson = (await res.json()) as
      | { data?: Array<{ id?: string; name?: string }> }
      | Array<{ id?: string; name?: string }>;
    const items = Array.isArray(rawJson)
      ? rawJson
      : Array.isArray(rawJson?.data)
        ? rawJson.data
        : [];

    return items
      .map((m) => String(m.id || m.name || "").trim())
      .filter(Boolean)
      .map((id) => ({
        name: id,
        label: id,
      }));
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
      ocrThinking: isValidThinkingEffort(parsed.ocrThinking) ? parsed.ocrThinking : undefined,
      translateThinking: isValidThinkingEffort(parsed.translateThinking)
        ? parsed.translateThinking
        : undefined,
      askThinking: isValidThinkingEffort(parsed.askThinking) ? parsed.askThinking : undefined,
      byEndpoint:
        parsed.byEndpoint && typeof parsed.byEndpoint === "object" ? parsed.byEndpoint : undefined,
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
      ...(config.ocrThinking ? { ocrThinking: config.ocrThinking } : {}),
      ...(config.translateThinking ? { translateThinking: config.translateThinking } : {}),
      ...(config.askThinking ? { askThinking: config.askThinking } : {}),
      ...(config.byEndpoint ? { byEndpoint: config.byEndpoint } : {}),
    })
  );
}

export function getCommandModel(
  config: SavedModelConfig | null,
  command: CommandKind,
  provider: ResolvedProviderConfig
): string {
  if (!config) return "";
  const field = COMMAND_MODEL_FIELD_MAP[command];
  const key = normalizeEndpointKey(provider.endpoint);
  const scoped = config.byEndpoint?.[key]?.[field];
  if (scoped !== undefined) {
    return scoped.trim();
  }

  // Backwards compatibility for existing configs saved before per-endpoint bindings
  if (!provider.isCustomEndpoint) {
    const hasAnyBindingForField = Object.values(config.byEndpoint || {}).some(
      (entry) => entry?.[field] !== undefined
    );
    if (!hasAnyBindingForField) {
      return (config[field] || "").trim();
    }
  }

  return "";
}

export function getCommandThinkingEffort(
  config: SavedModelConfig | null,
  command: CommandKind,
  provider: ResolvedProviderConfig
): ThinkingEffort {
  if (!config) return "default";
  const field = COMMAND_THINKING_FIELD_MAP[command];
  const key = normalizeEndpointKey(provider.endpoint);
  const scoped = config.byEndpoint?.[key]?.[field];
  if (isValidThinkingEffort(scoped)) {
    return scoped;
  }
  if (!provider.isCustomEndpoint && isValidThinkingEffort(config[field])) {
    return config[field]!;
  }
  return "default";
}

export async function saveCommandModel(
  current: SavedModelConfig,
  command: CommandKind,
  endpoint: string,
  model: string,
  thinkingEffort?: ThinkingEffort
): Promise<SavedModelConfig> {
  const modelField = COMMAND_MODEL_FIELD_MAP[command];
  const thinkingField = COMMAND_THINKING_FIELD_MAP[command];
  const key = normalizeEndpointKey(endpoint);
  const cleanModel = model.trim();
  const existingEntry = current.byEndpoint?.[key] || {};
  const nextEffort = thinkingEffort ?? existingEntry[thinkingField] ?? current[thinkingField] ?? "default";

  const nextByEndpoint: Record<string, CommandModelMap> = {
    ...(current.byEndpoint || {}),
    [key]: {
      ...existingEntry,
      [modelField]: cleanModel,
      [thinkingField]: nextEffort,
    },
  };

  const nextConfig: SavedModelConfig = {
    ocrModel: current.ocrModel || "",
    translateModel: current.translateModel || "",
    askModel: current.askModel || "",
    ocrThinking: current.ocrThinking,
    translateThinking: current.translateThinking,
    askThinking: current.askThinking,
    [modelField]: cleanModel,
    [thinkingField]: nextEffort,
    byEndpoint: nextByEndpoint,
  };

  await saveModelConfig(nextConfig);
  return nextConfig;
}

export async function saveCommandThinkingEffort(
  current: SavedModelConfig,
  command: CommandKind,
  endpoint: string,
  thinkingEffort: ThinkingEffort
): Promise<SavedModelConfig> {
  const thinkingField = COMMAND_THINKING_FIELD_MAP[command];
  const key = normalizeEndpointKey(endpoint);

  const nextByEndpoint: Record<string, CommandModelMap> = {
    ...(current.byEndpoint || {}),
    [key]: {
      ...(current.byEndpoint?.[key] || {}),
      [thinkingField]: thinkingEffort,
    },
  };

  const nextConfig: SavedModelConfig = {
    ...current,
    [thinkingField]: thinkingEffort,
    byEndpoint: nextByEndpoint,
  };

  await saveModelConfig(nextConfig);
  return nextConfig;
}

export function guessVisionModel(models: InstalledModelInfo[]): string {
  const visionPattern = /vl|vision|ocr|llava|minicpm|moondream|pixtral|qwen3\.5|gemma3/i;
  return models.find((m) => visionPattern.test(m.name))?.name || "";
}

export function guessTextModel(models: InstalledModelInfo[]): string {
  const pureOcrPattern = /ocr/i;
  return models.find((m) => !pureOcrPattern.test(m.name))?.name || models[0]?.name || "";
}
