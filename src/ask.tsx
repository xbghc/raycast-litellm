import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  Form,
  Icon,
  LaunchProps,
  Toast,
  closeMainWindow,
  getPreferenceValues,
  openCommandPreferences,
  openExtensionPreferences,
  showHUD,
  showToast,
  useNavigation,
} from "@raycast/api";
import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModelConfigForm } from "./components/ModelConfigForm";
import { isOllamaNativeEndpoint, streamChat, turnsToMessages } from "./lib/llm";
import {
  SavedModelConfig,
  formatEndpointHost,
  getCommandModel,
  loadModelConfig,
  resolveCommandProvider,
} from "./lib/model-store";
import { saveAndOpenInOllama } from "./lib/ollama-app";
import { ChatTurn, crossShortcut } from "./lib/types";

function FollowUpForm(props: { onSend: (question: string) => void }) {
  const { pop } = useNavigation();
  const [question, setQuestion] = useState("");

  return (
    <Form
      navigationTitle="继续追问"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="发送追问"
            icon={Icon.Message}
            onSubmit={() => {
              if (!question.trim()) {
                void showToast({ style: Toast.Style.Failure, title: "请输入追问内容" });
                return;
              }
              props.onSend(question.trim());
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="followUp"
        title="追问内容"
        placeholder="基于当前上下文继续提问..."
        value={question}
        onChange={setQuestion}
        autoFocus
      />
    </Form>
  );
}

export default function AskCommand(props: LaunchProps<{ arguments: Arguments.Ask }>) {
  const prefs = getPreferenceValues<Preferences.Ask>();
  const { push, pop } = useNavigation();

  const provider = useMemo(
    () => resolveCommandProvider(prefs),
    [prefs.apiKey, prefs.customApiKey, prefs.customEndpoint, prefs.endpoint]
  );
  const readFreshProvider = useCallback(
    () => resolveCommandProvider(getPreferenceValues<Preferences.Ask>()),
    []
  );

  const rawInput = (props.arguments.text || props.fallbackText || "").trim();
  const initialPrompt = props.arguments.text?.trim()
    ? props.arguments.text.trim()
    : rawInput.replace(/^q\s+/i, "").trim();

  const [modelConfig, setModelConfig] = useState<SavedModelConfig | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>(() =>
    initialPrompt
      ? [
          {
            id: randomUUID(),
            role: "user",
            content: initialPrompt,
            createdAt: Date.now(),
          },
        ]
      : []
  );
  const [streamingContent, setStreamingContent] = useState<string>("");
  const [streamingThinking, setStreamingThinking] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState<boolean>(false);
  const [syncedChatId, setSyncedChatId] = useState<string | undefined>(undefined);

  const askModel = useMemo(
    () => getCommandModel(modelConfig, "ask", provider),
    [modelConfig, provider]
  );
  const canSyncToOllama = useMemo(
    () => isOllamaNativeEndpoint(provider.endpoint),
    [provider.endpoint]
  );
  const providerHost = useMemo(() => formatEndpointHost(provider.endpoint), [provider.endpoint]);

  const abortRef = useRef<AbortController | null>(null);
  const turnsRef = useRef<ChatTurn[]>(turns);
  turnsRef.current = turns;

  useEffect(() => {
    void loadModelConfig().then(setModelConfig);
  }, []);

  const sendConversationToModel = useCallback(
    async (conversationTurns: ChatTurn[], targetModel: string) => {
      if (!targetModel) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      setError(null);
      setStreamingContent("");
      setStreamingThinking("");

      try {
        const final = await streamChat({
          endpoint: provider.endpoint,
          model: targetModel,
          apiKey: provider.apiKey,
          signal: controller.signal,
          messages: [
            {
              role: "system",
              content: "你是一个简洁、准确、高效的 AI 助手。请用清晰易读的 Markdown 直接回答用户问题。",
            },
            ...turnsToMessages(conversationTurns),
          ],
          onProgress: (prog) => {
            setStreamingContent(prog.content);
            setStreamingThinking(prog.thinking);
          },
        });

        if (controller.signal.aborted) return;

        const assistantTurn: ChatTurn = {
          id: randomUUID(),
          role: "assistant",
          content: final.content.trim() || "(空回复)",
          thinking: final.thinking.trim() || undefined,
          createdAt: Date.now(),
        };

        setStreamingContent("");
        setStreamingThinking("");
        setTurns((prev) => [...prev, assistantTurn]);
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
    },
    [provider.apiKey, provider.endpoint]
  );

  // Trigger initial completion once askModel is available
  const initialTriggeredRef = useRef(false);
  useEffect(() => {
    if (
      !initialTriggeredRef.current &&
      askModel &&
      turns.length === 1 &&
      turns[0].role === "user"
    ) {
      initialTriggeredRef.current = true;
      void sendConversationToModel(turns, askModel);
    }
    return () => {
      abortRef.current?.abort();
    };
  }, [askModel, sendConversationToModel, turns]);

  const openModelSettings = useCallback(() => {
    if (!modelConfig) return;
    push(
      <ModelConfigForm
        command="ask"
        provider={readFreshProvider()}
        refreshProvider={readFreshProvider}
        initialConfig={modelConfig}
        onSaved={(updated) => {
          setModelConfig(updated);
          pop();
        }}
      />
    );
  }, [modelConfig, pop, push, readFreshProvider]);

  const handleAppendUserQuestion = useCallback(
    (question: string) => {
      const newUserTurn: ChatTurn = {
        id: randomUUID(),
        role: "user",
        content: question,
        createdAt: Date.now(),
      };
      const updated = [...turnsRef.current, newUserTurn];
      setTurns(updated);
      void sendConversationToModel(updated, askModel);
    },
    [askModel, sendConversationToModel]
  );

  const handleRegenerateLast = useCallback(() => {
    const current = [...turnsRef.current];
    if (current.length === 0) return;
    if (current[current.length - 1].role === "assistant") {
      current.pop();
    }
    setTurns(current);
    void sendConversationToModel(current, askModel);
  }, [askModel, sendConversationToModel]);

  const handleContinueInOllama = useCallback(async () => {
    if (isLoading) {
      abortRef.current?.abort();
      setIsLoading(false);
    }

    const exportTurns = [...turnsRef.current];
    if (streamingContent.trim()) {
      exportTurns.push({
        id: randomUUID(),
        role: "assistant",
        content: streamingContent.trim(),
        thinking: streamingThinking.trim() || undefined,
        createdAt: Date.now(),
      });
    }

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "正在同步对话到 Ollama...",
    });

    try {
      const result = await saveAndOpenInOllama({
        turns: exportTurns,
        model: askModel,
        existingChatId: syncedChatId,
        customAppPath: prefs.ollamaAppPath,
      });
      setSyncedChatId(result.chatId);
      toast.hide();
      await closeMainWindow();
      await showHUD(
        result.launchedTarget === "desktop-app"
          ? "已写入会话并打开 Ollama 桌面端继续对话"
          : `未检测到桌面端，已在终端启动 ollama run ${askModel}`
      );
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "跳转 Ollama 失败";
      toast.message = err instanceof Error ? err.message : String(err);
    }
  }, [askModel, isLoading, prefs.ollamaAppPath, streamingContent, streamingThinking, syncedChatId]);

  const latestAnswer = useMemo(() => {
    if (streamingContent.trim()) return streamingContent.trim();
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "assistant") return turns[i].content;
    }
    return "";
  }, [streamingContent, turns]);

  const hasAnyThinking = useMemo(
    () => Boolean(streamingThinking.trim() || turns.some((t) => t.thinking?.trim())),
    [streamingThinking, turns]
  );

  const copyLatestAnswer = useCallback(async () => {
    if (!latestAnswer) {
      await showToast({ style: Toast.Style.Failure, title: "回答尚未生成完毕" });
      return;
    }
    await Clipboard.copy(latestAnswer);
    await showHUD("已复制回答到剪贴板");
  }, [latestAnswer]);

  // First-run or new-provider model picker (preserves `turns` so saving immediately answers `q ${text}`)
  if (modelConfig && !askModel) {
    return (
      <ModelConfigForm
        command="ask"
        provider={provider}
        refreshProvider={readFreshProvider}
        initialConfig={modelConfig}
        onSaved={setModelConfig}
      />
    );
  }

  // Interactive entry form when opened without `${text}` argument
  if (modelConfig && turns.length === 0) {
    return (
      <Form
        navigationTitle={`Quick Ask · ${askModel}${provider.isCustomEndpoint ? ` @ ${providerHost}` : ""}`}
        actions={
          <ActionPanel>
            <Action.SubmitForm
              title="发送提问"
              icon={Icon.Message}
              onSubmit={(values: { prompt: string }) => {
                const q = (values.prompt || "").trim();
                if (!q) {
                  void showToast({ style: Toast.Style.Failure, title: "请输入你的问题" });
                  return;
                }
                const firstTurn: ChatTurn = {
                  id: randomUUID(),
                  role: "user",
                  content: q,
                  createdAt: Date.now(),
                };
                initialTriggeredRef.current = true;
                setTurns([firstTurn]);
                void sendConversationToModel([firstTurn], askModel);
              }}
            />
            <Action
              title="切换问答模型"
              icon={Icon.Cog}
              shortcut={crossShortcut("m", ["shift"])}
              onAction={openModelSettings}
            />
            <Action
              title="配置问答独立 Endpoint / API Key"
              icon={Icon.Network}
              shortcut={crossShortcut("e", ["shift"])}
              onAction={openCommandPreferences}
            />
            <Action
              title="打开全局默认偏好设置"
              icon={Icon.Gear}
              onAction={openExtensionPreferences}
            />
          </ActionPanel>
        }
      >
        <Form.TextArea
          id="prompt"
          title="问题"
          placeholder="输入你想问的问题（提示：为命令设置别名 q 后，可在 Raycast 直接输入 q 空格 问题）"
          autoFocus
        />
      </Form>
    );
  }

  const renderedBlocks: string[] = [];
  const isSingleTurn = turns.filter((t) => t.role === "user").length <= 1;

  for (const turn of turns) {
    if (turn.role === "user") {
      if (isSingleTurn) {
        renderedBlocks.push(`> **Q:** ${turn.content.replace(/\n/g, "\n> ")}`);
      } else {
        renderedBlocks.push(`### 🙋‍♂️ 你\n\n${turn.content}`);
      }
    } else if (turn.role === "assistant") {
      const thoughtBlock =
        showThinking && turn.thinking
          ? `> 💭 **思考过程**\n>\n> ${turn.thinking.replace(/\n/g, "\n> ")}\n\n`
          : "";
      if (isSingleTurn) {
        renderedBlocks.push(`${thoughtBlock}${turn.content}`);
      } else {
        renderedBlocks.push(`### 🤖 ${askModel}\n\n${thoughtBlock}${turn.content}`);
      }
    }
  }

  if (isLoading || !modelConfig) {
    let liveSection = "";
    if (streamingThinking && (!streamingContent || showThinking)) {
      const previewThought = showThinking
        ? streamingThinking
        : streamingThinking.slice(-240).trim();
      liveSection += `> 💭 *思考中：${previewThought.replace(/\n/g, " ")}*\n\n`;
    }
    liveSection += streamingContent || "*正在生成回答...*";
    renderedBlocks.push(isSingleTurn ? liveSection : `### 🤖 ${askModel}\n\n${liveSection}`);
  }

  if (error) {
    renderedBlocks.push(`> ⚠️ **请求出错**\n>\n> ${error.replace(/\n/g, "\n> ")}`);
  }

  const providerBadge = provider.isCustomEndpoint || !canSyncToOllama ? ` (${providerHost})` : "";
  const footer = canSyncToOllama
    ? `\n\n---\n*模型: \`${askModel}\`${providerBadge} · 按 \`Enter\` 进入 Ollama 桌面端继续对话 · 按 \`Ctrl/⌘ + N\` 在当前面板快速追问*`
    : `\n\n---\n*模型: \`${askModel}\`${providerBadge} · 按 \`Enter\` 复制回答 · 按 \`Ctrl/⌘ + N\` 在当前面板快速追问*`;
  const markdown = renderedBlocks.join("\n\n---\n\n") + footer;

  return (
    <Detail
      isLoading={isLoading || !modelConfig}
      navigationTitle={`Quick Ask · ${askModel}${provider.isCustomEndpoint ? ` @ ${providerHost}` : ""}`}
      markdown={markdown}
      actions={
        <ActionPanel>
          <ActionPanel.Section title="继续对话与复制">
            {canSyncToOllama ? (
              <>
                <Action
                  title="进入 Ollama 继续对话"
                  icon={Icon.AppWindowSidebarLeft}
                  onAction={handleContinueInOllama}
                />
                <Action
                  title="复制最新回答"
                  icon={Icon.Clipboard}
                  shortcut={crossShortcut("return")}
                  onAction={copyLatestAnswer}
                />
                <Action
                  title="在当前面板继续追问"
                  icon={Icon.PlusCircle}
                  shortcut={crossShortcut("n")}
                  onAction={() => push(<FollowUpForm onSend={handleAppendUserQuestion} />)}
                />
                <Action
                  title="粘贴回答到当前应用"
                  icon={Icon.Document}
                  shortcut={crossShortcut("v", ["shift"])}
                  onAction={async () => {
                    if (!latestAnswer) return;
                    await Clipboard.paste(latestAnswer);
                  }}
                />
              </>
            ) : (
              <>
                <Action
                  title="复制最新回答"
                  icon={Icon.Clipboard}
                  onAction={copyLatestAnswer}
                />
                <Action
                  title="在当前面板继续追问"
                  icon={Icon.PlusCircle}
                  shortcut={crossShortcut("n")}
                  onAction={() => push(<FollowUpForm onSend={handleAppendUserQuestion} />)}
                />
                <Action
                  title="粘贴回答到当前应用"
                  icon={Icon.Document}
                  shortcut={crossShortcut("return")}
                  onAction={async () => {
                    if (!latestAnswer) return;
                    await Clipboard.paste(latestAnswer);
                  }}
                />
              </>
            )}
          </ActionPanel.Section>

          <ActionPanel.Section title="显示与模型配置">
            {hasAnyThinking && (
              <Action
                title={showThinking ? "折叠思考过程 (Thinking)" : "展开思考过程 (Thinking)"}
                icon={Icon.LightBulb}
                shortcut={crossShortcut("t")}
                onAction={() => setShowThinking((v) => !v)}
              />
            )}
            <Action
              title="重新生成回答"
              icon={Icon.RotateClockwise}
              shortcut={crossShortcut("r")}
              onAction={handleRegenerateLast}
            />
            <Action
              title="切换问答模型"
              icon={Icon.Cog}
              shortcut={crossShortcut("m", ["shift"])}
              onAction={openModelSettings}
            />
            <Action
              title="配置问答独立 Endpoint / API Key"
              icon={Icon.Network}
              shortcut={crossShortcut("e", ["shift"])}
              onAction={openCommandPreferences}
            />
            <Action
              title="打开全局默认偏好设置"
              icon={Icon.Gear}
              onAction={openExtensionPreferences}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
