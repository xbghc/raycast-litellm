import {
  Action,
  ActionPanel,
  Form,
  Icon,
  Toast,
  openCommandPreferences,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import {
  CommandKind,
  InstalledModelInfo,
  ResolvedProviderConfig,
  SavedModelConfig,
  fetchInstalledModels,
  getCommandModel,
  getCommandThinkingEffort,
  guessTextModel,
  guessVisionModel,
  saveCommandModel,
} from "../lib/model-store";
import {
  THINKING_EFFORT_OPTIONS,
  ThinkingEffort,
  crossShortcut,
  getThinkingEffortShortLabel,
} from "../lib/types";

const NONE_OCR_VALUE = "__none__";

const COMMAND_META: Record<
  CommandKind,
  {
    navTitle: string;
    fieldTitle: string;
    infoText: string;
    placeholder: string;
  }
> = {
  ocr: {
    navTitle: "配置视觉 OCR 模型与思考强度",
    fieldTitle: "OCR 模型",
    infoText: "用于视觉大模型 OCR 识别；仅作用于当前 OCR 命令生效的 Provider",
    placeholder: "例如 glm-ocr 或 qwen2.5vl:7b",
  },
  translate: {
    navTitle: "配置翻译模型与思考强度",
    fieldTitle: "翻译模型",
    infoText: "专用于 t ${text} 翻译命令；仅绑定到翻译命令当前生效的 Provider",
    placeholder: "例如 qwen2.5:7b 或 gpt-4o-mini",
  },
  ask: {
    navTitle: "配置问答模型与思考强度",
    fieldTitle: "问答模型",
    infoText: "专用于 q ${text} 问答命令；仅绑定到问答命令当前生效的 Provider",
    placeholder: "例如 qwen3:8b 或 acp2api 模型名",
  },
};

export interface ModelConfigFormProps {
  command: CommandKind;
  provider: ResolvedProviderConfig;
  refreshProvider?: () => ResolvedProviderConfig;
  initialConfig: SavedModelConfig;
  requireModel?: boolean;
  onSaved: (updated: SavedModelConfig) => void;
}

export function ModelConfigForm(props: ModelConfigFormProps) {
  const meta = COMMAND_META[props.command];
  const [activeProvider, setActiveProvider] = useState<ResolvedProviderConfig>(props.provider);
  const [models, setModels] = useState<InstalledModelInfo[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState<boolean>(false);

  const initialSaved = getCommandModel(props.initialConfig, props.command, props.provider);
  const initialEffort = getCommandThinkingEffort(props.initialConfig, props.command, props.provider);

  const [selectedModel, setSelectedModel] = useState<string>(
    props.command === "ocr" ? initialSaved || NONE_OCR_VALUE : initialSaved
  );
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort>(initialEffort);

  useEffect(() => {
    setActiveProvider(props.provider);
  }, [props.provider]);

  const reloadModels = useCallback(async () => {
    const currentProvider = props.refreshProvider ? props.refreshProvider() : activeProvider;
    setActiveProvider(currentProvider);
    setIsLoading(true);
    setFetchError(null);

    const savedForProvider = getCommandModel(props.initialConfig, props.command, currentProvider);
    const savedEffortForProvider = getCommandThinkingEffort(
      props.initialConfig,
      props.command,
      currentProvider
    );
    setThinkingEffort(savedEffortForProvider);

    try {
      const list = await fetchInstalledModels(currentProvider.endpoint, currentProvider.apiKey);
      setModels(list);

      if (list.length > 0) {
        setManualMode(false);
        if (props.command === "ocr") {
          const fallbackVision = guessVisionModel(list);
          setSelectedModel((prev) => {
            if (savedForProvider) return savedForProvider;
            if (prev && prev !== NONE_OCR_VALUE && list.some((m) => m.name === prev)) return prev;
            return fallbackVision || NONE_OCR_VALUE;
          });
        } else {
          const fallbackText = guessTextModel(list);
          setSelectedModel((prev) => {
            if (savedForProvider) return savedForProvider;
            if (prev && list.some((m) => m.name === prev)) return prev;
            return fallbackText;
          });
        }
      } else {
        setManualMode(true);
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
      setManualMode(true);
    } finally {
      setIsLoading(false);
    }
  }, [activeProvider, props]);

  useEffect(() => {
    void reloadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.provider.endpoint, props.provider.apiKey]);

  const handleSubmit = async () => {
    const cleanModel =
      props.command === "ocr" && selectedModel === NONE_OCR_VALUE ? "" : selectedModel.trim();

    if (props.command === "ocr") {
      if (props.requireModel && !cleanModel) {
        await showToast({ style: Toast.Style.Failure, title: "请选择或填写用于视觉 OCR 的模型" });
        return;
      }
    } else if (!cleanModel) {
      await showToast({ style: Toast.Style.Failure, title: `请为${meta.fieldTitle}选择或填写模型名称` });
      return;
    }

    const updated = await saveCommandModel(
      props.initialConfig,
      props.command,
      activeProvider.endpoint,
      cleanModel,
      thinkingEffort
    );

    const effortBadge =
      thinkingEffort !== "default" ? ` · 思考:${getThinkingEffortShortLabel(thinkingEffort)}` : "";
    await showToast({
      style: Toast.Style.Success,
      title: cleanModel ? `已保存: ${cleanModel}${effortBadge}` : "已保存配置",
    });
    props.onSaved(updated);
  };

  const existsInList = models.some((m) => m.name === selectedModel);
  const endpointSourceTag = activeProvider.isCustomEndpoint ? "当前命令独立 Endpoint" : "全局默认 Endpoint";
  const keySourceTag = activeProvider.isCustomApiKey
    ? " · 独立 API Key"
    : activeProvider.apiKey
      ? " · 全局 API Key"
      : "";

  const statusLine = fetchError
    ? `⚠️ 无法从 ${activeProvider.endpoint} 获取模型列表 (${fetchError})，可直接手动输入模型名，或修改当前命令独立 Endpoint`
    : models.length > 0
      ? `已自动检测到 ${models.length} 个可用模型`
      : "未检测到模型列表，可直接手动输入模型名";

  return (
    <Form
      isLoading={isLoading}
      navigationTitle={meta.navTitle}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存配置" icon={Icon.CheckCircle} onSubmit={handleSubmit} />
          <Action
            title="配置当前命令独立 Endpoint / API Key"
            icon={Icon.Network}
            shortcut={crossShortcut("e", ["shift"])}
            onAction={openCommandPreferences}
          />
          <Action
            title="重新扫描服务端可用模型"
            icon={Icon.ArrowClockwise}
            shortcut={crossShortcut("r")}
            onAction={reloadModels}
          />
          {models.length > 0 && (
            <Action
              title={manualMode ? "切换为下拉列表选择" : "切换为手动输入模型名"}
              icon={Icon.Pencil}
              shortcut={crossShortcut("i")}
              onAction={() => setManualMode((v) => !v)}
            />
          )}
          <Action
            title="打开全局默认偏好设置"
            icon={Icon.Gear}
            onAction={openExtensionPreferences}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="生效服务端"
        text={`${activeProvider.endpoint}（${endpointSourceTag}${keySourceTag}）\n${statusLine}`}
      />

      {!manualMode && models.length > 0 ? (
        <Form.Dropdown
          id="modelSelect"
          title={meta.fieldTitle}
          info={meta.infoText}
          value={selectedModel}
          onChange={setSelectedModel}
          autoFocus
        >
          {props.command === "ocr" && (
            <Form.Dropdown.Item value={NONE_OCR_VALUE} title="暂不配置（仅使用系统原生离线 OCR）" />
          )}
          {selectedModel && selectedModel !== NONE_OCR_VALUE && !existsInList && (
            <Form.Dropdown.Item value={selectedModel} title={`${selectedModel} (当前已保存)`} />
          )}
          {models.map((m) => (
            <Form.Dropdown.Item key={m.name} value={m.name} title={m.label} />
          ))}
        </Form.Dropdown>
      ) : (
        <Form.TextField
          id="modelManual"
          title={props.command === "ocr" && !props.requireModel ? `${meta.fieldTitle} (可选)` : meta.fieldTitle}
          placeholder={meta.placeholder}
          info={meta.infoText}
          value={selectedModel === NONE_OCR_VALUE ? "" : selectedModel}
          onChange={(v) => setSelectedModel(props.command === "ocr" ? v || NONE_OCR_VALUE : v)}
          autoFocus
        />
      )}

      <Form.Dropdown
        id="thinkingEffort"
        title="思考强度"
        info="OpenAI / LiteLLM / acp2api 接口传递 reasoning_effort；Ollama 接口传递 think。若目标模型不支持该参数会自动降级兼容"
        value={thinkingEffort}
        onChange={(v) => setThinkingEffort(v as ThinkingEffort)}
      >
        {THINKING_EFFORT_OPTIONS.map((opt) => (
          <Form.Dropdown.Item key={opt.value} value={opt.value} title={opt.title} />
        ))}
      </Form.Dropdown>
    </Form>
  );
}
