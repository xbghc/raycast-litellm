import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  Form,
  Icon,
  LaunchProps,
  Toast,
  getPreferenceValues,
  getSelectedText,
  openExtensionPreferences,
  showHUD,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat } from "./lib/llm";
import { TargetLanguage, crossShortcut } from "./lib/types";

const LANGUAGE_LABELS: Record<TargetLanguage, string> = {
  auto_zh_en: "智能互译 (中文 ↔ 英文)",
  zh: "简体中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
};

function buildTranslationPrompt(targetLang: TargetLanguage): string {
  switch (targetLang) {
    case "zh":
      return "你是一位专业、地道的翻译引擎。请将用户提供的文本准确、自然地翻译为【简体中文】。保持原文的格式、代码块、专有名词与语气。只直接输出译文，严禁输出任何解释、引号包裹或前缀。";
    case "en":
      return "You are a professional translator. Translate the user's text naturally and idiomatically into English, preserving formatting, code spans, and tone. Output ONLY the translated text with no explanations or prefixes.";
    case "ja":
      return "あなたはプロの翻訳者です。入力されたテキストを自然で正確な日本語に翻訳してください。書式やコードブロックは維持し、翻訳結果のみを出力してください。説明は一切不要です。";
    case "ko":
      return "당신은 전문 번역가입니다. 입력된 텍스트를 자연스럽고 정확한 한국어로 번역하세요. 서식과 코드 블록을 유지하고 설명 없이 번역문만 출력하세요.";
    case "fr":
      return "Vous êtes un traducteur professionnel. Traduisez le texte en français naturel et précis en conservant la mise en forme. Affichez uniquement la traduction sans aucune explication.";
    case "auto_zh_en":
    default:
      return "你是一位专业双语翻译引擎。自动判断输入文本的主要语言：若主要为中文，请翻译为自然地道的英文；若为其他语言，请翻译为准确流畅的简体中文。保留原有的换行、Markdown 格式与技术术语。只输出译文正文，不要添加任何解释、注释或“译文如下”等前缀。";
  }
}

function EditSourceForm(props: {
  initialText: string;
  initialLang: TargetLanguage;
  onSubmit: (text: string, lang: TargetLanguage) => void;
}) {
  const { pop } = useNavigation();
  const [text, setText] = useState(props.initialText);
  const [lang, setLang] = useState<TargetLanguage>(props.initialLang);

  return (
    <Form
      navigationTitle="输入待翻译文本"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="开始翻译"
            icon={Icon.Globe}
            onSubmit={() => {
              if (!text.trim()) {
                void showToast({ style: Toast.Style.Failure, title: "请输入要翻译的文本" });
                return;
              }
              props.onSubmit(text.trim(), lang);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="sourceText"
        title="原文"
        placeholder="输入要翻译的内容..."
        value={text}
        onChange={setText}
        autoFocus
      />
      <Form.Dropdown
        id="targetLang"
        title="翻译方向"
        value={lang}
        onChange={(v) => setLang(v as TargetLanguage)}
      >
        {(Object.keys(LANGUAGE_LABELS) as TargetLanguage[]).map((key) => (
          <Form.Dropdown.Item key={key} value={key} title={LANGUAGE_LABELS[key]} />
        ))}
      </Form.Dropdown>
    </Form>
  );
}

export default function TranslateCommand(props: LaunchProps<{ arguments: Arguments.Translate }>) {
  const prefs = getPreferenceValues<Preferences.Translate>();
  const translateModel = prefs.translateModel.trim();
  const { push } = useNavigation();

  const [sourceText, setSourceText] = useState<string>((props.arguments.text || "").trim());
  const [initializingInput, setInitializingInput] = useState<boolean>(!props.arguments.text?.trim());
  const [targetLang, setTargetLang] = useState<TargetLanguage>(prefs.targetLang || "auto_zh_en");

  const [translated, setTranslated] = useState<string>("");
  const [thinking, setThinking] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [runNonce, setRunNonce] = useState<number>(0);

  const abortRef = useRef<AbortController | null>(null);

  // Fallback to selected text or clipboard text when invoked without `${text}` argument
  useEffect(() => {
    if (props.arguments.text?.trim()) {
      setInitializingInput(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const selected = await getSelectedText();
        if (!cancelled && selected.trim()) {
          setSourceText(selected.trim());
          setInitializingInput(false);
          return;
        }
      } catch {
        // Ignore when no text is selected
      }

      try {
        const clip = await Clipboard.readText();
        if (!cancelled && clip?.trim()) {
          setSourceText(clip.trim());
        }
      } catch {
        // Ignore
      } finally {
        if (!cancelled) {
          setInitializingInput(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [props.arguments.text]);

  const runTranslation = useCallback(async () => {
    if (!sourceText.trim()) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);
    setTranslated("");
    setThinking("");

    try {
      const final = await streamChat({
        endpoint: prefs.endpoint,
        model: translateModel,
        apiKey: prefs.apiKey,
        signal: controller.signal,
        messages: [
          { role: "system", content: buildTranslationPrompt(targetLang) },
          { role: "user", content: sourceText },
        ],
        onProgress: (prog) => {
          setTranslated(prog.content);
          setThinking(prog.thinking);
        },
      });

      if (!controller.signal.aborted) {
        setTranslated(final.content.trim());
        setThinking(final.thinking.trim());
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === controller) {
        setIsLoading(false);
      }
    }
  }, [prefs.apiKey, prefs.endpoint, sourceText, targetLang, translateModel]);

  useEffect(() => {
    if (initializingInput || !sourceText.trim()) return;
    void runTranslation();
    return () => {
      abortRef.current?.abort();
    };
  }, [initializingInput, sourceText, targetLang, translateModel, runNonce, runTranslation]);

  if (!initializingInput && !sourceText.trim()) {
    return (
      <Form
        navigationTitle="翻译 (Translate)"
        actions={
          <ActionPanel>
            <Action.SubmitForm
              title="开始翻译"
              icon={Icon.Globe}
              onSubmit={(values: { text: string; lang: string }) => {
                if (!values.text?.trim()) {
                  void showToast({ style: Toast.Style.Failure, title: "请输入待翻译文本" });
                  return;
                }
                setTargetLang((values.lang as TargetLanguage) || targetLang);
                setSourceText(values.text.trim());
              }}
            />
            <Action title="打开插件偏好设置" icon={Icon.Gear} onAction={openExtensionPreferences} />
          </ActionPanel>
        }
      >
        <Form.TextArea
          id="text"
          title="待翻译文本"
          placeholder="在此输入要翻译的内容（提示：为命令设置别名 t 后，可在 Raycast 直接输入 t 空格 文本）"
          autoFocus
        />
        <Form.Dropdown id="lang" title="翻译方向" defaultValue={targetLang}>
          {(Object.keys(LANGUAGE_LABELS) as TargetLanguage[]).map((key) => (
            <Form.Dropdown.Item key={key} value={key} title={LANGUAGE_LABELS[key]} />
          ))}
        </Form.Dropdown>
      </Form>
    );
  }

  let markdown = "";
  if (error) {
    markdown = `> ⚠️ **翻译请求失败**\n>\n> ${error.replace(/\n/g, "\n> ")}\n\n---\n\n**原文：**\n\n${sourceText}`;
  } else {
    const mainOutput = translated
      ? translated
      : thinking
        ? `> 💭 *模型正在思考翻译细节...*`
        : isLoading || initializingInput
          ? "*正在生成译文...*"
          : "*暂无译文*";

    markdown = `${mainOutput}\n\n---\n\n**原文** · \`${LANGUAGE_LABELS[targetLang]}\` · \`${translateModel}\`\n\n> ${sourceText.replace(/\n/g, "\n> ")}`;
  }

  return (
    <Detail
      isLoading={isLoading || initializingInput}
      navigationTitle={`Translate · ${LANGUAGE_LABELS[targetLang]}`}
      markdown={markdown}
      actions={
        <ActionPanel>
          <ActionPanel.Section title="译文操作">
            <Action
              title="复制译文"
              icon={Icon.Clipboard}
              onAction={async () => {
                if (!translated.trim()) {
                  await showToast({ style: Toast.Style.Failure, title: "译文尚未生成完毕" });
                  return;
                }
                await Clipboard.copy(translated.trim());
                await showHUD("已复制译文到剪贴板");
              }}
            />
            <Action
              title="粘贴译文到当前应用"
              icon={Icon.Document}
              shortcut={crossShortcut("return")}
              onAction={async () => {
                if (!translated.trim()) {
                  await showToast({ style: Toast.Style.Failure, title: "译文尚未生成完毕" });
                  return;
                }
                await Clipboard.paste(translated.trim());
              }}
            />
            <Action
              title="复制原文"
              icon={Icon.Text}
              shortcut={crossShortcut("c", ["shift"])}
              onAction={async () => {
                await Clipboard.copy(sourceText);
                await showHUD("已复制原文");
              }}
            />
          </ActionPanel.Section>

          <ActionPanel.Section title="翻译控制">
            <Action
              title="编辑原文 / 重新输入"
              icon={Icon.Pencil}
              shortcut={crossShortcut("i")}
              onAction={() =>
                push(
                  <EditSourceForm
                    initialText={sourceText}
                    initialLang={targetLang}
                    onSubmit={(newText, newLang) => {
                      setTargetLang(newLang);
                      setSourceText(newText);
                    }}
                  />
                )
              }
            />
            <ActionPanel.Submenu
              title="切换翻译目标语言"
              icon={Icon.Globe}
              shortcut={crossShortcut("l")}
            >
              {(Object.keys(LANGUAGE_LABELS) as TargetLanguage[]).map((key) => (
                <Action
                  key={key}
                  title={LANGUAGE_LABELS[key]}
                  icon={key === targetLang ? Icon.CheckCircle : Icon.Circle}
                  onAction={() => setTargetLang(key)}
                />
              ))}
            </ActionPanel.Submenu>
            <Action
              title="重新翻译"
              icon={Icon.RotateClockwise}
              shortcut={crossShortcut("r")}
              onAction={() => setRunNonce((n) => n + 1)}
            />
            <Action
              title="打开插件偏好设置"
              icon={Icon.Gear}
              onAction={openExtensionPreferences}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
