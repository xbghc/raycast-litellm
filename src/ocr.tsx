import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Icon,
  Keyboard,
  LaunchType,
  List,
  Toast,
  confirmAlert,
  getPreferenceValues,
  launchCommand,
  openExtensionPreferences,
  showHUD,
  showToast,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatRelativeTime,
  isToday,
  loadCachedImageHistory,
  saveImageHistory,
  syncClipboardImages,
  toFileMarkdownUrl,
} from "./lib/clipboard-images";
import { runImageOcr } from "./lib/ocr-engine";
import { ClipboardImageItem, OcrEngineType, crossShortcut } from "./lib/types";

export default function OcrCommand() {
  const prefs = getPreferenceValues<Preferences.Ocr>();
  const visionModel = (prefs.ocrModel || "").trim();

  const [items, setItems] = useState<ClipboardImageItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [engine, setEngine] = useState<OcrEngineType>(prefs.ocrEngine || "system");
  const [isSyncing, setIsSyncing] = useState<boolean>(true);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [livePreviewText, setLivePreviewText] = useState<Record<string, string>>({});
  const [ocrErrors, setOcrErrors] = useState<Record<string, string>>({});
  const [showImagePreview, setShowImagePreview] = useState<boolean>(true);

  const itemsRef = useRef<ClipboardImageItem[]>([]);
  itemsRef.current = items;
  const activeAbortRef = useRef<AbortController | null>(null);

  const getCacheKey = useCallback(
    (targetEngine: OcrEngineType) => (targetEngine === "system" ? "system" : `llm:${visionModel}`),
    [visionModel]
  );

  const refreshClipboard = useCallback(async () => {
    setIsSyncing(true);
    try {
      const cached = await loadCachedImageHistory();
      if (cached.length > 0 && itemsRef.current.length === 0) {
        setItems(cached);
        setSelectedId((prev) => prev || cached[0]?.id);
      }

      const synced = await syncClipboardImages();
      setItems(synced);
      if (synced.length > 0) {
        setSelectedId((prev) => (prev && synced.some((i) => i.id === prev) ? prev : synced[0].id));
      }
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: "读取剪贴板图片失败",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsSyncing(false);
    }
  }, []);

  useEffect(() => {
    refreshClipboard();
    return () => {
      activeAbortRef.current?.abort();
    };
  }, [refreshClipboard]);

  const executeOcrForItem = useCallback(
    async (item: ClipboardImageItem, targetEngine: OcrEngineType, force = false) => {
      const cacheKey = getCacheKey(targetEngine);
      if (!force && item.ocrCache?.[cacheKey] !== undefined) {
        return;
      }

      activeAbortRef.current?.abort();
      const controller = new AbortController();
      activeAbortRef.current = controller;

      setLoadingId(item.id);
      setOcrErrors((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });

      try {
        const recognized = await runImageOcr({
          imagePath: item.cachedPath,
          mimeType: item.mimeType,
          engine: targetEngine,
          endpoint: prefs.endpoint,
          model: visionModel,
          apiKey: prefs.apiKey,
          signal: controller.signal,
          onProgress: (partial) => {
            setLivePreviewText((prev) => ({ ...prev, [item.id]: partial }));
          },
        });

        if (controller.signal.aborted) return;

        setLivePreviewText((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });

        setItems((prev) => {
          const updated = prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  ocrCache: {
                    ...(it.ocrCache || {}),
                    [cacheKey]: recognized,
                  },
                }
              : it
          );
          void saveImageHistory(updated);
          return updated;
        });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        setOcrErrors((prev) => ({ ...prev, [item.id]: errMsg }));
      } finally {
        if (activeAbortRef.current === controller) {
          setLoadingId(null);
        }
      }
    },
    [getCacheKey, prefs.apiKey, prefs.endpoint, visionModel]
  );

  // Automatically trigger OCR whenever selection or OCR engine changes
  useEffect(() => {
    if (!selectedId) return;
    const target = items.find((i) => i.id === selectedId);
    if (!target) return;

    const cacheKey = getCacheKey(engine);
    if (target.ocrCache?.[cacheKey] !== undefined) {
      return;
    }

    const delayMs = engine === "llm" ? 150 : 40;
    const timer = setTimeout(() => {
      void executeOcrForItem(target, engine, false);
    }, delayMs);

    return () => clearTimeout(timer);
  }, [selectedId, engine, items, getCacheKey, executeOcrForItem]);

  const togglePin = useCallback(async (item: ClipboardImageItem) => {
    setItems((prev) => {
      const updated = prev.map((it) => (it.id === item.id ? { ...it, pinned: !it.pinned } : it));
      void saveImageHistory(updated);
      return updated;
    });
  }, []);

  const deleteItem = useCallback(async (item: ClipboardImageItem) => {
    setItems((prev) => {
      const updated = prev.filter((it) => it.id !== item.id);
      void saveImageHistory(updated);
      return updated;
    });
    await showToast({ style: Toast.Style.Success, title: "已移除该图片记录" });
  }, []);

  const clearUnpinned = useCallback(async () => {
    const confirmed = await confirmAlert({
      title: "清空未置顶的图片记录？",
      message: "置顶的图片及已识别缓存将被保留。",
    });
    if (!confirmed) return;
    setItems((prev) => {
      const kept = prev.filter((it) => it.pinned);
      void saveImageHistory(kept);
      return kept;
    });
    await showToast({ style: Toast.Style.Success, title: "已清空未置顶图片记录" });
  }, []);

  const sections = useMemo(() => {
    const pinned = items.filter((i) => i.pinned);
    const today = items.filter((i) => !i.pinned && isToday(i.copiedAt));
    const earlier = items.filter((i) => !i.pinned && !isToday(i.copiedAt));
    return { pinned, today, earlier };
  }, [items]);

  const buildDetailMarkdown = useCallback(
    (item: ClipboardImageItem): string => {
      const cacheKey = getCacheKey(engine);
      const cachedText = item.ocrCache?.[cacheKey];
      const streamingText = livePreviewText[item.id];
      const errText = ocrErrors[item.id];
      const isItemLoading = loadingId === item.id;

      let bodySection = "";
      if (errText) {
        bodySection = `> ⚠️ **OCR 识别失败**\n>\n> ${errText.replace(/\n/g, "\n> ")}\n\n*提示：可按快捷键切换系统原生 OCR / 视觉大模型 OCR，或按重新识别重试。*`;
      } else if (streamingText !== undefined && isItemLoading) {
        bodySection = streamingText || "*正在识别图片中的文字...*";
      } else if (cachedText !== undefined) {
        bodySection = cachedText.trim() ? cachedText : "*[未在图片中检测到文字]*";
      } else if (isItemLoading) {
        bodySection =
          engine === "system"
            ? "*正在调用系统原生 OCR 识别...*"
            : `*正在调用视觉模型 \`${visionModel}\` 识别...*`;
      } else {
        bodySection = "*选中图片后自动显示 OCR 结果*";
      }

      if (!showImagePreview) {
        return bodySection;
      }

      const fileUrl = toFileMarkdownUrl(item.cachedPath);
      const metaFooter = `\`${item.width > 0 ? `${item.width}×${item.height}` : item.mimeType}\` · \`${
        engine === "system" ? "系统原生 OCR" : visionModel
      }\` · ${formatRelativeTime(item.copiedAt)}`;

      return `${bodySection}\n\n---\n\n![Clipboard Image](${fileUrl})\n\n${metaFooter}`;
    },
    [engine, getCacheKey, livePreviewText, loadingId, ocrErrors, showImagePreview, visionModel]
  );

  const renderItem = (item: ClipboardImageItem) => {
    const cacheKey = getCacheKey(engine);
    const ocrText = item.ocrCache?.[cacheKey] || "";
    const allCachedTexts = Object.values(item.ocrCache || {}).join(" ");
    const isItemLoading = loadingId === item.id;

    const keywords = [
      item.title,
      item.sourceName || "",
      `${item.width}x${item.height}`,
      ...allCachedTexts.split(/\s+/).filter(Boolean).slice(0, 60),
    ].filter(Boolean);

    return (
      <List.Item
        key={item.id}
        id={item.id}
        icon={{ source: item.cachedPath }}
        title={item.sourceName ? `${item.title} · ${item.sourceName}` : item.title}
        keywords={keywords}
        accessories={
          item.pinned
            ? [{ icon: { source: Icon.Pin, tintColor: Color.Yellow } }]
            : undefined
        }
        detail={<List.Item.Detail isLoading={isItemLoading} markdown={buildDetailMarkdown(item)} />}
        actions={
          <ActionPanel>
            <ActionPanel.Section title="OCR 文本操作">
              <Action
                title="复制 OCR 结果"
                icon={Icon.Clipboard}
                onAction={async () => {
                  if (!ocrText.trim()) {
                    await showToast({ style: Toast.Style.Failure, title: "当前暂无可复制的 OCR 文本" });
                    return;
                  }
                  await Clipboard.copy(ocrText);
                  await showHUD("已复制 OCR 识别结果");
                }}
              />
              <Action
                title="粘贴 OCR 结果到当前应用"
                icon={Icon.Document}
                shortcut={crossShortcut("return")}
                onAction={async () => {
                  if (!ocrText.trim()) {
                    await showToast({ style: Toast.Style.Failure, title: "当前暂无可粘贴的 OCR 文本" });
                    return;
                  }
                  await Clipboard.paste(ocrText);
                }}
              />
              <Action
                title="复制原图"
                icon={Icon.Image}
                shortcut={crossShortcut("c", ["shift"])}
                onAction={async () => {
                  await Clipboard.copy({ file: item.cachedPath });
                  await showHUD("已复制图片到剪贴板");
                }}
              />
            </ActionPanel.Section>

            <ActionPanel.Section title="联动翻译与问答">
              <Action
                title="翻译识别结果"
                icon={Icon.Globe}
                shortcut={crossShortcut("t")}
                onAction={async () => {
                  if (!ocrText.trim()) {
                    await showToast({ style: Toast.Style.Failure, title: "请等待识别完成后再翻译" });
                    return;
                  }
                  await launchCommand({
                    name: "translate",
                    type: LaunchType.UserInitiated,
                    arguments: { text: ocrText },
                  });
                }}
              />
              <Action
                title="用识别结果提问"
                icon={Icon.Message}
                shortcut={crossShortcut("j")}
                onAction={async () => {
                  if (!ocrText.trim()) {
                    await showToast({ style: Toast.Style.Failure, title: "请等待识别完成后再提问" });
                    return;
                  }
                  await launchCommand({
                    name: "ask",
                    type: LaunchType.UserInitiated,
                    arguments: { text: ocrText },
                  });
                }}
              />
            </ActionPanel.Section>

            <ActionPanel.Section title="识别与面板控制">
              <Action
                title="重新识别当前图片"
                icon={Icon.RotateClockwise}
                shortcut={crossShortcut("r")}
                onAction={() => executeOcrForItem(item, engine, true)}
              />
              <Action
                title={
                  engine === "system"
                    ? `切换为视觉大模型 OCR${visionModel ? ` (${visionModel})` : ""}`
                    : "切换为系统原生离线 OCR"
                }
                icon={Icon.Switch}
                shortcut={crossShortcut("e")}
                onAction={() => setEngine((prev) => (prev === "system" ? "llm" : "system"))}
              />
              <Action
                title={showImagePreview ? "隐藏右侧原图预览" : "显示右侧原图预览"}
                icon={Icon.Eye}
                shortcut={crossShortcut("i")}
                onAction={() => setShowImagePreview((v) => !v)}
              />
              <Action
                title="刷新剪贴板图片列表"
                icon={Icon.ArrowClockwise}
                shortcut={crossShortcut("r", ["shift"])}
                onAction={refreshClipboard}
              />
            </ActionPanel.Section>

            <ActionPanel.Section title="剪贴板记录管理">
              <Action
                title={item.pinned ? "取消置顶" : "置顶此图片"}
                icon={Icon.Pin}
                shortcut={crossShortcut("p", ["shift"])}
                onAction={() => togglePin(item)}
              />
              <Action
                title="删除此图片记录"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.Remove}
                onAction={() => deleteItem(item)}
              />
              <Action
                title="清空未置顶记录"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.RemoveAll}
                onAction={clearUnpinned}
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
  };

  return (
    <List
      isShowingDetail={items.length > 0}
      isLoading={isSyncing}
      selectedItemId={selectedId}
      onSelectionChange={(id) => setSelectedId(id || undefined)}
      searchBarPlaceholder="Type to filter image clipboard items or OCR text..."
      searchBarAccessory={
        <List.Dropdown
          tooltip="选择 OCR 识别引擎"
          value={engine}
          onChange={(val) => setEngine(val as OcrEngineType)}
        >
          <List.Dropdown.Item
            title="系统原生离线 OCR"
            value="system"
            icon={Icon.ComputerChip}
          />
          <List.Dropdown.Item
            title={visionModel ? `视觉大模型 (${visionModel})` : "视觉大模型 (未配置模型)"}
            value="llm"
            icon={Icon.Stars}
          />
        </List.Dropdown>
      }
    >
      {items.length === 0 && !isSyncing ? (
        <List.EmptyView
          icon={Icon.Image}
          title="剪贴板中暂无图片"
          description="截图或复制任意图片后打开此命令，左侧将自动列出剪贴板图片并在右侧展示 OCR 识别结果"
          actions={
            <ActionPanel>
              <Action title="重新扫描剪贴板" icon={Icon.ArrowClockwise} onAction={refreshClipboard} />
              <Action title="打开插件偏好设置" icon={Icon.Gear} onAction={openExtensionPreferences} />
            </ActionPanel>
          }
        />
      ) : (
        <>
          {sections.pinned.length > 0 && (
            <List.Section title="Pinned">{sections.pinned.map(renderItem)}</List.Section>
          )}
          {sections.today.length > 0 && (
            <List.Section title="Today">{sections.today.map(renderItem)}</List.Section>
          )}
          {sections.earlier.length > 0 && (
            <List.Section title="Earlier">{sections.earlier.map(renderItem)}</List.Section>
          )}
        </>
      )}
    </List>
  );
}
