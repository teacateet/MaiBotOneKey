import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ADAPTER_OFFLINE_KEYWORDS,
  CONSOLE_AUTO_SCROLL_THRESHOLD_PX,
  fallbackEndpoints,
  NAPCAT_OFFLINE_KEYWORDS,
  NATIVE_WEBVIEW_DATA_DIRECTORIES,
  PROCESS_LOG_RENDER_LIMIT,
  PROCESS_POLL_INTERVAL_MS,
  SCREEN_CONTEXT_POLL_INTERVAL_MS,
  SERVICE_WINDOW_LABELS,
  STORAGE_KEY,
} from "./appConstants";
import {
  blobToBase64,
  defaultVoiceConfig,
  findLatestLogMatch,
  getProcessStateLabel,
  isTauriEnvironment,
  joinLocalDataPath,
  loadStoredUrls,
  makeVoiceLogId,
  openExternal,
  renderAnsiLines,
  resolveServiceUrl,
  sanitizeStoredServiceUrls,
  sortProcessSnapshots,
  stringifyError,
  waitForServiceWindowReady,
} from "./appUtils";
import type {
  LoginStabilityReport,
  OfflineAlert,
  ProcessSnapshot,
  ServiceEndpoint,
  ServiceId,
  ViewMode,
  VoiceChatConfig,
  VoiceChatLogItem,
  VoiceChatResponse,
} from "./types";
import "./App.css";
function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("services");
  const [serviceDefinitions, setServiceDefinitions] = useState<ServiceEndpoint[]>(fallbackEndpoints);
  const [urlDrafts, setUrlDrafts] = useState<Partial<Record<ServiceId, string>>>(loadStoredUrls);
  const [activeServiceId, setActiveServiceId] = useState<ServiceId>("maibot");
  const [openInFrame, setOpenInFrame] = useState(true);
  const [statusText, setStatusText] = useState("正在准备控制台...");
  const [processSnapshots, setProcessSnapshots] = useState<ProcessSnapshot[]>([]);
  const [activeProcessId, setActiveProcessId] = useState<string>("maibot-main");
  const [processStatusText, setProcessStatusText] = useState("进入进程面板后会开始同步内置进程状态。");
  const [processBusy, setProcessBusy] = useState<string | null>(null);
  const [loginStabilityReport, setLoginStabilityReport] =
    useState<LoginStabilityReport | null>(null);
  const [logAutoFollow, setLogAutoFollow] = useState(true);
  const [dismissedOfflineAlertIds, setDismissedOfflineAlertIds] = useState<string[]>([]);
  const [voiceConfig, setVoiceConfig] = useState<VoiceChatConfig>(defaultVoiceConfig);
  const [voiceStatusText, setVoiceStatusText] = useState("语音对话未开始。");
  const [voiceLogs, setVoiceLogs] = useState<VoiceChatLogItem[]>([]);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceAlwaysOn, setVoiceAlwaysOn] = useState(false);
  const [voiceScreenContextEnabled, setVoiceScreenContextEnabled] = useState(true);
  const [voiceScreenContext, setVoiceScreenContext] = useState("屏幕上下文尚未读取。");
  const [nativeDataDirectories, setNativeDataDirectories] = useState<Record<ServiceId, string>>(
    NATIVE_WEBVIEW_DATA_DIRECTORIES,
  );
  const consoleOutputRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const alwaysOnStreamRef = useRef<MediaStream | null>(null);
  const alwaysOnAudioContextRef = useRef<AudioContext | null>(null);
  const alwaysOnAnalyserRef = useRef<AnalyserNode | null>(null);
  const alwaysOnRecorderRef = useRef<MediaRecorder | null>(null);
  const alwaysOnChunksRef = useRef<Blob[]>([]);
  const alwaysOnAnimationRef = useRef<number | null>(null);
  const alwaysOnSegmentTimerRef = useRef<number | null>(null);
  const alwaysOnSpeakingRef = useRef(false);
  const alwaysOnLastVoiceAtRef = useRef(0);
  const alwaysOnCooldownUntilRef = useRef(0);
  const alwaysOnRecordedTypeRef = useRef("audio/webm");
  const voiceTurnQueueRef = useRef<Blob[]>([]);
  const voiceTurnProcessingRef = useRef(false);
  const voicePlaybackQueueRef = useRef<string[]>([]);
  const voicePlaybackActiveRef = useRef(false);
  const voiceAlwaysOnRef = useRef(false);
  const voiceScreenContextRef = useRef("");
  const voiceScreenContextRequestRef = useRef(false);
  const recordingChunksRef = useRef<Blob[]>([]);
  const voiceLogsRef = useRef<VoiceChatLogItem[]>([]);
  const serviceWindowUrlsRef = useRef<Partial<Record<ServiceId, string>>>({});

  useEffect(() => {
    voiceAlwaysOnRef.current = voiceAlwaysOn;
  }, [voiceAlwaysOn]);

  useEffect(() => {
    voiceScreenContextRef.current = voiceScreenContext;
  }, [voiceScreenContext]);

  useEffect(() => {
    if (!voiceAlwaysOn || !voiceScreenContextEnabled || !isTauriEnvironment()) {
      return;
    }

    let disposed = false;
    const refreshScreenContext = async () => {
      if (document.hidden) {
        return;
      }
      if (voiceScreenContextRequestRef.current) {
        return;
      }
      voiceScreenContextRequestRef.current = true;
      try {
        const context = await invoke<string>("get_realtime_screen_context");
        if (!disposed && context !== voiceScreenContextRef.current) {
          setVoiceScreenContext(context);
        }
      } catch (error) {
        if (!disposed) {
          setVoiceScreenContext(`屏幕上下文读取失败：${stringifyError(error)}`);
        }
      } finally {
        voiceScreenContextRequestRef.current = false;
      }
    };

    void refreshScreenContext();
    const timer = window.setInterval(() => void refreshScreenContext(), SCREEN_CONTEXT_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [voiceAlwaysOn, voiceScreenContextEnabled]);

  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }

    let disposed = false;
    appLocalDataDir()
      .then((baseDir) => {
        if (disposed) {
          return;
        }
        setNativeDataDirectories({
          maibot: joinLocalDataPath(baseDir, "embedded-webviews", "maibot"),
          napcat: joinLocalDataPath(baseDir, "embedded-webviews", "napcat"),
        });
      })
      .catch(() => {
        setNativeDataDirectories(NATIVE_WEBVIEW_DATA_DIRECTORIES);
        setStatusText("原生 Webview 会话目录解析失败，已回退为兼容目录。");
      });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    invoke<ServiceEndpoint[]>("get_service_endpoints")
      .then((definitions) => {
        if (definitions.length > 0) {
          setServiceDefinitions(definitions);
          setStatusText("本地服务入口已加载，可以直接嵌入或切到浏览器处理故障。");
        } else {
          setStatusText("未从后端拿到服务入口，已回退到默认地址。");
        }
      })
      .catch(() => {
        setStatusText("正在使用前端默认地址。后面接入真实进程管理后，这里会改成自动探测。");
      });
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }

    invoke<VoiceChatConfig>("get_voice_chat_config")
      .then((config) => {
        setVoiceConfig(config);
        setVoiceStatusText("语音配置已加载，默认输出中文。");
      })
      .catch((error) => {
        setVoiceStatusText(`语音配置加载失败：${stringifyError(error)}`);
      });
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeStoredServiceUrls(urlDrafts)));
  }, [urlDrafts]);

  useEffect(() => {
    if (viewMode !== "processes") {
      return undefined;
    }

    let disposed = false;

    const refresh = async (silent: boolean) => {
      if (silent && document.hidden) {
        return;
      }
      try {
        const [rawSnapshots, stabilityReport] = await Promise.all([
          invoke<ProcessSnapshot[]>("get_process_snapshots"),
          invoke<LoginStabilityReport>("get_login_stability_report"),
        ]);
        const snapshots = sortProcessSnapshots(rawSnapshots);
        if (disposed) {
          return;
        }
        setProcessSnapshots(snapshots);
        setLoginStabilityReport(stabilityReport);
        setActiveProcessId((current) => {
          if (snapshots.some((item) => item.id === current)) {
            return current;
          }
          return snapshots[0]?.id ?? current;
        });
        if (!silent) {
          setProcessStatusText("主程序、Adapter、NapCat 和语音 API 已接入软件内面板，不再需要外部 cmd。");
        }
      } catch (error) {
        if (disposed) {
          return;
        }
        setProcessStatusText(`进程面板连接失败：${stringifyError(error)}`);
      }
    };

    void refresh(false);
    const timer = window.setInterval(() => void refresh(true), PROCESS_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [viewMode]);

  const resolvedServices = useMemo(
    () =>
      serviceDefinitions.map((service) => ({
        ...service,
        url: urlDrafts[service.id]?.trim() || service.defaultUrl,
        effectiveUrl: resolveServiceUrl(service, urlDrafts[service.id]),
      })),
    [serviceDefinitions, urlDrafts],
  );

  const refreshServiceDefinitions = useCallback(async () => {
    try {
      const definitions = await invoke<ServiceEndpoint[]>("get_service_endpoints");
      if (definitions.length > 0) {
        setServiceDefinitions(definitions);
        return definitions;
      }
    } catch {
      // ignore and keep current definitions
    }

    return serviceDefinitions;
  }, [serviceDefinitions]);

  const resolveFreshServiceUrl = useCallback(
    async (service: { id: ServiceId; defaultUrl: string }) => {
      const latestDefinitions = await refreshServiceDefinitions();
      const latestService = latestDefinitions.find((item) => item.id === service.id) ?? service;
      return resolveServiceUrl(latestService, urlDrafts[service.id]);
    },
    [refreshServiceDefinitions, urlDrafts],
  );

  const openServiceExternally = useCallback(
    async (service: { id: ServiceId; defaultUrl: string }) => {
      await openExternal(await resolveFreshServiceUrl(service));
    },
    [resolveFreshServiceUrl],
  );

  const activeService =
    resolvedServices.find((service) => service.id === activeServiceId) ?? resolvedServices[0];

  const orderedProcesses = useMemo(
    () => sortProcessSnapshots(processSnapshots),
    [processSnapshots],
  );

  const activeProcess =
    orderedProcesses.find((process) => process.id === activeProcessId) ?? orderedProcesses[0];
  const activeProcessLastLogLine =
    activeProcess?.logLines[activeProcess.logLines.length - 1] ?? "";
  const visibleActiveProcessLogLines = useMemo(
    () => activeProcess?.logLines.slice(-PROCESS_LOG_RENDER_LIMIT) ?? [],
    [activeProcess?.logLines],
  );
  const renderedActiveProcessLogs = useMemo(
    () => renderAnsiLines(visibleActiveProcessLogLines),
    [visibleActiveProcessLogLines],
  );
  const hasExternalProcess = orderedProcesses.some((process) => process.runningExternally);
  const loginRiskMessages = loginStabilityReport?.riskMessages ?? [];
  const hasLoginStabilityRisk = loginRiskMessages.length > 0;
  const normalQqCount = loginStabilityReport?.normalQqProcesses.length ?? 0;
  const napcatQqCount = loginStabilityReport?.napcatQqProcesses.length ?? 0;
  const napcatBootCount = loginStabilityReport?.napcatBootProcesses.length ?? 0;
  const offlineAlerts = useMemo(() => {
    const alerts: OfflineAlert[] = [];

    const buildAlert = (
      processId: string,
      title: string,
      summary: string,
      keywords: string[],
    ) => {
      const process = orderedProcesses.find((item) => item.id === processId);
      if (!process) {
        return;
      }

      const detail = findLatestLogMatch(process.logLines, keywords);
      if (!detail) {
        return;
      }

      alerts.push({
        id: `${process.id}:${detail}`,
        processId: process.id,
        title,
        summary,
        detail,
      });
    };

    buildAlert(
      "napcat",
      "QQ 登录异常",
      "NapCat 最近出现掉线或登录错误，可能需要重新登录或执行深度清理。",
      NAPCAT_OFFLINE_KEYWORDS,
    );
    buildAlert(
      "adapter",
      "QQ 消息链路异常",
      "Adapter 检测到 QQ 链路断开，当前 bot 可能不回复或发不出去消息。",
      ADAPTER_OFFLINE_KEYWORDS,
    );

    return alerts;
  }, [orderedProcesses]);
  const visibleOfflineAlerts = useMemo(
    () => offlineAlerts.filter((alert) => !dismissedOfflineAlertIds.includes(alert.id)),
    [dismissedOfflineAlertIds, offlineAlerts],
  );

  const scrollConsoleTo = useCallback(
    (position: "top" | "bottom", behavior: ScrollBehavior = "smooth") => {
      const node = consoleOutputRef.current;
      if (!node) {
        return;
      }

      if (position === "top") {
        node.scrollTo({ top: 0, behavior });
        setLogAutoFollow(false);
        return;
      }

      node.scrollTo({ top: node.scrollHeight, behavior });
      setLogAutoFollow(true);
    },
    [],
  );

  const focusProcessLog = useCallback((processId: string, reason: string) => {
    setViewMode("processes");
    setActiveProcessId(processId);
    setProcessStatusText(reason);
    setLogAutoFollow(true);
  }, []);

  const openProcessPanel = useCallback(() => {
    setViewMode("processes");
    setLogAutoFollow(true);
  }, []);

  const selectProcess = useCallback((processId: string) => {
    setActiveProcessId(processId);
    setLogAutoFollow(true);
  }, []);

  const handleConsoleScroll = useCallback(() => {
    const node = consoleOutputRef.current;
    if (!node) {
      return;
    }

    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setLogAutoFollow((current) => {
      const next = distanceToBottom <= CONSOLE_AUTO_SCROLL_THRESHOLD_PX;
      return current === next ? current : next;
    });
  }, []);

  const openServiceWindow = useCallback(
    async (service: { id: ServiceId; name: string; url: string; defaultUrl: string }) => {
      const targetUrl = await resolveFreshServiceUrl(service);

      if (!isTauriEnvironment()) {
        await openExternal(targetUrl);
        return;
      }

      const label = SERVICE_WINDOW_LABELS[service.id];
      let win = await WebviewWindow.getByLabel(label);
      const previousUrl = serviceWindowUrlsRef.current[service.id];

      if (win && previousUrl && previousUrl !== targetUrl) {
        await win.close().catch(() => undefined);
        win = null;
      }

      if (!win) {
        win = new WebviewWindow(label, {
          url: targetUrl,
          title: `${service.name} · 软件内小窗`,
          width: 1180,
          height: 820,
          minWidth: 900,
          minHeight: 640,
          resizable: true,
          center: true,
          focus: true,
          visible: true,
          dataDirectory: nativeDataDirectories[service.id],
        });
        await waitForServiceWindowReady(win);
      }

      serviceWindowUrlsRef.current[service.id] = targetUrl;
      await win.show().catch(() => undefined);
      await win.setFocus().catch(() => undefined);
      setStatusText(`${service.name} 已在软件内小窗打开，不再走主界面内嵌。`);
    },
    [nativeDataDirectories, resolveFreshServiceUrl],
  );

  useEffect(() => {
    if (viewMode !== "processes" || !activeProcess || !logAutoFollow) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const node = consoleOutputRef.current;
      if (!node) {
        return;
      }
      node.scrollTop = node.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    activeProcess,
    activeProcessLastLogLine,
    logAutoFollow,
    viewMode,
  ]);

  const refreshProcessSnapshots = useCallback(async () => {
    const [rawSnapshots, stabilityReport] = await Promise.all([
      invoke<ProcessSnapshot[]>("get_process_snapshots"),
      invoke<LoginStabilityReport>("get_login_stability_report"),
    ]);
    const snapshots = sortProcessSnapshots(rawSnapshots);
    setProcessSnapshots(snapshots);
    setLoginStabilityReport(stabilityReport);
    if (snapshots.length > 0) {
      setActiveProcessId((current) => {
        if (snapshots.some((item) => item.id === current)) {
          return current;
        }
        return snapshots[0].id;
      });
    }
    return snapshots;
  }, []);

  const runProcessAction = useCallback(
    async (
      command: string,
      args: Record<string, unknown> | undefined,
      pendingText: string,
      doneText: string,
    ) => {
      setProcessBusy(command);
      setProcessStatusText(pendingText);

      try {
        const snapshots = sortProcessSnapshots(await invoke<ProcessSnapshot[]>(command, args));
        setProcessSnapshots(snapshots);
        try {
          setLoginStabilityReport(await invoke<LoginStabilityReport>("get_login_stability_report"));
        } catch {
          setLoginStabilityReport(null);
        }
        if (snapshots.length > 0) {
          setActiveProcessId((current) => {
            if (snapshots.some((item) => item.id === current)) {
              return current;
            }
            return snapshots[0].id;
          });
        }
        setProcessStatusText(doneText);
      } catch (error) {
        const actionError = stringifyError(error);

        try {
          await refreshProcessSnapshots();
          setProcessStatusText(`${pendingText}失败：${actionError}`);
        } catch (refreshError) {
          setProcessStatusText(
            `${pendingText}失败：${actionError}；状态刷新也失败：${stringifyError(refreshError)}`,
          );
        }
      } finally {
        setProcessBusy(null);
      }
    },
    [refreshProcessSnapshots],
  );

  const updateVoiceConfig = useCallback(
    <K extends keyof VoiceChatConfig>(key: K, value: VoiceChatConfig[K]) => {
      setVoiceConfig((current) => ({
        ...current,
        [key]: value,
      }));
    },
    [],
  );

  const stopAlwaysOnVoice = useCallback(() => {
    setVoiceAlwaysOn(false);
    voiceAlwaysOnRef.current = false;
    if (alwaysOnAnimationRef.current !== null) {
      window.clearInterval(alwaysOnAnimationRef.current);
      alwaysOnAnimationRef.current = null;
    }
    if (alwaysOnSegmentTimerRef.current !== null) {
      window.clearTimeout(alwaysOnSegmentTimerRef.current);
      alwaysOnSegmentTimerRef.current = null;
    }
    const recorder = alwaysOnRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    alwaysOnRecorderRef.current = null;
    alwaysOnChunksRef.current = [];
    alwaysOnStreamRef.current?.getTracks().forEach((track) => track.stop());
    alwaysOnStreamRef.current = null;
    void alwaysOnAudioContextRef.current?.close().catch(() => undefined);
    alwaysOnAudioContextRef.current = null;
    alwaysOnAnalyserRef.current = null;
    alwaysOnSpeakingRef.current = false;
    setVoiceStatusText("常开语音对话已关闭。");
  }, []);

  const playVoiceAudio = useCallback((audioUrl: string) => {
    const startPlayback = (nextAudioUrl: string) => {
      const shouldWaitForUser =
        voiceAlwaysOnRef.current && (alwaysOnSpeakingRef.current || alwaysOnRecorderRef.current !== null);
      if (shouldWaitForUser) {
        voicePlaybackQueueRef.current.unshift(nextAudioUrl);
        setVoiceStatusText("回复语音已准备好，等待你说完后播放。");
        return;
      }
      if (voicePlaybackActiveRef.current) {
        voicePlaybackQueueRef.current.push(nextAudioUrl);
        return;
      }

      voicePlaybackActiveRef.current = true;
      const audio = new Audio(nextAudioUrl);
      const finishPlayback = () => {
        voicePlaybackActiveRef.current = false;
        alwaysOnCooldownUntilRef.current = performance.now() + 620;
        const queuedAudioUrl = voicePlaybackQueueRef.current.shift();
        if (queuedAudioUrl) {
          window.setTimeout(() => startPlayback(queuedAudioUrl), 80);
        }
      };
      audio.onended = finishPlayback;
      void audio.play().catch(finishPlayback);
    };

    startPlayback(audioUrl);
  }, []);

  const saveVoiceConfig = useCallback(async () => {
    setVoiceBusy(true);
    setVoiceStatusText("正在保存语音配置...");
    try {
      const savedConfig = await invoke<VoiceChatConfig>("save_voice_chat_config", {
        config: voiceConfig,
      });
      setVoiceConfig(savedConfig);
      setVoiceStatusText("语音配置已保存。");
    } catch (error) {
      setVoiceStatusText(`语音配置保存失败：${stringifyError(error)}`);
    } finally {
      setVoiceBusy(false);
    }
  }, [voiceConfig]);

  const clearVoiceHistory = useCallback(async () => {
    setVoiceBusy(true);
    setVoiceStatusText("正在清空语音上下文...");
    try {
      await invoke("clear_voice_chat_history");
      voiceLogs.forEach((item) => URL.revokeObjectURL(item.audioUrl));
      setVoiceLogs([]);
      setVoiceStatusText("语音上下文已清空。");
    } catch (error) {
      setVoiceStatusText(`清空语音上下文失败：${stringifyError(error)}`);
    } finally {
      setVoiceBusy(false);
    }
  }, [voiceLogs]);

  const processVoiceTurnQueue = useCallback(
    async () => {
      if (voiceTurnProcessingRef.current) {
        return;
      }
      voiceTurnProcessingRef.current = true;
      setVoiceBusy(true);
      try {
        while (voiceTurnQueueRef.current.length > 0) {
          const blob = voiceTurnQueueRef.current.shift();
          if (!blob) {
            break;
          }
          const queuedCount = voiceTurnQueueRef.current.length;
          setVoiceStatusText(
            queuedCount > 0
              ? `正在识别分段语音，后面还有 ${queuedCount} 段待处理...`
              : "正在识别语音并准备伊蕾娜语音回复...",
          );
          const audioBase64 = await blobToBase64(blob);
          const response = await invoke<VoiceChatResponse>("voice_chat_turn", {
            request: {
              audioBase64,
              mimeType: blob.type || "audio/webm",
              config: voiceConfig,
              screenContext: voiceScreenContextEnabled ? voiceScreenContextRef.current : "",
            },
          });
          const audioBytes = Uint8Array.from(atob(response.audioBase64), (char) => char.charCodeAt(0));
          const audioBlob = new Blob([audioBytes], { type: response.audioMime || "audio/wav" });
          const audioUrl = URL.createObjectURL(audioBlob);
          const nextItem: VoiceChatLogItem = {
            id: makeVoiceLogId(),
            transcript: response.transcript,
            replyText: response.replyText,
            audioUrl,
            asrModel: response.asrModel,
            replyModel: response.replyModel,
          };
          setVoiceLogs((current) => {
            const next = [nextItem, ...current];
            next.slice(20).forEach((item) => URL.revokeObjectURL(item.audioUrl));
            return next.slice(0, 20);
          });
          setVoiceStatusText(`识别完成：${response.transcript}`);
          playVoiceAudio(audioUrl);
        }
      } catch (error) {
        setVoiceStatusText(`语音对话失败：${stringifyError(error)}`);
      } finally {
        voiceTurnProcessingRef.current = false;
        setVoiceBusy(false);
      }
    },
    [playVoiceAudio, voiceConfig, voiceScreenContextEnabled],
  );

  const enqueueVoiceTurn = useCallback(
    (blob: Blob) => {
      voiceTurnQueueRef.current.push(blob);
      if (voiceTurnQueueRef.current.length > 1 || voiceTurnProcessingRef.current) {
        setVoiceStatusText(`已加入语音处理队列：${voiceTurnQueueRef.current.length} 段。`);
      }
      void processVoiceTurnQueue();
    },
    [processVoiceTurnQueue],
  );

  const stopVoiceRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  }, []);

  const getPreferredVoiceMimeType = useCallback(() => {
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      return "audio/webm;codecs=opus";
    }
    if (MediaRecorder.isTypeSupported("audio/webm")) {
      return "audio/webm";
    }
    return "";
  }, []);

  const startVoiceRecording = useCallback(async () => {
    if (voiceBusy || voiceRecording) {
      return;
    }

    setVoiceStatusText("正在请求麦克风权限...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const mimeType = getPreferredVoiceMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunksRef.current = [];
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        const chunks = recordingChunksRef.current;
        const recordedType = recorder.mimeType || mimeType || "audio/webm";
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        setVoiceRecording(false);

        if (chunks.length === 0) {
          setVoiceStatusText("没有录到音频，请重新录制。");
          return;
        }

        const blob = new Blob(chunks, { type: recordedType });
        enqueueVoiceTurn(blob);
      };

      recorder.start();
      setVoiceRecording(true);
      setVoiceStatusText("正在录音，讲完后点“停止并发送”。");
    } catch (error) {
      setVoiceRecording(false);
      setVoiceStatusText(`无法开始录音：${stringifyError(error)}`);
    }
  }, [enqueueVoiceTurn, getPreferredVoiceMimeType, voiceBusy, voiceRecording]);

  const finishAlwaysOnRecording = useCallback(() => {
    const recorder = alwaysOnRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    recorder.stop();
  }, []);

  const startAlwaysOnClip = useCallback(() => {
    const stream = alwaysOnStreamRef.current;
    if (!stream || alwaysOnRecorderRef.current) {
      return;
    }
    const mimeType = getPreferredVoiceMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    alwaysOnChunksRef.current = [];
    alwaysOnRecordedTypeRef.current = recorder.mimeType || mimeType || "audio/webm";
    alwaysOnRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        alwaysOnChunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      const chunks = alwaysOnChunksRef.current;
      if (alwaysOnSegmentTimerRef.current !== null) {
        window.clearTimeout(alwaysOnSegmentTimerRef.current);
        alwaysOnSegmentTimerRef.current = null;
      }
      alwaysOnRecorderRef.current = null;
      alwaysOnChunksRef.current = [];
      alwaysOnSpeakingRef.current = false;
      if (!voiceAlwaysOnRef.current || chunks.length === 0) {
        return;
      }
      const blob = new Blob(chunks, { type: alwaysOnRecordedTypeRef.current });
      if (blob.size < 1600) {
        setVoiceStatusText("常开监听中，忽略过短音频。");
        return;
      }
      enqueueVoiceTurn(blob);
    };
    recorder.start();
    if (alwaysOnSegmentTimerRef.current !== null) {
      window.clearTimeout(alwaysOnSegmentTimerRef.current);
    }
    alwaysOnSegmentTimerRef.current = window.setTimeout(() => {
      finishAlwaysOnRecording();
    }, 4200);
    alwaysOnSpeakingRef.current = true;
    alwaysOnLastVoiceAtRef.current = performance.now();
    setVoiceStatusText("检测到说话，正在录音...");
  }, [enqueueVoiceTurn, finishAlwaysOnRecording, getPreferredVoiceMimeType]);

  const startAlwaysOnVoice = useCallback(async () => {
    if (voiceAlwaysOnRef.current) {
      return;
    }
    if (voiceRecording) {
      stopVoiceRecording();
    }

    setVoiceStatusText("正在开启常开语音对话...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const AudioContextClass =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("当前 WebView 不支持 AudioContext。");
      }
      const audioContext = new AudioContextClass();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      alwaysOnStreamRef.current = stream;
      alwaysOnAudioContextRef.current = audioContext;
      alwaysOnAnalyserRef.current = analyser;
      setVoiceAlwaysOn(true);
      voiceAlwaysOnRef.current = true;
      setVoiceStatusText("常开语音对话已开启，直接说话即可。");

      const samples = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!voiceAlwaysOnRef.current) {
          return;
        }
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const centered = sample - 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / samples.length) / 128;
        const now = performance.now();
        const isVoice = rms > 0.055;
        if (now >= alwaysOnCooldownUntilRef.current) {
          if (isVoice && !alwaysOnSpeakingRef.current) {
            startAlwaysOnClip();
          }
          if (isVoice && alwaysOnSpeakingRef.current) {
            alwaysOnLastVoiceAtRef.current = now;
          }
          if (alwaysOnSpeakingRef.current && now - alwaysOnLastVoiceAtRef.current > 650) {
            finishAlwaysOnRecording();
          }
          if (
            !alwaysOnSpeakingRef.current &&
            !alwaysOnRecorderRef.current &&
            !voicePlaybackActiveRef.current &&
            voicePlaybackQueueRef.current.length > 0
          ) {
            const nextAudioUrl = voicePlaybackQueueRef.current.shift();
            if (nextAudioUrl) {
              playVoiceAudio(nextAudioUrl);
            }
          }
        }
      };
      alwaysOnAnimationRef.current = window.setInterval(tick, 90);
    } catch (error) {
      stopAlwaysOnVoice();
      setVoiceStatusText(`无法开启常开语音：${stringifyError(error)}`);
    }
  }, [finishAlwaysOnRecording, playVoiceAudio, startAlwaysOnClip, stopAlwaysOnVoice, stopVoiceRecording, voiceRecording]);

  const toggleAlwaysOnVoice = useCallback(() => {
    if (voiceAlwaysOnRef.current) {
      stopAlwaysOnVoice();
    } else {
      void startAlwaysOnVoice();
    }
  }, [startAlwaysOnVoice, stopAlwaysOnVoice]);

  useEffect(() => {
    voiceLogsRef.current = voiceLogs;
  }, [voiceLogs]);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (alwaysOnAnimationRef.current !== null) {
        window.clearInterval(alwaysOnAnimationRef.current);
      }
      if (alwaysOnSegmentTimerRef.current !== null) {
        window.clearTimeout(alwaysOnSegmentTimerRef.current);
      }
      alwaysOnStreamRef.current?.getTracks().forEach((track) => track.stop());
      void alwaysOnAudioContextRef.current?.close().catch(() => undefined);
      voiceLogsRef.current.forEach((item) => URL.revokeObjectURL(item.audioUrl));
    };
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }

    let disposed = false;
    const timer = window.setTimeout(() => {
      void runProcessAction(
        "start_all_managed_processes",
        undefined,
        "正在自动拉起内置进程...",
        "内置进程已自动拉起。",
      ).catch(() => {
        if (!disposed) {
          setProcessStatusText("自动拉起内置进程失败，请切到进程面板查看详情。");
        }
      });
    }, 0);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [runProcessAction]);

  return (
    <main className="shell">
      {visibleOfflineAlerts.length > 0 ? (
        <aside className="offline-alert-stack" aria-live="assertive">
          {visibleOfflineAlerts.map((alert) => (
            <article className="offline-alert-card" key={alert.id}>
              <button
                aria-label="关闭提示"
                className="alert-close-button"
                type="button"
                onClick={() =>
                  setDismissedOfflineAlertIds((current) =>
                    current.includes(alert.id) ? current : [...current, alert.id],
                  )
                }
              >
                ×
              </button>
              <p className="offline-alert-kicker">掉线提醒</p>
              <h2>{alert.title}</h2>
              <p className="offline-alert-summary">{alert.summary}</p>
              <p className="offline-alert-detail">{alert.detail}</p>
              <div className="offline-alert-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => focusProcessLog(alert.processId, `已定位到 ${alert.title} 日志。`)}
                >
                  查看日志
                </button>
                <button
                  className="danger-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "prepare_stable_qq_login",
                      undefined,
                      "正在执行稳态重登准备：停止 NapCat/Adapter 并清理 QQ 登录链路残留...",
                      "稳态重登准备完成。请确认普通 QQ 没有登录 bot 号，再启动 Adapter 和 NapCat。",
                    )
                  }
                >
                  稳态重登
                </button>
              </div>
            </article>
          ))}
        </aside>
      ) : null}

      <section className="masthead">
        <div className="masthead-copy">
          <p className="eyebrow">MaiBot Desktop</p>
          <h1>把 MaiBot 和 NapCat 收进一个桌面控制台</h1>
          <p className="lede">
            现在除了 WebUI，还能把 MaiBot 主程序、NapCat Adapter 和 NapCat
            的运行日志直接塞进软件里看，切换和排错都不用再盯外面的 cmd 窗口。
          </p>
        </div>
        <div className="masthead-panel">
          <span className="status-dot" />
          <p>
            {viewMode === "services"
              ? statusText
              : viewMode === "voice"
                ? voiceStatusText
                : processStatusText}
          </p>
        </div>
      </section>

      <section className="view-switcher">
        <button
          className={viewMode === "services" ? "view-button view-button--active" : "view-button"}
          type="button"
          onClick={() => setViewMode("services")}
        >
          Web 控制台
        </button>
        <button
          className={viewMode === "processes" ? "view-button view-button--active" : "view-button"}
          type="button"
          onClick={openProcessPanel}
        >
          进程面板
        </button>
        <button
          className={viewMode === "voice" ? "view-button view-button--active" : "view-button"}
          type="button"
          onClick={() => setViewMode("voice")}
        >
          语音对话
        </button>
      </section>

      {viewMode === "services" ? (
        <>
          <section className="overview-grid">
            {resolvedServices.map((service) => {
              const selected = service.id === activeServiceId;
              return (
                <article
                  className={`service-card${selected ? " service-card--active" : ""}`}
                  key={service.id}
                >
                  <div className="service-header">
                    <div>
                      <p className="service-kicker">
                        {service.id === "maibot" ? "主控" : "连接层"}
                      </p>
                      <h2>{service.name}</h2>
                    </div>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => setActiveServiceId(service.id)}
                    >
                      {selected ? "当前面板" : "切到这里"}
                    </button>
                  </div>

                  <p className="service-description">{service.description}</p>

                  <label className="field" htmlFor={`${service.id}-url`}>
                    <span>服务地址</span>
                    <input
                      id={`${service.id}-url`}
                      value={service.url}
                      onChange={(event) =>
                        setUrlDrafts((current) => ({
                          ...current,
                          [service.id]: event.target.value,
                        }))
                      }
                      placeholder={service.defaultUrl}
                    />
                  </label>

                  <div className="service-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => {
                        setActiveServiceId(service.id);
                        setOpenInFrame(true);
                        void openServiceWindow(service);
                      }}
                    >
                      软件内打开
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void openServiceExternally(service)}
                    >
                      浏览器打开
                    </button>
                  </div>

                  <p className="service-tip">{service.troubleshootingTip}</p>
                </article>
              );
            })}
          </section>

          <section className="workspace">
            <div className="workspace-bar">
              <div>
                <p className="workspace-label">当前工作区</p>
                <h2>{activeService.name}</h2>
              </div>
              <div className="workspace-actions">
                <button
                  className={openInFrame ? "tab-button tab-button--active" : "tab-button"}
                  type="button"
                  onClick={() => setOpenInFrame(true)}
                >
                  小窗模式
                </button>
                <button
                  className={!openInFrame ? "tab-button tab-button--active" : "tab-button"}
                  type="button"
                  onClick={() => setOpenInFrame(false)}
                >
                  故障页
                </button>
              </div>
            </div>

            {openInFrame ? (
              <section className="fallback-panel">
                <h3>软件内小窗模式</h3>
                <p>
                  登录页不再塞进主界面。现在会用软件内独立小窗打开 MaiBot / NapCat，
                  这样会话更接近正常浏览器，稳定性也更高。
                </p>
                <ul>
                  <li>当前地址：{activeService.effectiveUrl}</li>
                  <li>如果已经开过同一个服务的小窗，再点会直接唤起原窗口。</li>
                  <li>修改了地址后再打开，会自动重建该服务窗口。</li>
                </ul>
                <div className="workspace-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void openServiceWindow(activeService)}
                  >
                    打开 {activeService.name} 小窗
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void openServiceExternally(activeService)}
                  >
                    改用系统浏览器
                  </button>
                </div>
              </section>
            ) : (
              <section className="fallback-panel">
                <h3>额外操作和故障修复建议</h3>
                <p>
                  某些页面可能因为登录态、跨域策略、外部跳转或独立弹窗而不适合长期嵌入。遇到这些情况，直接切浏览器处理更稳。
                </p>
                <ul>
                  <li>MaiBot：日志卡死、WebSocket 重连、插件页面异常时优先浏览器打开。</li>
                  <li>NapCat：扫码、重新登录、网络配置、Token 查看一般都建议浏览器里做。</li>
                  <li>后续会把这里接成检测服务状态、一键打开和一键重启的故障中心。</li>
                </ul>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void openServiceExternally(activeService)}
                >
                  现在打开 {activeService.name}
                </button>
              </section>
            )}
          </section>
        </>
      ) : viewMode === "voice" ? (
        <>
          <section className="voice-hero-grid">
            <article className="service-card voice-status-card">
              <p className="service-kicker">Voice Chat</p>
              <h2>桌面端语音对话</h2>
              <p className="service-description">
                录音会在后端转成 16k 单声道 PCM，交给豆包语音识别；回复会读取当前 MaiBot
                人设和回复模型，再用本地伊蕾娜 GPT-SoVITS 合成语音。
              </p>
              <div className="voice-record-ring">
                <span
                  className={
                    voiceRecording || voiceAlwaysOn ? "voice-pulse voice-pulse--recording" : "voice-pulse"
                  }
                />
                <strong>
                  {voiceRecording ? "正在录音" : voiceBusy ? "处理中" : voiceAlwaysOn ? "常开监听" : "待机"}
                </strong>
              </div>
              <div className="service-actions">
                <button
                  className={voiceRecording ? "danger-button" : "primary-button"}
                  disabled={voiceAlwaysOn || (voiceBusy && !voiceRecording)}
                  type="button"
                  onClick={() =>
                    voiceRecording ? stopVoiceRecording() : void startVoiceRecording()
                  }
                >
                  {voiceRecording ? "停止并发送" : "开始录音"}
                </button>
                <button
                  className={voiceAlwaysOn ? "danger-button" : "secondary-button"}
                  disabled={voiceBusy && !voiceAlwaysOn}
                  type="button"
                  onClick={toggleAlwaysOnVoice}
                >
                  {voiceAlwaysOn ? "关闭常开语音" : "开启常开语音"}
                </button>
                <button
                  className={voiceScreenContextEnabled ? "secondary-button" : "ghost-button"}
                  type="button"
                  onClick={() => setVoiceScreenContextEnabled((current) => !current)}
                >
                  {voiceScreenContextEnabled ? "屏幕上下文：开" : "屏幕上下文：关"}
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "start_managed_process",
                      { processId: "tts-api" },
                      "正在启动 GPT-SoVITS 语音 API ...",
                      "GPT-SoVITS 语音 API 启动请求已发送。",
                    )
                  }
                >
                  启动伊蕾娜语音API
                </button>
              </div>
              <p className="service-tip">{voiceStatusText}</p>
              {voiceAlwaysOn && voiceScreenContextEnabled ? (
                <p className="voice-context-note">{voiceScreenContext}</p>
              ) : null}
            </article>

            <article className="service-card">
              <p className="service-kicker">Settings</p>
              <h2>语音配置</h2>
              <div className="voice-config-grid">
                <label className="field" htmlFor="voice-volc-app-id">
                  <span>火山 ASR APP ID</span>
                  <input
                    id="voice-volc-app-id"
                    value={voiceConfig.volcAsrAppId}
                    onChange={(event) => updateVoiceConfig("volcAsrAppId", event.target.value)}
                    placeholder="5029855949"
                  />
                </label>
                <label className="field" htmlFor="voice-volc-api-key">
                  <span>火山 ASR x-api-key</span>
                  <input
                    id="voice-volc-api-key"
                    type="password"
                    value={voiceConfig.volcAsrApiKey}
                    onChange={(event) => updateVoiceConfig("volcAsrApiKey", event.target.value)}
                    placeholder="662d8a47-..."
                  />
                </label>
                <label className="field" htmlFor="voice-volc-token">
                  <span>火山 Access Token 备用</span>
                  <input
                    id="voice-volc-token"
                    type="password"
                    value={voiceConfig.volcAsrAccessToken}
                    onChange={(event) => updateVoiceConfig("volcAsrAccessToken", event.target.value)}
                    placeholder="N9..."
                  />
                </label>
                <label className="field" htmlFor="voice-volc-submit">
                  <span>火山 Submit URL</span>
                  <input
                    id="voice-volc-submit"
                    value={voiceConfig.volcAsrSubmitUrl}
                    onChange={(event) => updateVoiceConfig("volcAsrSubmitUrl", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-volc-query">
                  <span>火山 Query URL</span>
                  <input
                    id="voice-volc-query"
                    value={voiceConfig.volcAsrQueryUrl}
                    onChange={(event) => updateVoiceConfig("volcAsrQueryUrl", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-volc-url">
                  <span>火山 Flash URL 备用</span>
                  <input
                    id="voice-volc-url"
                    value={voiceConfig.volcAsrUrl}
                    onChange={(event) => updateVoiceConfig("volcAsrUrl", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-volc-resource">
                  <span>火山资源 ID</span>
                  <input
                    id="voice-volc-resource"
                    value={voiceConfig.volcAsrResourceId}
                    onChange={(event) => updateVoiceConfig("volcAsrResourceId", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-volc-model">
                  <span>火山 ASR 模型</span>
                  <input
                    id="voice-volc-model"
                    value={voiceConfig.volcAsrModel}
                    onChange={(event) => updateVoiceConfig("volcAsrModel", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-volc-secret">
                  <span>火山 Secret Key</span>
                  <input
                    id="voice-volc-secret"
                    type="password"
                    value={voiceConfig.volcAsrSecretKey}
                    onChange={(event) => updateVoiceConfig("volcAsrSecretKey", event.target.value)}
                    placeholder="已保存备用，极速版通常不用"
                  />
                </label>
                <label className="field" htmlFor="voice-asr-key">
                  <span>Ark ASR API Key 备用</span>
                  <input
                    id="voice-asr-key"
                    type="password"
                    value={voiceConfig.asrApiKey}
                    onChange={(event) => updateVoiceConfig("asrApiKey", event.target.value)}
                    placeholder="ark-..."
                  />
                </label>
                <label className="field" htmlFor="voice-asr-base">
                  <span>Ark ASR Base URL 备用</span>
                  <input
                    id="voice-asr-base"
                    value={voiceConfig.asrBaseUrl}
                    onChange={(event) => updateVoiceConfig("asrBaseUrl", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-asr-model">
                  <span>Ark ASR 模型备用</span>
                  <input
                    id="voice-asr-model"
                    value={voiceConfig.asrModel}
                    onChange={(event) => updateVoiceConfig("asrModel", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-asr-path">
                  <span>Ark ASR 转写路径备用</span>
                  <input
                    id="voice-asr-path"
                    value={voiceConfig.asrTranscriptionPath}
                    onChange={(event) => updateVoiceConfig("asrTranscriptionPath", event.target.value)}
                    placeholder="/audio/transcriptions"
                  />
                </label>
                <label className="field" htmlFor="voice-output-language">
                  <span>默认输出语言</span>
                  <select
                    className="voice-select"
                    id="voice-output-language"
                    value={voiceConfig.outputLanguage}
                    onChange={(event) => updateVoiceConfig("outputLanguage", event.target.value)}
                  >
                    <option value="zh">中文</option>
                    <option value="ja">日语</option>
                    <option value="en">英语</option>
                  </select>
                </label>
                <label className="field" htmlFor="voice-tts-url">
                  <span>伊蕾娜语音 API</span>
                  <input
                    id="voice-tts-url"
                    value={voiceConfig.ttsApiUrl}
                    onChange={(event) => updateVoiceConfig("ttsApiUrl", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-history-turns">
                  <span>语音上下文轮数</span>
                  <input
                    id="voice-history-turns"
                    min={1}
                    max={20}
                    type="number"
                    value={voiceConfig.maxHistoryTurns}
                    onChange={(event) =>
                      updateVoiceConfig(
                        "maxHistoryTurns",
                        Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                      )
                    }
                  />
                </label>
              </div>
              <label className="field" htmlFor="voice-ref-audio">
                <span>参考音频路径</span>
                <input
                  id="voice-ref-audio"
                  value={voiceConfig.ttsRefAudioPath}
                  onChange={(event) => updateVoiceConfig("ttsRefAudioPath", event.target.value)}
                />
              </label>
              <label className="field" htmlFor="voice-prompt-text">
                <span>参考音频文本</span>
                <textarea
                  className="voice-textarea"
                  id="voice-prompt-text"
                  value={voiceConfig.ttsPromptText}
                  onChange={(event) => updateVoiceConfig("ttsPromptText", event.target.value)}
                />
              </label>
              <div className="service-actions">
                <button
                  className="primary-button"
                  disabled={voiceBusy}
                  type="button"
                  onClick={() => void saveVoiceConfig()}
                >
                  保存语音配置
                </button>
                <button
                  className="secondary-button"
                  disabled={voiceBusy}
                  type="button"
                  onClick={() => void clearVoiceHistory()}
                >
                  清空语音上下文
                </button>
              </div>
            </article>
          </section>

          <section className="workspace voice-workspace">
            <div className="workspace-bar">
              <div>
                <p className="workspace-label">Voice Timeline</p>
                <h2>语音识别和回复记录</h2>
              </div>
              <div className="workspace-actions">
                <button
                  className="ghost-button"
                  disabled={voiceBusy || voiceRecording || voiceAlwaysOn}
                  type="button"
                  onClick={() => void startVoiceRecording()}
                >
                  再说一句
                </button>
              </div>
            </div>

            {voiceLogs.length > 0 ? (
              <div className="voice-log-list">
                {voiceLogs.map((item) => (
                  <article className="voice-log-card" key={item.id}>
                    <div>
                      <p className="service-kicker">你说</p>
                      <p className="voice-transcript">{item.transcript}</p>
                    </div>
                    <div>
                      <p className="service-kicker">茶夕莳回复</p>
                      <p className="voice-reply">{item.replyText}</p>
                    </div>
                    <audio controls src={item.audioUrl} />
                    <p className="service-tip">
                      ASR：{item.asrModel} | 回复模型：{item.replyModel}
                    </p>
                  </article>
                ))}
              </div>
            ) : (
              <section className="fallback-panel">
                <h3>还没有语音记录</h3>
                <p>
                  点“开始录音”后直接说话。第一次使用时系统会请求麦克风权限；如果合成失败，先确认进程面板里的
                  GPT-SoVITS 语音 API 已运行。
                </p>
              </section>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="process-overview-grid">
            {orderedProcesses.map((process) => {
              const selected = process.id === activeProcess?.id;
              const stateClass = process.running
                ? "process-card process-card--running"
                : "process-card";

              return (
                <article
                  className={`${stateClass}${selected ? " process-card--active" : ""}`}
                  key={process.id}
                >
                  <div className="service-header">
                    <div>
                      <p className="service-kicker">进程</p>
                      <h2>{process.name}</h2>
                    </div>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => selectProcess(process.id)}
                    >
                      {selected ? "当前日志" : "查看日志"}
                    </button>
                  </div>
                  <p className="service-description">{process.description}</p>
                  <div className="process-meta-row">
                    <span
                      className={
                        process.running ? "state-pill state-pill--running" : "state-pill"
                      }
                    >
                      {getProcessStateLabel(process)}
                    </span>
                    <span className="meta-note">
                      PID {process.pid ?? "未分配"}
                      {process.runningExternally ? " | 外部实例" : ""}
                    </span>
                  </div>
                  <p className="service-tip">
                    {process.issue ??
                      process.statusNote ??
                      "已接入软件内输出面板，不会再额外弹 cmd。"}
                  </p>
                </article>
              );
            })}
          </section>

          <section className="workspace">
            <div className="workspace-bar">
              <div>
                <p className="workspace-label">进程总控</p>
                <h2>主程序日志和控制台切换</h2>
              </div>
              <div className="workspace-actions">
                <button
                  className="secondary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "cleanup_process_conflicts",
                      undefined,
                      "正在清理 8001 / 8095 / 6099 / 9880 端口占用...",
                      "端口占用清理完成。现在可以重新启动全部进程。",
                    )
                  }
                >
                  清理端口占用
                </button>
                <button
                  className="danger-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "deep_cleanup_process_state",
                      undefined,
                      "正在执行一键清理：停止残留进程、释放端口并重置心跳状态...",
                      "一键清理完成。现在可以重新启动全部进程。",
                    )
                  }
                >
                  一键清理并重置
                </button>
                <button
                  className="secondary-button secondary-button--warning"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "prepare_stable_qq_login",
                      undefined,
                      "正在执行稳态重登准备：停止 NapCat/Adapter 并清理 QQ 登录链路残留...",
                      "稳态重登准备完成。请确认普通 QQ 没有登录 bot 号，再启动 Adapter 和 NapCat。",
                    )
                  }
                >
                  稳态重登准备
                </button>
                <button
                  className="primary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "start_all_managed_processes",
                      undefined,
                      "正在启动全部内置进程...",
                      "全部进程启动请求已发送。",
                    )
                  }
                >
                  全部启动
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "stop_all_managed_processes",
                      undefined,
                      "正在停止全部内置进程...",
                      "全部进程停止请求已发送。",
                    )
                  }
                >
                  全部停止
                </button>
                <button
                  className="ghost-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "get_process_snapshots",
                      undefined,
                      "正在刷新进程状态...",
                      "进程状态已刷新。",
                    )
                  }
                >
                  刷新状态
                </button>
              </div>
            </div>

            {hasExternalProcess ? (
              <div className="cleanup-banner">
                检测到已有外部实例占用 MaiBot / Adapter / NapCat / 语音 API
                端口。如果 bot 不回复、QQ 误报异常或你怀疑有残留进程，优先点“一键清理并重置”，再点“全部启动”。
              </div>
            ) : null}

            {loginStabilityReport ? (
              <div
                className={
                  hasLoginStabilityRisk
                    ? "cleanup-banner cleanup-banner--danger"
                    : "cleanup-banner cleanup-banner--ok"
                }
              >
                <strong>QQ 登录稳态：</strong>
                {loginStabilityReport.status}
                <span>
                  {" "}
                  bot号 {loginStabilityReport.qqAccount ?? "未读取"}，普通QQ {normalQqCount}
                  个，NapCat QQ {napcatQqCount} 个，NapCat启动器 {napcatBootCount} 个。
                </span>
                {hasLoginStabilityRisk ? (
                  <ul className="stability-risk-list">
                    {loginRiskMessages.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {activeProcess ? (
              <>
                <div className="process-tab-row">
                  {orderedProcesses.map((process) => (
                    <button
                      className={
                        process.id === activeProcess.id
                          ? "tab-button tab-button--active"
                          : "tab-button"
                      }
                      key={process.id}
                      type="button"
                      onClick={() => selectProcess(process.id)}
                    >
                      {process.name}
                    </button>
                  ))}
                </div>

                <div className="process-detail-grid">
                  <article className="meta-card">
                    <p className="service-kicker">工作目录</p>
                    <code>{activeProcess.cwd}</code>
                  </article>
                  <article className="meta-card">
                    <p className="service-kicker">启动命令</p>
                    <code>{activeProcess.commandLine}</code>
                  </article>
                  <article className="meta-card">
                    <p className="service-kicker">当前状态</p>
                    <div className="process-meta-row">
                      <span
                        className={
                          activeProcess.running ? "state-pill state-pill--running" : "state-pill"
                        }
                      >
                        {getProcessStateLabel(activeProcess)}
                      </span>
                      <span className="meta-note">
                        {activeProcess.available
                          ? activeProcess.runningExternally
                            ? "外部实例"
                            : activeProcess.managedByApp
                              ? "桌面端接管"
                              : "可启动"
                          : "配置缺失"}
                      </span>
                    </div>
                  </article>
                </div>

                <div className="process-actions-bar">
                  <button
                    className="primary-button"
                    disabled={
                      processBusy !== null ||
                      !activeProcess.available ||
                      activeProcess.running
                    }
                    type="button"
                    onClick={() =>
                      void runProcessAction(
                        "start_managed_process",
                        { processId: activeProcess.id },
                        `正在启动 ${activeProcess.name} ...`,
                        `${activeProcess.name} 启动请求已发送。`,
                      )
                    }
                  >
                    {activeProcess.runningExternally
                      ? "已由外部运行"
                      : activeProcess.managedByApp
                        ? "当前已运行"
                        : "启动当前进程"}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={processBusy !== null || !activeProcess.managedByApp}
                    type="button"
                    onClick={() =>
                      void runProcessAction(
                        "stop_managed_process",
                        { processId: activeProcess.id },
                        `正在停止 ${activeProcess.name} ...`,
                        `${activeProcess.name} 停止请求已发送。`,
                      )
                    }
                  >
                    停止当前进程
                  </button>
                  <button
                    className="ghost-button"
                    disabled={processBusy !== null}
                    type="button"
                    onClick={() =>
                      void runProcessAction(
                        "clear_process_logs",
                        { processId: activeProcess.id },
                        `正在清空 ${activeProcess.name} 日志...`,
                        `${activeProcess.name} 日志已清空。`,
                      )
                    }
                  >
                    清空当前日志
                  </button>
                </div>

                <div className="console-shell">
                  <div className="console-toolbar">
                    <div className="console-toolbar-row">
                      <div className="process-meta-row">
                        <span
                          className={
                            activeProcess.running ? "state-pill state-pill--running" : "state-pill"
                          }
                        >
                          {getProcessStateLabel(activeProcess)}
                        </span>
                        <span className="meta-note">
                          PID {activeProcess.pid ?? "未分配"}
                          {activeProcess.runningExternally ? " | 外部实例" : ""}
                        </span>
                        <span className="console-follow-note">
                          {logAutoFollow ? "日志自动跟随中" : "日志已暂停自动跟随"}
                        </span>
                      </div>
                      <div className="console-scroll-actions">
                        <button
                          className="tab-button"
                          type="button"
                          onClick={() => scrollConsoleTo("top")}
                        >
                          到最上面
                        </button>
                        <button
                          className="tab-button"
                          type="button"
                          onClick={() => scrollConsoleTo("bottom")}
                        >
                          到最下面
                        </button>
                      </div>
                    </div>
                    <code>{activeProcess.commandLine}</code>
                  </div>
                  {(!activeProcess.available && activeProcess.issue) || activeProcess.statusNote ? (
                    <div className="process-issue-banner">
                      {activeProcess.issue ?? activeProcess.statusNote}
                    </div>
                  ) : null}
                  <div
                    ref={consoleOutputRef}
                    className="console-output"
                    role="log"
                    aria-live="polite"
                    onScroll={handleConsoleScroll}
                  >
                    {visibleActiveProcessLogLines.length > 0
                      ? renderedActiveProcessLogs
                      : "这里会显示当前进程的 stdout / stderr 输出。启动后不再弹外部 cmd 窗口。"}
                  </div>
                </div>
              </>
            ) : (
              <section className="fallback-panel">
                <h3>进程面板还没拿到数据</h3>
                <p>如果这里长期为空，通常是后端还没编译好或者当前模块路径不完整。</p>
              </section>
            )}
          </section>
        </>
      )}
    </main>
  );
}

export default App;
