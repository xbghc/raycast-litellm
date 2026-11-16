import {
  Action,
  ActionPanel,
  Form,
  Icon,
  Toast,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import {
  InstalledModelInfo,
  SavedModelConfig,
  fetchInstalledModels,
  guessTextModel,
  guessVisionModel,
  saveModelConfig,
} from "../lib/model-store";
import { crossShortcut } from "../lib/types";

const NONE_OCR_VALUE = "__none__";

export interface ModelConfigFormProps {
  endpoint: string;
  apiKey?: string;
  initialConfig: SavedModelConfig;
  highlightField?: "ocr" | "translate" | "ask";
  onSaved: (updated: SavedModelConfig) => void;
}

export function ModelConfigForm(props: ModelConfigFormProps) {
  const [models, setModels] = useState<InstalledModelInfo[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState<boolean>(false);

  const [ocrModel, setOcrModel] = useState<string>(props.initialConfig.ocrModel || NONE_OCR_VALUE);
  const [translateModel, setTranslateModel] = useState<string>(props.initialConfig.translateModel);
  const [askModel, setAskModel] = useState<string>(props.initialConfig.askModel);

  const reloadModels = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const list = await fetchInstalledModels(props.endpoint, props.apiKey);
      setModels(list);

      if (list.length > 0) {
        setManualMode(false);
        const defaultText = guessTextModel(list);
        const defaultVision = guessVisionModel(list);

        setOcrModel((prev) => {
          if (prev && prev !== NONE_OCR_VALUE) return prev;
          return defaultVision || NONE_OCR_VALUE;
        });
        setTranslateModel((prev) => prev || defaultText);
        setAskModel((prev) => prev || defaultText);
      } else {
        setManualMode(true);
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
      setManualMode(true);
    } finally {
      setIsLoading(false);
    }
  }, [props.apiKey, props.endpoint]);

  useEffect(() => {
    void reloadModels();
  }, [reloadModels]);

  const handleSubmit = async () => {
    const cleanOcr = ocrModel === NONE_OCR_VALUE ? "" : ocrModel.trim();
    const cleanTranslate = translateModel.trim();
    const cleanAsk = askModel.trim();

    if (props.highlightField === "ocr" && !cleanOcr) {
      await showToast({ style: Toast.Style.Failure, title: "请选择用于视觉 OCR 的模型" });
      return;
    }
    if (!cleanTranslate || !cleanAsk) {
      await showToast({ style: Toast.Style.Failure, title: "请为翻译和问答选择模型" });
      return;
    }

    const nextConfig: SavedModelConfig = {
      ocrModel: cleanOcr,
      translateModel: cleanTranslate,
      askModel: cleanAsk,
    };

    await saveModelConfig(nextConfig);
    await showToast({ style: Toast.Style.Success, title: "已保存三个命令的模型配置" });
    props.onSaved(nextConfig);
  };

  const renderDropdownOptions = (currentVal: string) => {
    const existsInList = models.some((m) => m.name === currentVal);
    return (
      <>
        {currentVal && currentVal !== NONE_OCR_VALUE && !existsInList && (
          <Form.Dropdown.Item value={currentVal} title={`${currentVal} (当前已保存)`} />
        )}
        {models.map((m) => (
          <Form.Dropdown.Item key={m.name} value={m.name} title={m.label} />
        ))}
      </>
    );
  };

  return (
    <Form
      isLoading={isLoading}
      navigationTitle="配置本地模型 (OCR / 翻译 / 问答)"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存模型配置" icon={Icon.CheckCircle} onSubmit={handleSubmit} />
          <Action
            title="重新扫描本地已安装模型"
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
            title="修改 Endpoint 地址"
            icon={Icon.Gear}
            onAction={openExtensionPreferences}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="服务端点"
        text={
          fetchError
            ? `⚠️ 无法从 ${props.endpoint} 获取模型列表 (${fetchError})，请确认 Ollama 已启动并已执行 ollama pull`
            : models.length > 0
              ? `${props.endpoint} · 已自动检测到 ${models.length} 个本地模型`
              : `${props.endpoint} · 暂未检测到已下载模型，请先执行 ollama pull 下载模型`
        }
      />

      {!manualMode && models.length > 0 ? (
        <>
          <Form.Dropdown
            id="ocrModel"
            title="OCR 模型"
            info="用于视觉大模型 OCR 识别；若只用系统原生离线 OCR 可选“暂不配置”"
            value={ocrModel}
            onChange={setOcrModel}
            autoFocus={props.highlightField === "ocr"}
          >
            <Form.Dropdown.Item value={NONE_OCR_VALUE} title="暂不配置（仅使用系统原生离线 OCR）" />
            {renderDropdownOptions(ocrModel)}
          </Form.Dropdown>

          <Form.Dropdown
            id="translateModel"
            title="翻译模型"
            info="专用于 t ${text} 翻译命令"
            value={translateModel}
            onChange={setTranslateModel}
            autoFocus={props.highlightField === "translate"}
          >
            {renderDropdownOptions(translateModel)}
          </Form.Dropdown>

          <Form.Dropdown
            id="askModel"
            title="问答模型"
            info="专用于 q ${text} 对话问答命令"
            value={askModel}
            onChange={setAskModel}
            autoFocus={props.highlightField === "ask" || !props.highlightField}
          >
            {renderDropdownOptions(askModel)}
          </Form.Dropdown>
        </>
      ) : (
        <>
          <Form.TextField
            id="ocrModelManual"
            title="OCR 模型 (可选)"
            placeholder="例如 qwen2.5vl:7b"
            value={ocrModel === NONE_OCR_VALUE ? "" : ocrModel}
            onChange={(v) => setOcrModel(v || NONE_OCR_VALUE)}
          />
          <Form.TextField
            id="translateModelManual"
            title="翻译模型"
            placeholder="例如 qwen2.5:7b"
            value={translateModel}
            onChange={setTranslateModel}
          />
          <Form.TextField
            id="askModelManual"
            title="问答模型"
            placeholder="例如 qwen3:8b"
            value={askModel}
            onChange={setAskModel}
          />
        </>
      )}
    </Form>
  );
}
